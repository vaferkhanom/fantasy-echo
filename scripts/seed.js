'use strict';
/* One-shot scripts: seed DB + sync season fixtures. Safe to re-run. */
const { ensureSchema } = require('../src/schema');
const { seedClubsAndPlayers } = require('../src/seed');
const { syncSeason } = require('../src/services/ingest/tsdb');
const { refreshGwFlags } = require('../src/services/gameweek');
const { refreshRanks } = require('../src/services/entries');
const { getPool } = require('../src/db');

(async () => {
  await ensureSchema();
  const seeded = await seedClubsAndPlayers();
  console.log(seeded ? 'clubs+players seeded' : 'seed skipped (already exists)');
  const r = await syncSeason();
  console.log(`fixtures synced: +${r.fixtures} new, ${r.updated} updated`);
  await refreshGwFlags();
  await refreshRanks();
  const { query } = require('../src/db');
  const { rows } = await query(`SELECT count(*)::int AS players FROM players`);
  const { rows: fx } = await query(`SELECT count(*)::int AS n FROM fixtures`);
  const { rows: gw } = await query(`SELECT count(*)::int AS n FROM gameweeks`);
  console.log(`players: ${rows[0].players}, fixtures: ${fx[0].n}, gameweeks: ${gw[0].n}`);
  await getPool().end();
})().catch(e => { console.error(e); process.exit(1); });
