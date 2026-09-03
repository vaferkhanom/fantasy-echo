'use strict';
const { query, tx } = require('../../db');
const cfg = require('../../config');

const LEAGUE_ID = 4742; // Iranian Persian Gulf Pro League (TheSportsDB)
const BASE = 'https://www.thesportsdb.com/api/v1/json';

async function tsdb(path) {
  const url = `${BASE}/${cfg.tsdbKey}/${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`tsdb ${res.status}`);
  return res.json();
}

async function clubByTsdbId(id) {
  const { rows } = await query(`SELECT id FROM clubs WHERE tsdb_id=$1`, [String(id)]);
  return rows[0] || null;
}

async function ensureGw(gwId) {
  await query(
    `INSERT INTO gameweeks (id, name) VALUES ($1,$2)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [gwId, `هفته ${gwId}`]);
}

/* Sync N rounds (current +/- window). Free tier returns up to 5 events per call;
 * we call per-round so coverage is complete. */
async function syncRounds(rounds) {
  let fixtures = 0, updated = 0;
  for (const r of rounds) {
    let data;
    try {
      data = await tsdb(`eventsround.php?id=${LEAGUE_ID}&r=${r}&s=2026-2027`);
    } catch (e) {
      continue;
    }
    const events = data.events || [];
    if (!events.length) continue;
    await ensureGw(r);
    for (const ev of events) {
      const home = await clubByTsdbId(ev.idHomeTeam);
      const away = await clubByTsdbId(ev.idAwayTeam);
      if (!home || !away) continue;
      const kickoff = ev.strTimestamp ? new Date(ev.strTimestamp + 'Z') : null;
      const finished = ev.strStatus === 'FT' || (ev.intHomeScore !== null && ev.intAwayScore !== null && ev.strPostponed !== 'yes');
      const { rowCount } = await query(
        `INSERT INTO fixtures (gw_id, tsdb_event_id, home_club, away_club, kickoff, home_goals, away_goals, finished, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'tsdb')
         ON CONFLICT (tsdb_event_id) DO UPDATE SET
           home_goals=EXCLUDED.home_goals, away_goals=EXCLUDED.away_goals,
           finished=EXCLUDED.finished, kickoff=COALESCE(EXCLUDED.kickoff, fixtures.kickoff)
         RETURNING (xmax = 0) AS inserted`,
        [r, String(ev.idEvent), home.id, away.id, kickoff,
         ev.intHomeScore === null ? null : Number(ev.intHomeScore),
         ev.intAwayScore === null ? null : Number(ev.intAwayScore),
         finished && ev.strPostponed !== 'yes']);
      if (rowCount && rowCount[0] && rowCount[0].inserted) fixtures++; else updated++;
    }
  }
  return { fixtures, updated };
}

async function currentRoundWindow(span = 2) {
  const { rows } = await query(`
    SELECT COALESCE(MAX(gw_id),1) AS g FROM fixtures WHERE finished=false
      AND kickoff > now() - interval '3 hours'`);
  const cur = rows[0].g || 1;
  const list = [];
  for (let r = Math.max(1, cur - span); r <= cur + span; r++) list.push(r);
  return list;
}

async function syncCurrent() {
  const rounds = await currentRoundWindow(2);
  return syncRounds(rounds);
}

async function syncSeason() {
  const rounds = [];
  for (let r = 1; r <= 34; r++) rounds.push(r);
  return syncRounds(rounds);
}

// Derive team-level per-GW stats (conceded, clean sheet) from fixtures
async function gwTeamConceded(gwId) {
  const { rows } = await query(
    `SELECT home_club, away_club, home_goals, away_goals FROM fixtures
     WHERE gw_id=$1 AND finished AND home_goals IS NOT NULL`, [gwId]);
  const conceded = {};
  for (const f of rows) {
    conceded[f.home_club] = (conceded[f.home_club] || 0) + (f.away_goals || 0);
    conceded[f.away_club] = (conceded[f.away_club] || 0) + (f.home_goals || 0);
  }
  return conceded;
}

module.exports = { syncCurrent, syncSeason, syncRounds, gwTeamConceded, LEAGUE_ID };
