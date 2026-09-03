'use strict';
/* refresh fixtures on demand (used by cron or manually) */
const { ensureSchema } = require('../src/schema');
const { syncCurrent } = require('../src/services/ingest/tsdb');
const { refreshGwFlags } = require('../src/services/gameweek');
const { getPool } = require('../src/db');

(async () => {
  await ensureSchema();
  const r = await syncCurrent();
  await refreshGwFlags();
  console.log(`synced: +${r.fixtures} new, ${r.updated} updated`);
  await getPool().end();
})().catch(e => { console.error(e.message); process.exit(1); });
