'use strict';
const { query, tx } = require('../db');
const C = require('../config').leetcode;

function formationOk(lineup) {
  // lineup: array of slots 1..11 with pos
  const d = lineup.filter(p => p === 'DEF').length;
  const m = lineup.filter(p => p === 'MID').length;
  const f = lineup.filter(p => p === 'FWD').length;
  return d >= 3 && d <= 5 && m >= 2 && m <= 5 && f >= 1 && f <= 3 && d + m + f === 10;
}

function budgetOk(squad, prices, bank) {
  const total = squad.reduce((s, pid) => s + (prices[pid] || 0), 0);
  return { total, ok: total <= C.startBudget + bank };
}

// The 15-man squad with position quotas 2/5/5/3, <=3 per club
function squadOk(squad, playersById) {
  if (squad.length !== C.squadSize) return false;
  const posCount = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubCount = {};
  for (const pid of squad) {
    const p = playersById[pid];
    if (!p) return false;
    posCount[p.pos]++;
    clubCount[p.club_id] = (clubCount[p.club_id] || 0) + 1;
  }
  for (const k of Object.keys(posCount)) if (posCount[k] !== C.squad[k]) return false;
  for (const k of Object.keys(clubCount)) if (clubCount[k] > C.maxPerClub) return false;
  return true;
}

// Effective squad for a gw: squad rows + transfers applied for that gw
async function effectiveSquad(entryId, gwId) {
  const { rows } = await query(
    `SELECT s.slot, s.player_id, s.is_captain, s.is_vice, p.pos, p.club_id, p.price
     FROM squads s JOIN players p ON p.id = s.player_id
     WHERE s.entry_id=$1 AND s.gw_id=$2 ORDER BY s.slot`,
    [entryId, gwId]
  );
  return rows;
}

// InGW players (those with minutes>0 in stats)
async function playersInGw(gwId) {
  const { rows } = await query(
    `SELECT player_id, minutes FROM stats_gw WHERE gw_id=$1 AND minutes > 0`,
    [gwId]
  );
  const m = {};
  for (const r of rows) m[r.player_id] = r.minutes;
  return m;
}

/*
 * Automatic substitutions (FPL-style):
 * - GK sub: if starting GK didn't play and bench GK did -> swap (only one GK swap possible).
 * - Outfield subs: bench order 12,13,14,15; a bench player comes in if a starter blanked (0 min)
 *   and formation stays valid. Max 3 outfield autosubs.
 * Returns updated lineup array [{slot, player_id, pos, ...}] with playedOnly adjustments.
 */
function autoSubs(lineup, minutesMap) {
  // lineup: array of 15 objects {slot (1..11 starting), player_id, pos, is_captain}
  const starting = lineup.filter(p => p.slot <= 11).sort((a, b) => a.slot - b.slot);
  const bench = lineup.filter(p => p.slot > 11).sort((a, b) => a.slot - b.slot);
  const played = pid => (minutesMap[pid] || 0) > 0;

  // GK swap
  const startGk = starting.find(p => p.pos === 'GKP');
  const benchGk = bench.find(p => p.pos === 'GKP');
  if (startGk && benchGk && !played(startGk.player_id) && played(benchGk.player_id)) {
    startGk.slot = 12; benchGk.slot = startGk.slot === 12 ? 12 : 12; // placeholder, fix below
  }
  // simpler approach below rebuilds slots
  return autoSubsCore(lineup, minutesMap);
}

function autoSubsCore(lineup, minutesMap) {
  const players = lineup.map(p => ({ ...p }));
  const starting = players.filter(p => p.slot <= 11).sort((a, b) => a.slot - b.slot);
  const bench = players.filter(p => p.slot > 11).sort((a, b) => a.slot - b.slot);
  const played = pid => (minutesMap[pid] || 0) > 0;

  // GK swap
  const startGk = starting.find(p => p.pos === 'GKP');
  const benchGk = bench.find(p => p.pos === 'GKP');
  let gkSwapped = false;
  if (startGk && benchGk && !played(startGk.player_id) && played(benchGk.player_id)) {
    const t = startGk.slot; startGk.slot = benchGk.slot; benchGk.slot = t;
    gkSwapped = true;
  }

  // Outfield subs
  const outBench = bench.filter(p => p.pos !== 'GKP');
  let subsLeft = 3;
  for (const b of outBench) {
    if (subsLeft <= 0) break;
    if (!played(b.player_id)) continue;
    const blanked = starting.filter(s => s.pos !== 'GKP' && !played(s.player_id));
    if (!blanked.length) break;
    // try each blanked starter, check formation validity after swap
    let done = false;
    for (const s of blanked) {
      const trial = starting.map(x => (x.player_id === s.player_id ? { ...x, pos: b.pos } : x));
      if (formationOk(trial.map(x => x.pos))) {
        const t = s.slot; s.slot = b.slot; b.slot = t;
        subsLeft--; done = true;
        break;
      }
    }
    if (!done) break;
  }
  return players;
}

// Captain fallback: if captain blanked, vice; if both blanked, top-scoring starter? FPL: if vice also blanked, no double.
function captainTimes(pick, minutesMap) {
  const cap = pick.find(p => p.is_captain && p.slot <= 11);
  if (cap && (minutesMap[cap.player_id] || 0) > 0) return { capId: cap.player_id, times: 2 };
  const vice = pick.find(p => p.is_vice && p.slot <= 11);
  if (vice && (minutesMap[vice.player_id] || 0) > 0) return { capId: vice.player_id, times: 2 };
  return { capId: null, times: 1 };
}

module.exports = { formationOk, budgetOk, squadOk, effectiveSquad, playersInGw, autoSubs, captainTimes };
