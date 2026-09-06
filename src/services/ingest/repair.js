'use strict';
/* One-time + ongoing consistency repair:
 * Re-resolves every varzesh3-linked fixture against the official results API
 * (round + v3 match id -> authoritative clubs/orientation/score), fixes
 * misassigned clubs and players, removes duplicate rows, re-scores.
 */
const { query } = require('../../db');
const v3 = require('./varzesh3');
const auto = require('./auto');
const { finishGw } = require('../engine');

async function repairAll() {
  const log = [];
  const { rows: clubs } = await query(`SELECT id, fa_name, v3id FROM clubs`);
  const rounds = await v3.resultsAll();
  // authoritative v3teamId -> {name}; exact-matched club fix
  const teams = new Map();
  for (const r of rounds) {
    for (const dg of (r.dates || [])) {
      for (const mt of (dg.matches || [])) {
        teams.set(String(mt.host.id), mt.host.name);
        teams.set(String(mt.guest.id), mt.guest.name);
      }
    }
  }
  for (const [tid, name] of teams) {
    const hit = clubs.find(c => auto.normExact(c.fa_name) === auto.normExact(name));
    if (hit && hit.v3id !== tid) {
      await query(`UPDATE clubs SET v3id=$1 WHERE id=$2`, [tid, hit.id]);
      log.push(`club v3id: ${hit.fa_name} -> ${tid}`);
    }
  }
  const { rows: clubs2 } = await query(`SELECT id, fa_name FROM clubs`);

  // index v3 matches by id
  const byId = new Map();
  for (const r of rounds) {
    const m = String(r.round || '').match(/(\d+)/);
    const gw = m ? Number(m[1]) : null;
    for (const dg of (r.dates || [])) {
      for (const mt of (dg.matches || [])) byId.set(String(mt.id), { mt, gw });
    }
  }

  const { rows: fixtures } = await query(
    `SELECT * FROM fixtures WHERE varzesh3_id IS NOT NULL`);
  const affectedGws = new Set();
  let fixed = 0, dups = 0, playersMoved = 0, linksCleared = 0;

  for (const f of fixtures) {
    const found = byId.get(String(f.varzesh3_id));
    if (!found) continue;
    const { mt, gw } = found;
    const ch = auto.resolveClubId(mt.host.name, clubs2);
    const ca = auto.resolveClubId(mt.guest.name, clubs2);
    if (!ch || !ca || (ch === f.home_club && ca === f.away_club)) continue;
    // misassigned fixture -> repair
    log.push(`fix fixture ${f.id} gw${f.gw_id}: clubs (${f.home_club},${f.away_club}) -> (${ch},${ca})`);
    // 1. clear wrong person links (linked players not in correct clubs)
    const d = await v3.matchDetail(f.varzesh3_id).catch(() => null);
    if (d && d.lineup) {
      const personSide = {};
      for (const side of ['host', 'guest']) {
        const L = d.lineup[side] || {};
        for (const ln of (L.formationLines || [])) {
          for (const p of (ln.players || [])) personSide[p.id] = side;
        }
        for (const p of (L.benchedPlayers || [])) personSide[p.id] = side;
      }
      const correctClub = { host: ch, guest: ca };
      for (const [pid3, side] of Object.entries(personSide)) {
        const { rows: linked } = await query(`SELECT id, club_id FROM players WHERE v3id=$1`, [Number(pid3)]);
        for (const pl of linked) {
          if (pl.club_id !== correctClub[side]) {
            // wrong link: clear it + drop its bogus stats for this gw (re-extracted below)
            await query(`UPDATE players SET v3id=NULL WHERE id=$1`, [pl.id]);
            await query(`DELETE FROM stats_gw WHERE gw_id=$1 AND player_id=$2`, [f.gw_id, pl.id]);
            linksCleared++;
          }
        }
      }
      // move correctly-linked players (right person, wrong club row) to the right club
      {
        const { rows: allLinked } = await query(
          `SELECT p.id, p.club_id, p.v3id FROM players p WHERE p.v3id IS NOT NULL AND (p.club_id=$1 OR p.club_id=$2)`,
          [f.home_club, f.away_club]);
        const sideOf = {};
        for (const [pid3, side] of Object.entries(personSide)) sideOf[pid3] = side;
        for (const pl of allLinked) {
          const side = sideOf[pl.v3id];
          if (side && pl.club_id !== correctClub[side]) {
            await query(`UPDATE players SET club_id=$1 WHERE id=$2`, [correctClub[side], pl.id]);
            playersMoved++;
          }
        }
      }
    }
    // 2. fix fixture itself
    await query(
      `UPDATE fixtures SET home_club=$1, away_club=$2, home_goals=$3, away_goals=$4,
        finished=true, stats_applied=false, stats_source='repaired', locked_at=NULL, gw_id=$5 WHERE id=$6`,
      [ch, ca, mt.goals ? mt.goals.host : f.home_goals, mt.goals ? mt.goals.guest : f.away_goals, gw || f.gw_id, f.id]);
    // 3. remove duplicate rows (same gw + clubs), prefer keeping rows with stats
    const { rows: dupes } = await query(
      `SELECT id, stats_applied FROM fixtures
       WHERE gw_id=$1 AND ((home_club=$2 AND away_club=$3) OR (home_club=$3 AND away_club=$2)) AND id<>$4`,
      [gw || f.gw_id, ch, ca, f.id]);
    for (const dp of dupes) {
      await query(`DELETE FROM fixtures WHERE id=$1`, [dp.id]);
      dups++;
    }
    affectedGws.add(gw || f.gw_id);
    fixed++;
  }

  // re-run extraction for repaired fixtures + re-score affected GWs
  for (const gw of affectedGws) {
    const { rows: todo } = await query(
      `SELECT * FROM fixtures WHERE gw_id=$1 AND NOT stats_applied AND finished`, [gw]);
    for (const fx of todo) {
      try { await auto.processFixture(fx, {}); } catch (e) { log.push(`reprocess ${fx.id} failed: ${e.message}`); }
    }
    const { rows: rem } = await query(
      `SELECT count(*)::int AS n FROM fixtures WHERE gw_id=$1 AND NOT (finished AND stats_applied)`, [gw]);
    await finishGw(gw, { bonus: rem[0].n === 0 });
    log.push(`gw${gw} re-finished (bonus: ${rem[0].n === 0})`);
  }
  return { fixed, dups, playersMoved, linksCleared, gws: [...affectedGws], log: log.slice(0, 40) };
}

module.exports = { repairAll };
