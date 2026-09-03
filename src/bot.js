'use strict';
/* Telegram bot: long polling (no webhook dependency), Persian UX. */
const cfg = require('../config');
const { query } = require('../db');
const { currentGw, nextGw } = require('../services/gameweek');
const { myLeagues, createLeague, joinByCode } = require('../services/leagues');
const { finishGw, upsertSignal } = require('../services/engine');
const { syncSeason, syncCurrent } = require('../services/ingest/tsdb');

const API = 'https://api.telegram.org/bot';
let offset = 0;
let running = false;

async function call(method, params = {}) {
  const res = await fetch(`${API}${cfg.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(70000)
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || 'tg error');
  return data.result;
}

function esc(s) { return String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function miniAppKeyboard(text) {
  return {
    keyboard: [[{ text, web_app: { url: cfg.appUrl } }]],
    resize_keyboard: true
  };
}

async function ensureUser(from) {
  const { rows } = await query(
    `INSERT INTO users (tg_id, username, first_name)
     VALUES ($1,$2,$3)
     ON CONFLICT (tg_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, updated_at=now()
     RETURNING id, tg_id, username, first_name`,
    [from.id, from.username || null, from.first_name || '']);
  const u = rows[0];
  const { rows: e } = await query(`SELECT id FROM entries WHERE user_id=$1`, [u.id]);
  if (!e[0]) {
    const teamName = (u.first_name || '').slice(0, 32) || 'بازیکن';
    const { rows: e2 } = await query(
      `INSERT INTO entries (user_id, team_name) VALUES ($1,$2) RETURNING id`,
      [u.id, `تیم ${teamName}`]);
    u.entry_id = e2[0].id;
  } else {
    u.entry_id = e[0].id;
  }
  return u;
}

function isAdmin(tgId) {
  if (cfg.adminIds.includes(String(tgId))) return true;
  return false;
}

const HELP_TEXT = `🏆 **echtasy** — فانتزی لیگ برتر خلیج فارس

دستورات:
/team — تیم من (مینی‌اپ)
/rank — رتبه من در لیدربورد
/leagues — لیگ‌های من
/join <کد> — عضویت در لیگ با کد
/fixtures — بازی‌های هفته جاری
/top — ۱۰ نفر برتر
/help — همین راهنما

⚖️ قوانین امتیازدهی (مطابق فانتزی پریمیرلیگ):
• حضور تا ۶۰ دقیقه: ۱ امتیاز | ۶۰ دقیقه کامل: ۲
• گل: دروازه‌بان/دفاع ۶، هافبک ۵، مهاجم ۴
• پاس گل: ۳ | کلین‌شیت: د/د ۴، هافبک ۱
• هر ۳ سیو دروازه‌بان: ۱ | مهار پنالتی: ۵
• هر ۲ گل خورده (د/د): ‎-۱ | اوت‌گل: ‎-۲
• زرد: ‎-۱ | قرمز: ‎-۳ | پنالتی از دست رفته: ‎-۲
• ستاره‌های زمین (BPS): ۳/۲/۱

⚽ سقف ۱۵ بازیکن، بودجه ۱۰۰ میلیون، حداکثر ۳ بازیکن از هر باشگاه، کاپیتان ×۲، چیپ‌ها: وایلدکارت، بن‌بوست، سه‌برابر، فری‌هیت.`;

async function onStart(msg) {
  const u = await ensureUser(msg.from);
  const name = esc(u.first_name || 'بازیکن');
  const gw = await currentGw();
  const gwName = gw ? `هفته ${gw.id}` : '';
  await call('sendMessage', {
    chat_id: msg.chat.id,
    text:
      `⚔️ **به **echtasy** خوش آمدی، ${name}!**\n\n` +
      `فانتزی‌فوتبال رسمی لیگ برتر خلیج فارس.\n` +
      `🏆 تیم بساز، از بازیکنان واقعی لیگ، با قیمت واقعی.\n` +
      `📈 امتیازها با نتایج واقعی هر هفته آپدیت می‌شود.\n` +
      `👥 لیگ بساز، کد بده، با بقیه بجنگ!\n` +
      (gwName ? `\n🔥 در حال حاضر: ${gwName}` : ''),
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎮 ورود به اپلیکیشن', web_app: { url: cfg.appUrl } }],
        [{ text: '📖 قوانین و امتیازدهی', callback_data: 'help' }]
      ]
    }
  });
}

async function onRank(msg) {
  const u = await ensureUser(msg.from);
  const { rows } = await query(`SELECT total_points, gw_points, overall_rank FROM entries WHERE id=$1`, [u.entry_id]);
  const { rows: cnt } = await query(`SELECT count(*)::int AS n FROM entries`);
  const e = rows[0] || {};
  await call('sendMessage', {
    chat_id: msg.chat.id,
    text: `📊 **رتبه تو:** ${e.overall_rank || '-'} از ${cnt[0].n}\n` +
          `🔥 امتیاز کل: **${e.total_points || 0}**\n` +
          `⚡ امتیاز هفته: **${e.gw_points || 0}**`,
    parse_mode: 'Markdown'
  });
}

async function onTop(msg) {
  const { rows } = await query(
    `SELECT e.team_name, e.total_points, u.first_name FROM entries e JOIN users u ON u.id=e.user_id
     ORDER BY e.total_points DESC LIMIT 10`);
  let t = '🏅 **لیدربورد — ۱۰ نفر برتر**\n\n';
  rows.forEach((r, i) => {
    t += `${i + 1}. ${esc(r.team_name || r.first_name)} — **${r.total_points}**\n`;
  });
  await call('sendMessage', { chat_id: msg.chat.id, text: t, parse_mode: 'Markdown' });
}

async function onFixtures(msg) {
  const gw = await currentGw() || await nextGw();
  if (!gw) return call('sendMessage', { chat_id: msg.chat.id, text: 'هفته‌ای فعال نیست.' });
  const { rows } = await query(
    `SELECT f.*, c1.fa_name AS h, c2.fa_name AS a FROM fixtures f
     JOIN clubs c1 ON c1.id=f.home_club JOIN clubs c2 ON c2.id=f.away_club
     WHERE f.gw_id=$1 ORDER BY f.kickoff`, [gw.id]);
  let t = `📅 **بازی‌های هفته ${gw.id}**\n\n`;
  for (const f of rows) {
    const sc = f.finished ? `**${f.home_goals}-${f.away_goals}**` : 'ساعت ' + (f.kickoff ? new Date(f.kickoff).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }) : '؟');
    t += `${esc(f.h)} ${sc} ${esc(f.a)}\n`;
  }
  await call('sendMessage', { chat_id: msg.chat.id, text: t, parse_mode: 'Markdown' });
}

async function onLeagues(msg) {
  const u = await ensureUser(msg.from);
  const list = await myLeagues(u.entry_id);
  let t = '👥 **لیگ‌های من**\n\n';
  if (!list.length) t += 'هنوز لیگی نداری. با /join <کد> عضو شو یا در مینی‌اپ بساز!\n';
  for (const l of list) t += `• ${esc(l.name)} — کد: \`${l.code}\` (${l.members} نفر)\n`;
  await call('sendMessage', { chat_id: msg.chat.id, text: t, parse_mode: 'Markdown' });
}

async function onJoin(msg, arg) {
  if (!arg) return call('sendMessage', { chat_id: msg.chat.id, text: 'استفاده: /join کد_لیگ' });
  const u = await ensureUser(msg.from);
  try {
    const l = await joinByCode(u.entry_id, arg.trim());
    await call('sendMessage', { chat_id: msg.chat.id, text: `✅ به لیگ «${esc(l.name)}» اضافه شدی!` });
  } catch (e) {
    await call('sendMessage', { chat_id: msg.chat.id, text: `❌ ${esc(e.message)}` });
  }
}

async function onNewLeague(msg, arg) {
  if (!arg) return call('sendMessage', { chat_id: msg.chat.id, text: 'استفاده: /newleague اسم_لیگ' });
  const u = await ensureUser(msg.from);
  const l = await createLeague(arg.slice(0, 40), u.id);
  await query(`INSERT INTO league_members (league_id, entry_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [l.id, u.entry_id]);
  await call('sendMessage', {
    chat_id: msg.chat.id,
    text: `🏟 لیگ «${esc(l.name)}» ساخته شد!\nکد دعوت: \`${l.code}\`\nاین کد را برای دوستانت بفرست تا با /join ${l.code} عضو شوند.`,
    parse_mode: 'Markdown'
  });
}

// ---- Admin ----
async function onAdmin(msg, arg) {
  if (!isAdmin(msg.from.id)) return;
  const [cmd, ...rest] = arg.split(' ');
  try {
    if (cmd === 'sync') {
      const r = await syncSeason();
      return reply(msg, `sync done: +${r.fixtures} new, ${r.updated} updated`);
    }
    if (cmd === 'finish') {
      const gw = Number(rest[0]);
      const r = await finishGw(gw);
      return reply(msg, `gw ${gw} finished, ${r.playersScored} players scored`);
    }
    if (cmd === 'stat') {
      // /admin stat <gw> <playerId> key=val key=val...
      const gw = Number(rest[0]), pid = Number(rest[1]);
      const obj = {};
      for (const kv of rest.slice(2)) {
        const [k, v] = kv.split('=');
        if (k) obj[k] = Number(v);
      }
      await upsertSignal(gw, pid, obj, msg.from.id);
      return reply(msg, `stat saved for player ${pid} in gw ${gw}`);
    }
    return reply(msg, 'admin cmds: sync | finish <gw> | stat <gw> <playerId> k=v ...');
  } catch (e) {
    return reply(msg, 'error: ' + esc(e.message));
  }
}

async function reply(msg, text) {
  await call('sendMessage', { chat_id: msg.chat.id, text });
}

// ---- dispatcher ----
async function handleUpdate(upd) {
  const msg = upd.message || upd.edited_message;
  if (msg && msg.text) {
    const text = msg.text.trim();
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase();
    if (cmd === '/start') return onStart(msg);
    if (cmd === '/help') return call('sendMessage', { chat_id: msg.chat.id, text: HELP_TEXT, parse_mode: 'Markdown' });
    if (cmd === '/team') return call('sendMessage', { chat_id: msg.chat.id, text: '🎮 تیم را در مینی‌اپ مدیریت کن:', reply_markup: miniAppKeyboard('باز کردن تیم') });
    if (cmd === '/rank') return onRank(msg);
    if (cmd === '/top') return onTop(msg);
    if (cmd === '/fixtures') return onFixtures(msg);
    if (cmd === '/leagues') return onLeagues(msg);
    if (cmd === '/join') return onJoin(msg, rest.join(' '));
    if (cmd === '/newleague') return onNewLeague(msg, rest.join(' '));
    if (cmd.startsWith('/admin')) return onAdmin(msg, rest.join(' '));
  }
  const cb = upd.callback_query;
  if (cb && cb.data === 'help') {
    await call('answerCallbackQuery', { callback_query_id: cb.id });
    return call('sendMessage', { chat_id: cb.message.chat.id, text: HELP_TEXT, parse_mode: 'Markdown' });
  }
}

async function pollOnce() {
  const updates = await call('getUpdates', {
    offset, timeout: 55, allowed_updates: ['message', 'callback_query']
  });
  for (const u of updates) {
    offset = u.update_id + 1;
    try { await handleUpdate(u); } catch (e) { /* keep polling */ }
  }
}

async function loop() {
  while (running) {
    try { await pollOnce(); }
    catch (e) { await new Promise(r => setTimeout(r, 3000)); }
  }
}

async function start() {
  if (!cfg.token) throw new Error('BOT_TOKEN missing');
  if (running) return;
  running = true;
  const me = await call('getMe');
  console.log(`bot online as @${me.username}`);
  // ensure commands are set
  await call('setMyCommands', {
    commands: [
      { command: 'start', description: 'شروع / ورود' },
      { command: 'team', description: 'تیم من' },
      { command: 'rank', description: 'رتبه من' },
      { command: 'top', description: 'برترین‌ها' },
      { command: 'fixtures', description: 'بازی‌های هفته' },
      { command: 'leagues', description: 'لیگ‌های من' },
      { command: 'join', description: 'عضویت با کد' },
      { command: 'newleague', description: 'ساخت لیگ' },
      { command: 'help', description: 'راهنما' }
    ]
  }).catch(() => {});
  loop();
}

module.exports = { start };
