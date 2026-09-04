'use strict';
const express = require('express');
const path = require('path');
const { ensureSchema } = require('./schema');
const cfg = require('./config');
const { query } = require('./db');
const { refreshGwFlags, currentGw, nextGw } = require('./services/gameweek');
const { syncCurrent } = require('./services/ingest/tsdb');
const { finishGw } = require('./services/engine');
const { refreshRanks } = require('./services/entries');
const cron = require('node-cron');
const bot = require('./bot');
const api = require('./api');

async function main() {
  await ensureSchema();
  try {
    const { syncClubMeta } = require('./seed');
    await syncClubMeta();
  } catch (_) {}
  await refreshGwFlags().catch(() => {});
  await refreshRanks().catch(() => {});

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

  // Scheduler: fixtures sync every 6h; auto stats ingest hourly (2 fixtures); score refresh hourly; flags nightly.
  cron.schedule('7 */6 * * *', () => {
    (async () => {
      try {
        const { syncV3Results } = require('./services/ingest/v3sync');
        await syncV3Results();
      } catch (_) {}
      try { await syncCurrent(); } catch (_) {}
      try { await refreshGwFlags(); } catch (_) {}
    })();
  });
  cron.schedule('23 * * * *', () => {
    try {
      const { autoIngestCycle } = require('./services/ingest/auto');
      autoIngestCycle(2).catch(() => {});
    } catch (e) { /* silent */ }
  });
  cron.schedule('11 * * * *', async () => {
    try {
      const gw = await currentGw();
      if (gw && gw.is_finished) await finishGw(gw.id);
      await refreshRanks();
    } catch (e) { /* silent */ }
  });
  cron.schedule('15 3 * * *', () => refreshGwFlags().catch(() => {}));

  app.listen(cfg.port, () => {
    console.log(`echtasy server listening on :${cfg.port}`);
  });

  // Start bot (long polling) — never crash the process on token issues
  bot.start().catch(err => {
    console.error('bot start failed:', err && err.message ? err.message : 'unknown');
  });

  process.on('unhandledRejection', () => {});
  process.on('uncaughtException', () => {});
}

main().catch(e => {
  console.error('fatal:', e && e.message ? e.message : e);
  process.exit(1);
});
