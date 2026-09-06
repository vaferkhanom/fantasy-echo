'use strict';
/* Squad verification against official varzesh3 club squads:
 * - fixes club assignment (transfers + misassigned),
 * - fixes Persian names to official spellings,
 * - fixes positions + portraits (per-person, kills wrong-photo bugs),
 * - adds missing real players, deactivates bogus ones.
 */
const { query } = require('../../db');
const v3 = require('./varzesh3');

const ROLE_POS = {
  'دروازه بان': 'GKP', 'دروازه بان ها': 'GKP', 'دروازه‌بان': 'GKP',
  'مدافع': 'DEF', 'مدافعین': 'DEF', 'مدافعان': 'DEF',
  'هافبک': 'MID', 'هافبک ها': 'MID', 'هافبک‌ها': 'MID',
  'مهاجم': 'FWD', 'مهاجمین': 'FWD', 'مهاجمان': 'FWD'
};
function rolePos(role) {
  const r = String(role || '');
  if (r.includes('دروازه')) return 'GKP';
  if (r.includes('مدافع')) return 'DEF';
  if (r.includes('هافبک')) return 'MID';
  if (r.includes('مهاجم')) return 'FWD';
  return 'MID';
}

function norm(s) {
  return String(s || '').replace(/[\u200c\u200b]/g, ' ').replace(/ي/g, 'ی').replace(/ك/g, 'ک')
    .replace(/\s+/g, ' ').trim();
}
function coreKey(s) {
  // reuse city's word stripping via auto's CITY set through normExact comparison fallback
  return norm(s);
}

const TIER_BASE = { GKP: 40, DEF: 40, MID: 45, FWD: 45 };
const TIER_BONUS = { 5: 10, 4: 5, 3: 0, 2: 0, 1: 0 };

let verifyRunning = false;
let lastVerify = null;

async function fetchAllSquads(clubs) {
  const officialByClub = {};
  const v3club = {};
  for (const club of clubs) {
    if (!club.v3id) continue;
    let squad;
    try { squad = await v3.apiGet(`/football/teams/${club.v3id}/squad`); }
    catch (e) { continue; }
    officialByClub[club.id] = [];
    for (const g of (squad || [])) {
      const pos = rolePos(g.role);
      for (const p of (g.players || [])) {
        officialByClub[club.id].push({
          v3id: Number(p.id), name: p.name, pos,
          portrait: p.portrait || null, shirt: p.shirtNumber || null
        });
        if (!v3club[Number(p.id)]) v3club[Number(p.id)] = club.id;
      }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return { officialByClub, v3club };
}

async function dedupePlayers(v3club) {
  // one v3id -> exactly one row (in the official club); others cleared/removed
  const { rows: dupes } = await query(
    `SELECT v3id, array_agg(id ORDER BY id) AS ids FROM players
     WHERE v3id IS NOT NULL GROUP BY v3id HAVING count(*) > 1`);
  let fixed = 0, cleared = 0, removed = 0;
  for (const d of dupes) {
    const rightClub = v3club[d.v3id];
    const { rows: rows } = await query(`SELECT * FROM players WHERE id = ANY($1) ORDER BY id`, [d.ids]);
    // keep: row already in right club, else first row (moved to right club if known)
    let keep = rows.find(r => rightClub && r.club_id === rightClub) || rows[0];
    if (rightClub && keep.club_id !== rightClub) {
      await query(`UPDATE players SET club_id=$1 WHERE id=$2`, [rightClub, keep.id]);
      fixed++;
    }
    for (const r of rows) {
      if (r.id === keep.id) continue;
      const { rows: refs } = await query(
        `SELECT (SELECT count(*) FROM stats_gw WHERE player_id=$1)
              + (SELECT count(*) FROM points WHERE player_id=$1)
              + (SELECT count(*) FROM squads WHERE player_id=$1) AS n`, [r.id]);
      if (Number(refs[0].n) > 0) {
        await query(`UPDATE players SET v3id=NULL, portrait=NULL, status='unverified' WHERE id=$1`, [r.id]);
        cleared++;
      } else {
        await query(`DELETE FROM players WHERE id=$1`, [r.id]);
        removed++;
      }
    }
  }
  return { fixed, cleared, removed, groups: dupes.length };
}

async function verifySquads() {
  if (verifyRunning) return { started: false };
  verifyRunning = true;
  const report = { clubs: {}, added: 0, moved: 0, renamed: 0, repos: 0, photos: 0, deactivated: 0, deleted: 0, dedup: null, errors: [] };
  try {
    const { rows: clubs } = await query(`SELECT * FROM clubs ORDER BY id`);
    const { officialByClub, v3club } = await fetchAllSquads(clubs);
    for (const club of clubs) {
      const official = officialByClub[club.id] || [];
      if (!official.length) { report.errors.push(`${club.fa_name}: no official squad`); continue; }
      const { rows: ours } = await query(`SELECT * FROM players WHERE club_id=$1`, [club.id]);
      const byV3 = new Map(ours.filter(p => p.v3id).map(p => [Number(p.v3id), p]));
      const seenOurs = new Set();
      let cAdded = 0, cMoved = 0, cRenamed = 0, cRepos = 0, cPhotos = 0;
      for (const op of official) {
        let pl = byV3.get(op.v3id);
        if (!pl) {
          // search by exact official name anywhere (transfer from another club),
          // but only unlinked rows (linked rows belong to their v3 person already)
          const { rows: byName } = await query(
            `SELECT * FROM players WHERE fa_name=$1 AND v3id IS NULL LIMIT 5`, [op.name]);
          pl = byName[0] || null;
          if (!pl) {
            // whole-word fallback within this club
            const cand = ours.find(o => !seenOurs.has(o.id) && (
              norm(o.fa_name) === norm(op.name)));
            if (cand) pl = cand;
          }
        }
        if (pl) {
          seenOurs.add(pl.id);
          const sets = [], vals = [];
          const push = (col, val, cur) => {
            if (val !== undefined && val !== null && val !== cur) { sets.push(`${col}=$${vals.length + 1}`); vals.push(val); }
          };
          push('club_id', club.id, pl.club_id);
          push('fa_name', op.name, pl.fa_name);
          push('pos', op.pos, pl.pos);
          push('portrait', op.portrait, pl.portrait);
          push('v3id', op.v3id, pl.v3id ? Number(pl.v3id) : null);
          if (sets.length) {
            vals.push(pl.id);
            await query(`UPDATE players SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
            if (pl.club_id !== club.id) cMoved++;
            if (pl.fa_name !== op.name) cRenamed++;
            if (pl.pos !== op.pos) cRepos++;
            if (pl.portrait !== op.portrait) cPhotos++;
          }
        } else {
          // genuinely new player
          const price = ((TIER_BASE[op.pos] || 45) + (TIER_BONUS[club.tier] || 0)) / 10;
          await query(
            `INSERT INTO players (club_id, fa_name, pos, price, is_foreign, v3id, portrait)
             VALUES ($1,$2,$3,$4,false,$5,$6)`,
            [club.id, op.name, op.pos, price, op.v3id, op.portrait]);
          cAdded++;
        }
      }
      // our players not in official squad
      for (const pl of ours) {
        if (seenOurs.has(pl.id)) continue;
        const { rows: refs } = await query(
          `SELECT (SELECT count(*) FROM stats_gw WHERE player_id=$1)
                + (SELECT count(*) FROM points WHERE player_id=$1)
                + (SELECT count(*) FROM squads WHERE player_id=$1)
                + (SELECT count(*) FROM transfers WHERE player_in=$1 OR player_out=$1) AS n`,
          [pl.id]);
        if (Number(refs[0].n) > 0) {
          await query(`UPDATE players SET status='unverified' WHERE id=$1`, [pl.id]);
          report.deactivated++;
        } else {
          await query(`DELETE FROM players WHERE id=$1`, [pl.id]);
          report.deleted++;
        }
      }
      report.added += cAdded; report.moved += cMoved; report.renamed += cRenamed;
      report.repos += cRepos; report.photos += cPhotos;
      report.clubs[club.fa_name] = { official: official.length, added: cAdded, moved: cMoved, renamed: cRenamed, repos: cRepos };
    }
    report.dedup = await dedupePlayers(v3club);
    lastVerify = { ok: true, at: new Date().toISOString(), ...report, errors: report.errors };
  } catch (e) {
    lastVerify = { ok: false, error: (e.message || '').slice(0, 200) };
  } finally {
    verifyRunning = false;
  }
  return lastVerify;
}

module.exports = { verifySquads, getVerifyStatus: () => ({ running: verifyRunning, last: lastVerify }) };
