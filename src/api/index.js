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
const { syncSeason, syncCurrent } = require('../services/ingest/tsdb');
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
  const { rows } = await query(`
    SELECT e.*, u.username, u.first_name, u.photo_url FROM entries e JOIN users u ON u.id=e.user_id WHERE e.id=$1
  `, [req.entry.id]);
  const { rows: owned } = await query(`
    SELECT s.player_id, s.slot, s.is_captain, s.is_vice, p.fa_name, p.en_name, p.pos, p.price, p.club_id, c.fa_name AS club
    FROM squads s JOIN players p ON p.id=s.player_id JOIN clubs c ON c.id=p.club_id
    WHERE s.entry_id=$1 AND s.gw_id=$2 ORDER BY s.slot`,
    [req.entry.id, gw ? gw.id : 1]);
  const { rows: lg } = await query(`SELECT count(*)::int AS n FROM league_members WHERE entry_id=$1`, [req.entry.id]);
  res.json({
    user: { id: req.user.tg_id, name: req.user.first_name, username: req.user.username, photo: req.user.photo_url },
    entry: rows[0],
    squad: owned,
    gw,
    leagues: lg[0].n,
    isAdmin: req.isAdmin,
    budget: { start: 100, bank: rows[0].bank }
  });
});

router.get('/players', async (req, res) => {
  const { rows } = await query(`
    SELECT p.*, c.fa_name AS club, c.tier
    FROM players p JOIN clubs c ON c.id=p.club_id ORDER BY p.price DESC`);
  res.json(rows);
});

router.get('/clubs', async (req, res) => {
  const { rows } = await query(`SELECT * FROM clubs ORDER BY tier, id`);
  res.json(rows);
});

// Save full squad (15 slots) for the NEXT (editable) gameweek
router.post('/squad', async (req, res) => {
  const gw = (await nextGw()) || (await currentGw());
  if (!gw) return res.status(400).json({ error: 'no active gameweek' });
  const { slots, teamName } = req.body;
  // slots: [{player_id, slot 1..15, is_captain, is_vice}]
  const { rows: players } = await query(`SELECT id, pos, club_id, price FROM players`);
  const byId = {};
  for (const p of players) byId[p.id] = p;
  const ids = slots.map(s => s.player_id);
  if (new Set(ids).size !== 15) return res.status(400).json({ error: 'دقیقاً ۱۵ بازیکن لازم است' });
  if (!squadOk(ids, byId)) return res.status(400).json({ error: 'ترکیب سیمبل نامعتبر است (۲/۵/۵/۳ و حداکثر ۳ بازیکن از هر باشگاه)' });
  const starting = slots.filter(s => s.slot <= 11).map(s => byId[s.player_id].pos);
  if (!formationOk(starting)) return res.status(400).json({ error: 'ساختار زمین نامعتبر است' });
  const caps = slots.filter(s => s.is_captain).length;
  const vices = slots.filter(s => s.is_vice).length;
  if (caps !== 1 || vices !== 1) return res.status(400).json({ error: 'یک کاپیتان و یک نایب‌کاپیتان انتخاب کن' });
  const total = ids.reduce((s, id) => s + byId[id].price, 0);
  const bank = Math.round((req.entry.bank || 0) * 10);
  if (total > 1000 + bank) return res.status(400).json({ error: 'بودجه کافی نیست' });

  await tx(async client => {
    await client.query(`DELETE FROM squads WHERE entry_id=$1 AND gw_id=$2`, [req.entry.id, gw.id]);
    for (const s of slots) {
      await client.query(
        `INSERT INTO squads (entry_id, gw_id, player_id, slot, is_captain, is_vice) VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.entry.id, gw.id, s.player_id, s.slot, !!s.is_captain, !!s.is_vice]);
    }
    if (teamName) {
      await client.query(`UPDATE entries SET team_name=$1 WHERE id=$2`, [String(teamName).slice(0, 40), req.entry.id]);
    }
  });
  res.json({ ok: true });
});

// Chips
router.post('/chip', async (req, res) => {
  const gw = (await nextGw()) || (await currentGw());
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
    const t = await leagueTable(Number(req.params.id), null);
    res.json(t);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Leaderboard
router.get('/leaderboard', async (req, res) => {
  const { rows } = await query(`
    SELECT e.team_name, e.total_points, e.gw_points, e.overall_rank, u.first_name, u.username, u.photo_url
    FROM entries e JOIN users u ON u.id=e.user_id
    ORDER BY e.total_points DESC, e.gw_points DESC LIMIT 100`);
  res.json(rows);
});

// Fixtures + my gw history
router.get('/fixtures', async (req, res) => {
  const gwId = Number(req.params.gw) || (await currentGw())?.id || 1;
  const { rows } = await query(`
    SELECT f.*, c1.fa_name AS home, c1.en_name AS home_en, c2.fa_name AS away, c2.en_name AS away_en
    FROM fixtures f JOIN clubs c1 ON c1.id=f.home_club JOIN clubs c2 ON c2.id=f.away_club
    WHERE f.gw_id=$1 ORDER BY f.kickoff`, [gwId]);
  res.json({ gwId, fixtures: rows });
});

router.get('/my-points', async (req, res) => {
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
  res.json({ gwId, total: detail ? detail.total : 0, detail: detail ? detail.detail : [], players: rows });
});

// Admin
router.post('/admin/sync-season', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const r = await syncSeason();
  await refreshGwFlags();
  res.json(r);
});
router.post('/admin/finish-gw/:gw', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const r = await finishGw(Number(req.params.gw));
  res.json(r);
});
router.post('/admin/signal', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { gw, player_id, signal } = req.body;
  await upsertSignal(Number(gw), Number(player_id), signal, req.user.id);
  res.json({ ok: true });
});
router.get('/admin/queue', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const { rows } = await query(`
    SELECT p.id, p.fa_name, c.fa_name AS club, p.pos
    FROM players p JOIN clubs c ON c.id=p.club_id
    WHERE c.id IN (SELECT home_club FROM fixtures WHERE gw_id=$1 AND finished
                   UNION SELECT away_club FROM fixtures WHERE gw_id=$1 AND finished)
    ORDER BY c.id, p.pos`, [req.body.gw || 1]);
  res.json(rows);
});

module.exports = router;
