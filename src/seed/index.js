'use strict';
const { query, tx } = require('../db');
const clubs = require('./clubs');
const playersSeed = require('./players');

async function seedClubsAndPlayers() {
  console.log('[seed] start');
  const { rows } = await query(`SELECT count(*)::int AS n FROM clubs`);
  console.log('[seed] clubs count =', rows[0].n);
  if (rows[0].n > 0) { await syncClubMeta(); return false; }
  await tx(async client => {
    const clubIds = {};
    for (const c of clubs) {
      const { rows: r } = await client.query(
        `INSERT INTO clubs (slug, fa_name, en_name, city, tier, tsdb_id, color1, color2)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [c.slug, c.fa_name, c.en_name, c.city, c.tier, c.tsdb_id, c.color1, c.color2]);
      clubIds[c.slug] = r[0].id;
    }
    console.log('[seed] clubs inserted');
    let n = 0;
    for (const [slug, list] of Object.entries(playersSeed)) {
      for (const [fa, en, pos, price, isForeign] of list) {
        await client.query(
          `INSERT INTO players (club_id, fa_name, en_name, pos, price, is_foreign)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [clubIds[slug], fa, en, pos, price / 10, !!isForeign]);
        n++;
      }
    }
    console.log('[seed] players inserted:', n);
  });
  console.log('[seed] done');
  return true;
}

/* Idempotent: refresh club meta (colors, tiers, names) on every run. */
async function syncClubMeta() {
  for (const c of clubs) {
    await query(
      `UPDATE clubs SET fa_name=$1, en_name=$2, city=$3, tier=$4, tsdb_id=COALESCE(tsdb_id,$5),
        color1=COALESCE(color1,$6), color2=COALESCE(color2,$7) WHERE slug=$8`,
      [c.fa_name, c.en_name, c.city, c.tier, c.tsdb_id, c.color1, c.color2, c.slug]);
  }
}

module.exports = { seedClubsAndPlayers, syncClubMeta };
