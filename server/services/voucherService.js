const db = require('../config/database');

function generateVoucherCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'RJ-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
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

function getRates() {
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