const db = require('../config/database');
const {
  generateVoucherCode,
  getExpirationMinutesForCoin
} = require('./voucherService');
const {
  allowClient,
  blockClient,
  setClientBandwidth,
  removeClientBandwidth
} = require('./networkService');
const sseService = require('./sseService');

// Cache bandwidth settings to avoid repeated DB queries (Bug #35)
let settingCache = {
  enable_bandwidth_cap: null,
  bandwidth_cap_download_mbps: null,
  bandwidth_cap_upload_mbps: null,
  enable_bandwidth_burst: null,
  bandwidth_burst_mbps: null,
  bandwidth_burst_seconds: null,
  last_check: 0
};
const SETTING_CACHE_TTL = 60000; // 1 minute

function isBandwidthCapEnabled() {
  const now = Date.now();
  if (settingCache.enable_bandwidth_cap === null || now - settingCache.last_check > SETTING_CACHE_TTL) {
    const value = db.prepare("SELECT value FROM settings WHERE key = 'enable_bandwidth_cap'").get()?.value || '0';
    settingCache.enable_bandwidth_cap = value === '1';
    settingCache.last_check = now;
  }
  return settingCache.enable_bandwidth_cap;
}

function getMaxMbps() {
  const now = Date.now();
  if (settingCache.bandwidth_cap_download_mbps === null || now - settingCache.last_check > SETTING_CACHE_TTL) {
    const value = db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_cap_download_mbps'").get()?.value || '5';
    settingCache.bandwidth_cap_download_mbps = parseInt(value, 10) || 5;
    settingCache.last_check = now;
  }
  return settingCache.bandwidth_cap_download_mbps;
}

// Bug (ROUTER_MODE_PLAN.md §12): bandwidth_cap_upload_mbps existed as a
// setting and was editable from the admin UI, but nothing ever read it -
// every setClientBandwidth() call only ever passed the download number,
// applied to both directions. Customers' actual upload speed was silently
// whatever the download cap said, not what the upload field promised.
function getMaxUploadMbps() {
  const now = Date.now();
  if (settingCache.bandwidth_cap_upload_mbps === null || now - settingCache.last_check > SETTING_CACHE_TTL) {
    const value = db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_cap_upload_mbps'").get()?.value || '5';
    settingCache.bandwidth_cap_upload_mbps = parseInt(value, 10) || 5;
    settingCache.last_check = now;
  }
  return settingCache.bandwidth_cap_upload_mbps;
}

// Real, router-enforced burst (RouterOS Simple Queue burst-limit) - not
// something that hides itself from a speed test, a genuine short-lived
// higher rate that settles back to the paid-for cap under sustained use.
// Router-mode only (see networkService.js's setClientBandwidth comment);
// returns null when disabled so callers pass burst=null and get plain
// max-limit-only shaping, same as before this existed.
function getBurstConfig() {
  const now = Date.now();
  if (settingCache.enable_bandwidth_burst === null || now - settingCache.last_check > SETTING_CACHE_TTL) {
    const enabled = db.prepare("SELECT value FROM settings WHERE key = 'enable_bandwidth_burst'").get()?.value === '1';
    const mbps = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_burst_mbps'").get()?.value || '20', 10) || 20;
    const seconds = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_burst_seconds'").get()?.value || '8', 10) || 8;
    settingCache.enable_bandwidth_burst = enabled;
    settingCache.bandwidth_burst_mbps = mbps;
    settingCache.bandwidth_burst_seconds = seconds;
    settingCache.last_check = now;
  }
  return settingCache.enable_bandwidth_burst
    ? { mbps: settingCache.bandwidth_burst_mbps, seconds: settingCache.bandwidth_burst_seconds }
    : null;
}

// Bug: mac_address is looked up with a case-sensitive exact match, but
// callers were inconsistent about casing — coin.js lowercased before
// storing, while promo.js/session.js and the portal's own MAC
// auto-detection (uppercase) did not. A session created via coin insert
// (stored lowercase) would silently show as "no active session" the moment
// the portal polled its status using the uppercase MAC it had detected —
// paid, internet unlocked, but the customer's own UI never showing it.
// Normalizing once here, centrally, means every caller gets consistent
// behavior regardless of what case they pass in.
function normalizeMac(mac) {
  return String(mac || '').trim().toLowerCase();
}

function getSessionByMac(mac) {
  return db.prepare(`
    SELECT * FROM sessions
    WHERE mac_address = ?
  `).get(normalizeMac(mac));
}

function getSessionByVoucher(voucherCode) {
  return db.prepare(
    'SELECT * FROM sessions WHERE voucher_code = ?'
  ).get(voucherCode);
}

async function createSession(mac, ip, minutes, expirationMinutes) {
  mac = normalizeMac(mac);
  const voucherCode = generateVoucherCode();
  const now = Date.now();

  // Use Math.floor for consistency (Bug #49 — floating point precision)
  const mins = Math.floor(parseFloat(minutes) || 0);
  const expMins = Math.floor(parseFloat(expirationMinutes) || mins);

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
    if (isBandwidthCapEnabled()) {
      await setClientBandwidth(mac, getMaxMbps(), getMaxUploadMbps(), getBurstConfig());
      console.log(`[Network] Bandwidth cap applied to ${mac}: ${getMaxMbps()}Mbps down / ${getMaxUploadMbps()}Mbps up`);
    } else {
      console.log(`[Network] Bandwidth cap disabled - allowing full speed for ${mac}`);
    }
  } catch(e) {
    console.error(`[Network] Failed to unlock ${mac}:`, e.message);
  }

  // Bug: the portal only found out a coin landed by polling — this pushes
  // an instant wake-up to any open portal tab for this MAC right now,
  // instead of it waiting on its next poll tick.
  sseService.notify(mac);

  return db.prepare(
    'SELECT * FROM sessions WHERE voucher_code = ?'
  ).get(voucherCode);
}

async function addTimeToSession(mac, minutes, expirationMinutes) {
  mac = normalizeMac(mac);
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
    WHERE mac_address = ?
  `).run(newMinutes, newExpiresAt, newHardExpiresAt, mac);

  // Ensure internet access is still allowed (in case of reboot)
  try {
    await allowClient(mac);
    if (isBandwidthCapEnabled()) {
      await setClientBandwidth(mac, getMaxMbps(), getMaxUploadMbps(), getBurstConfig());
    }
  } catch(e) {}

  sseService.notify(mac);

  return db.prepare(
    'SELECT * FROM sessions WHERE mac_address = ?'
  ).get(mac);
}

async function pauseSession(voucherCode) {
  const session = getSessionByVoucher(voucherCode);
  if (!session || session.is_paused === 1) return null;

  const now = new Date().toISOString();
  const remaining = Math.floor(
    (new Date(session.expires_at) - new Date()) / 60000
  );

  db.prepare(`
    UPDATE sessions
    SET is_paused = 1,
        paused_at = ?,
        minutes_remaining = ?
    WHERE voucher_code = ?
  `).run(now, Math.max(0, remaining), voucherCode);

  // Block internet access when pausing
  try {
    await blockClient(session.mac_address);
    console.log(`[Network] Internet blocked for ${session.mac_address} (paused)`);
  } catch(e) {
    console.error(`[Network] Failed to block ${session.mac_address} on pause:`, e.message);
  }

  sseService.notify(session.mac_address);

  return db.prepare(
    'SELECT * FROM sessions WHERE voucher_code = ?'
  ).get(voucherCode);
}

async function resumeSession(voucherCode) {
  const session = getSessionByVoucher(voucherCode);
  if (!session || session.is_paused === 0) return null;

  const now = new Date();
  const hardExpires = new Date(session.hard_expires_at);
  if (now >= hardExpires) {
    await expireSession(voucherCode);
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

  // Re-enable internet access when resuming
  try {
    await allowClient(session.mac_address);
    console.log(`[Network] Internet unlocked for ${session.mac_address} (resumed)`);
    if (isBandwidthCapEnabled()) {
      await setClientBandwidth(session.mac_address, getMaxMbps(), getMaxUploadMbps(), getBurstConfig());
      console.log(`[Network] Bandwidth cap reapplied to ${session.mac_address}: ${getMaxMbps()}Mbps down / ${getMaxUploadMbps()}Mbps up`);
    } else {
      console.log(`[Network] Bandwidth cap disabled - allowing full speed for ${session.mac_address}`);
    }
  } catch(e) {
    console.error(`[Network] Failed to unlock ${session.mac_address} on resume:`, e.message);
  }

  sseService.notify(session.mac_address);

  return db.prepare(
    'SELECT * FROM sessions WHERE voucher_code = ?'
  ).get(voucherCode);
}

async function expireSession(voucherCode) {
  const session = getSessionByVoucher(voucherCode);

  db.prepare(
    'DELETE FROM sessions WHERE voucher_code = ?'
  ).run(voucherCode);

  if (session && session.mac_address) {
    sseService.notify(session.mac_address);
  }

  // Bug found on real hardware: promo.js's /redeem route sets a redeemed
  // voucher's status to 'active' the moment it's used, but nothing ever
  // moved it out of that state once the session it created actually ended
  // - the admin Vouchers page showed "Active" forever for every redeemed
  // code, long after the customer's time (and internet access) was gone.
  // expireSession() is the one place every session-ending path (timer
  // expiry, admin cut, customer cancel) already funnels through, so it's
  // the right single spot to close this out. 'used' (not 'unused'/'active')
  // is what the admin UI already renders as "Expired".
  if (session && session.mac_address) {
    try {
      db.prepare(
        "UPDATE promo_vouchers SET status = 'used' WHERE mac_address = ? AND status = 'active'"
      ).run(session.mac_address);
    } catch (e) {
      console.error(`[Promo] Failed to mark voucher used for ${session.mac_address}:`, e.message);
    }
  }

  // Block internet access
  if (session && session.mac_address) {
    try {
      await blockClient(session.mac_address);
      await removeClientBandwidth(session.mac_address);
      console.log(`[Network] Internet blocked for ${session.mac_address}`);
    } catch(e) {
      console.error(`[Network] Failed to block ${session.mac_address}:`, e.message);
    }
  }
}

function getActiveSessions() {
  return db.prepare(`
    SELECT * FROM sessions
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
