'use strict';
const { query } = require('./db');
const C = require('./config').leetcode;

/*
 * Transfers with FPL rules:
 * - 2 free transfers per GW; saving up to 5 (banked). >2 used => -4 each.
 * - Deadline: cannot change squad for a GW whose deadline has passed.
 * - Player prices move ±0.1 per rise/fall threshold trigger, sell-on-value:
 *   selling price = price paid + half of any rise (rounded down, in 0.1 units).
 */

function toUnits(price) { return Math.round(price * 10); }
function fromUnits(u) { return Math.round(u) / 10; }

async function getEntry(entryId) {
  const { rows } = await query(`SELECT * FROM entries WHERE id=$1`, [entryId]);
  return rows[0] || null;
}

async function getBank(entryId) {
  const e = await getEntry(entryId);
  return e ? e.bank : 0;
}

async function setBank(entryId, bankUnits) {
  await query(`UPDATE entries SET bank=$1 WHERE id=$2`, [fromUnits(bankUnits), entryId]);
}

async function purchasesMap(entryId) {
  const { rows } = await query(
    `SELECT player_id, price FROM transfers WHERE entry_id=$1 AND player_in IS NOT NULL`,
    [entryId]);
  const m = {};
  for (const r of rows) m[r.player_id] = r.price;
  return m;
}

function sellValue(buyPrice, currentPrice) {
  // FPL: if price rose since purchase, sell for buy + half the rise; if fell, sell at current.
  const buy = toUnits(buyPrice), cur = toUnits(currentPrice);
  if (cur >= buy) return fromUnits(buy + Math.floor((cur - buy) / 2));
  return fromUnits(cur);
}

async function freeTransfersFor(entryId, gwId) {
  // free = base 2 + banked (up to 5), 0 in wildcard/freehit gw
  const { rows } = await query(
    `SELECT count(*)::int AS used FROM transfers WHERE entry_id=$1 AND gw_id=$2 AND cost=0`,
    [entryId, gwId]);
  const chips = await query(`SELECT chip FROM chips WHERE entry_id=$1 AND gw_id=$2`, [entryId, gwId]);
  const chip = chips.rows.map(r => r.chip);
  if (chip.includes('wildcard') || chip.includes('freehit')) return { free: 15, base: 15 };
  // banked: compute from previous gws' unused frees, cap 5
  const { rows: hist } = await query(
    `SELECT gw_id, count(*)::int AS used FROM transfers
     WHERE entry_id=$1 AND cost=0 AND gw_id<$2 GROUP BY gw_id ORDER BY gw_id`,
    [entryId, gwId]);
  let banked = 0;
  const histMap = {};
  for (const h of hist) histMap[h.gw_id] = h.used;
  const { rows: gws } = await query(`SELECT id FROM gameweeks WHERE id<$1 AND id>1 ORDER BY id`, [gwId]);
  for (const g of gws) {
    banked = Math.min(5, banked + C.freeTransfers - (histMap[g.id] || 0));
    if (banked < 0) banked = 0;
  }
  const free = Math.min(5, banked + C.freeTransfers);
  return { free, base: C.freeTransfers };
}

async function transferCount(entryId, gwId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM transfers WHERE entry_id=$1 AND gw_id=$2`, [entryId, gwId]);
  return rows[0].n;
}

module.exports = { toUnits, fromUnits, sellValue, getEntry, getBank, setBank, purchasesMap, freeTransfersFor, transferCount, CHIPS: C };
