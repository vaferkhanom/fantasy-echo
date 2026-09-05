/* echtasy mini app — vanilla JS SPA */
const tg = window.Telegram?.WebApp;
const state = { me: null, players: [], clubs: [], draft: null, gw: null, clubsById: {} };
const FA_NUM = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const faNum = n => String(n).replace(/\d/g, d => FA_NUM[d]);
const money = p => faNum(Number(p).toFixed(1));
const posFa = { GKP: 'دروازه‌بان', DEF: 'دفاع', MID: 'هافبک', FWD: 'مهاجم' };
const posTag = { GKP: 'gkp', DEF: 'def', MID: 'mid', FWD: 'fwd' };
const POS_COLORS = { GKP: ['#7dd3fc', '#38bdf8'], DEF: ['#86efac', '#22c55e'], MID: ['#fde047', '#eab308'], FWD: ['#fca5a5', '#ef4444'] };

tg?.ready();
tg?.expand();
tg?.setHeaderColor('#05080a');
tg?.setBackgroundColor('#05080a');

/* ---------- helpers ---------- */
function haptic(kind = 'light') {
  try { tg?.HapticFeedback?.impactOccurred(kind); } catch {}
}
function lum(hex) {
  const h = String(hex || '#888888').replace('#', '');
  const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '8');
  const r = parseInt(f.slice(0, 2), 16) / 255, g = parseInt(f.slice(2, 4), 16) / 255, b = parseInt(f.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function kitStyle(p) {
  const c = state.clubsById[p.club_id];
  const c1 = (c && c.color1) || POS_COLORS[p.pos][0];
  const c2 = (c && c.color2) || POS_COLORS[p.pos][1];
  const dark = lum(c1) > 0.55;
  return `background:linear-gradient(160deg,${c1},${c2});color:${dark ? '#10140f' : '#fff'}`;
}
function avatar(p, cls = 'pl-ava') {
  const inner = p.portrait
    ? `<img src="${p.portrait}" alt="" loading="lazy" onerror="this.remove()">`
    : (p.pos || '').slice(0, 3);
  const bg = p.club_id && state.clubsById[p.club_id]
    ? `background:linear-gradient(135deg,${state.clubsById[p.club_id].color1},${state.clubsById[p.club_id].color2});color:${lum(state.clubsById[p.club_id].color1) > 0.55 ? '#10140f' : '#fff'}`
    : `background:linear-gradient(135deg,${POS_COLORS[p.pos][0]},${POS_COLORS[p.pos][1]})`;
  return `<span class="${cls}" style="${bg}">${inner}</span>`;
}
function jdate(iso, withWeekday = false) {
  try {
    const o = withWeekday
      ? { weekday: 'long', day: 'numeric', month: 'long' }
      : { day: 'numeric', month: 'long' };
    return new Date(iso).toLocaleDateString('fa-IR', { ...o, timeZone: 'Asia/Tehran' });
  } catch { return ''; }
}
function jtime(iso) {
  try { return new Date(iso).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }); }
  catch { return ''; }
}
function countUp(el, target, dur = 900) {
  if (!el) return;
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = faNum(Math.round(target * e));
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
async function renderTicker() {
  try {
    const boot = await api('/boot');
    const items = (boot.latest || []).map(f =>
      `<span class="tick-item">${f.home} <b>${faNum(f.home_goals)} - ${faNum(f.away_goals)}</b> ${f.away}</span>`
    ).join('<span class="tick-item">⚽</span>');
    if (!items) return;
    const t = document.getElementById('ticker');
    document.getElementById('ticker-track').innerHTML = items + items;
    t.classList.remove('hidden');
  } catch {}
}

function headers() {
  const h = { 'content-type': 'application/json' };
  if (tg?.initData) h['x-telegram-init-data'] = tg.initData;
  return h;
}
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { ...opts, headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'خطا در ارتباط با سرور');
  return data;
}
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2600);
}
function sheet(html) {
  const m = document.getElementById('modal');
  document.getElementById('sheet').innerHTML =
    `<div class="grab-row"><div class="grab"></div><button class="sheet-x" id="sheet-x" aria-label="بستن">✕</button></div>` + html;
  m.classList.remove('hidden');
  document.getElementById('sheet-x').onclick = () => { haptic(); closeSheet(); };
}
function closeSheet() { document.getElementById('modal').classList.add('hidden'); }
function backHtml(tab, label = 'بازگشت') {
  return `<button class="back-btn" data-back="${tab}"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>${label}</button>`;
}
function wireBack(root) {
  root.querySelectorAll('[data-back]').forEach(b => b.onclick = () => { haptic(); go(b.dataset.back); });
}
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeSheet(); });
function confetti(n = 40) {
  const colors = ['#f0b90b', '#ffdd57', '#22c55e', '#38bdf8', '#ef4444', '#ffffff'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = (1.6 + Math.random() * 1.6) + 's';
    c.style.animationDelay = Math.random() * .5 + 's';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 3800);
  }
}

/* ============ SPLASH ============ */
const BALL_SVG = `<svg class="ball" viewBox="0 0 100 100"><defs><radialGradient id="bg1" cx="35%" cy="30%"><stop offset="0%" stop-color="#fff"/><stop offset="70%" stop-color="#dfe5ec"/><stop offset="100%" stop-color="#9aa6b5"/></radialGradient></defs><circle cx="50" cy="50" r="44" fill="url(#bg1)"/><path d="M50 22 L66 34 L60 52 L40 52 L34 34 Z" fill="#0b0f16"/><path d="M50 22 L46 6 L56 6 Z" fill="#0b0f16"/><path d="M66 34 L82 28 L84 40 Z" fill="#0b0f16"/><path d="M60 52 L74 66 L64 72 Z" fill="#0b0f16"/><path d="M40 52 L26 66 L36 72 Z" fill="#0b0f16"/><path d="M34 34 L18 28 L16 40 Z" fill="#0b0f16"/></svg>`;

function renderSplash() {
  document.getElementById('view').innerHTML = `
    <div class="splash">
      ${BALL_SVG}
      <div class="logo">echtasy</div>
      <div class="tagline">فانتزی‌فوتبال لیگ برتر خلیج فارس<br>تیم رویایی‌ات را بساز و با کل ایران رقابت کن</div>
      <div class="feats"><span>⚽ بازیکنان واقعی</span><span>📈 امتیاز زنده</span><span>🏆 لیگ خصوصی</span></div>
      <button class="btn" id="btn-enter">شروع ماجراجویی 🚀</button>
    </div>`;
  document.getElementById('btn-enter').onclick = () => { haptic('medium'); go('home'); };
}

/* ============ HOME ============ */
async function renderHome() {
  const v = document.getElementById('view');
  v.innerHTML = `<div class="stat-grid">${'<div class="stat"><div class="v skel" style="height:24px"></div><div class="k">—</div></div>'.repeat(3)}</div><div class="card skel" style="height:120px"></div>`;
  const [boot, me] = await Promise.all([api('/boot'), api('/me').catch(() => null)]);
  state.me = me; state.gw = boot.gw;
  renderTicker();
  const hasSquad = me?.squad?.length === 15;
  const gwName = boot.gw ? `هفته ${faNum(boot.gw.id)}` : (boot.next ? `هفته ${faNum(boot.next.id)}` : 'پیش‌فصل');
  const gwBadge = document.getElementById('gw-badge');
  gwBadge.textContent = gwName;
  gwBadge.classList.remove('hidden');
  document.getElementById('btn-admin').classList.toggle('hidden', !me?.isAdmin);

  const rank = me?.entry?.overall_rank || 0;
  const managers = Math.max(boot.managers, 1);
  const ringPct = rank ? Math.max(0.06, 1 - (rank - 1) / managers) : 0;
  const C = 2 * Math.PI * 40;

  let deadline = '';
  if (boot.next?.deadline) {
    deadline = `<div class="card glow live-edge">
      <div class="eyebrow">ددلاین هفته ${faNum(boot.next.id)}</div>
      <div class="countdown" id="cd"></div>
      <div class="small faint" style="text-align:center;margin-top:10px">${jdate(boot.next.deadline, true)} ساعت ${jtime(boot.next.deadline)}</div>
    </div>`;
  }
  v.innerHTML = `
    ${deadline}
    <div class="card glow">
      <div class="hero-rank">
        <div class="ring pop">
          <svg width="92" height="92" viewBox="0 0 92 92">
            <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#ffe08a"/><stop offset="100%" stop-color="#f5c518"/>
            </linearGradient></defs>
            <circle class="track" cx="46" cy="46" r="40" fill="none" stroke-width="8"/>
            <circle class="val" cx="46" cy="46" r="40" fill="none" stroke-width="8"
              stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - ringPct)).toFixed(1)}"/>
          </svg>
          <div class="center"><b id="rank-num">${rank ? faNum(rank) : '—'}</b><span>رتبه تو</span></div>
        </div>
        <div style="flex:1">
          <div class="eyebrow">عملکرد</div>
          <div class="row" style="gap:18px">
            <div><div class="num gold-t" style="font-size:26px;font-weight:700" id="stat-total">0</div><div class="small muted">امتیاز کل</div></div>
            <div><div class="num" style="font-size:26px;font-weight:700" id="stat-gw">0</div><div class="small muted">هفته</div></div>
            <div><div class="num" style="font-size:26px;font-weight:700">${faNum(managers)}</div><div class="small muted">مدیر</div></div>
          </div>
        </div>
      </div>
      ${hasSquad
        ? `<button class="btn ghost" id="btn-myteam" style="margin-top:14px">مشاهده هفته من</button>`
        : `<button class="btn" id="btn-build" style="margin-top:14px">🛠 ساخت تیم رویایی</button>`}
    </div>
    ${!hasSquad ? `<div class="card"><div class="h-title">🏆 فانتزی لیگ برتر چطور کار می‌کند؟</div>
      <p class="muted small" style="line-height:2.1;margin:0">با ${faNum(100)} میلیون بودجه، ۱۵ بازیکن واقعی لیگ را بخر. هر هفته با نتایج واقعی امتیاز بگیر، کاپیتانت را دوبرابر کن و در لیگ‌های خصوصی با دوستانت رقابت کن.</p></div>` : ''}
    <div class="card">
      <div class="h-title">⚽ آخرین نتایج</div>
      <div id="latest-fx"></div>
      <button class="btn ghost sm" id="btn-allfx">همه بازی‌ها</button>
    </div>
    <div class="card">
      <div class="h-title">🥇 برترین مدیران</div>
      <div id="lb-mini"></div>
      <button class="btn ghost sm" id="btn-lb">لیدربورد کامل</button>
    </div>`;
  countUp(v.querySelector('#stat-total'), me?.entry?.total_points || 0);
  countUp(v.querySelector('#stat-gw'), me?.entry?.gw_points || 0);
  if (rank) countUp(v.querySelector('#rank-num'), rank);
  if (deadline && boot.next?.deadline) startCountdown(boot.next.deadline);
  const lfx = v.querySelector('#latest-fx');
  lfx.innerHTML = boot.latest.map(fxRow).join('') || '<div class="empty"><div class="big">🏟</div><p>هنوز بازی‌ای برگزار نشده.</p></div>';
  const lb = await api('/leaderboard').catch(() => []);
  const myId = me?.entry?.id;
  v.querySelector('#lb-mini').innerHTML = lb.slice(0, 5).map((r, i) => lbRow(r, i, null)).join('') || '<p class="muted small">هنوز بازیکنی ثبت‌نام نکرده. اولین باش!</p>';
  v.querySelector('#btn-lb').onclick = () => { haptic(); renderLeaderboard(); };
  v.querySelector('#btn-allfx').onclick = () => { haptic(); renderFixtures(); };
  const b = v.querySelector('#btn-build'); if (b) b.onclick = () => { haptic('medium'); go('squad'); };
  const mt = v.querySelector('#btn-myteam'); if (mt) mt.onclick = () => { haptic(); renderMyPoints(boot.gw?.id); };
}

function fxRow(f) {
  const sc = f.finished
    ? `<span class="num">${faNum(f.home_goals)} - ${faNum(f.away_goals)}</span>`
    : `<span class="vs num">${jtime(f.kickoff)}</span>`;
  const sub = f.finished ? '' : `<div class="dt">${jdate(f.kickoff)}</div>`;
  return `<div class="fx"><div class="t a">${f.home}</div><div class="mid"><div class="sc ${f.finished ? 'ft' : ''}">${sc}</div>${sub}</div><div class="t b">${f.away}</div></div>`;
}
function lbRow(r, i, myEntryId) {
  const name = r.team_name || r.first_name || '—';
  const me = myEntryId && (r.entry_id === myEntryId || r.id === myEntryId);
  return `<div class="lb-row ${me ? 'me' : ''}"><div class="lb-pos ${i < 3 ? 'top' + (i + 1) : ''}">${faNum(i + 1)}</div>
    <div class="lb-name"><div class="n">${r.team_name || name}${me ? ' (تو)' : ''}</div><div class="muted small">${r.first_name || ''}</div></div>
    <div class="lb-pts num">${faNum(r.total_points)}<small>هفته ${faNum(r.gw_points)}</small></div></div>`;
}
function startCountdown(deadlineStr) {
  const el = document.getElementById('cd'); if (!el) return;
  const target = new Date(deadlineStr).getTime();
  const tick = () => {
    const d = target - Date.now();
    if (!el.isConnected) return clearInterval(t);
    if (d <= 0) { el.innerHTML = '<div class="cd-box"><div class="n">🏁</div></div>'; return; }
    const days = Math.floor(d / 864e5), h = Math.floor(d % 864e5 / 36e5), m = Math.floor(d % 36e5 / 6e4), s = Math.floor(d % 6e4 / 1e3);
    el.innerHTML = [[days, 'روز'], [h, 'ساعت'], [m, 'دقیقه'], [s, 'ثانیه']].map(([n, l]) => `<div class="cd-box"><div class="n">${faNum(n)}</div><div class="l">${l}</div></div>`).join('');
  };
  tick(); const t = setInterval(tick, 1000);
}

/* ============ MARKET ============ */
async function renderMarket() {
  const v = document.getElementById('view');
  v.innerHTML = `
    <div class="row between" style="margin-bottom:4px">
      <div><div class="eyebrow">بازار نقل‌وانتقالات</div>
      <div style="font-size:19px;font-weight:800">🛒 بازیکنان لیگ</div></div>
      <div class="pill gold">بانک <b class="num">${money(state.me?.entry?.bank || 0)}</b></div>
    </div>
    <div class="sticky-bar">
      <div class="search-wrap"><input id="q" type="search" placeholder="جستجوی بازیکن یا باشگاه…">
      <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2"/></svg></div>
      <div class="row" style="gap:8px;margin-top:8px">
        <div class="chips" id="poschips" style="margin:0;flex:1">
          <button class="chip on" data-p="all">همه</button>
          <button class="chip" data-p="GKP">دروازه‌بان</button>
          <button class="chip" data-p="DEF">دفاع</button>
          <button class="chip" data-p="MID">هافبک</button>
          <button class="chip" data-p="FWD">مهاجم</button>
        </div>
        <select id="sort" class="sel" style="width:118px;padding:9px 10px;font-size:12px">
          <option value="price-desc">گران‌ترین</option>
          <option value="price-asc">ارزان‌ترین</option>
          <option value="name">نام</option>
        </select>
      </div>
    </div>
    <div id="plist" class="stagger"></div>`;
  if (!state.players.length) {
    state.players = (await api('/players')).map(p => ({ ...p, price: Number(p.price) }));
    const clubs = await api('/clubs');
    state.clubsById = Object.fromEntries(clubs.map(c => [c.id, c]));
  }
  let pos = 'all', sort = 'price-desc';
  const draw = () => {
    const q = v.querySelector('#q').value.trim();
    let list = state.players;
    if (pos !== 'all') list = list.filter(p => p.pos === pos);
    if (q) list = list.filter(p => (p.fa_name + (p.en_name || '') + p.club).includes(q));
    if (sort === 'price-desc') list = [...list].sort((a, b) => b.price - a.price);
    else if (sort === 'price-asc') list = [...list].sort((a, b) => a.price - b.price);
    else list = [...list].sort((a, b) => String(a.fa_name).localeCompare(String(b.fa_name), 'fa'));
    const box = v.querySelector('#plist');
    box.classList.remove('stagger'); void box.offsetWidth; box.classList.add('stagger');
    box.innerHTML = list.slice(0, 80).map(playerCard).join('') || '<div class="empty"><div class="big">🔍</div><p>بازیکنی پیدا نشد.</p></div>';
    v.querySelectorAll('.pl-card').forEach(el => el.onclick = () => playerSheet(+el.dataset.id));
  };
  v.querySelector('#q').oninput = draw;
  v.querySelector('#sort').onchange = e => { sort = e.target.value; draw(); };
  v.querySelectorAll('#poschips .chip').forEach(b => b.onclick = () => {
    haptic();
    v.querySelectorAll('#poschips .chip').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); pos = b.dataset.p; draw();
  });
  draw();
}
function playerCard(p) {
  const c = state.clubsById[p.club_id];
  return `<div class="pl-card" data-id="${p.id}">
    ${avatar(p)}
    <div class="pl-info"><div class="pl-name">${p.fa_name}</div>
      <div class="pl-club">${c ? `<span class="club-dot" style="background:${c.color1}"></span>` : ''}${p.club} · <span class="tag ${posTag[p.pos]}">${posFa[p.pos]}</span></div></div>
    <div class="pl-price">${money(p.price)}<small>میلیون</small></div></div>`;
}
function playerSheet(id) {
  const p = state.players.find(x => x.id === id); if (!p) return;
  sheet(`<h3 class="row">${avatar(p)}<span>${p.fa_name}</span></h3>
    <p class="muted small">${p.en_name || ''} · ${p.club} · ${posFa[p.pos]}${p.is_foreign ? ' · 🌍 غیرایرانی' : ''}</p>
    <div class="stat-line"><span class="muted">قیمت</span><b class="num gold-t" style="font-size:18px">${money(p.price)} میلیون</b></div>
    <div class="stat-line"><span class="muted">پست</span><span class="tag ${posTag[p.pos]}">${posFa[p.pos]}</span></div>
    <div class="stat-line"><span class="muted">باشگاه</span><b>${p.club}</b></div>
    <p class="muted small" style="line-height:2.1;margin:12px 0">${p.price >= 7 ? '⭐ ستاره‌ی خط ' + posFa[p.pos] + ' — امتیازساز اصلی تیم.' : p.price <= 4.5 ? '💎 ارزش خرید بالا — گزینه اقتصادی هوشمندانه برای پر کردن ترکیب.' : '✔ گزینه مطمئن و آماده برای ترکیب اصلی.'}</p>
    <button class="btn" id="btn-buy">افزودن به تیم ⚡</button>`);
  document.getElementById('btn-buy').onclick = () => {
    haptic('medium');
    addToDraft(p);
    closeSheet();
  };
}

/* ============ DRAFT / SQUAD ============ */
const FORMATIONS = [
  { id: '343', d: 3, m: 4, f: 3 }, { id: '433', d: 4, m: 3, f: 3 }, { id: '442', d: 4, m: 4, f: 2 },
  { id: '451', d: 4, m: 5, f: 1 }, { id: '532', d: 5, m: 3, f: 2 }, { id: '541', d: 5, m: 4, f: 1 }
];

async function renderSquad() {
  const v = document.getElementById('view');
  const me = await api('/me').catch(() => null);
  if (me) state.me = me;
  if (!state.players.length) {
    state.players = (await api('/players')).map(p => ({ ...p, price: Number(p.price) }));
    const clubs = await api('/clubs');
    state.clubsById = Object.fromEntries(clubs.map(c => [c.id, c]));
  }
  if (!state.draft) {
    state.draft = initDraft(me?.squad || []);
  }
  drawPitch();
}

function initDraft(existing) {
  const slots = Array.from({ length: 15 }, (_, i) => ({ slot: i + 1, player: null, is_captain: false, is_vice: false }));
  const bySlot = {};
  (existing || []).forEach(s => { bySlot[s.slot] = s; });
  slots.forEach(s => {
    const ex = bySlot[s.slot];
    if (ex) s.player = state.players.find(p => p.id === ex.player_id) || null;
  });
  if (existing?.length === 15) {
    const cap = existing.find(s => s.is_captain);
    const vice = existing.find(s => s.is_vice);
    if (cap) slots[cap.slot - 1].is_captain = true;
    if (vice) slots[vice.slot - 1].is_vice = true;
  } else if (slots[0]?.player) {
    slots[0].is_captain = true;
    slots[1] && (slots[1].is_vice = true);
  }
  return { slots, formation: FORMATIONS[2] };
}

function draftTotals() {
  const filled = state.draft.slots.filter(s => s.player);
  const spent = filled.reduce((s, x) => s + Number(x.player.price), 0);
  const counts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  filled.forEach(s => counts[s.player.pos]++);
  const clubCounts = {};
  filled.forEach(s => clubCounts[s.player.club_id] = (clubCounts[s.player.club_id] || 0) + 1);
  return { spent, bank: 100 - spent, counts, clubCounts, n: filled.length };
}

function addToDraft(player) {
  const d = state.draft;
  const t = draftTotals();
  if (d.slots.some(s => s.player?.id === player.id)) return toast('این بازیکن در تیم تو هست', 'err');
  if ((t.clubCounts[player.club_id] || 0) >= 3) return toast('حداکثر ۳ بازیکن از هر باشگاه', 'err');
  if (t.counts[player.pos] >= { GKP: 2, DEF: 5, MID: 5, FWD: 3 }[player.pos]) return toast('ظرفیت پست پر است', 'err');
  if (Number(player.price) > t.bank + 1e-9) return toast('بودجه کافی نیست!', 'err');
  const target = d.slots.find(s => !s.player);
  if (!target) return toast('تیم پر است', 'err');
  target.player = player;
  if (!d.slots.some(s => s.is_captain && s.player)) target.is_captain = true;
  else if (!d.slots.some(s => s.is_vice && s.player)) target.is_vice = true;
  drawPitch(); toast(`${player.fa_name} اضافه شد ⚡`, 'ok');
}
function removeFromDraft(slotIdx) {
  const s = state.draft.slots[slotIdx];
  if (!s.player) return;
  const hadCap = s.is_captain, hadVice = s.is_vice;
  s.player = null; s.is_captain = false; s.is_vice = false;
  if (hadCap) { const n = state.draft.slots.find(x => x.player && !x.is_captain && !x.is_vice); if (n) n.is_captain = true; }
  else if (hadVice) { const n = state.draft.slots.find(x => x.player && !x.is_captain && !x.is_vice); if (n) n.is_vice = true; }
  drawPitch();
}

function drawPitch() {
  const v = document.getElementById('view');
  const d = state.draft, t = draftTotals();
  const f = d.formation;
  const starting = d.slots.slice(0, 11);
  const bench = d.slots.slice(11);
  const rowCount = pos => pos === 'GKP' ? 1 : pos === 'DEF' ? f.d : pos === 'MID' ? f.m : f.f;
  const rowOf = pos => {
    const items = starting.filter(s => s.player?.pos === pos);
    const empties = Math.max(0, rowCount(pos) - items.length);
    return items.map(s => pjHtml(s)).concat(Array(empties).fill(pjHtml({ player: null }, null, pos))).join('');
  };
  const cap = d.slots.find(s => s.is_captain && s.player)?.player;
  v.innerHTML = `
    <div class="row between" style="margin-bottom:10px">
      <div><div class="eyebrow">ترکیب تیم</div>
      <div style="font-size:19px;font-weight:800">${state.me?.entry?.team_name || 'تیم من'}</div></div>
      <div class="pill num ${t.n === 15 ? 'gold' : ''}">${faNum(t.n)} / ۱۵</div>
    </div>
    <div class="seg" style="margin-bottom:12px" id="fmtseg">
      ${FORMATIONS.map(x => `<button data-f="${x.id}" class="${x.id === f.id ? 'on' : ''}">${faNum(x.id)}</button>`).join('')}
    </div>
    <div class="pitch-wrap">
      <div class="pitch-flood"></div><div class="pitch-line"></div><div class="pitch-mid"></div>
      <div class="pitch-circle"></div><div class="pitch-spot"></div>
      <div class="pitch">
        <div class="pitch-row">${rowOf('GKP')}</div>
        <div class="pitch-row">${rowOf('DEF')}</div>
        <div class="pitch-row">${rowOf('MID')}</div>
        <div class="pitch-row">${rowOf('FWD')}</div>
      </div>
    </div>
    <div class="bench-bar"><span class="lbl">نیمکت ذخیره</span><span class="line"></span></div>
    <div class="bench-row">${bench.map((s, bi) => pjHtml({ ...s, i: 11 + bi })).join('')}</div>
    <div class="card" style="margin-top:14px">
      <div class="row between">
        <div><div class="muted small">هزینه تیم</div><b class="num" style="font-size:18px">${money(t.spent)}</b></div>
        <div style="text-align:center"><div class="muted small">موجودی بانک</div><b class="num green-t" style="font-size:18px">${money(Math.max(t.bank, 0))}</b></div>
        <div style="text-align:left"><div class="muted small">کاپیتان ©️</div><b style="font-size:13px">${cap ? cap.fa_name : '—'}</b></div>
      </div>
      <div class="row" style="gap:10px;margin-top:14px">
        <button class="btn green" id="btn-save" style="flex:1.4">ثبت تیم ✅</button>
        <button class="btn ghost" id="btn-chip" style="flex:1">🎁 چیپ</button>
      </div>
    </div>`;
  v.querySelectorAll('#fmtseg button').forEach(b => b.onclick = () => {
    haptic();
    state.draft.formation = FORMATIONS.find(x => x.id === b.dataset.f);
    drawPitch();
  });
  v.querySelector('#btn-save').onclick = saveSquad;
  v.querySelector('#btn-chip').onclick = chipSheet;
  v.querySelectorAll('.pj').forEach(el => {
    el.onclick = () => {
      haptic();
      if (el.dataset.idx !== undefined && el.dataset.idx !== 'undefined') {
        const idx = +el.dataset.idx, s = d.slots[idx];
        if (s.player) return slotSheet(idx);
        return pickSheet(idx);
      }
      pickSheet(-1, el.dataset.pos || null);
    };
  });
}
function pjHtml(s, ptsMap, pos) {
  const p = s.player;
  const cap = s.is_captain ? '<span class="cap">©️</span>' : s.is_vice ? '<span class="cap" style="opacity:.55">Ⓥ</span>' : '';
  if (!p) return `<button class="pj empty" data-pos="${pos || ''}"><span class="shirt">＋</span><span class="nm">${pos ? posFa[pos] : 'انتخاب'}</span></button>`;
  const pts = ptsMap ? ptsMap[p.id] : null;
  const ptPill = pts !== null && pts !== undefined
    ? `<span class="pt num ${pts > 0 ? 'plus' : pts < 0 ? 'minus' : ''}">${pts > 0 ? '+' : ''}${faNum(pts)}</span>`
    : `<span class="pt num">${money(p.price)}</span>`;
  const shirtInner = p.portrait ? `<img src="${p.portrait}" alt="" loading="lazy" onerror="this.remove()">` : p.pos[0];
  return `<button class="pj ${s.is_captain ? 'capt' : ''}" data-idx="${s.i ?? s.slot - 1}">
    ${cap}${ptPill}<span class="shirt" style="${kitStyle(p)}">${shirtInner}</span><span class="nm">${p.fa_name}</span></button>`;
}
function slotSheet(idx) {
  const s = state.draft.slots[idx];
  sheet(`<h3>${s.player.fa_name}</h3>
    <p class="muted small">${s.player.club} · ${posFa[s.player.pos]} · ${money(s.player.price)}M</p>
    <div class="row" style="gap:10px;flex-wrap:wrap">
      <button class="btn sm ghost" id="a-cap">${s.is_captain ? 'لغو کاپیتان' : '🅲 کاپیتان'}</button>
      <button class="btn sm ghost" id="a-vice">${s.is_vice ? 'لغو نایب' : '🆅 نایب'}</button>
      <button class="btn sm red" id="a-del">حذف</button>
    </div>`);
  document.getElementById('a-cap').onclick = () => {
    const was = s.is_captain;
    state.draft.slots.forEach(x => x.is_captain = false);
    s.is_captain = !was; drawPitch(); closeSheet();
  };
  document.getElementById('a-vice').onclick = () => {
    const was = s.is_vice;
    state.draft.slots.forEach(x => x.is_vice = false);
    s.is_vice = !was; drawPitch(); closeSheet();
  };
  document.getElementById('a-del').onclick = () => { removeFromDraft(idx); closeSheet(); };
}
function pickSheet(idx, onlyPos) {
  const t = draftTotals();
  let candidates = state.players
    .filter(p => !state.draft.slots.some(s => s.player?.id === p.id))
    .filter(p => p.price <= t.bank);
  if (onlyPos && ['GKP', 'DEF', 'MID', 'FWD'].includes(onlyPos)) candidates = candidates.filter(p => p.pos === onlyPos);
  candidates = candidates.sort((a, b) => b.price - a.price).slice(0, 30);
  sheet(`<h3>انتخاب ${onlyPos ? posFa[onlyPos] : 'بازیکن'}</h3><div style="max-height:50dvh;overflow-y:auto">
    ${candidates.map(c => `<div class="pl-card" data-pid="${c.id}">${playerCardInner(c)}</div>`).join('') || '<p class="muted small">گزینه‌ای در بودجه نیست.</p>'}</div>`);
  document.querySelectorAll('[data-pid]').forEach(el => el.onclick = () => {
    haptic();
    addToDraft(state.players.find(p => p.id === +el.dataset.pid));
    closeSheet();
  });
}
function playerCardInner(p) {
  return `${avatar(p)}
    <div class="pl-info"><div class="pl-name">${p.fa_name}</div>
    <div class="pl-club">${p.club} · <span class="tag ${posTag[p.pos]}">${posFa[p.pos]}</span></div></div>
    <div class="pl-price">${money(p.price)}</div>`;
}

async function saveSquad() {
  const d = state.draft;
  if (d.slots.some(s => !s.player)) return toast('۱۵ بازیکن لازم است', 'err');
  const slots = d.slots.map(s => ({ player_id: s.player.id, slot: s.slot, is_captain: s.is_captain, is_vice: s.is_vice }));
  const starting = slots.filter(s => s.slot <= 11).map(s => s.player ? state.players.find(p => p.id === s.player_id).pos : null);
  try {
    await api('/squad', { method: 'POST', body: JSON.stringify({ slots }) });
    confetti(); toast('تیم ثبت شد! 🎉', 'ok');
    go('home');
  } catch (e) { toast(e.message, 'err'); }
}

function chipSheet() {
  sheet(`<h3>🎁 چیپ‌ها</h3>
    <p class="muted small">هر چیپ یک‌بار در فصل قابل استفاده است.</p>
    ${[['wildcard', '🃏 وایلدکارت', 'تغییر نامحدود تیم بدون جریمه'],
       ['freehit', '⚡ فری‌هیت', 'تیم این هفته آزاد، هفته بعد برگشت'],
       ['bboost', '🪑 بن‌بوست', 'امتیاز نیمکت هم حساب می‌شود'],
       ['3xc', '✖️۳ کاپیتان', 'امتیاز کاپیتان سه‌برابر']].map(([id, t, d]) =>
      `<div class="card"><div class="h-title">${t}</div><p class="muted small">${d}</p>
       <button class="btn sm" data-chip="${id}">فعال‌سازی</button></div>`).join('')}`);
  document.querySelectorAll('[data-chip]').forEach(b => b.onclick = async () => {
    try {
      await api('/chip', { method: 'POST', body: JSON.stringify({ chip: b.dataset.chip }) });
      toast('چیپ فعال شد! 🎯', 'ok'); closeSheet();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ============ MY POINTS ============ */
async function renderMyPoints(gwId) {
  const v = document.getElementById('view');
  const d = await api('/my-points' + (gwId ? '/' + gwId : ''));
  v.innerHTML = backHtml('home') + `
    <div class="card glow" style="text-align:center">
      <div class="eyebrow" style="justify-content:center">هفته ${faNum(d.gwId)}</div>
      <div class="num gold-t pop" style="font-size:52px;font-weight:700;line-height:1" id="gw-total">0</div>
      <div class="muted small">امتیاز این هفته</div>
    </div>
    <div class="card"><div class="h-title">🧩 ترکیب و امتیازها</div>${d.players.map(p => `
      <div class="lb-row"><div class="lb-pos">${faNum(p.slot)}</div>
      <div class="lb-name"><div class="n">${p.fa_name} ${p.pts > 0 ? `<b class="num green-t">+${faNum(p.pts)}</b>` : p.pts < 0 ? `<b class="num red-t">${faNum(p.pts)}</b>` : ''}</div>
      <div class="muted small">${p.club} · ${posFa[p.pos]} · ${faNum(p.minutes || 0)} دقیقه${p.goals ? ` · ⚽ ${faNum(p.goals)}` : ''}${p.assists ? ` · 🅰️ ${faNum(p.assists)}` : ''}${p.bonus ? ` · ⭐ ${faNum(p.bonus)}` : ''}</div></div></div>`).join('')}
    </div>`;
  countUp(v.querySelector('#gw-total'), d.total);
  wireBack(v);
}

/* ============ FIXTURES ============ */
async function renderFixtures(gwId) {
  const v = document.getElementById('view');
  const d = await api('/fixtures' + (gwId ? '/' + gwId : ''));
  const gws = Array.from({ length: 7 }, (_, i) => d.gwId - 3 + i).filter(g => g >= 1 && g <= 34);
  const live = d.fixtures.filter(f => !f.finished).length;
  v.innerHTML = backHtml('home') + `
    <div class="row between" style="margin-bottom:4px">
      <div><div class="eyebrow">تقویم لیگ برتر</div>
      <div style="font-size:19px;font-weight:800">📅 بازی‌های هفته ${faNum(d.gwId)}</div></div>
      ${live ? `<div class="pill live">● ${faNum(live)} بازی پیش‌رو</div>` : `<div class="pill">پایان هفته</div>`}
    </div>
    <div class="chips">${gws.map(g => `<button class="chip ${g === d.gwId ? 'on' : ''}" data-gw="${g}">${faNum(g)}</button>`).join('')}</div>
    ${d.fixtures.map(f => `
      <div class="fx">
        <div class="t a">${f.home}</div>
        <div class="mid"><div class="sc ${f.finished ? 'ft' : ''}">${f.finished ? `${faNum(f.home_goals)} - ${faNum(f.away_goals)}` : jtime(f.kickoff)}</div>
        <div class="dt">${f.finished ? 'پایان' : jdate(f.kickoff)}</div></div>
        <div class="t b">${f.away}</div>
      </div>`).join('') || '<div class="empty"><div class="big">📅</div><p>بازی‌ای ثبت نشده.</p></div>'}`;
  v.querySelectorAll('[data-gw]').forEach(b => b.onclick = () => { haptic(); renderFixtures(+b.dataset.gw); });
  wireBack(v);
}

/* ============ LEAGUES ============ */
async function renderLeagues() {
  const v = document.getElementById('view');
  const list = await api('/leagues').catch(() => []);
  v.innerHTML = `
    <div class="row" style="gap:10px;margin-bottom:14px">
      <button class="btn" id="btn-new" style="flex:1">🏟 لیگ جدید</button>
      <button class="btn ghost" id="btn-join" style="flex:1">🔑 عضویت با کد</button>
    </div>
    ${list.length ? `<div class="card"><div class="h-title">لیگ‌های من</div>` + list.map(l => `<div class="pl-card" data-lg="${l.id}">
      <div class="pl-ava" style="background:linear-gradient(135deg,#ffe08a,#f5c518);font-size:20px">🏆</div>
      <div class="pl-info"><div class="pl-name">${l.name}</div><div class="pl-club">${faNum(l.members)} مدیر · کد ${l.code}</div></div></div>`).join('') + '</div>'
      : `<div class="card"><div class="empty"><div class="big">🏟</div>
        <p>هنوز لیگی نداری! یک لیگ بساز، کدش را با دوستانت قسمت کن و ببین کی بهتر تیم می‌چیند.</p>
        <button class="btn sm" id="btn-new2">ساخت اولین لیگ</button></div></div>`}`;
  const mkNew = () => sheet(`<h3>🏟 لیگ جدید</h3>
    <input id="ln" type="text" placeholder="نام لیگ (مثلاً همکاران اداره)">
    <p class="muted small" style="margin:10px 0">کد ۶ حرفی ساخته می‌شود؛ به دوستانت بده تا با <b>/join</b> عضو شوند.</p>
    <button class="btn" id="mk">ساخت لیگ 🚀</button>`) || (document.getElementById('mk').onclick = async () => {
      try {
        const l = await api('/league', { method: 'POST', body: JSON.stringify({ name: document.getElementById('ln').value }) });
        closeSheet(); confetti();
        renderLeague(l.id);
      } catch (e) { toast(e.message, 'err'); }
    });
  v.querySelector('#btn-new').onclick = () => { haptic(); mkNew(); };
  const n2 = v.querySelector('#btn-new2'); if (n2) n2.onclick = () => { haptic(); mkNew(); };
  v.querySelector('#btn-join').onclick = () => { haptic(); sheet(`<h3>عضویت با کد دعوت</h3>
    <input id="jc" type="text" placeholder="کد ۶ حرفی" style="letter-spacing:6px;text-align:center;font-family:var(--font-num);font-size:18px">
    <button class="btn" id="jk" style="margin-top:12px">عضویت در لیگ ✅</button>`) || (document.getElementById('jk').onclick = async () => {
      try {
        const l = await api('/league/join', { method: 'POST', body: JSON.stringify({ code: document.getElementById('jc').value }) });
        toast('به لیگ اضافه شدی! ✅', 'ok'); closeSheet(); renderLeague(l.id);
      } catch (e) { toast(e.message, 'err'); }
    }); };
  v.querySelectorAll('[data-lg]').forEach(el => el.onclick = () => { haptic(); renderLeague(+el.dataset.lg); });
}

async function renderLeague(id) {
  const v = document.getElementById('view');
  const t = await api('/league/' + id);
  const myId = state.me?.entry?.id;
  v.innerHTML = backHtml('leagues', 'لیگ‌ها') + `
    <div class="card glow" style="text-align:center">
      <div style="font-size:38px">🏆</div>
      <div class="h-title" style="justify-content:center;margin:6px 0 2px">${t.league.name}</div>
      <p class="muted small">${faNum(t.members.length)} مدیر در این لیگ</p>
      <div class="code-box"><span class="muted small">کد دعوت</span><b>${t.league.code}</b>
      <button class="btn sm ghost" id="copy">کپی</button></div>
      <button class="btn sm" id="share" style="margin-top:10px">📤 دعوت دوستان</button>
    </div>
    <div class="card"><div class="h-title">جدول لیگ</div>
    ${t.members.map((m, i) => lbRow({ team_name: m.team_name, first_name: m.username || '', total_points: m.total, gw_points: m.gw, entry_id: m.entry_id }, i, myId)).join('')}</div>`;
  const copyBtn = document.getElementById('copy');
  copyBtn.onclick = async () => {
    haptic();
    try { await navigator.clipboard.writeText(t.league.code); toast('کد کپی شد ✅', 'ok'); }
    catch { toast('کپی نشد — کد: ' + t.league.code, 'err'); }
  };
  document.getElementById('share').onclick = () => {
    haptic();
    const url = `https://t.me/share/url?url=${encodeURIComponent(cfgLink())}&text=${encodeURIComponent(`توی فانتزی لیگ برتر بیا! کد لیگ: ${t.league.code}`)}`;
    tg?.openTelegramLink(url);
  };
  wireBack(v);
}
function cfgLink() { return location.origin + location.pathname; }

/* ============ LEADERBOARD ============ */
async function renderLeaderboard() {
  const v = document.getElementById('view');
  const lb = await api('/leaderboard');
  const myId = state.me?.entry?.id;
  v.innerHTML = backHtml('home') + `
    <div class="card glow" style="text-align:center">
      <div style="font-size:38px">🥇</div>
      <div class="h-title" style="justify-content:center;margin:6px 0 2px">لیدربورد کل ایران</div>
      <p class="muted small">${faNum(lb.length)} مدیر در رقابت</p>
    </div>
    <div class="card"><div class="h-title">جدول کلی</div>
    ${lb.map((r, i) => lbRow(r, i, myId)).join('') || '<div class="empty"><div class="big">🏟</div><p>هنوز رقابتی شروع نشده.</p></div>'}</div>`;
  wireBack(v);
}

/* ============ PROFILE ============ */
async function renderProfile() {
  const v = document.getElementById('view');
  const me = await api('/me');
  state.me = me;
  v.innerHTML = `
    <div class="card glow" style="text-align:center">
      <div style="font-size:44px">👤</div>
      <div class="h-title" style="justify-content:center;margin:8px 0 2px">${me.user.name || 'بازیکن'}</div>
      <p class="muted small" style="margin:0 0 12px">${me.user.username ? '@' + me.user.username : ''} · <span class="num">${me.user.id}</span></p>
      <div class="row" style="justify-content:center;gap:22px;margin-top:6px">
        <div><b class="num gold-t" style="font-size:22px" id="pf-pts">0</b><div class="muted small">امتیاز</div></div>
        <div><b class="num" style="font-size:22px">${faNum(me.entry.overall_rank || '—')}</b><div class="muted small">رتبه</div></div>
        <div><b class="num" style="font-size:22px">${faNum(me.leagues)}</b><div class="muted small">لیگ</div></div>
      </div>
    </div>
    <div class="card">
      <div class="h-title">📝 نام تیم</div>
      <input id="tn" type="text" value="${(me.entry.team_name || '').replace(/"/g, '&quot;')}">
      <button class="btn sm" id="savetn" style="margin-top:10px">ذخیره نام</button>
    </div>
    <div class="card">
      <div class="h-title">⚖️ قوانین امتیازدهی</div>
      <div class="admin-stat"><span>گل (دروازه‌بان/دفاع)</span><b class="num">۶</b></div>
      <div class="admin-stat"><span>گل (هافبک)</span><b class="num">۵</b></div>
      <div class="admin-stat"><span>گل (مهاجم)</span><b class="num">۴</b></div>
      <div class="admin-stat"><span>پاس گل</span><b class="num">۳</b></div>
      <div class="admin-stat"><span>کلین‌شیت (دروازه‌بان/دفاع)</span><b class="num">۴</b></div>
      <div class="admin-stat"><span>کلین‌شیت (هافبک)</span><b class="num">۱</b></div>
      <div class="admin-stat"><span>هر ۳ سیو (دروازه‌بان)</span><b class="num">۱</b></div>
      <div class="admin-stat"><span>مهار پنالتی</span><b class="num">۵</b></div>
      <div class="admin-stat"><span>هر ۲ گل خورده (د/د)</span><b class="num">−۱</b></div>
      <div class="admin-stat"><span>کارت زرد</span><b class="num">−۱</b></div>
      <div class="admin-stat"><span>کارت قرمز</span><b class="num">−۳</b></div>
      <div class="admin-stat"><span>گل به خودی</span><b class="num">−۲</b></div>
      <div class="admin-stat"><span>بهترین بازیکن زمین (BPS)</span><b class="num">۳/۲/۱</b></div>
    </div>`;
  document.getElementById('savetn').onclick = async () => {
    haptic();
    const slots = me.squad.map(s => ({ player_id: s.player_id, slot: s.slot, is_captain: s.is_captain, is_vice: s.is_vice }));
    if (slots.length === 15) {
      await api('/squad', { method: 'POST', body: JSON.stringify({ slots, teamName: document.getElementById('tn').value }) });
      toast('ذخیره شد ✅', 'ok');
    } else toast('اول تیم ۱۵ نفره را بساز', 'err');
  };
  countUp(document.getElementById('pf-pts'), me.entry.total_points || 0);
}

/* ============ ADMIN ============ */
async function renderAdmin() {
  const v = document.getElementById('view');
  v.innerHTML = backHtml('profile') + `
    <div class="card"><div class="h-title">⚙️ پنل مدیریت</div>
      <div class="eyebrow">داده‌ها (خودکار)</div>
      <button class="btn sm" id="a-syncv3" style="margin-bottom:8px">sync نتایج فصل از ورزش‌سه</button>
      <button class="btn sm green" id="a-auto" style="margin-bottom:8px">استخراج خودکار آمار (۲ بازی)</button>
      <button class="btn sm ghost" id="a-pend" style="margin-bottom:8px">بازی‌های در انتظار آمار</button>
      <div id="a-out" class="small muted" style="margin-bottom:8px;line-height:2"></div>
      <div class="eyebrow">دستی</div>
      <input id="a-gw" type="text" placeholder="شماره هفته برای finish" style="margin-bottom:8px">
      <button class="btn sm red" id="a-finish">بستن هفته و محاسبه امتیاز</button>
      <p class="muted small" style="margin-top:10px">ورود دستی آمار: /admin signal در بات.</p>
    </div>`;
  const out = t => document.getElementById('a-out').textContent = t;
  document.getElementById('a-syncv3').onclick = async () => {
    try { out('در حال sync...'); const r = await api('/admin/sync-v3', { method: 'POST' }); out(`نتایج: ${faNum(r.fixtures)} جدید، ${faNum(r.updated)} آپدیت`); toast('sync شد ✅', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('a-auto').onclick = async () => {
    try {
      const r = await api('/admin/auto-ingest', { method: 'POST', body: JSON.stringify({ limit: 3 }) });
      if (!r.started) { out('در حال اجراست، صبر کن…'); return; }
      out('استخراج خودکار شروع شد… وضعیت را بررسی می‌کنم');
      const poll = async (n) => {
        if (n <= 0) { out('هنوز در حال اجراست؛ بعداً «در انتظار» را بزن'); return; }
        await new Promise(rr => setTimeout(rr, 30000));
        try {
          const s = await api('/admin/ingest-status');
          out(`در حال اجرا… ${faNum(s.pending)} بازی مانده`);
          if (!s.running) { out(s.pending ? `${faNum(s.pending)} بازی مانده — دوباره بزن` : 'همه بازی‌ها آمار دارند ✅'); toast('انجام شد ✅', 'ok'); }
          else poll(n - 1);
        } catch (e) { out('خطا در بررسی وضعیت'); }
      };
      poll(20);
    }
    catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('a-pend').onclick = async () => {
    try { const r = await api('/admin/pending'); out(r.length ? r.map(f => `${f.home} - ${f.away} (هفته ${faNum(f.gw_id)})`).join('، ') : 'همه بازی‌ها آمار دارند ✅'); }
    catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('a-finish').onclick = async () => {
    try { const r = await api('/admin/finish-gw/' + document.getElementById('a-gw').value, { method: 'POST' }); toast(`هفته بسته شد — ${r.playersScored} بازیکن`, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  wireBack(v);
}

/* ============ ROUTER ============ */
const TABS = { home: renderHome, squad: renderSquad, market: renderMarket, leagues: renderLeagues, profile: renderProfile };
let current = '';
function go(tab, arg) {
  current = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  (TABS[tab] || renderHome)(arg).catch(e => {
    if (/401|unauthorized/.test(e.message)) renderSplash();
    else toast(e.message, 'err');
  });
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => go(t.dataset.tab));
document.getElementById('btn-admin').onclick = renderAdmin;

(async function init() {
  if (!tg?.initData) { renderSplash(); return; }
  try { await api('/me'); go('home'); } catch { renderSplash(); }
})();
