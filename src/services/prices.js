'use strict';
const { query } = require('../db');
const C = require('../config').leetcode;
const { toUnits, fromUnits } = require('./transfers');

/*
 * Price engine (FPL-style):
 * - Ownership delta (buyers - sellers) since last price change triggers:
 *   >= +3 -> price +0.1 ; <= -3 -> price -0.1 (floor 4.0m, cap 140.0m).
 * - Max 3 rises per player per gameweek. Prices are stored in tenths (units of 0.1m).
 */
async function updatePrices(gwId) {
  // Current squads = latest gameweek each entry has squads for
  const { rows: owners } = await query(`
    SELECT s.player_id, count(DISTINCT s.entry_id)::int AS n
    FROM squads s
    JOIN (SELECT entry_id, MAX(gw_id) AS mg FROM squads GROUP BY entry_id) latest
      ON latest.entry_id = s.entry_id AND latest.mg = s.gw_id
    GROUP BY s.player_id`);
  const now = {};
  for (const r of owners) now[r.player_id] = r.n;

  // previous ownership snapshot stored as meta
  const { rows: meta } = await query(`SELECT value FROM meta WHERE key='ownership'`);
  const prevOwn = meta[0] ? JSON.parse(meta[0].value) : {};

  const { rows: players } = await query(`SELECT id, price FROM players`);
  const changes = [];
  const ups = [], downs = [];
  for (const p of players) {
    const cur = toUnits(Number(p.price));
    const nNow = now[p.id] || 0;
    const nPrev = prevOwn[p.id] || 0;
    const delta = nNow - nPrev;
    if (delta >= C.priceRiseThreshold) {
      const nu = Math.min(cur + C.priceDelta, 1400);
      if (nu !== cur) { ups.push(p.id); changes.push({ id: p.id, from: fromUnits(cur), to: fromUnits(nu) }); }
    } else if (delta <= -C.priceFallThreshold) {
      const nu = Math.max(cur - C.priceDelta, 40);
      if (nu !== cur) { downs.push(p.id); changes.push({ id: p.id, from: fromUnits(cur), to: fromUnits(nu) }); }
    }
  }
  if (ups.length) await query(`UPDATE players SET price = price + 0.1 WHERE id = ANY($1)`, [ups]);
  if (downs.length) await query(`UPDATE players SET price = price - 0.1 WHERE id = ANY($1) AND price > 4.0`, [downs]);
  await query(`
    INSERT INTO meta (key, value) VALUES ('ownership', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(now)]);
  return changes;
}

async function logPrices(gwId) {
  await query(`
    INSERT INTO price_hist (player_id, gw_id, price)
    SELECT id, $1, price FROM players
    ON CONFLICT (player_id, gw_id) DO UPDATE SET price=EXCLUDED.price`,
    [gwId]);
}

module.exports = { updatePrices, logPrices };
