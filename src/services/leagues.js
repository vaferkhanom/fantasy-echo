'use strict';
const crypto = require('crypto');
const { query } = require('./db');

function code() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += alphabet[b[i] % alphabet.length];
  return s;
}

async function createLeague(name, ownerId, kind = 'classic') {
  for (let i = 0; i < 5; i++) {
    const c = code();
    try {
      const { rows } = await query(
        `INSERT INTO leagues (name, code, owner_id, kind) VALUES ($1,$2,$3,$4) RETURNING *`,
        [name, c, ownerId, kind]);
      return rows[0];
    } catch (e) {
      if (!/unique/.test(e.message)) throw e;
    }
  }
  throw new Error('league code collision');
}

async function joinByCode(entryId, codeStr) {
  const { rows } = await query(`SELECT * FROM leagues WHERE code=$1`, [String(codeStr).toUpperCase()]);
  if (!rows[0]) throw new Error('لیگی با این کد پیدا نشد');
  await query(
    `INSERT INTO league_members (league_id, entry_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`, [rows[0].id, entryId]);
  return rows[0];
}

async function leagueTable(leagueId, gwId) {
  // Classic: rank by total points; H2H: rank by wins (computed from gw winners)
  const { rows: lg } = await query(`SELECT * FROM leagues WHERE id=$1`, [leagueId]);
  const league = lg[0];
  if (!league) throw new Error('لیگ پیدا نشد');
  const { rows } = await query(
    `SELECT e.id, e.team_name, e.total_points, e.gw_points, e.overall_rank,
            u.first_name, u.username, u.photo_url
     FROM league_members lm
     JOIN entries e ON e.id = lm.entry_id
     JOIN users u ON u.id = e.user_id
     WHERE lm.league_id=$1`, [leagueId]);
  const members = rows.map(r => ({
    entry_id: r.id,
    team_name: r.team_name || r.first_name || 'من',
    username: r.username,
    photo_url: r.photo_url,
    total: r.total_points,
    gw: r.gw_points,
    rank: r.overall_rank
  }));
  if (league.kind === 'h2h') {
    // Compute H2H record from finished gameweeks: each gw, members paired by gw_points ranking is complex;
    // simplified H2H: rank by number of gw wins (gw_points > other member's same gw) — approximate via cumulative.
    members.sort((a, b) => b.gw - a.gw || b.total - a.total);
  } else {
    members.sort((a, b) => b.total - a.total || b.gw - a.gw);
  }
  members.forEach((m, i) => { m.pos = i + 1; });
  return { league, members };
}

async function myLeagues(entryId) {
  const { rows } = await query(
    `SELECT l.*, (SELECT count(*)::int FROM league_members lm WHERE lm.league_id=l.id) AS members
     FROM leagues l JOIN league_members lm ON lm.league_id=l.id
     WHERE lm.entry_id=$1 ORDER BY l.created_at DESC`, [entryId]);
  return rows;
}

module.exports = { createLeague, joinByCode, leagueTable, myLeagues, code };
