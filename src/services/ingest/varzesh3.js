'use strict';
/* Varzesh3 (ورزش سه) match data fetcher — Iranian league match centre pages.
 * Provides: score, events (goals w/ assists, cards, subs w/ minutes), lineups, bench.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const LEAGUE_MATCHES = 'https://www.varzesh3.com/football/league/6/%D9%84%DB%8C%DA%AF-%D8%A8%D8%B1%D8%AA%D8%B1-%D8%A7%DB%8C%D8%B1%D8%A7%D9%86/%D8%A8%D8%A7%D8%B2%DB%8C-%D9%87%D8%A7';

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'fa,en;q=0.8' },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error(`v3 ${res.status}`);
  return res.text();
}

const API = 'https://web-api.varzesh3.com/v2.0';
async function apiGet(path) {
  const res = await fetch(API + path, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error(`v3api ${res.status}`);
  return res.json();
}

const SEASON = 903038, LEAGUE = 6;

/* All played rounds: [{round:'هفته N', matches:[{id, week?, host:{id,name}, guest, goals:{host,guest}, status, date, time}]}] */
async function resultsAll() {
  const rounds = new Map();
  for (const skip of [0, 9, 18, 27, 36, 45]) {
    let data;
    try { data = await apiGet(`/football/leagues/${LEAGUE}/seasons/${SEASON}/results?skip=${skip}`); }
    catch (e) { break; }
    if (!data.items || !data.items.length) break;
    for (const r of data.items) {
      if (!rounds.has(r.round)) rounds.set(r.round, r);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  return [...rounds.values()];
}

async function matchDetail(v3id) {
  return apiGet(`/football/matches/${v3id}`);
}

function cleanText(html) {
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // convert event icons to text tokens
  t = t.replace(/<img[^>]*alt="([^"]+)"[^>]*icons\/([a-z-]+)\.svg[^>]*>/gi, ' [ICON:$1] ');
  t = t.replace(/<img[^>]*icons\/([a-z-]+)\.svg[^>]*alt="([^"]+)"[^>]*>/gi, ' [ICON:$2] ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;|&#x27;|&quot;/g, m => ({ '&nbsp;': ' ', '&#x27;': "'", '&quot;': '"' }[m]));
  return t.replace(/\s+/g, ' ').trim();
}

function pickOccurrence(text, keyword, validator, startFrom = 0) {
  let idx = text.indexOf(keyword, startFrom);
  while (idx >= 0) {
    const window = text.slice(idx, idx + 2500);
    if (validator(window)) return idx;
    idx = text.indexOf(keyword, idx + keyword.length);
  }
  return -1;
}

/* All current matches: [{v3id, home, away, scoreH, scoreA, status}] */
async function leagueMatches() {
  const html = await fetchHtml(LEAGUE_MATCHES);
  const out = [];
  const seen = new Set();
  const re = /href="(\/football\/match\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const path = m[1], id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const texts = [...m[3].matchAll(/>([^<>]{1,60})</g)].map(x => x[1].trim()).filter(Boolean);
    // played: [home, H, '-', A, away]; upcoming: [home, time, away]
    let home = texts[0] || '', away = '', scoreH = null, scoreA = null, timeText = '';
    if (texts.length >= 5 && texts[2] === '-' && /^\d+$/.test(texts[1]) && /^\d+$/.test(texts[3])) {
      scoreH = Number(texts[1]); scoreA = Number(texts[3]); away = texts[4];
    } else if (texts.length >= 3) {
      timeText = texts[1]; away = texts[2];
    }
    if (home && away) out.push({ v3id: id, path, home, away, scoreH, scoreA, timeText });
  }
  return out;
}

/* Full report text for one match, compacted for the LLM. */
async function matchReport(path) {
  const html = await fetchHtml(`https://www.varzesh3.com${path}`).catch(() => null);
  if (!html) return null;
  const text = cleanText(html);
  const head = text.slice(0, text.indexOf('اتفاقات بازی') > 0 ? text.indexOf('اتفاقات بازی') : 800).slice(-800);
  const hasMinute = w => /\d{1,3}'/.test(w);
  const ev0 = pickOccurrence(text, 'اتفاقات بازی', hasMinute);
  const li0 = pickOccurrence(text, 'ترکیب اصلی', w => /4-4-2|4-3-3|4-2-3-1|3-5-2|5-3-2|4-5-1|4-4-1-1|3-4-3/.test(w));
  const be0 = pickOccurrence(text, 'بازیکنان ذخیره', w => w.length > 100, li0 > 0 ? li0 : 0);
  const wk0 = text.indexOf('بازی‌های هفته', be0 > 0 ? be0 : 0);
  const events = ev0 >= 0 ? text.slice(ev0, li0 > ev0 ? li0 : ev0 + 6000).slice(0, 5000) : '';
  const lineup = li0 >= 0 ? text.slice(li0, be0 > li0 ? be0 : li0 + 3000).slice(0, 2800) : '';
  const bench = be0 >= 0 ? text.slice(be0, wk0 > be0 ? wk0 : be0 + 3000).slice(0, 2800) : '';
  // team stats pairs are [home, away]: مهار توپ (saves), کارت زرد/قرمز
  const teamStats = {};
  const sv = text.match(/مهار توپ\s+(\d+)\s+(\d+)/);
  if (sv) teamStats.saves = [Number(sv[1]), Number(sv[2])];
  const cy = text.match(/کارت زرد\s+(\d+)\s+(\d+)/);
  if (cy) teamStats.yellow = [Number(cy[1]), Number(cy[2])];
  const cr = text.match(/کارت قرمز\s+(\d+)\s+(\d+)/);
  if (cr) teamStats.red = [Number(cr[1]), Number(cr[2])];
  return { head, events, lineup, bench, teamStats };
}

module.exports = { fetchHtml, cleanText, leagueMatches, matchReport, apiGet, resultsAll, matchDetail, SEASON, LEAGUE };
