# echtasy — فانتزی لیگ برتر خلیج فارس

Fantasy football (FPL-style) for the **Iranian Persian Gulf Pro League 2026-27**, delivered as a **Telegram Mini App + Bot**.

- Persian RTL Mini App, Vazirmatn font, epic dark-gold design
- Real players (230+, 18 clubs) with realistic tier-based prices
- Full FPL scoring engine (exact point values + BPS bonus 3/2/1)
- 15-man squads (2/5/5/3), 100m budget, max 3 per club, formations, captain/vice
- Chips: Wildcard, Free Hit, Bench Boost, Triple Captain (1/each/season)
- Transfers: 2 free/GW (bank up to 5), −4 per extra hit, FPL sell-on price rule
- Auto fixtures/scores sync from TheSportsDB (league 4742) every 30 min
- Private leagues with 6-char invite codes + global leaderboard
- Telegram login (HMAC-verified initData), separate account per Telegram ID

## Architecture

```
src/
  server.js        express app + cron + bot bootstrap
  bot.js           Telegram long-polling bot (commands, admin)
  api/             REST API for the Mini App (initData auth)
  services/
    scoring.js     FPL point values + BPS
    squad.js       autosubs, formation checks
    transfers.js   free transfers, sell-on value
    chips.js       chip management
    leagues.js     league codes + tables
    entries.js     GW totals, ranks
    engine.js      finish-GW pipeline (merge signals → score → prices)
    prices.js      price engine (ownership delta ±3 → ±0.1)
    ingest/tsdb.js TheSportsDB sync
  seed/            18 clubs + ~230 real players (fa names, prices in tenths)
```

## Admin (match stats)

TheSportsDB gives results, not per-player stats. Admins enter player stats per GW:

- Bot: `/admin stat <gw> <playerId> minutes=90 goals=1 assists=0 saves=3 yellow=0 ...`
- Then `/admin finish <gw>` (or API) computes points, bonus, ranks, prices.

Signals are merged into `stats_gw`; `finishGw` is idempotent and can re-run.

## Env vars (Railway)

| var | purpose |
|---|---|
| `BOT_TOKEN` | Telegram bot token |
| `DATABASE_URL` | Postgres (Railway plugin) |
| `APP_URL` | public Mini App URL (used in bot keyboard buttons) |
| `ADMIN_IDS` | comma-separated Telegram IDs of admins |
| `SESSION_SECRET` | random string |
| `TSDB_KEY` | TheSportsDB key (default `3`) |

## Price criteria (documented policy)

Base by club tier (Big4 = Persepolis/Esteghlal/Tractor/Sepahan): GK 4.5, DEF 4.5, MID/FWD 5.5; −0.5 per tier below. Star multiplier for national-team/foreign stars (e.g. Hosseinzadeh 9.5, Alipour 8.5, Asani 8.5, Beiranvand 6.5). Floor 4.0, ceiling 13.0. Prices live-move ±0.1 by ownership delta ≥3 (max 3 steps/GW, floor 4.0).

## Local dev

```
npm install
DATABASE_URL=postgres://... BOT_TOKEN=... APP_URL=https://... npm start
# or one-shot: npm run seed
```
