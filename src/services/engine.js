'use strict';
const { query, tx } = require('../db');
const { scoreFixture } = require('./scoring');
const { gwTeamConceded } = require('./ingest/tsdb');
const { recomputeAllForGw, refreshRanks } = require('./entries');
const { updatePrices, logPrices } = require('./prices');
const { refreshGwFlags } = require('./gameweek');

/*
 * Finish a gameweek:
 * 1. Mark finished.
 * 2. Merge manual signals into stats_gw (idempotent full overwrite of given fields).
 * 3. Compute base + BPS points per player, assign bonus (top-3 BPS = 3/2/1).
 * 4. Freeze player points into `points` table.
 * 5. Recompute every entry's GW total (autosub + chips + captain).
 * 6. Refresh overall ranks, update price engine, log price history.
 */
async function finishGw(gwId) {
  await query(`UPDATE gameweeks SET is_finished=true WHERE id=$1`, [gwId]);

  const conceded = await gwTeamConceded(gwId);
  const { rows: players } = await query(`SELECT id, pos, club_id FROM players`);
  const playersById = {};
  for (const p of players) playersById[p.id] = p;
  const { rows: stats } = await query(`SELECT * FROM stats_gw WHERE gw_id=$1 AND minutes > 0`, [gwId]);

  const statsByPlayer = {};
  for (const s of stats) {
    statsByPlayer[s.player_id] = {
      minutes: s.minutes, goals: s.goals, assists: s.assists, saves: s.saves,
      pen_saved: s.pen_saved, pen_missed: s.pen_missed, yellow: s.yellow,
      red: s.red, own_goal: s.own_goal, pen_won: 0
    };
  }
  const scored = scoreFixture(statsByPlayer, conceded, playersById);

  const c = await tx(async client => {
    await client.query(`DELETE FROM points WHERE gw_id=$1`, [gwId]);
    for (const [pid, r] of Object.entries(scored)) {
      await client.query(
        `INSERT INTO points (entry_id, gw_id, player_id, pts, bps, minutes)
         VALUES (0,$1,$2,$3,$4,$5)`,
        [gwId, Number(pid), r.pts, r.bps, r.minutes]);
    }
    return Object.keys(scored).length;
  });

  await recomputeAllForGw(gwId);
  await updatePrices(gwId);
  await logPrices(gwId);
  await refreshRanks();
  await refreshGwFlags();
  return { playersScored: c, gwId };
}

async function upsertSignal(gwId, playerId, signalObj, adminId) {
  const allowed = ['minutes','goals','assists','saves','pen_saved','pen_missed','yellow','red','own_goal'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (signalObj[k] !== undefined) {
      sets.push(`${k} = $${vals.length + 1}`);
      vals.push(Number(signalObj[k]) || 0);
    }
  }
  if (!sets.length) throw new Error('empty signal');
  const n = vals.length;
  const all = [...vals, gwId, playerId];
  console.log('[signal] insert admin_signals', gwId, playerId);
  await query(
    `INSERT INTO admin_signals (gw_id, player_id, signal, created_by) VALUES ($1,$2,$3,$4)`,
    [gwId, playerId, JSON.stringify(signalObj), adminId]);
  console.log('[signal] upsert stats_gw');
  await query(
    `INSERT INTO stats_gw (gw_id, player_id) VALUES ($1, $2)
     ON CONFLICT (gw_id, player_id) DO NOTHING`,
    [gwId, playerId]);
  console.log('[signal] update stats_gw');
  await query(
    `UPDATE stats_gw SET ${sets.join(', ')} WHERE gw_id=$${n + 1} AND player_id=$${n + 2}`, all);
  console.log('[signal] done');
}

module.exports = { finishGw, upsertSignal };
