'use strict';
const { query } = require('./db');

/* Gameweek helpers. Current/next gameweek derived from fixtures. */

async function currentGw() {
  const { rows } = await query(
    `SELECT * FROM gameweeks WHERE is_current = true LIMIT 1`
  );
  return rows[0] || null;
}

async function nextGw() {
  const { rows } = await query(
    `SELECT * FROM gameweeks WHERE is_next = true LIMIT 1`
  );
  return rows[0] || null;
}

// Recompute current/next flags + deadline (deadline = earliest kickoff of gw)
async function refreshGwFlags() {
  await query(`UPDATE gameweeks SET is_current=false, is_next=false`);
  await query(`
    WITH agg AS (
      SELECT gw_id, MIN(kickoff) AS first_kick, MAX(kickoff) AS last_kick,
             COUNT(*) FILTER (WHERE finished) AS fin, COUNT(*) AS total
      FROM fixtures GROUP BY gw_id
    )
    UPDATE gameweeks g SET
      deadline = agg.first_kick,
      starts_at = agg.first_kick,
      ends_at = agg.last_kick + interval '3 hours',
      is_current = (agg.first_kick <= now() AND agg.last_kick + interval '3 hours' > now() AND agg.fin < agg.total),
      is_next = (agg.first_kick > now())
    FROM agg WHERE agg.gw_id = g.id
  `);
  // If nothing is current/next (e.g. between seasons), fallback: first unfished gw
  const { rows } = await query(`SELECT count(*)::int AS n FROM gameweeks WHERE is_current OR is_next`);
  if (rows[0].n === 0) {
    await query(`
      WITH nxt AS (
        SELECT g.id FROM gameweeks g JOIN fixtures f ON f.gw_id=g.id
        WHERE NOT f.finished GROUP BY g.id ORDER BY MIN(f.kickoff) LIMIT 1
      ) UPDATE gameweeks SET is_current=true WHERE id IN (SELECT id FROM nxt)
    `);
  }
}

module.exports = { currentGw, nextGw, refreshGwFlags };
