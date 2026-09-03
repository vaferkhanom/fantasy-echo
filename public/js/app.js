/* echtasy mini app — vanilla JS SPA */
const tg = window.Telegram?.WebApp;
const state = { me: null, players: [], clubs: [], draft: null, gw: null, clubsById: {} };
const FA_NUM = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const faNum = n => String(n).replace(/\d/g, d => FA_NUM[d]);
const money = p => faNum(p.toFixed(1));
const posFa = { GKP: 'دروازه‌بان', DEF: 'دفاع', MID: 'هافبک', FWD: 'مهاجم' };
const posTag = { GKP: 'gkp', DEF: 'def', MID: 'mid', FWD: 'fwd' };
const POS_COLORS = { GKP: ['#7dd3fc', '#38bdf8'], DEF: ['#86efac', '#22c55e'], MID: ['#fde047', '#eab308'], FWD: ['#fca5a5', '#ef4444'] };

tg?.ready();
tg?.expand();
tg?.setHeaderColor('#07090d');
tg?.setBackgroundColor('#07090d');

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
  document.getElementById('sheet').innerHTML = `<div class="grab"></div>` + html;
  m.classList.remove('hidden');
}
function closeSheet() { document.getElementById('modal').classList.add('hidden'); }
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
    <div class="hero-grad"></div>
    <div class="splash">
      ${BALL_SVG}
      <div class="logo">echtasy</div>
      <div class="tagline">فانتزی‌فوتبال لیگ برتر خلیج فارس<br>تیم رویایی‌ات را بساز و با کل ایران رقابت کن</div>
      <button class="btn" id="btn-enter">شروع ماجراجویی</button>
    </div>`;
  document.getElementById('btn-enter').onclick = () => go('home');
}

/* ============ HOME ============ */
async function renderHome() {
  const v = document.getElementById('view');
  v.innerHTML = `<div class="stat-grid">${'<div class="stat"><div class="v skel" style="height:24px"></div><div class="k">—</div></div>'.repeat(3)}</div><div class="card skel" style="height:120px"></div>`;
  const [boot, me] = await Promise.all([api('/boot'), api('/me').catch(() => null)]);
  state.me = me; state.gw = boot.gw;
  const hasSquad = me?.squad?.length === 15;
  const gwName = boot.gw ? `هفته ${faNum(boot.gw.id)}` : 'پیش‌فصل';
  document.getElementById('gw-badge').textContent = gwName;
  document.getElementById('gw-badge').classList.remove('hidden');
  document.getElementById('btn-admin').classList.toggle('hidden', !me?.isAdmin);

  let deadline = '';
  if (boot.next?.deadline) {
    deadline = `<div class="card glow">
      <div class="h-title">⏳ دِدلاین هفته ${faNum(boot.next.id)}</div>
      <div class="countdown" id="cd"></div>
      <div class="progress"><i style="width:0%"></i></div>
    </div>`;
  }
  v.innerHTML = `
    <div class="hero-grad"></div>
    ${deadline}
    <div class="stat-grid">
      <div class="stat pop"><div class="v">${faNum(me?.entry?.total_points || 0)}</div><div class="k">امتیاز کل</div></div>
      <div class="stat pop" style="animation-delay:.07s"><div class="v">${faNum(me?.entry?.overall_rank || '—')}</div><div class="k">رتبه</div></div>
      <div class="stat pop" style="animation-delay:.14s"><div class="v">${faNum(boot.managers)}</div><div class="k">مدیر</div></div>
    </div>
    ${hasSquad ? `<button class="btn ghost" id="btn-myteam">مشاهده هفته من ${faNum(me?.entry?.gw_points || 0)} امتیاز</button>` : `
    <div class="card glow" style="text-align:center">
      <div style="font-size:34px">🏆</div>
      <div class="h-title" style="justify-content:center">تیمت را بساز!</div>
      <p class="muted small" style="line-height:2">بودجه ${faNum(100)} میلیونی داری. بازیکنان واقعی لیگ برتر ایران را با قیمت واقعی خریداری کن، ترکیب بچین و کاپیتانت را انتخاب کن.</p>
      <button class="btn" id="btn-build">🛠 ساخت تیم</button>
    </div>`}
    <div class="card">
      <div class="h-title">⚽ آخرین نتایج</div>
      <div id="latest-fx"></div>
      <button class="btn ghost sm" id="btn-allfx">همه بازی‌ها</button>
    </div>
    <div class="card">
      <div class="h-title">🥇 برترین‌های overall</div>
      <div id="lb-mini"></div>
      <button class="btn ghost sm" id="btn-lb">لیدربورد کامل</button>
    </div>`;
  if (deadline && boot.next?.deadline) startCountdown(boot.next.deadline);
  const lfx = v.querySelector('#latest-fx');
  lfx.innerHTML = boot.latest.map(fxRow).join('') || '<p class="muted small">هنوز بازی‌ای برگزار نشده.</p>';
  const lb = await api('/leaderboard').catch(() => []);
  v.querySelector('#lb-mini').innerHTML = lb.slice(0, 5).map((r, i) => lbRow(r, i)).join('') || '<p class="muted small">هنوز بازیکنی ثبت‌نام نکرده. اولین باشی!</p>';
  v.querySelector('#btn-lb').onclick = () => renderLeaderboard();
  v.querySelector('#btn-allfx').onclick = () => renderFixtures();
  const b = v.querySelector('#btn-build'); if (b) b.onclick = () => go('squad');
  const mt = v.querySelector('#btn-myteam'); if (mt) mt.onclick = () => renderMyPoints(boot.gw?.id);
}

function fxRow(f) {
  const sc = f.finished ? `<span class="num">${faNum(f.home_goals)} - ${faNum(f.away_goals)}</span>` : '—';
  return `<div class="fx"><div class="t a">${f.home}</div><div class="sc">${sc}</div><div class="t b">${f.away}</div></div>`;
}
function lbRow(r, i) {
  const name = r.team_name || r.first_name || '—';
  return `<div class="lb-row"><div class="lb-pos ${i < 3 ? 'top' + (i + 1) : ''}">${faNum(i + 1)}</div>
    <div class="lb-name"><div class="n">${r.team_name || name}</div><div class="muted small">${r.first_name || ''}</div></div>
    <div class="lb-pts num">${faNum(r.total_points)}</div></div>`;
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
  v.innerHTML = `<div class="hero-grad"></div>
    <div class="row between" style="margin-bottom:10px"><div class="h-title" style="margin:0">🛒 بازار بازیکنان</div>
    <div class="pill">بانک: <b class="num">${money(state.me?.entry?.bank || 0)}</b></div></div>
    <div class="search-wrap"><input id="q" type="search" placeholder="جستجوی بازیکن یا باشگاه…">
    <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2"/></svg></div>
    <div class="chips" id="poschips">
      <button class="chip on" data-p="all">همه</button>
      <button class="chip" data-p="GKP">دروازه‌بان</button>
      <button class="chip" data-p="DEF">دفاع</button>
      <button class="chip" data-p="MID">هافبک</button>
      <button class="chip" data-p="FWD">مهاجم</button>
    </div>
    <div id="plist"></div>`;
  if (!state.players.length) {
    state.players = await api('/players');
    const clubs = await api('/clubs');
    state.clubsById = Object.fromEntries(clubs.map(c => [c.id, c]));
  }
  let pos = 'all';
  const draw = () => {
    const q = v.querySelector('#q').value.trim();
    let list = state.players;
    if (pos !== 'all') list = list.filter(p => p.pos === pos);
    if (q) list = list.filter(p => (p.fa_name + p.en_name + p.club).includes(q));
    v.querySelector('#plist').innerHTML = list.slice(0, 80).map(playerCard).join('') || '<p class="muted small">چیزی پیدا نشد.</p>';
    v.querySelectorAll('.pl-card').forEach(el => el.onclick = () => playerSheet(+el.dataset.id));
  };
  v.querySelector('#q').oninput = draw;
  v.querySelectorAll('#poschips .chip').forEach(b => b.onclick = () => {
    v.querySelectorAll('#poschips .chip').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); pos = b.dataset.p; draw();
  });
  draw();
}
function playerCard(p) {
  const [c1, c2] = POS_COLORS[p.pos];
  return `<div class="pl-card" data-id="${p.id}">
    <div class="pl-ava" style="background:linear-gradient(135deg,${c1},${c2})">${p.pos}</div>
    <div class="pl-info"><div class="pl-name">${p.fa_name}</div>
      <div class="pl-club">${p.club} · <span class="tag ${posTag[p.pos]}">${posFa[p.pos]}</span></div></div>
    <div class="pl-price">${money(p.price)}</div></div>`;
}
function playerSheet(id) {
  const p = state.players.find(x => x.id === id); if (!p) return;
  const [c1, c2] = POS_COLORS[p.pos];
  sheet(`<h3 class="row"><span class="pl-ava" style="background:linear-gradient(135deg,${c1},${c2})">${p.pos}</span> ${p.fa_name}</h3>
    <p class="muted small">${p.en_name || ''} · ${p.club} · ${posFa[p.pos]}${p.is_foreign ? ' · 🌍 غیرایرانی' : ''}</p>
    <div class="row between card" style="margin:10px 0"><span class="muted">قیمت</span><b class="num" style="font-size:18px;color:var(--gold2)">${money(p.price)}M</b></div>
    <p class="muted small" style="line-height:2">${p.price >= 7 ? '⭐ ستاره‌ی خط ' + posFa[p.pos] + ' — امتیازساز اصلی.' : p.price <= 4.5 ? '💎 ارزش خرید بالا — گزینه اقتصادی هوشمندانه.' : '✔ گزینه مطمئن برای ترکیب.'}</p>
    <button class="btn" id="btn-buy">افزودن به تیم</button>`);
  document.getElementById('btn-buy').onclick = () => {
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
    state.players = await api('/players');
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
  const spent = filled.reduce((s, x) => s + x.player.price, 0);
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
  if (player.price > t.bank) return toast('بودجه کافی نیست!', 'err');
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
  const byPos = pos => d.slots.map((s, i) => ({ ...s, i })).filter(s => (s.player?.pos || pos) === pos);
  const rowHtml = (pos, count) => {
    const items = byPos(pos).slice(0, count + 2);
    return `<div class="pitch-row">${d.slots.map((s, i) => ({ ...s, i })).filter(s => !s.player ? s.slot <= 11 : s.player.pos === pos).filter(s => count > 0).slice(0, count).map(s => pjHtml(s)).join('')}</div>`;
  };
  // Build rows by formation
  const f = d.formation;
  const starting = d.slots.slice(0, 11);
  const bench = d.slots.slice(11);
  const rowOf = pos => {
    let items = starting.filter(s => s.player?.pos === pos);
    const empties = Math.max(0, rowCount(pos) - items.length);
    return items.map(pjHtml).concat(Array(empties).fill(pjHtml({ player: null }))).join('');
  };
  const rowCount = pos => pos === 'GKP' ? 1 : pos === 'DEF' ? f.d : pos === 'MID' ? f.m : f.f;
  v.innerHTML = `<div class="hero-grad"></div>
    <div class="row between" style="margin-bottom:10px">
      <div class="h-title" style="margin:0">🧩 ترکیب تیم</div>
      <div class="pill num">${faNum(t.n)}/۱۵</div>
    </div>
    <div class="row" style="margin-bottom:10px;gap:8px">
      <select id="fmt" class="chip" style="border-radius:12px;padding:8px 12px;background:var(--bg2);color:var(--txt);border:1px solid var(--stroke)">
        ${FORMATIONS.map(x => `<option value="${x.id}" ${x.id === f.id ? 'selected' : ''}>${faNum(x.id)}</option>`).join('')}
      </select>
      <button class="btn sm green" id="btn-save">ثبت تیم</button>
      <button class="btn sm ghost" id="btn-chip">چیپ</button>
    </div>
    <div class="pitch-wrap"><div class="pitch-line"></div><div class="pitch-mid"></div><div class="pitch-circle"></div>
      <div class="pitch">
        <div class="pitch-row">${rowOf('GKP')}</div>
        <div class="pitch-row">${rowOf('DEF')}</div>
        <div class="pitch-row">${rowOf('MID')}</div>
        <div class="pitch-row">${rowOf('FWD')}</div>
      </div>
    </div>
    <div class="bench-row bench">${bench.map(s => pjHtml(s, true)).join('')}</div>
    <div class="row between card" style="margin-top:14px">
      <div><div class="muted small">هزینه</div><b class="num">${money(t.spent)}</b></div>
      <div style="text-align:center"><div class="muted small">بانک</div><b class="num" style="color:var(--green)">${money(Math.max(t.bank, 0))}</b></div>
      <div style="text-align:left"><div class="muted small">کاپیتان</div><b>${d.slots.find(s => s.is_captain && s.player)?.player?.fa_name || '—'}</b></div>
    </div>`;
  v.querySelector('#fmt').onchange = e => {
    state.draft.formation = FORMATIONS.find(x => x.id === e.target.value);
    drawPitch();
  };
  v.querySelector('#btn-save').onclick = saveSquad;
  v.querySelector('#btn-chip').onclick = chipSheet;
  v.querySelectorAll('.pj').forEach(el => {
    el.onclick = () => {
      const idx = +el.dataset.idx, s = d.slots[idx];
      if (s.player) slotSheet(idx);
      else pickSheet(idx);
    };
  });
}
function pjHtml(s, bench = false) {
  const p = s.player;
  const cap = s.is_captain ? '<span class="cap">🅲</span>' : s.is_vice ? '<span class="cap" style="opacity:.6">🆅</span>' : '';
  if (!p) return `<button class="pj empty ${bench ? '' : ''}" data-idx="${s.i ?? s.slot - 1}"><span class="shirt">+</span><span class="nm">${bench ? 'ذخیره' : 'انتخاب'}</span></button>`;
  return `<button class="pj ${p.pos === 'GKP' ? 'gkp' : ''} ${s.is_captain ? 'capt' : ''}" data-idx="${s.i ?? s.slot - 1}">
    ${cap}<span class="pt num">${money(p.price)}</span><span class="shirt">${p.pos[0]}</span><span class="nm">${p.fa_name}</span></button>`;
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
function pickSheet(idx) {
  const t = draftTotals();
  const posOrder = ['GKP', 'DEF', 'MID', 'FWD'];
  const need = state.draft.slots[idx];
  // suggest: any position for starting slots; for bench fill remaining quotas
  const candidates = state.players
    .filter(p => !state.draft.slots.some(s => s.player?.id === p.id))
    .filter(p => p.price <= t.bank)
    .sort((a, b) => b.price - a.price).slice(0, 30);
  sheet(`<h3>انتخاب بازیکن</h3><div style="max-height:50dvh;overflow-y:auto">
    ${candidates.map(c => `<div class="pl-card" data-pid="${c.id}">${playerCardInner(c)}</div>`).join('')}</div>`);
  document.querySelectorAll('[data-pid]').forEach(el => el.onclick = () => {
    addToDraft(state.players.find(p => p.id === +el.dataset.pid));
    closeSheet();
  });
}
function playerCardInner(p) {
  const [c1, c2] = POS_COLORS[p.pos];
  return `<div class="pl-ava" style="background:linear-gradient(135deg,${c1},${c2})">${p.pos}</div>
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
  v.innerHTML = `<div class="hero-grad"></div>
    <div class="stat-grid">
      <div class="stat pop"><div class="v">${faNum(d.total)}</div><div class="k">امتیاز هفته ${faNum(d.gwId)}</div></div>
    </div>
    <div class="card">${d.players.map(p => `
      <div class="lb-row"><div class="lb-pos ${p.slot <= 11 ? '' : 'muted'}">${faNum(p.slot)}</div>
      <div class="lb-name"><div class="n">${p.fa_name} ${p.pts > 0 ? `<b class="num" style="color:var(--green)">+${faNum(p.pts)}</b>` : p.pts < 0 ? `<b class="num" style="color:var(--red)">${faNum(p.pts)}</b>` : ''}</div>
      <div class="muted small">${p.club} · ${posFa[p.pos]} · ${faNum(p.minutes || 0)}'${p.goals ? ` · ⚽${faNum(p.goals)}` : ''}${p.assists ? ` · 🅰${faNum(p.assists)}` : ''}</div></div></div>`).join('')}
    </div>`;
}

/* ============ FIXTURES ============ */
async function renderFixtures(gwId) {
  const v = document.getElementById('view');
  const d = await api('/fixtures' + (gwId ? '/' + gwId : ''));
  const { rows } = { rows: null };
  const gws = Array.from({ length: 5 }, (_, i) => d.gwId - 2 + i).filter(g => g >= 1);
  v.innerHTML = `<div class="hero-grad"></div>
    <div class="chips">${gws.map(g => `<button class="chip ${g === d.gwId ? 'on' : ''}" data-gw="${g}">هفته ${faNum(g)}</button>`).join('')}</div>
    ${d.fixtures.map(f => `
      <div class="fx">
        <div class="t a">${f.home}</div>
        <div class="sc ${f.finished ? '' : 'live'}">${f.finished ? `${faNum(f.home_goals)} - ${faNum(f.away_goals)}` : new Date(f.kickoff).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</div>
        <div class="t b">${f.away}</div>
      </div>`).join('') || '<p class="muted small">بازی‌ای ثبت نشده.</p>'}`;
  v.querySelectorAll('[data-gw]').forEach(b => b.onclick = () => renderFixtures(+b.dataset.gw));
}

/* ============ LEAGUES ============ */
async function renderLeagues() {
  const v = document.getElementById('view');
  const list = await api('/leagues').catch(() => []);
  v.innerHTML = `<div class="hero-grad"></div>
    <div class="row" style="gap:10px;margin-bottom:14px">
      <button class="btn" id="btn-new" style="flex:1">🏟 لیگ جدید</button>
      <button class="btn ghost" id="btn-join" style="flex:1">🔑 عضویت با کد</button>
    </div>
    ${list.length ? list.map(l => `<div class="pl-card" data-lg="${l.id}">
      <div class="pl-ava" style="background:linear-gradient(135deg,#fde047,#eab308)">🏆</div>
      <div class="pl-info"><div class="pl-name">${l.name}</div><div class="pl-club">${faNum(l.members)} بازیکن · کد: ${l.code}</div></div></div>`).join('')
      : '<div class="card"><p class="muted small" style="line-height:2">هنوز لیگی نداری! یک لیگ بساز، کدش را با دوستانت قسمت کن و ببینید کی بهتر تیم می‌چیند. 😎</p></div>'}`;
  v.querySelector('#btn-new').onclick = () => sheet(`<h3>لیگ جدید</h3>
    <input id="ln" type="text" placeholder="نام لیگ (مثلاً همکاران اداره)">
    <p class="muted small" style="margin:10px 0">کد ۶ حرفی ساخته می‌شود؛ به دوستانت بده.</p>
    <button class="btn" id="mk">ساخت لیگ</button>`) || (document.getElementById('mk').onclick = async () => {
      try {
        const l = await api('/league', { method: 'POST', body: JSON.stringify({ name: document.getElementById('ln').value }) });
        closeSheet(); confetti();
        renderLeague(l.id);
      } catch (e) { toast(e.message, 'err'); }
    });
  v.querySelector('#btn-join').onclick = () => sheet(`<h3>عضویت با کد</h3>
    <input id="jc" type="text" placeholder="کد ۶ حرفی" style="letter-spacing:6px;text-align:center;font-family:var(--font-num)">
    <button class="btn" id="jk" style="margin-top:12px">عضویت</button>`) || (document.getElementById('jk').onclick = async () => {
      try {
        const l = await api('/league/join', { method: 'POST', body: JSON.stringify({ code: document.getElementById('jc').value }) });
        toast('به لیگ اضافه شدی! ✅', 'ok'); closeSheet(); renderLeague(l.id);
      } catch (e) { toast(e.message, 'err'); }
    });
  v.querySelectorAll('[data-lg]').forEach(el => el.onclick = () => renderLeague(+el.dataset.lg));
}

async function renderLeague(id) {
  const v = document.getElementById('view');
  const t = await api('/league/' + id);
  v.innerHTML = `<div class="hero-grad"></div>
    <div class="card glow">
      <div class="h-title">🏆 ${t.league.name}</div>
      <div class="code-box"><span class="muted small">کد دعوت</span><b>${t.league.code}</b>
      <button class="btn sm ghost" id="share">مشارکت</button></div>
    </div>
    ${t.members.map((m, i) => lbRow({ team_name: m.team_name, first_name: m.username || '', total_points: m.total }, i)).join('')}`;
  document.getElementById('share').onclick = () => {
    const url = `https://t.me/share/url?url=${encodeURIComponent(cfgLink())}&text=${encodeURIComponent(`توی فانتزی لیگ برتر بیا! کد لیگ: ${t.league.code}`)}`;
    tg?.openTelegramLink(url);
  };
}
function cfgLink() { return location.origin + location.pathname; }

/* ============ LEADERBOARD ============ */
async function renderLeaderboard() {
  const v = document.getElementById('view');
  const lb = await api('/leaderboard');
  v.innerHTML = `<div class="hero-grad"></div>
    <div class="card glow" style="text-align:center">
      <div style="font-size:34px">🥇</div><div class="h-title" style="justify-content:center">لیدربورد کل</div>
    </div>${lb.map((r, i) => lbRow(r, i)).join('')}`;
}

/* ============ PROFILE ============ */
async function renderProfile() {
  const v = document.getElementById('view');
  const me = await api('/me');
  state.me = me;
  v.innerHTML = `<div class="hero-grad"></div>
    <div class="card glow" style="text-align:center">
      <div style="font-size:40px">👤</div>
      <div class="h-title" style="justify-content:center;margin-top:8px">${me.user.name || 'بازیکن'}</div>
      <p class="muted small">${me.user.username ? '@' + me.user.username : ''} · ID: <span class="num">${me.user.id}</span></p>
      <div class="row" style="justify-content:center;gap:14px;margin-top:10px">
        <div><b class="num" style="font-size:20px;color:var(--gold2)">${faNum(me.entry.total_points)}</b><div class="muted small">امتیاز</div></div>
        <div><b class="num" style="font-size:20px">${faNum(me.entry.overall_rank || '—')}</b><div class="muted small">رتبه</div></div>
        <div><b class="num" style="font-size:20px">${faNum(me.leagues)}</b><div class="muted small">لیگ</div></div>
      </div>
    </div>
    <div class="card">
      <div class="h-title">📝 نام تیم</div>
      <input id="tn" type="text" value="${me.entry.team_name || ''}">
      <button class="btn sm" id="savetn" style="margin-top:10px">ذخیره</button>
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
    // reuse squad save with teamName only — send existing squad
    const slots = me.squad.map(s => ({ player_id: s.player_id, slot: s.slot, is_captain: s.is_captain, is_vice: s.is_vice }));
    if (slots.length === 15) {
      await api('/squad', { method: 'POST', body: JSON.stringify({ slots, teamName: document.getElementById('tn').value }) });
      toast('ذخیره شد ✅', 'ok');
    } else toast('اول تیم ۱۵ نفره را بساز', 'err');
  };
}

/* ============ ADMIN ============ */
async function renderAdmin() {
  const v = document.getElementById('view');
  v.innerHTML = `<div class="hero-grad"></div>
    <div class="card"><div class="h-title">⚙️ پنل مدیریت</div>
      <button class="btn sm" id="a-sync" style="margin-bottom:8px">sync فیکسچرهای فصل</button>
      <input id="a-gw" type="text" placeholder="شماره هفته برای finish" style="margin-bottom:8px">
      <button class="btn sm red" id="a-finish">بستن هفته و محاسبه امتیاز</button>
      <p class="muted small" style="margin-top:10px">ورود آمار بازیکنان از طریق /admin signal در بات.</p>
    </div>`;
  document.getElementById('a-sync').onclick = async () => {
    try { const r = await api('/admin/sync-season', { method: 'POST' }); toast(`sync: ${r.fixtures} جدید، ${r.updated} آپدیت`, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('a-finish').onclick = async () => {
    try { const r = await api('/admin/finish-gw/' + document.getElementById('a-gw').value, { method: 'POST' }); toast(`هفته بسته شد — ${r.playersScored} بازیکن`, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
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
