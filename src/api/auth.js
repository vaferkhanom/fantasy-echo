'use strict';
const crypto = require('crypto');
const cfg = require('./config');
const { query } = require('./db');

/* Validate Telegram WebApp initData (HMAC-SHA256 per official docs). */
function validateInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(cfg.token).digest();
    const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (hmac !== hash) return null;
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Date.now() / 1000 - authDate > 86400) return null; // 24h validity
    const user = JSON.parse(params.get('user') || 'null');
    return user;
  } catch {
    return null;
  }
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', cfg.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  try {
    const [body, sig] = token.split('.');
    const expect = crypto.createHmac('sha256', cfg.sessionSecret).update(body).digest('base64url');
    if (sig !== expect || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (Date.now() - payload.iat > 7 * 86400 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

async function ensureUserAndEntry(tgUser) {
  const { rows } = await query(
    `INSERT INTO users (tg_id, username, first_name, photo_url)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tg_id) DO UPDATE SET username=EXCLUDED.username,
       first_name=EXCLUDED.first_name, photo_url=EXCLUDED.photo_url, updated_at=now()
     RETURNING *`,
    [tgUser.id, tgUser.username || null, tgUser.first_name || '', tgUser.photo_url || null]);
  const u = rows[0];
  let { rows: e } = await query(`SELECT * FROM entries WHERE user_id=$1`, [u.id]);
  if (!e[0]) {
    const teamName = `تیم ${(tgUser.first_name || 'بازیکن').slice(0, 30)}`;
    ({ rows: e } = await query(
      `INSERT INTO entries (user_id, team_name) VALUES ($1,$2) RETURNING *`, [u.id, teamName]));
  }
  const isAdmin = cfg.adminIds.includes(String(tgUser.id));
  return { user: u, entry: e[0], isAdmin };
}

function authMiddleware(req, res, next) {
  const initData = req.get('x-telegram-init-data') || '';
  const user = validateInitData(initData);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  ensureUserAndEntry(user)
    .then(({ user, entry, isAdmin }) => {
      req.user = user; req.entry = entry; req.isAdmin = isAdmin;
      next();
    })
    .catch(() => res.status(500).json({ error: 'auth failed' }));
}

module.exports = { validateInitData, sign, verify, authMiddleware, ensureUserAndEntry };
