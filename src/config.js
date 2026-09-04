'use strict';
const crypto = require('crypto');
module.exports = {
  token: process.env.BOT_TOKEN || '',
  port: Number(process.env.PORT || 3000),
  dbUrl: process.env.DATABASE_URL || '',
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  adminIds: (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  apiFootballKey: process.env.API_FOOTBALL_KEY || '',
  nvapiKey: process.env.NVAPI_KEY || '',
  nimModel: process.env.NIM_MODEL || 'openai/gpt-oss-20b',
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  tsdbKey: process.env.TSDB_KEY || '3',
  tz: 'Asia/Tehran',
  leetcode: {
    startBudget: 1000,
    squadSize: 15,
    maxPerClub: 3,
    squad: { GKP: 2, DEF: 5, MID: 5, FWD: 3 },
    freeTransfers: 2,
    hitCost: 4,
    benchCount: 4,
    priceRiseThreshold: 3,
    priceFallThreshold: 3,
    priceDelta: 1,
    priceChangeMax: 3
  }
};
