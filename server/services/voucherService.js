const db = require('../config/database');
const { randomInt } = require('crypto');

function generateVoucherCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'RJ-';
  for (let i = 0; i < 6; i++) {
    // crypto.randomInt(), not Math.random() - this is a real, guessable
    // secret (looked up directly by promo.js/session lookups), not just
    // an internal counter.
    code += chars.charAt(randomInt(chars.length));
  }
  const existing = db.prepare(
    'SELECT id FROM sessions WHERE voucher_code = ?'
  ).get(code);
  if (existing) return generateVoucherCode();
  return code;
}

function getRateForCoin(coinValue) {
  return db.prepare(
    'SELECT * FROM rates WHERE coin_value = ?'
  ).get(coinValue);
}

function getMinutesForCoin(coinValue) {
  const rate = getRateForCoin(coinValue);
  return rate ? rate.minutes : 0;
}

function getExpirationMinutesForCoin(coinValue) {
  const rate = getRateForCoin(coinValue);
  return rate ? rate.expiration_minutes : 0;
}

// Same 8 tiers database.js seeds at boot if the rates table is empty,
// duplicated here as a self-heal, not a second source of truth, so an
// admin opening the Rates page (or any coin credit) never sees a genuinely
// empty rate list regardless of *why* the boot-time seed didn't stick on
// a given box (multi-tenant site migrations, a table that briefly existed
// with 0 rows before a restart, etc.), getRates() below always guarantees
// at least these defaults exist before reading.
function ensureDefaultRates() {
  const count = db.prepare('SELECT COUNT(*) as count FROM rates').get().count;
  if (count > 0) return;
  const insertRate = db.prepare(
    'INSERT INTO rates (coin_value, minutes, expiration_minutes, label) VALUES (?, ?, ?, ?)'
  );
  insertRate.run(1,   5,    30,    '₱1 = 5 mins');
  insertRate.run(5,   60,   120,   '₱5 = 1 hour');
  insertRate.run(10,  120,  240,   '₱10 = 2 hours');
  insertRate.run(15,  180,  300,   '₱15 = 3 hours');
  insertRate.run(20,  300,  480,   '₱20 = 5 hours');
  insertRate.run(50,  4320, 4320,  '₱50 = 3 days');
  insertRate.run(100, 10080,10080, '₱100 = 7 days');
  insertRate.run(300, 43200,43200, '₱300 = 30 days');

  const insertPremiumRate = db.prepare(
    'INSERT INTO rates (coin_value, minutes, expiration_minutes, label, download_mbps, upload_mbps) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertPremiumRate.run(1,   1,    15,    '₱1 Premium = 1 min (10/5 Mbps)', 10, 5);
  insertPremiumRate.run(5,   15,   60,    '₱5 Premium = 15 mins (10/5 Mbps)', 10, 5);
  insertPremiumRate.run(10,  30,   120,   '₱10 Premium = 30 mins (10/5 Mbps)', 10, 5);
  insertPremiumRate.run(15,  45,   150,   '₱15 Premium = 45 mins (10/5 Mbps)', 10, 5);
  insertPremiumRate.run(20,  75,   240,   '₱20 Premium = 1hr 15min (10/5 Mbps)', 10, 5);
  insertPremiumRate.run(50,  1080, 2160,  '₱50 Premium = 18 hours (10/5 Mbps)', 10, 5);
  insertPremiumRate.run(100, 2520, 5040,  '₱100 Premium = 1.75 days (10/5 Mbps)', 10, 5);
  insertPremiumRate.run(300, 10800,21600, '₱300 Premium = 7.5 days (10/5 Mbps)', 10, 5);

  console.log('💡 Rates table was empty, reseeded default tiers');
}

function getRates() {
  ensureDefaultRates();
  return db.prepare(
    'SELECT * FROM rates ORDER BY coin_value ASC'
  ).all();
}

module.exports = {
  generateVoucherCode,
  getRateForCoin,
  getMinutesForCoin,
  getExpirationMinutesForCoin,
  getRates
};