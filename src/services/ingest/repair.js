'use strict';
/* Consistency repair (async, idempotent):
 * Phase 0: reconcile each round's fixture SET against official v3 results
 *          (adopt scores into unlinked rows, delete bogus rows, fix misassigned clubs).
 * Phase 1: fix players' clubs/links per match detail, re-extract stats, re-finish GWs.
 */
const { query } = require('../../db');
const v3 = require('./varzesh3');
const auto = require('./auto');
const { finishGw } = require('../engine');

let repairRunning = false;
let lastRepair = null;

async function reconcileRound(gw, truthMatches, log) {
  // truthMatches: [{v3id, home, away, gh, ga}]
  const { rows: ours } = await query(`SELECT * FROM fixtures WHERE gw_id=$1`, [gw]);
  const used = new Set();
  let adopted = 0, deleted = 0;
  for (const f of ours) {
    let t = truthMatches.find(m => m.v3id === String(f.varzesh3_id));
    if (!t) {
      t = truthMatches.find(m => !used.has(m.v3id) && m.home === f.home_club && m.away === f.away_club);
      if (t) {
        await query(`UPDATE fixtures SET varzesh3_id=$1, home_goals=$2, away_goals=$3, finished=true, locked_at=NULL WHERE id=$4`,
          [t.v3id, t.gh, t.ga, f.id]);
        used.add(t.v3id);
        adopted++;
        continue;
      }
      // never delete unfinished (future schedule) rows
      if (!f.finished) {
        log.push(`gw${gw}: keeping unfinished fixture ${f.id} (not in played truth)`);
        continue;
      }
      await query(`DELETE FROM fixtures WHERE id=$1`, [f.id]);
      log.push(`gw${gw}: deleted bogus fixture ${f.id}`);
      deleted++;
    } else {
      used.add(t.v3id);
    }
  }
  // missing truth matches -> adopt into unlinked same-club row or insert
  const { rows: ours2 } = await query(`SELECT id, varzesh3_id, home_club, away_club FROM fixtures WHERE gw_id=$1`, [gw]);
  const have = new Set(ours2.map(r => String(r.varzesh3_id)));
  let inserted = 0;
  for (const t of truthMatches) {
    if (have.has(t.v3id)) continue;
    const sameClubs = ours2.find(r => !r.varzesh3_id && r.home_club === t.home && r.away_club === t.away);
    if (sameClubs) {
      await query(`UPDATE fixtures SET varzesh3_id=$1, home_goals=$2, away_goals=$3, finished=true, locked_at=NULL WHERE id=$4`,
        [t.v3id, t.gh, t.ga, sameClubs.id]);
      adopted++;
    } else {
      try {
        await query(
          `INSERT INTO fixtures (gw_id, varzesh3_id, home_club, away_club, home_goals, away_goals, finished, source)
           VALUES ($1,$2,$3,$4,$5,$6,true,'v3')`,
          [gw, t.v3id, t.home, t.away, t.gh, t.ga]);
        inserted++;
      } catch (e) {
        if (!/duplicate|unique/.test(e.message)) throw e;
        log.push(`gw${gw}: skipped duplicate insert (${t.v3id})`);
      }
    }
  }
  return { adopted, deleted, inserted };
}

async function repairAllAsync() {
  if (repairRunning) return { started: false };
  repairRunning = true;
  const log = [];
  try {
    const { syncV3Results } = require('./v3sync');
    const sr = await syncV3Results().catch(e => ({ error: e.message }));
    log.push(`sync: ${JSON.stringify(sr).slice(0, 160)}`);

    const { rows: clubs } = await query(`SELECT id, fa_name, v3id FROM clubs`);
    const rounds = await v3.resultsAll();
    // authoritative v3teamId -> club (exact only)
    const teamClub = new Map();
  for (const r of rounds) {
    for (const dg of (r.dates || [])) {
      for (const mt of (dg.matches || [])) {
        for (const side of ['host', 'guest']) {
          const t = mt[side];
          const cid = auto.resolveClubId(t.name, clubs);
          if (cid) {
            teamClub.set(String(t.id), cid);
            if (clubs.find(c => c.id === cid).v3id !== String(t.id)) {
              await query(`UPDATE clubs SET v3id=$1 WHERE id=$2`, [String(t.id), cid]);
            }
          } else {
            log.push(`unmapped v3 team: ${t.name}`);
          }
        }
      }
    }
  }

    const affectedGws = new Set();
    for (const r of rounds) {
      try {
      const m = String(r.round || '').match(/(\d+)/);
      if (!m) continue;
      const gw = Number(m[1]);
      const truth = [];
      for (const dg of (r.dates || [])) {
        for (const mt of (dg.matches || [])) {
          const h = teamClub.get(String(mt.host.id));
          const a = teamClub.get(String(mt.guest.id));
          if (!h || !a) { log.push(`gw${gw}: unmapped teams ${mt.host.name}-${mt.guest.name}`); continue; }
          truth.push({
            v3id: String(mt.id), home: h, away: a,
            gh: mt.goals ? mt.goals.host : null, ga: mt.goals ? mt.goals.guest : null
          });
        }
      }
      const rr = await reconcileRound(gw, truth, log);
      if (rr.adopted || rr.deleted || rr.inserted) {
        log.push(`gw${gw}: adopted=${rr.adopted} deleted=${rr.deleted} inserted=${rr.inserted}`);
        affectedGws.add(gw);
      }
      // verify clubs of linked fixtures + repair players
      const { rows: linked } = await query(`SELECT * FROM fixtures WHERE gw_id=$1 AND varzesh3_id IS NOT NULL`, [gw]);
      for (const f of linked) {
        const t = truth.find(x => x.v3id === String(f.varzesh3_id));
        if (!t) continue;
        if (t.home !== f.home_club || t.away !== f.away_club) {
          log.push(`gw${gw}: fix fixture ${f.id} clubs (${f.home_club},${f.away_club})->(${t.home},${t.away})`);
          try {
            await fixFixtureClubs(f, t, log);
          } catch (e) {
            log.push(`gw${gw}: fix fixture ${f.id} failed: ${(e.message || '').slice(0, 120)}`);
            continue;
          }
          affectedGws.add(gw);
        }
      }
      } catch (e) {
        log.push(`round ${r.round} failed: ${(e.message || '').slice(0, 120)}`);
      }
    }

    for (const gw of [...affectedGws].sort((a, b) => a - b)) {
      const { rows: todo } = await query(
        `SELECT * FROM fixtures WHERE gw_id=$1 AND NOT stats_applied AND finished`, [gw]);
      for (const fx of todo) {
        try { await auto.processFixture(fx, {}); }
        catch (e) { log.push(`reprocess ${fx.id}: ${(e.message || '').slice(0, 100)}`); }
      }
      const { rows: rem } = await query(
        `SELECT count(*)::int AS n FROM fixtures WHERE gw_id=$1 AND NOT (finished AND stats_applied)`, [gw]);
      await finishGw(gw, { bonus: rem[0].n === 0 });
      log.push(`gw${gw} re-finished (bonus: ${rem[0].n === 0})`);
    }
    lastRepair = { ok: true, at: new Date().toISOString(), gws: [...affectedGws], log: log.slice(-40) };
  } catch (e) {
    lastRepair = { ok: false, error: (e.message || '').slice(0, 200) };
  } finally {
    repairRunning = false;
  }
  return lastRepair;
}

async function fixFixtureClubs(f, t, log) {
  // clear wrong person links + bogus stats, move players, fix fixture
  const d = await v3.matchDetail(f.varzesh3_id).catch(() => null);
  const correctClub = { host: t.home, guest: t.away };
  if (d && d.lineup) {
    const personSide = {};
    for (const side of ['host', 'guest']) {
      const L = d.lineup[side] || {};
      for (const ln of (L.formationLines || [])) {
        for (const p of (ln.players || [])) personSide[p.id] = side;
      }
      for (const p of (L.benchedPlayers || [])) personSide[p.id] = side;
    }
    for (const [pid3, side] of Object.entries(personSide)) {
      const { rows: linked } = await query(`SELECT id, club_id FROM players WHERE v3id=$1`, [Number(pid3)]);
      for (const pl of linked) {
        if (pl.club_id !== correctClub[side]) {
          await query(`UPDATE players SET v3id=NULL WHERE id=$1`, [pl.id]);
          await query(`DELETE FROM stats_gw WHERE gw_id=$1 AND player_id=$2`, [f.gw_id, pl.id]);
        }
      }
    }
    // move players that are linked correctly by person but sit in wrong club rows
    const { rows: allLinked } = await query(
      `SELECT id, club_id, v3id FROM players WHERE v3id IS NOT NULL AND (club_id=$1 OR club_id=$2)`,
      [f.home_club, f.away_club]);
    for (const pl of allLinked) {
      const side = personSide[pl.v3id];
      if (side && pl.club_id !== correctClub[side]) {
        await query(`UPDATE players SET club_id=$1 WHERE id=$2`, [correctClub[side], pl.id]);
      }
    }
  }
  // FIRST remove rows that would collide with the corrected clubs (unique constraint),
  // keeping the one that already has stats if any
  const { rows: rivals } = await query(
    `SELECT id, stats_applied FROM fixtures
     WHERE gw_id=$1 AND home_club=$2 AND away_club=$3 AND id<>$4`,
    [f.gw_id, t.home, t.away, f.id]);
  for (const rp of rivals) {
    if (!rp.stats_applied) {
      await query(`DELETE FROM fixtures WHERE id=$1`, [rp.id]);
      log.push(`fixture ${f.id}: deleted rival row ${rp.id} (no stats)`);
    } else {
      // rival has stats: merge by adopting its stats flag, then delete it
      await query(`DELETE FROM fixtures WHERE id=$1`, [rp.id]);
      log.push(`fixture ${f.id}: deleted rival row ${rp.id} (had stats; will re-extract)`);
    }
  }
  await query(
    `UPDATE fixtures SET home_club=$1, away_club=$2, home_goals=$3, away_goals=$4,
      finished=true, stats_applied=false, stats_source='repaired', locked_at=NULL WHERE id=$5`,
    [t.home, t.away, t.gh, t.ga, f.id]);
}

module.exports = { repairAllAsync, getRepairStatus: () => ({ running: repairRunning, last: lastRepair }) };
