'use strict';
const { query } = require('./db');
const C = require('./config').leetcode;
const { scoreFixture } = require('./scoring');
const { autoSubs, captainTimes, playersInGw } = require('./squad');
const { activeChips } = require('./chips');

/*
 * Recalculate points for a finished GW for one entry.
 * Applies: autosubs, chips (TC x2->x3 cap? FPL triple captain = x3; bboost: bench counts; freehit: pts count anyway).
 */
async function computeEntryGw(entryId, gwId) {
  const { rows: sq } = await query(
    `SELECT s.slot, s.player_id, s.is_captain, s.is_vice, p.pos, p.club_id
     FROM squads s JOIN players p ON p.id=s.player_id
     WHERE s.entry_id=$1 AND s.gw_id=$2`, [entryId, gwId]);
  if (!sq.length) return null;
  const chips = await activeChips(entryId, gwId);
  const minutes = await playersInGw(gwId);

  let picks = autoSubs(sq, minutes);
  const boost = chips.includes('bboost');
  const scoringPicks = boost ? picks : picks.filter(p => p.slot <= 11);

  const { capId, times } = captainTimes(picks.filter(p => p.slot <= 11), minutes);
  const multiplier = chips.includes('3xc') ? 3 : 2;

  const { rows: ptsRows } = await query(
    `SELECT player_id, pts FROM points WHERE gw_id=$1`, [gwId]);
  const ptsMap = {};
  for (const r of ptsRows) ptsMap[r.player_id] = r.pts;

  let total = 0;
  const detail = [];
  for (const p of scoringPicks) {
    let pt = ptsMap[p.player_id] || 0;
    let isCap = false;
    if (capId && p.player_id === capId && (minutes[p.player_id] || 0) > 0) {
      pt = (ptsMap[p.player_id] || 0) * multiplier;
      isCap = true;
    }
    total += pt;
    detail.push({ player_id: p.player_id, slot: p.slot, pts: pt, isCap, played: (minutes[p.player_id] || 0) > 0 });
  }
  return { total, detail };
}

async function recomputeAllForGw(gwId) {
  const { rows: entries } = await query(`SELECT id FROM entries`);
  const { rows: gw } = await query(`SELECT * FROM gameweeks WHERE id=$1`, [gwId]);
  if (!gw[0] || !gw[0].is_finished) return 0;
  let n = 0;
  for (const e of entries) {
    const res = await computeEntryGw(e.id, gwId);
    if (res) {
      await query(`UPDATE entries SET gw_points=$1 WHERE id=$2`, [res.total, e.id]);
      n++;
    }
  }
  await refreshRanks();
  return n;
}

async function refreshRanks() {
  await query(`
    WITH r AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY total_points DESC, gw_points DESC, id) AS rk
      FROM entries
    )
    UPDATE entries e SET overall_rank = r.rk FROM r WHERE r.id = e.id
  `);
}

module.exports = { computeEntryGw, recomputeAllForGw, refreshRanks };
