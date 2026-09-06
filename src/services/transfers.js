'use strict';
const { query } = require('../db');
const C = require('../config').leetcode;

/*
 * Transfers with strict FPL-style rules:
 * - 2 free transfers per GW, bankable up to 5 total. Each extra = -4 points.
 * - Wildcard / Free Hit for a GW = unlimited free transfers that week.
 * - Bank is derived (100 - squad cost), strict 100.0 budget.
 */

function toUnits(price) { return Math.round(Number(price) * 10); }
function fromUnits(u) { return Math.round(u) / 10; }

async function getEntry(entryId) {
  const { rows } = await query(`SELECT * FROM entries WHERE id=$1`, [entryId]);
  return rows[0] || null;
}

async function chipsFor(entryId, gwId) {
  const { rows } = await query(`SELECT chip FROM chips WHERE entry_id=$1 AND gw_id=$2`, [entryId, gwId]);
  return rows.map(r => r.chip);
}

/* Free-transfer allowance for gwId, computed from full history.
 * avail starts at 2 (gw1 = 2 free); each past gw: bank = min(3, max(0, avail - usedTotal)).
 * Returns {free, unlimited} where free = min(5, 2 + bank). */
async function freeAllowance(entryId, gwId) {
  const chips = await chipsFor(entryId, gwId);
  if (chips.includes('wildcard') || chips.includes('freehit')) {
    return { free: 99, unlimited: true, bank: 0 };
  }
  const { rows: hist } = await query(
    `SELECT gw_id, count(*)::int AS used FROM transfers
     WHERE entry_id=$1 AND gw_id<$2 GROUP BY gw_id`, [entryId, gwId]);
  const usedMap = {};
  for (const h of hist) usedMap[h.gw_id] = h.used;
  const { rows: gws } = await query(`SELECT id FROM gameweeks WHERE id<$1 ORDER BY id`, [gwId]);
  let bank = 0;
  for (const g of gws) {
    const avail = Math.min(5, C.freeTransfers + bank);
    const used = usedMap[g.id] || 0;
    bank = Math.min(3, Math.max(0, avail - used));
  }
  return { free: Math.min(5, C.freeTransfers + bank), unlimited: false, bank };
}

/* Latest finalized squad strictly before gwId (array of player_ids). */
async function previousSquad(entryId, gwId) {
  const { rows } = await query(
    `SELECT player_id FROM squads WHERE entry_id=$1 AND gw_id < $2
     AND gw_id = (SELECT MAX(gw_id) FROM squads WHERE entry_id=$1 AND gw_id < $2)`,
    [entryId, gwId]);
  return rows.map(r => r.player_id);
}

/* Record transfers for a new squad: diff vs previous GW squad.
 * Returns {made, free, hits, cost}. Throws nothing; callers validate budget first. */
async function recordTransfers(entryId, gwId, newIds) {
  const prev = await previousSquad(entryId, gwId);
  const prevSet = new Set(prev);
  const newSet = new Set(newIds);
  const ins = newIds.filter(id => !prevSet.has(id));
  const outs = prev.filter(id => !newSet.has(id));
  const n = Math.max(ins.length, outs.length);
  if (prev.length === 0 || n === 0) {
    // first squad ever, or no changes: clear + (re)record nothing
    await query(`DELETE FROM transfers WHERE entry_id=$1 AND gw_id=$2`, [entryId, gwId]);
    return { made: 0, free: 0, hits: 0, cost: 0 };
  }
  const { free, unlimited } = await freeAllowance(entryId, gwId);
  const freeN = unlimited ? n : Math.min(n, free);
  const hits = unlimited ? 0 : n - freeN;
  await query(`DELETE FROM transfers WHERE entry_id=$1 AND gw_id=$2`, [entryId, gwId]);
  const inS = [...ins].sort((a, b) => a - b);
  const outS = [...outs].sort((a, b) => a - b);
  for (let i = 0; i < n; i++) {
    const cost = i < freeN ? 0 : C.hitCost;
    await query(
      `INSERT INTO transfers (entry_id, gw_id, player_out, player_in, cost)
       VALUES ($1,$2,$3,$4,$5)`,
      [entryId, gwId, outS[i] ?? null, inS[i] ?? null, cost]);
  }
  return { made: n, free: freeN, hits, cost: hits * C.hitCost };
}

async function hitsFor(entryId, gwId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(cost),0)::int AS c FROM transfers WHERE entry_id=$1 AND gw_id=$2`,
    [entryId, gwId]);
  return rows[0].c;
}

async function transferCount(entryId, gwId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM transfers WHERE entry_id=$1 AND gw_id=$2`, [entryId, gwId]);
  return rows[0].n;
}

module.exports = {
  toUnits, fromUnits, getEntry, chipsFor, freeAllowance,
  previousSquad, recordTransfers, hitsFor, transferCount
};
