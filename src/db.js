'use strict';
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL || '';
    const needsSsl = /sslmode=require/.test(url) || process.env.PGSSL === 'require';
    pool = new Pool({
      connectionString: url || undefined,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
      max: 10,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000
    });
    pool.on('error', () => {});
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function tx(fn) {
  const c = getPool();
  const client = await c.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '30s'`);
    await client.query(`SET LOCAL statement_timeout = '60s'`);
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, tx };
