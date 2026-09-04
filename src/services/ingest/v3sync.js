'use strict';
/* Sync fixtures + scores from varzesh3 JSON API (full season, all rounds). */
const { query } = require('../../db');
const v3 = require('./varzesh3');
const { teamMatch } = require('./auto');

// Jalali -> Gregorian (canonical algorithm)
function div(a, b) { return ~~(a / b); }
function mod(a, b) { return a - ~~(a / b) * b; }
function jalCal(jy) {
  const breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  const bl = breaks.length, gy = jy + 621;
  let leapJ = -14, jp = breaks[0], jm, jump, leapG, march, n, i;
  if (jy < jp || jy >= breaks[bl - 1]) throw new Error('invalid jalaali year');
  for (i = 1; i < bl; i++) {
    jm = breaks[i]; jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ++;
  leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  march = 20 + leapJ - leapG;
  return { gy, march };
}
function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}
function j2d(jy, jm, jd) {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}
function d2g(jdn) {
  let l = jdn + 68569;
  const n = Math.floor((4 * l) / 146097);
  l = l - Math.floor((146097 * n + 3) / 4);
  const i = Math.floor((4000 * (l + 1)) / 1461001);
  l = l - Math.floor((1461 * i) / 4) + 31;
  const j = Math.floor((80 * l) / 2447);
  const d = l - Math.floor((2447 * j) / 80);
  l = Math.floor(j / 11);
  const m = j + 2 - 12 * l;
  const y = 100 * (n - 49) + i + l;
  return { gy: y, gm: m, gd: d };
}
function j2g(jy, jm, jd) {
  return d2g(j2d(jy, jm, jd));
}
const FA_MONTHS = {
  'فروردین': 1, 'اردیبهشت': 2, 'خرداد': 3, 'تیر': 4, 'مرداد': 5, 'شهریور': 6,
  'مهر': 7, 'آبان': 8, 'آذر': 9, 'دی': 10, 'بهمن': 11, 'اسفند': 12
};
const FA_DIGITS = { '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9 };
function faNum(s) {
  return String(s || '').replace(/[۰-۹]/g, d => FA_DIGITS[d]);
}
function parseJalaliDate(s) {
  // "1405/06/01" or "11 شهریور 1405" (also Persian digits)
  try {
    const t = faNum(String(s || '').replace(/[\u200c]/g, ' '));
    let y, m, d;
    const slash = t.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (slash) { y = +slash[1]; m = +slash[2]; d = +slash[3]; }
    else {
      const mt = t.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
      if (!mt) return null;
      y = Number(mt[3]); m = FA_MONTHS[mt[2]]; d = Number(mt[1]);
      if (!m) return null;
    }
    const g = j2g(y, m, d);
    return `${g.gy}-${String(g.gm).padStart(2, '0')}-${String(g.gd).padStart(2, '0')}`;
  } catch (_) { return null; }
}

async function clubIdByV3(v3id, faName) {
  const { rows } = await query(`SELECT id FROM clubs WHERE v3id=$1`, [String(v3id)]);
  if (rows[0]) return rows[0].id;
  const { rows: all } = await query(`SELECT id, fa_name FROM clubs`);
  const hit = all.find(c => teamMatch(c.fa_name, faName));
  if (hit) {
    await query(`UPDATE clubs SET v3id=$1 WHERE id=$2`, [String(v3id), hit.id]);
    return hit.id;
  }
  return null;
}

async function syncV3Results() {
  const rounds = await v3.resultsAll();
  let fixtures = 0, updated = 0, skipped = 0;
  for (const r of rounds) {
    const gwm = String(r.round || '').match(/(\d+)/);
    if (!gwm) continue;
    const gw = Number(gwm[1]);
    await query(`INSERT INTO gameweeks (id, name) VALUES ($1,$2)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`, [gw, `هفته ${gw}`]);
    for (const dg of (r.dates || [])) {
      const day = parseJalaliDate(dg.date);
      for (const mt of (dg.matches || [])) {
        const home = await clubIdByV3(mt.host.id, mt.host.name);
        const away = await clubIdByV3(mt.guest.id, mt.guest.name);
        if (!home || !away) { skipped++; continue; }
        const finished = mt.status === 7;
        const gh = mt.goals ? mt.goals.host : null;
        const ga = mt.goals ? mt.goals.guest : null;
        let kickoff = null;
        if (day && mt.time) {
          const tm = faNum(mt.time).match(/(\d{1,2}):(\d{2})/);
          if (tm) kickoff = new Date(`${day}T${tm[1].padStart(2, '0')}:${tm[2]}:00+03:30`);
        }
        const { rows: ex } = await query(
          `SELECT id FROM fixtures WHERE varzesh3_id=$1`, [String(mt.id)]);
        if (ex[0]) {
          await query(
            `UPDATE fixtures SET home_goals=$1, away_goals=$2, finished=$3,
              kickoff=COALESCE($4, kickoff), gw_id=$5 WHERE id=$6`,
            [gh, ga, finished, kickoff, gw, ex[0].id]);
          updated++;
        } else {
          const { rows: same } = await query(
            `SELECT id FROM fixtures WHERE gw_id=$1 AND home_club=$2 AND away_club=$3`,
            [gw, home, away]);
          if (same[0]) {
            await query(
              `UPDATE fixtures SET varzesh3_id=$1, home_goals=$2, away_goals=$3, finished=$4,
                kickoff=COALESCE($5, kickoff) WHERE id=$6`,
              [String(mt.id), gh, ga, finished, kickoff, same[0].id]);
            updated++;
          } else {
            await query(
              `INSERT INTO fixtures (gw_id, varzesh3_id, home_club, away_club, kickoff, home_goals, away_goals, finished, source)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'v3')`,
              [gw, String(mt.id), home, away, kickoff, gh, ga, finished]);
            fixtures++;
          }
        }
      }
    }
  }
  return { fixtures, updated, skipped, rounds: rounds.length };
}

module.exports = { syncV3Results, parseJalaliDate };
