'use strict';
/* Fully-automatic match-stats pipeline:
 * finished fixture -> varzesh3 match page -> NVIDIA NIM extracts player events
 * -> validate vs scoreline -> write stats_gw (+auto-add unknown players) -> finish GW.
 * No manual entry required.
 */
const { query } = require('../../db');
const { chatJson } = require('./nim');
const v3 = require('./varzesh3');
const { finishGw } = require('../engine');

const CITY_WORDS = ['قزوین', 'اردکان', 'خوزستان', 'سیرجان', 'اراک', 'خرم‌آباد', 'خرم آباد', 'اهواز', 'انزلی', 'مازندران', 'قائم‌شهر', 'قائم شهر', 'تهران', 'تبریز', 'اصفهان', 'فولادشهر', 'شیراز', 'شهربابک', 'شهر بابک', 'آبادان', 'بندرانزلی', 'بندر انزلی'];

function normalizeFa(s) {
  let t = String(s || '').replace(/[\u200c\u200b]/g, ' ').replace(/ي/g, 'ی').replace(/ك/g, 'ک');
  for (const w of CITY_WORDS) t = t.replace(new RegExp(w, 'g'), ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function teamMatch(a, b) {
  const x = normalizeFa(a), y = normalizeFa(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

const TIER_BASE = { GKP: 40, DEF: 40, MID: 45, FWD: 45 };
const TIER_BONUS = { 5: 10, 4: 5, 3: 0, 2: 0, 1: 0 };

function priceFor(tier, pos) {
  return ((TIER_BASE[pos] || 45) + (TIER_BONUS[tier] || 0)) / 10;
}

const SYSTEM = `You are a precise football data extractor for the Iranian Persian Gulf Pro League. Reply with ONLY valid JSON, no other text. Never invent events. If info is absent, use 0 / null. Transliteration varies (e.g. خامروبکوف = همراه‌بکوف, اوستون = استون): match by sound, always prefer the given player_id.`;

function buildPrompt(fx, homeRoster, awayRoster, report) {
  const fmt = list => list.map(p => `${p.id}|${p.fa_name}|${p.en_name || ''}|${p.pos}`).join('\n');
  return `Match: ${fx.home} ${fx.home_goals} - ${fx.away_goals} ${fx.away} (week ${fx.gw_id})
Rosters (id|fa|en|pos):
HOME:
${fmt(homeRoster)}
AWAY:
${fmt(awayRoster)}
Report head: ${report.head}
Events: ${report.events}
Lineup: ${report.lineup}
Bench: ${report.bench}
Rules:
- Goal lines look like "N - M scorer - assister" (second name = assist). "گل رد شده" = disallowed, EXCLUDE.
- "(پنالتی)" = penalty goal, "(گل به خودی)" = own goal. Sub lines "X - Y" with NO score prefix = player ON - player OFF.
- Single-name lines with minute = card (yellow unless red stated). Starter with minute in lineup = subbed OFF at that minute. Bench with minute = subbed ON.
- Starter no minute = 90. Bench no minute = 0 (DNP). Red card: minutes = dismissal minute.
- A player appearing in the lineup section is starter:true even with a minute (that minute = subbed OFF). A bench player with a minute = subbed ON at that minute.
- own_goal ONLY when explicitly written (گل به خودی). Saves: credit team saves to goalkeepers proportionally by minutes (round to int); all other players saves=0.
- Team saves [home, away]: ${report.teamStats && report.teamStats.saves ? report.teamStats.saves.join(',') : 'unknown'}. Yellow/red totals [home, away]: ${report.teamStats && report.teamStats.yellow ? report.teamStats.yellow.join(',') + ' / ' + (report.teamStats.red || [0, 0]).join(',') : 'unknown'} (cross-check only).
- Output JSON: {"players":[{"player_id":int|null,"new_name":string|null,"new_pos":"GKP"|"DEF"|"MID"|"FWD"|null,"side":"home"|"away"|null,"starter":bool,"minutes":int,"goals":int,"assists":int,"yellow":int,"red":int,"own_goal":int,"pen_missed":int,"pen_saved":int,"saves":int}],"notes":string}
- Include EVERY person from events + all lineup starters + all bench players: anyone with minutes>0 plus unused bench (minutes 0, all zeros). Typical total ~28-32 entries. NEVER omit people.
- CRITICAL: every scorer/assister/card/sub name MUST appear in output either with the correct player_id (fa_name must sound the same) or as new_name. If unsure between two roster entries, choose new_name. Forcing a wrong player_id is the worst error.
- COUNT CHECK before replying: output MUST contain exactly 11 entries with starter:true per side (22 total). Bench entries cover the rest (~6-12 per side).
- Example: events "31' 1 - 0 عیسی مرادی - ابوذر صفرزاده" + lineup has مرادی starting, صفرزاده starting -> {"player_id":null,"new_name":"عیسی مرادی","side":"home","starter":true,"minutes":74,...,"goals":1} (if subbed at 74) and صفرزاده {"assists":1}. Event "74' علیرضا ملکی - عیسی مرادی" (no score) with ملکی on bench -> ملکی {"starter":false,"minutes":16}, مرادی minutes 74 (already counted). Event "81' وحید امیری" single name -> {"yellow":1} on امیری (who came on at 46).`;
}

async function extractForFixture(fx, report) {
  const { rows: roster } = await query(
    `SELECT id, club_id, fa_name, en_name, pos FROM players WHERE club_id=$1 OR club_id=$2`,
    [fx.home_club, fx.away_club]);
  const homeRoster = roster.filter(p => p.club_id === fx.home_club);
  const awayRoster = roster.filter(p => p.club_id === fx.away_club);
  const data = await chatJson(SYSTEM, buildPrompt(fx, homeRoster, awayRoster, report));
  if (!data || !Array.isArray(data.players)) throw new Error('bad extraction shape');
  // retry once with correction feedback on validation failure
  const v0 = validateGoals(fx, data, roster);
  if (!v0.ok) {
    const fix = await chatJson(SYSTEM,
      `Your previous output was WRONG: goal accounting is home ${v0.homeFor} vs ${v0.expH}, away ${v0.awayFor} vs ${v0.expA}. ` +
      `Recheck every goal line (score prefix "N - M"), disallowed goals (گل رد شده) must be excluded, own goals (گل به خودی) count for the OTHER side. ` +
      `Return the FULL corrected JSON for: ${fx.home} ${fx.home_goals}-${fx.away_goals} ${fx.away}. Report events: ${report.events.slice(0, 2500)}`);
    if (fix && Array.isArray(fix.players) && fix.players.length >= 20) {
      fix.notes = (fix.notes || '') + ' [retry]';
      return { data: fix, roster };
    }
  }
  return { data, roster };
}

function validateGoals(fx, data, roster) {
  const byId = {};
  for (const p of roster) byId[p.id] = p;
  // map extracted to club
  let homeFor = 0, awayFor = 0;
  const clubOf = pl => {
    if (pl.player_id && byId[pl.player_id]) return byId[pl.player_id].club_id;
    if (pl.side === 'home') return fx.home_club;
    if (pl.side === 'away') return fx.away_club;
    return null;
  };
  // attach club by matching new players to side via starter lists is unreliable;
  // instead compute from mapped players only and allow unmatched-new goals tolerance of 0
  for (const pl of data.players) {
    const cid = clubOf(pl);
    if (!cid) continue;
    const isHome = cid === fx.home_club;
    if (pl.own_goal) { if (isHome) awayFor += pl.own_goal; else homeFor += pl.own_goal; }
    else if (pl.goals) { if (isHome) homeFor += pl.goals; else awayFor += pl.goals; }
  }
  return {
    ok: homeFor === fx.home_goals && awayFor === fx.away_goals,
    homeFor, awayFor, expH: fx.home_goals, expA: fx.away_goals
  };
}

async function applyExtraction(fx, data, roster) {
  const byName = {};
  for (const p of roster) byName[p.id] = p;
  const clubs = {};
  {
    const { rows } = await query(`SELECT id, tier FROM clubs WHERE id=$1 OR id=$2`, [fx.home_club, fx.away_club]);
    for (const c of rows) clubs[c.id] = c.tier;
  }
  // resolve ids (auto-add unknown, tagged to the correct side)
  for (const pl of data.players) {
    if (!pl.player_id && pl.new_name) {
      pl._club = pl.side === 'away' ? fx.away_club : fx.home_club;
      const { rows } = await query(
        `INSERT INTO players (club_id, fa_name, pos, price, is_foreign)
         VALUES ($1,$2,$3,$4,false) RETURNING id`,
        [pl._club, pl.new_name, ['GKP', 'DEF', 'MID', 'FWD'].includes(pl.new_pos) ? pl.new_pos : 'MID',
         priceFor(clubs[pl._club] || 3, pl.new_pos)]);
      pl.player_id = rows[0].id;
    }
  }
  const allowed = ['minutes', 'goals', 'assists', 'saves', 'pen_saved', 'pen_missed', 'yellow', 'red', 'own_goal'];
  for (const pl of data.players) {
    if (!pl.player_id) continue;
    const sets = [], vals = [];
    for (const k of allowed) {
      sets.push(`${k} = $${vals.length + 1}`);
      vals.push(Number(pl[k]) || 0);
    }
    const all = [...vals, fx.gw_id, pl.player_id];
    const n = vals.length;
    await query(
      `INSERT INTO stats_gw (gw_id, player_id) VALUES ($1,$2) ON CONFLICT (gw_id, player_id) DO NOTHING`,
      [fx.gw_id, pl.player_id]);
    await query(
      `UPDATE stats_gw SET ${sets.join(', ')} WHERE gw_id=$${n + 1} AND player_id=$${n + 2}`, all);
  }
  await query(
    `UPDATE fixtures SET stats_applied=true, stats_source='auto-v3+nim' WHERE id=$1`, [fx.id]);
}

/* One fixture end-to-end. Returns {status} */
async function processFixture(fx, v3cache) {
  const { rows: cl } = await query(`SELECT id, fa_name FROM clubs WHERE id=$1 OR id=$2`, [fx.home_club, fx.away_club]);
  const cmap = {};
  for (const c of cl) cmap[c.id] = c.fa_name;
  const home = cmap[fx.home_club], away = cmap[fx.away_club];
  if (!v3cache.list) v3cache.list = await v3.leagueMatches();
  const cand = v3cache.list.find(m =>
    (teamMatch(m.home, home) && teamMatch(m.away, away)));
  if (!cand) return { status: 'no-v3-match' };
  // adopt score if missing
  if ((fx.home_goals === null || fx.away_goals === null) && cand.scoreH !== null) {
    await query(`UPDATE fixtures SET home_goals=$1, away_goals=$2, finished=true WHERE id=$3`,
      [cand.scoreH, cand.scoreA, fx.id]);
    fx.home_goals = cand.scoreH; fx.away_goals = cand.scoreA; fx.finished = true;
  }
  if (fx.home_goals === null) return { status: 'no-score' };
  const report = await v3.matchReport(cand.path);
  if (!report || !report.events) return { status: 'no-report' };
  await query(`UPDATE fixtures SET varzesh3_id=$1 WHERE id=$2`, [cand.v3id, fx.id]);
  const { data, roster } = await extractForFixture(
    { ...fx, home, away }, report).catch(e => ({ err: e.message }));
  if (data && data.err) return { status: 'extract-failed', notes: data.err };
  // tag new players with club side using lineup text? keep simple: prompt already maps known; new default home (rare)
  const v = validateGoals({ ...fx, home_goals: fx.home_goals, away_goals: fx.away_goals }, data, roster);
  if (!v.ok) {
    await query(`UPDATE fixtures SET stats_source=$1 WHERE id=$2`,
      [`mismatch:H${v.homeFor}/${v.expH}-A${v.awayFor}/${v.expA} ${(data.notes || '').slice(0, 120)}`, fx.id]);
    return { status: 'mismatch', notes: `H ${v.homeFor}/${v.expH} A ${v.awayFor}/${v.expA}` };
  }
  await applyExtraction(fx, data, roster);
  // finish gw with bonus only when whole round is applied
  const { rows: rem } = await query(
    `SELECT count(*)::int AS n FROM fixtures WHERE gw_id=$1 AND NOT (finished AND stats_applied)`, [fx.gw_id]);
  await finishGw(fx.gw_id, { bonus: rem[0].n === 0 });
  return { status: 'applied', bonus: rem[0].n === 0 };
}

async function pendingFixtures(limit = 10) {
  const { rows } = await query(
    `SELECT f.*, c1.fa_name AS home, c2.fa_name AS away
     FROM fixtures f JOIN clubs c1 ON c1.id=f.home_club JOIN clubs c2 ON c2.id=f.away_club
     WHERE NOT f.stats_applied AND (f.finished OR (f.kickoff IS NOT NULL AND f.kickoff < now() - interval '2 hours'))
     ORDER BY f.kickoff NULLS LAST, f.id LIMIT $1`, [limit]);
  return rows;
}

async function autoIngestCycle(limit = 2) {
  const work = await pendingFixtures(10);
  const v3cache = {};
  const results = [];
  for (const fx of work.slice(0, limit)) {
    try {
      // enrich fx with club names already selected
      const r = await processFixture(fx, v3cache);
      results.push({ fixture: fx.id, gw: fx.gw_id, ...r });
    } catch (e) {
      results.push({ fixture: fx.id, gw: fx.gw_id, status: 'error', notes: (e && e.message || '').slice(0, 160) });
    }
  }
  return results;
}

module.exports = { autoIngestCycle, pendingFixtures, processFixture, normalizeFa, teamMatch, buildPrompt };
