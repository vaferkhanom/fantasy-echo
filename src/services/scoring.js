'use strict';
/*
 * FPL-accurate scoring engine.
 * Exact FPL point values (fantasy.premierleague.com/help/rules):
 *  - Playing up to 60 minutes: +1   |  Playing 60+ minutes: +2
 *  - Goal: GKP/DEF +6, MID +5, FWD +4
 *  - Assist: +3
 *  - Clean sheet (60+ mins): GKP/DEF +4, MID +1
 *  - Every 3 saves by GK: +1
 *  - Penalty save: +5 | Penalty miss: -2
 *  - Every 2 goals conceded by team while player on pitch (GKP/DEF): -1
 *  - Bonus: top 3 players by BPS get 3/2/1
 *  - Own goal: -2 | Yellow: -1 | Red: -3
 */

const POS_GOAL = { GKP: 6, DEF: 6, MID: 5, FWD: 4 };
const POS_CS = { GKP: 4, DEF: 4, MID: 1, FWD: 0 };

// BPS weights (FPL-style bonus points system, key actions)
const BPS = {
  minutes90: 35, minutes60: 30, minutesLt60: 3,
  goal: 24, goalGKDEF: 50, assist: 9,
  save: 3, penSave: 15, penMiss: -6,
  yellow: -3, red: -9, ownGoal: -6,
  conceded2: -1, cleanSheetGK: 12, cleanSheetDEF: 12,
  wonPenalty: 12
};

function basePoints(st, pos, conceded) {
  // st: {minutes, goals, assists, saves, pen_saved, pen_missed, yellow, red, own_goal}
  let p = 0;
  if (st.minutes > 0 && st.minutes < 60) p += 1;
  else if (st.minutes >= 60) p += 2;
  const goalPts = POS_GOAL[pos] || 4;
  p += goalPts * (st.goals || 0);
  p += 3 * (st.assists || 0);
  if (st.minutes >= 60 && (conceded === 0 || conceded === undefined)) p += POS_CS[pos] || 0;
  if (pos === 'GKP') p += Math.floor((st.saves || 0) / 3);
  p += 5 * (st.pen_saved || 0);
  p -= 2 * (st.pen_missed || 0);
  if (pos === 'GKP' || pos === 'DEF') p -= Math.floor((conceded || 0) / 2);
  p -= 2 * (st.own_goal || 0);
  p -= 1 * (st.yellow || 0);
  p -= 3 * (st.red || 0);
  return p;
}

function bpsScore(st, pos, conceded, extra) {
  let b = 0;
  if (st.minutes >= 90) b += BPS.minutes90;
  else if (st.minutes >= 60) b += BPS.minutes60;
  else if (st.minutes > 0) b += BPS.minutesLt60;
  if (pos === 'GKP' || pos === 'DEF') b += BPS.goalGKDEF * (st.goals || 0);
  else b += BPS.goal * (st.goals || 0);
  b += BPS.assist * (st.assists || 0);
  b += BPS.save * (st.saves || 0);
  b += BPS.penSave * (st.pen_saved || 0);
  b += BPS.penMiss * (st.pen_missed || 0);
  b += BPS.yellow * (st.yellow || 0);
  b += BPS.red * (st.red || 0);
  b += BPS.ownGoal * (st.own_goal || 0);
  if ((conceded || 0) === 0 && st.minutes >= 60) {
    b += pos === 'GKP' ? BPS.cleanSheetGK : pos === 'DEF' ? BPS.cleanSheetDEF : 0;
  }
  if (pos === 'GKP' || pos === 'DEF') b += BPS.conceded2 * Math.floor((conceded || 0) / 2);
  if (extra && extra.pen_won) b += BPS.wonPenalty * extra.pen_won;
  if (extra && extra.bps_bonus) b += extra.bps_bonus;
  return Math.max(b, 0);
}

/*
 * statsByPlayer: { playerId: {minutes, goals, assists, saves, pen_saved, pen_missed, yellow, red, own_goal, pen_won} }
 * concededByClub: { clubId: goalsConceded }
 * playersById: { id: {pos, club_id} }
 * Returns { playerId: {pts, bps, minutes, bonus} }
 */
function scoreFixture(statsByPlayer, concededByClub, playersById) {
  const rows = [];
  for (const [pid, st] of Object.entries(statsByPlayer)) {
    const pl = playersById[pid];
    if (!pl) continue;
    const conceded = concededByClub[pl.club_id] ?? 0;
    const bps = bpsScore(st, pl.pos, conceded, st);
    const pts = basePoints(st, pl.pos, conceded);
    rows.push({ playerId: Number(pid), pts, bps, minutes: st.minutes || 0 });
  }
  // Bonus: distinct BPS ranks get 3/2/1 (ties share the higher value, FPL-style)
  rows.sort((a, b) => b.bps - a.bps);
  const bonuses = {};
  let distinctRank = 0, prevBps = null;
  for (const r of rows) {
    if (r.bps <= 0) break;
    if (r.bps !== prevBps) { distinctRank++; prevBps = r.bps; }
    if (distinctRank > 3) break;
    bonuses[r.playerId] = 4 - distinctRank;
  }
  for (const r of rows) {
    r.pts += bonuses[r.playerId] || 0;
    r.bonus = bonuses[r.playerId] || 0;
  }
  const out = {};
  for (const r of rows) out[r.playerId] = { pts: r.pts, bps: r.bps, minutes: r.minutes, bonus: r.bonus };
  return out;
}

module.exports = { basePoints, bpsScore, scoreFixture, BPS };
