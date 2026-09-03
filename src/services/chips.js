'use strict';
const { query } = require('../db');
const C = require('../config').leetcode;

const CHIPS = ['wildcard', 'freehit', 'bboost', '3xc'];
const CHIP_ONCE = { wildcard: 1, freehit: 1, bboost: 1, '3xc': 1 };

async function chipUsed(entryId, chip) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM chips WHERE entry_id=$1 AND chip=$2`, [entryId, chip]);
  return rows[0].n >= (CHIP_ONCE[chip] || 1);
}

async function playChip(entryId, gwId, chip) {
  if (!CHIPS.includes(chip)) throw new Error('چیپ نامعتبر است');
  if (await chipUsed(entryId, chip)) throw new Error('این چیپ قبلاً استفاده شده');
  await query(
    `INSERT INTO chips (entry_id, gw_id, chip) VALUES ($1,$2,$3)
     ON CONFLICT (entry_id, gw_id, chip) DO UPDATE SET chip = EXCLUDED.chip`,
    [entryId, gwId, chip]);
}

async function activeChips(entryId, gwId) {
  const { rows } = await query(
    `SELECT chip FROM chips WHERE entry_id=$1 AND gw_id=$2`, [entryId, gwId]);
  return rows.map(r => r.chip);
}

module.exports = { CHIPS, playChip, chipUsed, activeChips };
