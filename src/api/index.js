'use strict';
const express = require('express');
const cfg = require('../config');
const { query, tx } = require('../db');
const { authMiddleware } = require('./auth');
const { currentGw, nextGw, refreshGwFlags } = require('../services/gameweek');
const { formationOk, squadOk } = require('../services/squad');
const { playChip, activeChips, chipUsed } = require('../services/chips');
const { createLeague, joinByCode, leagueTable, myLeagues } = require('../services/leagues');
const { computeEntryGw, refreshRanks } = require('../services/entries');
const { finishGw, upsertSignal } = require('../services/engine');
const { syncSeason, syncCurrent, syncRounds } = require('../services/ingest/tsdb');
const { toUnits, fromUnits, getEntry } = require('../services/transfers');

const router = express.Router();

// ---------- public (no auth) ----------
router.get('/boot', async (req, res) => {
  const gw = await currentGw();
  const nx = await nextGw();
  const { rows: cnt } = await query(`SELECT count(*)::int AS managers FROM entries`);
  const { rows: fx } = await query(`
    SELECT f.id, f.kickoff, c1.fa_name AS home, c2.fa_name AS away, f.home_goals, f.away_goals, f.finished
    FROM fixtures f JOIN clubs c1 ON c1.id=f.home_club JOIN clubs c2 ON c2.id=f.away_club
    WHERE f.finished ORDER BY f.kickoff DESC LIMIT 6`);
  res.json({ app: 'echtasy', gw, next: nx, managers: cnt[0].managers, latest: fx });
});

// ---------- authed ----------
router.use(authMiddleware);

router.get('/me', async (req, res) => {
  const gw = await currentGw();
  const editGw = (await nextGw()) || gw;
  const { rows } = await query(`
    SELECT e.*, u.username, u.first_name, u.photo_url FROM entries e JOIN users u ON u.id=e.user_id WHERE e.id=$1
  `, [req.entry.id]);
  const { rows: owned } = await query(`
    SELECT s.player_id, s.slot, s.is_captain, s.is_vice, p.fa_name, p.en_name, p.pos, p.price, p.club_id, c.fa_name AS club
    FROM squads s JOIN players p ON p.id=s.player_id JOIN clubs c ON c.id=p.club_id
    WHERE s.entry_id=$1 AND s.gw_id=$2 ORDER BY s.slot`,
    [req.entry.id, editGw ? editGw.id : (gw ? gw.id : 1)]);
  const { rows: lg } = await query(`SELECT count(*)::int AS n FROM league_members WHERE entry_id=$1`, [req.entry.id]);
  const { freeAllowance, transferCount, hitsFor } = require('../services/transfers');
  const allow = editGw ? await freeAllowance(req.entry.id, editGw.id).catch(() => ({ free: 2, unlimited: false, bank: 0 })) : { free: 2, unlimited: false, bank: 0 };
  const made = editGw ? await transferCount(req.entry.id, editGw.id).catch(() => 0) : 0;
  const hits = editGw ? await hitsFor(req.entry.id, editGw.id).catch(() => 0) : 0;
  const spent = owned.reduce((s, x) => s + Number(x.price), 0);
  res.json({
    user: { id: req.user.tg_id, name: req.user.first_name, username: req.user.username, photo: req.user.photo_url },
    entry: rows[0],
    squad: owned.map(s => ({ ...s, price: Number(s.price) })),
    squadGw: editGw ? editGw.id : null,
    gw,
    leagues: lg[0].n,
    isAdmin: req.isAdmin,
    budget: { start: 100, bank: Math.max(0, 100 - spent) },
    transfers: { free: allow.free, unlimited: !!allow.unlimited, made, hits, hitsCost: hits }
  });
});

router.get('/players', async (req, res) => {
  const { rows } = await query(`
    SELECT p.*, c.fa_name AS club, c.tier
    FROM players p JOIN clubs c ON c.id=p.club_id
    WHERE p.status='ok' ORDER BY p.price DESC`);
  res.json(rows.map(p => ({ ...p, price: Number(p.price) })));
});
router.post('/admin/verify', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { verifySquads, getVerifyStatus } = require('../services/ingest/verify');
  if (getVerifyStatus().running) return res.json({ started: false });
  verifySquads()
    .then(r => console.log('[verify] done, added:', r.added, 'moved:', r.moved, 'renamed:', r.renamed))
    .catch(e => console.log('[verify] error:', e && e.message));
  res.json({ started: true });
});
router.get('/admin/verify-status', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { getVerifyStatus } = require('../services/ingest/verify');
  res.json(getVerifyStatus());
});
router.get('/admin/export-seed', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { rows: clubs } = await query(`SELECT * FROM clubs ORDER BY id`);
  const { rows: players } = await query(
    `SELECT p.*, c.slug AS club_slug FROM players p JOIN clubs c ON c.id=p.club_id ORDER BY c.id, p.pos, p.fa_name`);
  res.json({ clubs, players: players.map(p => ({ ...p, price: Number(p.price) })) });
});
router.get('/admin/price-audit', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { rows } = await query(`
    SELECT p.id, p.fa_name, p.pos, p.price, p.club_id, c.fa_name AS club, c.tier,
      COALESCE(s.apps,0)::int AS apps, COALESCE(s.mins,0)::int AS mins,
      COALESCE(s.pts,0)::int AS pts
    FROM players p JOIN clubs c ON c.id=p.club_id
    LEFT JOIN (
      SELECT st.player_id,
        COUNT(*) FILTER (WHERE st.minutes > 0)::int AS apps,
        SUM(st.minutes)::int AS mins,
        SUM(COALESCE(pt.pts, 0))::int AS pts
      FROM stats_gw st LEFT JOIN points pt
        ON pt.entry_id=0 AND pt.gw_id=st.gw_id AND pt.player_id=st.player_id
      GROUP BY st.player_id
    ) s ON s.player_id=p.id
    WHERE p.status='ok' ORDER BY p.id`);
  res.json(rows.map(r => ({ ...r, price: Number(r.price) })));
});
router.post('/admin/prices-apply', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const list = Array.isArray(req.body.prices) ? req.body.prices : [];
  if (list.length > 2000) return res.status(400).json({ error: 'too many' });
  const gw = (await nextGw()) || (await currentGw());
  let n = 0;
  for (const it of list) {
    const price = Math.round(Number(it.price) * 10) / 10;
    if (!it.id || !(price >= 4 && price <= 14)) continue;
    await query(`UPDATE players SET price=$1 WHERE id=$2`, [price, Number(it.id)]);
    n++;
  }
  if (gw) {
    await query(`
      INSERT INTO price_hist (player_id, gw_id, price)
      SELECT id, $1, price FROM players
      ON CONFLICT (player_id, gw_id) DO UPDATE SET price=EXCLUDED.price`, [gw.id]);
  }
  res.json({ updated: n });
});

router.get('/clubs', async (req, res) => {
  const { rows } = await query(`SELECT * FROM clubs ORDER BY tier, id`);
  res.json(rows);
});

// Save full squad (15 slots) for the NEXT (editable) gameweek.
// Enforces: deadline lock, budget (numeric-safe), transfer accounting.
router.post('/squad', async (req, res) => {
  const gw = (await nextGw()) || (await currentGw());
  if (!gw) return res.status(400).json({ error: 'no active gameweek' });
  if (gw.deadline && new Date(gw.deadline).getTime() < Date.now()) {
    return res.status(403).json({ error: 'ددلاین این هفته گذشته است ⏳' });
  }
  const { slots, teamName } = req.body || {};
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'bad slots' });
  const { rows: players } = await query(`SELECT id, pos, club_id, price FROM players WHERE status='ok'`);
  const byId = {};
  for (const p of players) byId[p.id] = { ...p, price: Number(p.price) };
  const ids = slots.map(s => Number(s.player_id));
  if (ids.some(id => !byId[id])) return res.status(400).json({ error: 'بازیکن نامعتبر' });
  if (new Set(ids).size !== 15) return res.status(400).json({ error: 'دقیقاً ۱۵ بازیکن لازم است' });
  if (!squadOk(ids, byId)) return res.status(400).json({ error: 'ترکیب نامعتبر است (۲/۵/۵/۳ و حداکثر ۳ بازیکن از هر باشگاه)' });
  const slotNums = slots.map(s => Number(s.slot));
  if (new Set(slotNums).size !== 15 || slotNums.some(n => !(n >= 1 && n <= 15))) {
    return res.status(400).json({ error: 'شماره اسلات‌ها نامعتبر است' });
  }
  const starting = slots.filter(s => s.slot <= 11).map(s => byId[Number(s.player_id)].pos);
  if (starting.length !== 11 || !formationOk(starting)) return res.status(400).json({ error: 'ساختار زمین نامعتبر است' });
  const caps = slots.filter(s => s.is_captain).length;
  const vices = slots.filter(s => s.is_vice).length;
  if (caps !== 1 || vices !== 1) return res.status(400).json({ error: 'یک کاپیتان و یک نایب‌کاپیتان انتخاب کن' });
  const capSlot = slots.find(s => s.is_captain).slot;
  const viceSlot = slots.find(s => s.is_vice).slot;
  if (capSlot > 11 || viceSlot > 11) return res.status(400).json({ error: 'کاپیتان باید در ترکیب اصلی باشد' });
  const total = ids.reduce((s, id) => s + byId[id].price, 0);
  if (total - 100 > 1e-9) return res.status(400).json({ error: `بودجه کافی نیست (${total.toFixed(1)} از ۱۰۰)` });

  await tx(async client => {
    await client.query(`DELETE FROM squads WHERE entry_id=$1 AND gw_id=$2`, [req.entry.id, gw.id]);
    for (const s of slots) {
      await client.query(
        `INSERT INTO squads (entry_id, gw_id, player_id, slot, is_captain, is_vice) VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.entry.id, gw.id, Number(s.player_id), Number(s.slot), !!s.is_captain, !!s.is_vice]);
    }
    if (teamName) {
      await client.query(`UPDATE entries SET team_name=$1 WHERE id=$2`, [String(teamName).slice(0, 40), req.entry.id]);
    }
  });
  const { recordTransfers } = require('../services/transfers');
  let tr = { made: 0, free: 0, hits: 0, cost: 0 };
  try { tr = await recordTransfers(req.entry.id, gw.id, ids); } catch (e) { /* non-fatal */ }
  res.json({ ok: true, transfers: tr });
});

// Chips (deadline-locked)
router.post('/chip', async (req, res) => {
  const gw = (await nextGw()) || (await currentGw());
  if (!gw) return res.status(400).json({ error: 'no active gameweek' });
  if (gw.deadline && new Date(gw.deadline).getTime() < Date.now()) {
    return res.status(403).json({ error: 'ددلاین این هفته گذشته است ⏳' });
  }
  try {
    await playChip(req.entry.id, gw.id, req.body.chip);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Leagues
router.post('/league', async (req, res) => {
  try {
    const l = await createLeague(String(req.body.name || 'لیگ من').slice(0, 40), req.user.id, req.body.kind === 'h2h' ? 'h2h' : 'classic');
    await query(`INSERT INTO league_members (league_id, entry_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [l.id, req.entry.id]);
    res.json(l);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/league/join', async (req, res) => {
  try {
    const l = await joinByCode(req.entry.id, req.body.code);
    res.json(l);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/leagues', async (req, res) => {
  res.json(await myLeagues(req.entry.id));
});

router.get('/league/:id', async (req, res) => {
  try {
    const { rows: mem } = await query(
      `SELECT 1 FROM league_members WHERE league_id=$1 AND entry_id=$2`, [Number(req.params.id), req.entry.id]);
    if (!mem[0] && !req.isAdmin) return res.status(403).json({ error: 'عضو این لیگ نیستی' });
    const t = await leagueTable(Number(req.params.id), null);
    res.json(t);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Leaderboard
router.get('/leaderboard', async (req, res) => {
  const { rows } = await query(`
    SELECT e.id AS entry_id, e.team_name, e.total_points, e.gw_points, e.overall_rank, u.first_name, u.username, u.photo_url
    FROM entries e JOIN users u ON u.id=e.user_id
    ORDER BY e.total_points DESC, e.gw_points DESC LIMIT 100`);
  res.json(rows);
});

// Fixtures + my gw history
async function fixturesHandler(req, res) {
  const gwId = Number(req.params.gw) || (await currentGw())?.id || 1;
  const { rows } = await query(`
    SELECT f.*, c1.fa_name AS home, c1.en_name AS home_en, c2.fa_name AS away, c2.en_name AS away_en
    FROM fixtures f JOIN clubs c1 ON c1.id=f.home_club JOIN clubs c2 ON c2.id=f.away_club
    WHERE f.gw_id=$1 ORDER BY f.kickoff`, [gwId]);
  res.json({ gwId, fixtures: rows });
}
router.get('/fixtures', fixturesHandler);
router.get('/fixtures/:gw', fixturesHandler);

async function myPointsHandler(req, res) {
  const gwId = Number(req.params.gw) || (await currentGw())?.id || 1;
  const detail = await computeEntryGw(req.entry.id, gwId);
  const { rows } = await query(`
    SELECT s.slot, s.player_id, p.fa_name, p.pos, c.fa_name AS club,
           COALESCE(pt.pts,0) AS pts, COALESCE(st.minutes,0) AS minutes,
           st.goals, st.assists, st.bonus
    FROM squads s
    JOIN players p ON p.id=s.player_id
    JOIN clubs c ON c.id=p.club_id
    LEFT JOIN points pt ON pt.entry_id=0 AND pt.gw_id=$2 AND pt.player_id=s.player_id
    LEFT JOIN stats_gw st ON st.gw_id=$2 AND st.player_id=s.player_id
    WHERE s.entry_id=$1 AND s.gw_id=$2 ORDER BY s.slot`,
    [req.entry.id, gwId]);
  res.json({ gwId, total: detail ? detail.total : 0, hits: detail ? detail.hits : 0, detail: detail ? detail.detail : [], players: rows });
}
router.get('/my-points', myPointsHandler);
router.get('/my-points/:gw', myPointsHandler);

// Admin
router.post('/admin/seed-data', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { seedClubsAndPlayers } = require('../seed');
  const seeded = await seedClubsAndPlayers();
  await refreshGwFlags();
  res.json({ seeded });
});
router.post('/admin/sync-rounds', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const from = Math.max(1, Number(req.body.from) || 1);
  const to = Math.min(34, Number(req.body.to) || from);
  const rounds = [];
  for (let r = from; r <= to; r++) rounds.push(r);
  const r = await syncRounds(rounds);
  await refreshGwFlags();
  res.json({ ...r, from, to });
});
router.post('/admin/bootstrap', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { seedClubsAndPlayers } = require('../seed');
  const seeded = await seedClubsAndPlayers();
  const r = await syncSeason();
  await refreshGwFlags();
  await refreshRanks();
  res.json({ seeded, ...r });
});
router.post('/admin/sync-season', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const r = await syncSeason();
  await refreshGwFlags();
  res.json(r);
});
router.post('/admin/sync-v3', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { syncV3Results } = require('../services/ingest/v3sync');
  const r = await syncV3Results();
  await refreshGwFlags();
  res.json(r);
});
router.post('/admin/repair', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { repairAllAsync, getRepairStatus } = require('../services/ingest/repair');
  const cur = getRepairStatus();
  if (cur.running) return res.json({ started: false, reason: 'already-running' });
  repairAllAsync()
    .then(r => console.log('[repair] done:', JSON.stringify(r).slice(0, 300)))
    .catch(e => console.log('[repair] error:', e && e.message));
  res.json({ started: true });
});
router.get('/admin/repair-status', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { getRepairStatus } = require('../services/ingest/repair');
  res.json(getRepairStatus());
});
router.post('/admin/finish-gw/:gw', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const r = await finishGw(Number(req.params.gw), { bonus: req.body.bonus !== false });
  res.json(r);
});
let ingestRunning = false;
router.post('/admin/auto-ingest', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  if (ingestRunning) return res.json({ started: false, reason: 'already-running' });
  ingestRunning = true;
  const { autoIngestCycle } = require('../services/ingest/auto');
  const limit = Math.min(9, Math.max(1, Number(req.body.limit) || 2));
  autoIngestCycle(limit)
    .then(r => console.log('[auto-ingest] done:', JSON.stringify(r).slice(0, 400)))
    .catch(e => console.log('[auto-ingest] error:', e && e.message))
    .finally(() => { ingestRunning = false; });
  res.json({ started: true, limit });
});
router.get('/admin/ingest-status', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { pendingFixtures } = require('../services/ingest/auto');
  const pend = await pendingFixtures(50);
  res.json({ running: ingestRunning, pending: pend.length });
});
router.get('/admin/pending', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { pendingFixtures } = require('../services/ingest/auto');
  res.json(await pendingFixtures(20));
});
router.post('/admin/signal', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { gw, player_id, signal } = req.body;
  await upsertSignal(Number(gw), Number(player_id), signal, req.user.id);
  res.json({ ok: true });
});
router.get('/admin/queue', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const gw = Number(req.query.gw) || (await currentGw())?.id || 1;
  const { rows } = await query(`
    SELECT p.id, p.fa_name, c.fa_name AS club, p.pos
    FROM players p JOIN clubs c ON c.id=p.club_id
    WHERE c.id IN (SELECT home_club FROM fixtures WHERE gw_id=$1 AND finished
                   UNION SELECT away_club FROM fixtures WHERE gw_id=$1 AND finished)
    ORDER BY c.id, p.pos`, [gw]);
  res.json(rows);
});

module.exports = router;
