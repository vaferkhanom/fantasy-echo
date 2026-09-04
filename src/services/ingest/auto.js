'use strict';
/* Fully-automatic match-stats pipeline (deterministic, no manual entry):
 * varzesh3 JSON API -> structured events -> per-player stats -> validation -> scoring.
 * The LLM (NVIDIA NIM) is used ONLY for leftover name mapping (transliteration),
 * one small batched call per fixture when needed.
 */
const { query } = require('../../db');
const { chatJson } = require('./nim');
const v3 = require('./varzesh3');
const { finishGw } = require('../engine');

const CITY_WORDS = ['قزوین', 'اردکان', 'خوزستان', 'سیرجان', 'اراک', 'خرم‌آباد', 'خرم آباد', 'اهواز', 'انزلی', 'مازندران', 'قائم‌شهر', 'قائم شهر', 'تهران', 'تبریز', 'اصفهان', 'فولادشهر', 'شیراز', 'شهربابک', 'شهر بابک', 'آبادان', 'بندرانزلی', 'بندر انزلی'];

function normalizeFa(s) {
  return String(s || '').replace(/[\u200c\u200b]/g, '').replace(/ي/g, 'ی').replace(/ك/g, 'ک')
    .replace(/\s+/g, '').trim();
}
function stripCity(s) {
  let t = String(s || '').replace(/[\u200c]/g, ' ');
  for (const w of CITY_WORDS) t = t.replace(new RegExp(w, 'g'), ' ');
  return t.replace(/\s+/g, ' ').trim();
}
function teamMatch(a, b) {
  const x = stripCity(a), y = stripCity(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

const TIER_BASE = { GKP: 40, DEF: 40, MID: 45, FWD: 45 };
const TIER_BONUS = { 5: 10, 4: 5, 3: 0, 2: 0, 1: 0 };
function priceFor(tier, pos) {
  return ((TIER_BASE[pos] || 45) + (TIER_BONUS[tier] || 0)) / 10;
}
// position from formation line index
function posFromLine(lineIdx, lineCount) {
  if (lineIdx === 0) return 'GKP';
  if (lineIdx === lineCount - 1) return 'FWD';
  if (lineIdx === 1) return 'DEF';
  return 'MID';
}

/* ---- deterministic event parsing ---- */
function parseMatchDetail(d) {
  const per = {}; // v3pid -> {name, side, starter, minutes, goals, assists, yellow, red, own_goal, pen_missed, pen_saved, saves, portrait, pos}
  const ensure = (id, name, side) => {
    if (!per[id]) per[id] = {
      name, side, starter: false, minutes: 0, goals: 0, assists: 0,
      yellow: 0, red: 0, own_goal: 0, pen_missed: 0, pen_saved: 0, saves: 0,
      portrait: null, pos: null
    };
    return per[id];
  };
  for (const side of ['host', 'guest']) {
    const L = d.lineup && d.lineup[side];
    if (!L) continue;
    const lines = L.formationLines || [];
    lines.forEach((ln, li) => {
      for (const p of (ln.players || [])) {
        const r = ensure(p.id, p.name, side);
        r.starter = true; r.minutes = 90;
        r.portrait = p.portrait || null;
        r.pos = posFromLine(li, lines.length);
        if (p.isCaptain) r.captain = true;
        if (p.isManOfTheMatch) r.motm = true;
      }
    });
    for (const p of (L.benchedPlayers || [])) {
      const r = ensure(p.id, p.name, side);
      r.portrait = r.portrait || p.portrait || null;
    }
  }
  for (const e of (d.events || [])) {
    const t = e.rawTime != null ? Number(e.rawTime) : parseInt(e.time);
    if (e.eventType === 1) { // goal
      const desc = e.description || '';
      const isOG = /به خودی/.test(desc);
      const s = ensure(e.strikerId, e.strickerName, e.side === 0 ? 'host' : 'guest');
      if (isOG) s.own_goal += 1;
      else s.goals += 1;
      if (e.assisterId) {
        const a = ensure(e.assisterId, e.assisterName, e.side === 0 ? 'host' : 'guest');
        a.assists += 1;
      }
    } else if (e.eventType === 2) { // card
      const s = ensure(e.offendingPlayerId, e.offendingPlayerName, e.side === 0 ? 'host' : 'guest');
      if (Number(e.cardType) === 2) s.red += 1; else s.yellow += 1;
    } else if (e.eventType === 3) { // penalty
      const s = ensure(e.kickerId, e.kickerName, e.side === 0 ? 'host' : 'guest');
      if (Number(e.penaltyResult) === 1) s.goals += 1; // scored penalty
      else s.pen_missed += 1;
    } else if (e.eventType === 4) { // sub
      const off = ensure(e.outgoingPlayerId, e.outgoingPlayerName, e.side === 0 ? 'host' : 'guest');
      off.minutes = Math.min(90, t);
      const on = ensure(e.incomingPlayerId, e.incomingPlayerName, e.side === 0 ? 'host' : 'guest');
      on.minutes = Math.max(1, 90 - t);
    }
    // et5 (VAR/decision) ignored except already-counted goals
  }
  // normalize double-yellow -> 1 yellow + red (FPL treatment)
  for (const r of Object.values(per)) {
    if (r.yellow >= 2) { r.yellow = 1; r.red += 1; }
    if (r.red > 0 && r.minutes === 90) {
      // sent-off starter: keep 90? use card minute if known — events lack it here; keep simple
    }
  }
  // team saves -> goalkeepers by minutes
  try {
    const tot = (d.stats || []).find(s => /مجموع|کل/.test(s.title));
    const items = (tot && tot.stats.items) || [];
    const sv = items.find(i => /مهار/.test(i.title));
    if (sv) {
      const gks = { host: [], guest: [] };
      for (const [id, r] of Object.entries(per)) {
        if (r.pos === 'GKP' && r.minutes > 0) gks[r.side].push({ id, r });
      }
      const side2 = { host: Number(sv.hostValue) || 0, guest: Number(sv.guestValue) || 0 };
      for (const side of ['host', 'guest']) {
        const list = gks[side];
        const totalMin = list.reduce((s, x) => s + x.r.minutes, 0) || 1;
        let assigned = 0;
        list.forEach((x, i) => {
          const share = i === list.length - 1
            ? side2[side] - assigned
            : Math.round((side2[side] * x.r.minutes) / totalMin);
          x.r.saves = Math.max(0, share);
          assigned += x.r.saves;
        });
      }
    }
  } catch (_) {}
  return per;
}

/* ---- identity resolution ---- */
async function resolveIdentities(per, homeClub, awayClub) {
  // returns {mapped: {v3pid: playerId}, created: [{...}], unmatched: [...]}
  const { rows: roster } = await query(
    `SELECT id, club_id, fa_name, en_name, pos, v3id FROM players WHERE club_id=$1 OR club_id=$2`,
    [homeClub, awayClub]);
  const byV3 = {};
  for (const p of roster) if (p.v3id) byV3[p.v3id] = p.id;
  const normName = {};
  for (const p of roster) normName[p.id] = normalizeFa(p.fa_name);
  const mapped = {}, leftovers = [];
  for (const [v3id, r] of Object.entries(per)) {
    if (byV3[v3id]) { mapped[v3id] = byV3[v3id]; continue; }
    const n = normalizeFa(r.name);
    // exact / contains against same-side roster
    const cands = roster.filter(p =>
      (r.side === 'host' ? p.club_id === homeClub : p.club_id === awayClub));
    let hit = cands.find(p => normName[p.id] === n)
      || cands.find(p => normName[p.id] && (normName[p.id].includes(n) || n.includes(normName[p.id])));
    if (hit) {
      mapped[v3id] = hit.id;
      await query(`UPDATE players SET v3id=$1 WHERE id=$2`, [Number(v3id), hit.id]);
    } else {
      leftovers.push({ v3id, name: r.name, side: r.side, pos: r.pos, starter: r.starter });
    }
  }
  return { mapped, leftovers, roster };
}

async function mapLeftoversLLM(leftovers, homeClub, awayClub) {
  // one small batched call
  const { rows: roster } = await query(
    `SELECT id, club_id, fa_name, pos FROM players WHERE club_id=$1 OR club_id=$2`,
    [homeClub, awayClub]);
  const fmt = roster.map(p => `${p.id}|${p.club_id === homeClub ? 'H' : 'A'}|${p.fa_name}|${p.pos}`).join('\n');
  const names = leftovers.map(l => `${l.v3id}|${l.side === 'host' ? 'H' : 'A'}|${l.name}|${l.pos || '?'}|${l.starter ? 'starter' : 'bench'}`).join('\n');
  const sys = 'Persian football name matcher. Reply ONLY valid JSON.';
  const user = `Roster (id|side|name|pos):\n${fmt}\nReport names (v3id|side|name|guessedPos|starterOrBench):\n${names}\nMatch each report name to roster id by sound (transliteration varies). Reply {"map":[{"v3id":n,"id":n|null,"pos":"GKP"|"DEF"|"MID"|"FWD"}]}. Use null only if truly absent; pos = best position (use your football knowledge; starters: first lineup player is GK). ONLY JSON.`;
  const { chatJson } = require('./nim');
  const data = await chatJson(sys, user, { maxTokens: 2000 });
  const out = {};
  for (const m of (data.map || [])) {
    if (m.id) {
      out[m.v3id] = { id: m.id };
      await query(`UPDATE players SET v3id=$1 WHERE id=$2`, [Number(m.v3id), Number(m.id)]);
    } else {
      out[m.v3id] = { id: null, pos: m.pos };
    }
  }
  return out;
}

async function applyParsed(fx, per, homeClub, awayClub, sideOf, d) {
  const { mapped, leftovers } = await resolveIdentities(per, homeClub, awayClub);
  let llmMapped = {};
  if (leftovers.length) {
    try { llmMapped = await mapLeftoversLLM(leftovers, homeClub, awayClub); }
    catch (e) { llmMapped = {}; }
  }
  const { rows: clubs } = await query(`SELECT id, tier FROM clubs WHERE id=$1 OR id=$2`, [homeClub, awayClub]);
  const tier = {};
  for (const c of clubs) tier[c.id] = c.tier;
  let applied = 0;
  for (const [v3id, r] of Object.entries(per)) {
    let pid = mapped[v3id] || null;
    let llmPos = null;
    const lm = llmMapped[v3id];
    if (lm) {
      if (lm.id) pid = lm.id;
      else if (['GKP', 'DEF', 'MID', 'FWD'].includes(lm.pos)) llmPos = lm.pos;
    }
    if (!pid) {
      // auto-add unknown player
      const club = r.side === 'host' ? homeClub : awayClub;
      const pos = llmPos || (['GKP', 'DEF', 'MID', 'FWD'].includes(r.pos) ? r.pos : 'MID');
      const { rows } = await query(
        `INSERT INTO players (club_id, fa_name, pos, price, is_foreign, v3id, portrait)
         VALUES ($1,$2,$3,$4,false,$5,$6) RETURNING id`,
        [club, r.name, pos, priceFor(tier[club] || 3, pos), Number(v3id), r.portrait]);
      pid = rows[0].id;
    } else if (r.portrait) {
      await query(`UPDATE players SET portrait=COALESCE(portrait,$1) WHERE id=$2`, [r.portrait, pid]);
    }
    if (r.minutes <= 0 && !r.goals && !r.assists && !r.yellow && !r.red && !r.own_goal && !r.pen_missed && !r.pen_saved) continue;
    await query(
      `INSERT INTO stats_gw (gw_id, player_id) VALUES ($1,$2) ON CONFLICT (gw_id, player_id) DO NOTHING`,
      [fx.gw_id, pid]);
    await query(
      `UPDATE stats_gw SET minutes=$1, goals=$2, assists=$3, saves=$4, pen_saved=$5, pen_missed=$6, yellow=$7, red=$8, own_goal=$9
       WHERE gw_id=$10 AND player_id=$11`,
      [r.minutes, r.goals, r.assists, r.saves, r.pen_saved, r.pen_missed, r.yellow, r.red, r.own_goal, fx.gw_id, pid]);
    applied++;
  }
  await query(`UPDATE fixtures SET stats_applied=true, stats_source='auto-v3' WHERE id=$1`, [fx.id]);
  return { applied };
}

function validateParsed(fx, per, homeClub, awayClub, rosterClub) {
  // rosterClub: {playerId: clubId} + side map for new (from per side)
  let h = 0, a = 0;
  for (const [v3id, r] of Object.entries(per)) {
    const cid = (rosterClub[v3id] !== undefined) ? rosterClub[v3id]
      : (r.side === 'host' ? homeClub : awayClub);
    const isHome = cid === homeClub;
    if (r.own_goal) { if (isHome) a += r.own_goal; else h += r.own_goal; }
    else if (r.goals) { if (isHome) h += r.goals; else a += r.goals; }
  }
  return { ok: h === fx.home_goals && a === fx.away_goals, h, a };
}

async function findV3Match(fx, cmap, cache) {
  if (!cache.rounds) cache.rounds = await v3.resultsAll();
  for (const r of cache.rounds) {
    const m = String(r.round || '').match(/(\d+)/);
    if (!m || Number(m[1]) !== fx.gw_id) continue;
    for (const dg of (r.dates || [])) {
      for (const mt of (dg.matches || [])) {
        if (teamMatch(mt.host.name, cmap[fx.home_club]) && teamMatch(mt.guest.name, cmap[fx.away_club])) {
          return mt;
        }
      }
    }
  }
  return null;
}

async function processFixture(fx, cache = {}) {
  // fx: fixture row with home_club, away_club, gw_id, home_goals...
  // find v3 match id
  let v3id = fx.varzesh3_id;
  const { rows: cl } = await query(`SELECT id, fa_name FROM clubs WHERE id=$1 OR id=$2`, [fx.home_club, fx.away_club]);
  const cmap = {}; for (const c of cl) cmap[c.id] = c.fa_name;
  if (!v3id) {
    const mt = await findV3Match(fx, cmap, cache).catch(() => null);
    if (!mt) return { status: 'no-v3-match' };
    v3id = String(mt.id);
    await query(`UPDATE fixtures SET varzesh3_id=$1 WHERE id=$2`, [v3id, fx.id]);
    if (mt.goals && (fx.home_goals === null || fx.away_goals === null)) {
      await query(`UPDATE fixtures SET home_goals=$1, away_goals=$2, finished=true WHERE id=$3`,
        [mt.goals.host, mt.goals.guest, fx.id]);
      fx.home_goals = mt.goals.host; fx.away_goals = mt.goals.guest; fx.finished = true;
    }
  }
  if (fx.home_goals === null) return { status: 'no-score' };
  let d;
  try { d = await v3.matchDetail(v3id); }
  catch (e) { return { status: 'no-report' }; }
  if (!d || d.status !== 7 || !d.events) return { status: 'not-finished' };
  // adopt official score/teams data
  if (d.goals) {
    await query(`UPDATE fixtures SET home_goals=$1, away_goals=$2, finished=true WHERE id=$3`,
      [d.goals.host, d.goals.guest, fx.id]);
    fx.home_goals = d.goals.host; fx.away_goals = d.goals.guest;
  }
  // store club colors + v3 team ids
  for (const [side, club] of [['host', fx.home_club], ['away', fx.away_club]]) {
    const t = d[side];
    if (t) {
      await query(`UPDATE clubs SET v3id=COALESCE(v3id,$1), color1=COALESCE($2,color1) WHERE id=$3`,
        [String(t.id), t.style && t.style.backgroundColor, club]);
    }
  }
  const per = parseMatchDetail(d);
  // roster club map for validation
  const { rows: roster } = await query(
    `SELECT id, club_id, v3id FROM players WHERE club_id=$1 OR club_id=$2`, [fx.home_club, fx.away_club]);
  const rosterClub = {};
  for (const p of roster) { if (p.v3id) rosterClub[p.v3id] = p.club_id; }
  const v = validateParsed(fx, per, fx.home_club, fx.away_club, rosterClub);
  if (!v.ok) {
    await query(`UPDATE fixtures SET stats_source=$1 WHERE id=$2`,
      [`mismatch:H${v.h}/${fx.home_goals}-A${v.a}/${fx.away_goals}`, fx.id]);
    return { status: 'mismatch', notes: `H ${v.h}/${fx.home_goals} A ${v.a}/${fx.away_goals}` };
  }
  const r = await applyParsed(fx, per, fx.home_club, fx.away_club);
  const { rows: rem } = await query(
    `SELECT count(*)::int AS n FROM fixtures WHERE gw_id=$1 AND NOT (finished AND stats_applied)`, [fx.gw_id]);
  await finishGw(fx.gw_id, { bonus: rem[0].n === 0 });
  return { status: 'applied', applied: r.applied, bonus: rem[0].n === 0 };
}

async function pendingFixtures(limit = 10) {
  const { rows } = await query(
    `SELECT f.*, c1.fa_name AS home, c2.fa_name AS away
     FROM fixtures f JOIN clubs c1 ON c1.id=f.home_club JOIN clubs c2 ON c2.id=f.away_club
     WHERE NOT f.stats_applied AND (f.locked_at IS NULL OR f.locked_at < now() - interval '30 minutes')
       AND (f.finished OR (f.kickoff IS NOT NULL AND f.kickoff < now() - interval '2 hours'))
     ORDER BY f.kickoff NULLS LAST, f.id LIMIT $1`, [limit]);
  return rows;
}

let cycleRunning = false;
async function autoIngestCycle(limit = 2) {
  if (cycleRunning) return [{ status: 'already-running' }];
  cycleRunning = true;
  try {
    const work = await pendingFixtures(10);
    const cache = {};
    const results = [];
    for (const fx of work.slice(0, limit)) {
      try {
        await query(`UPDATE fixtures SET locked_at=now() WHERE id=$1`, [fx.id]);
        const r = await processFixture(fx, cache);
        results.push({ fixture: fx.id, gw: fx.gw_id, ...r });
      } catch (e) {
        results.push({ fixture: fx.id, gw: fx.gw_id, status: 'error', notes: (e && e.message || '').slice(0, 160) });
      }
    }
    return results;
  } finally {
    cycleRunning = false;
  }
}

module.exports = { autoIngestCycle, pendingFixtures, processFixture, normalizeFa, teamMatch, parseMatchDetail };
