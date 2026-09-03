'use strict';
const { query, tx } = require('../db');
const clubs = require('./clubs');
const playersSeed = require('./players');

async function seedClubsAndPlayers() {
  const { rows } = await query(`SELECT count(*)::int AS n FROM clubs`);
  if (rows[0].n > 0) return false;
  await tx(async client => {
    const clubIds = {};
    for (const c of clubs) {
      const { rows: r } = await client.query(
        `INSERT INTO clubs (slug, fa_name, en_name, city, tier, tsdb_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [c.slug, c.fa_name, c.en_name, c.city, c.tier, c.tsdb_id]);
      clubIds[c.slug] = r[0].id;
    }
    for (const [slug, list] of Object.entries(playersSeed)) {
      for (const [fa, en, pos, price, isForeign] of list) {
        await client.query(
          `INSERT INTO players (club_id, fa_name, en_name, pos, price, is_foreign)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [clubIds[slug], fa, en, pos, price / 10, !!isForeign]);
      }
    }
  });
  return true;
}

module.exports = { seedClubsAndPlayers };
