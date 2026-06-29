const db = require('../config/database');
const {
  generateVoucherCode,
  getExpirationMinutesForCoin
} = require('./voucherService');
const { allowClient, blockClient } = require('./networkService');

function getSessionByMac(mac) {
  return db.prepare(`
    SELECT * FROM sessions 
    WHERE mac_address = ? AND status = 'active'
  `).get(mac);
}

function getSessionByVoucher(voucherCode) {
  return db.prepare(
    'SELECT * FROM sessions WHERE voucher_code = ?'
  ).get(voucherCode);
}

async function createSession(mac, ip, minutes, expirationMinutes) {
  const voucherCode = generateVoucherCode();
  const now = Date.now();

  const mins = parseFloat(minutes) || 0;
  const expMins = parseFloat(expirationMinutes) || mins;

  const expiresAt = new Date(
    now + mins * 60 * 1000
  ).toISOString();

  const hardExpiresAt = new Date(
    now + expMins * 60 * 1000
  ).toISOString();

  console.log(`Creating session: ${mins} mins, expires: ${expiresAt}, hard: ${hardExpiresAt}`);

  db.prepare(`
    INSERT INTO sessions 
    (voucher_code, mac_address, ip_address, minutes_remaining, 
     expires_at, hard_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(voucherCode, mac, ip, mins, expiresAt, hardExpiresAt);

  // Allow internet access
  try {
    await allowClient(mac);
    console.log(`[Network] Internet unlocked for ${mac}`);
  } catch(e) {
    console.error(`[Network] Failed to unlock ${mac}:`, e.message);
  }

  return db.prepare(
    'SELECT * FROM sessions WHERE voucher_code = ?'
  ).get(voucherCode);
}

async function addTimeToSession(mac, minutes, expirationMinutes) {
  const session = getSessionByMac(mac);
  if (!session) return null;

  const now = Date.now();
  const newMinutes = session.minutes_remaining + minutes;

  const newExpiresAt = new Date(
    now + newMinutes * 60 * 1000
  ).toISOString();
  const newHardExpiresAt = new Date(
    now + expirationMinutes * 60 * 1000
  ).toISOString();

  db.prepare(`
    UPDATE sessions 
    SET minutes_remaining = ?, 
        expires_at = ?,
        hard_expires_at = ?
    WHERE mac_address = ? AND status = 'active'
  `).run(newMinutes, newExpiresAt, newHardExpiresAt, mac);

  // Ensure internet access is still allowed (in case of reboot)
  try {
    await allowClient(mac);
  } catch(e) {}

  return db.prepare(
    'SELECT * FROM sessions WHERE mac_address = ? AND status = ?'
  ).get(mac, 'active');
}

function pauseSession(voucherCode) {
  const session = getSessionByVoucher(voucherCode);
  if (!session || session.is_paused === 1) return null;

  const now = new Date().toISOString();
  const remaining = (
    new Date(session.expires_at) - new Date()
  ) / 60000;

  db.prepare(`
    UPDATE sessions 
    SET is_paused = 1, 
        paused_at = ?,
        minutes_remaining = ?
    WHERE voucher_code = ?
  `).run(now, Math.max(0, remaining), voucherCode);

  return db.prepare(
    'SELECT * FROM sessions WHERE voucher_code = ?'
  ).get(voucherCode);
}

function resumeSession(voucherCode) {
  const session = getSessionByVoucher(voucherCode);
  if (!session || session.is_paused === 0) return null;

  const now = new Date();
  const hardExpires = new Date(session.hard_expires_at);
  if (now >= hardExpires) {
    expireSession(voucherCode);
    return null;
  }

  const newExpiresAt = new Date(
    now.getTime() + session.minutes_remaining * 60 * 1000
  ).toISOString();

  db.prepare(`
    UPDATE sessions 
    SET is_paused = 0, 
        paused_at = NULL,
        expires_at = ?
    WHERE voucher_code = ?
  `).run(newExpiresAt, voucherCode);

  return db.prepare(
    'SELECT * FROM sessions WHERE voucher_code = ?'
  ).get(voucherCode);
}

async function expireSession(voucherCode) {
  const session = getSessionByVoucher(voucherCode);

  db.prepare(
    'DELETE FROM sessions WHERE voucher_code = ?'
  ).run(voucherCode);

  // Block internet access
  if (session && session.mac_address) {
    try {
      await blockClient(session.mac_address);
      console.log(`[Network] Internet blocked for ${session.mac_address}`);
    } catch(e) {
      console.error(`[Network] Failed to block ${session.mac_address}:`, e.message);
    }
  }
}

function getActiveSessions() {
  return db.prepare(`
    SELECT * FROM sessions 
    WHERE status = 'active' 
    ORDER BY created_at DESC
  `).all();
}

module.exports = {
  getSessionByMac,
  getSessionByVoucher,
  createSession,
  addTimeToSession,
  pauseSession,
  resumeSession,
  expireSession,
  getActiveSessions
};