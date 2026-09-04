const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomInt } = require('crypto');

// Pre-create upload directory on startup (Bug #16)
const uploadPath = path.join(__dirname, '../../public/portal/assets');
try {
  fs.mkdirSync(uploadPath, { recursive: true });
} catch(e) {
  console.warn('Warning: could not create upload directory:', e.message);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Double-check directory exists (Bug #16)
    if (!fs.existsSync(uploadPath)) {
      return cb(new Error('Upload directory does not exist'));
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const type = req.params.type;
    const ext = path.extname(file.originalname);
    // logo/banner are singular settings, always the same filename by design
    // (overwrite the one global image). Voucher-group logos are per-group,
    // so they need a unique filename or every group would overwrite the
    // same "voucher.png" and all print with whichever was uploaded last.
    // Bug found live: 'promo' and 'rental_wallpaper' are BOTH multi-item
    // lists (promo_banner_images/rental_wallpapers tables can hold many
    // rows) but were missing this same uniqueness suffix - every upload
    // wrote to the identical "promo.jpg"/"rental_wallpaper.jpg" path,
    // physically overwriting the previous image on disk. The DB ended up
    // with N distinct rows that all pointed at the one most-recently-
    // uploaded file, so the portal's carousel correctly rotated through
    // N slots that were all visually identical - looked like "only 1
    // image" even though the rotation logic itself was working fine.
    const suffix = (type === 'voucher' || type === 'promo' || type === 'rental_wallpaper') ? `-${Date.now()}` : '';
    cb(null, `${type}${suffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('Images only!'));
  }
});

// ESP32 vendo firmware (.bin) storage, same reasoning as DB_PATH/
// FINANCIAL_LOG_DIR living outside the app directory (server/config/
// database.js, server/services/financialLogService.js): a re-clone or
// reset of the app directory shouldn't be able to wipe out the currently-
// deployed firmware.
const firmwareDir = process.env.VENDO_FIRMWARE_DIR || path.join(__dirname, '../../data/firmware');
try {
  fs.mkdirSync(firmwareDir, { recursive: true });
} catch(e) {
  console.warn('Warning: could not create firmware directory:', e.message);
}
const firmwarePath = path.join(firmwareDir, 'latest.bin');
const firmwareUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, firmwareDir),
    filename: (req, file, cb) => cb(null, 'latest.bin'),
  }),
  limits: { fileSize: 4 * 1024 * 1024 }, // ESP32 flash partitions are well under this
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.bin') cb(null, true);
    else cb(new Error('Firmware must be a .bin file'));
  }
});

// Movies > Online's bulk TMDb-id import (a plain .txt list, one id per
// line) - kept in memory only, never written to disk, since it's parsed
// once and discarded (unlike the disk-backed uploads above, which are
// long-lived assets).
const idListUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.txt') cb(null, true);
    else cb(new Error('Please upload a .txt file'));
  }
});

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { hashPassword, verifyPassword } = require('../utils/passwordHash');
const { z, validateBody } = require('../utils/validation');
const { encryptSecret, decryptSecret } = require('../utils/secretCrypto');
const totpService = require('../services/totpService');
const crypto = require('crypto');
const { getActiveSessions, expireSession, pauseSession, resumeSession } = require('../services/sessionService');
const { getRates } = require('../services/voucherService');
const { checkSpam, recordAttempt, clearAttempts } = require('../services/spamService');
const kioskService = require('../services/satelliteKioskService');
const os = require('os');
const { exec, execSync, execFile } = require('child_process');

// No reverse proxy sits in front of this server (setup/nginx.conf is an
// unused empty placeholder), so the raw socket address is the real client IP.
function getRealClientIp(req) {
  const raw = (req.connection.remoteAddress || req.socket.remoteAddress || '')
    .replace('::ffff:', '').trim();
  // WAN admin access now goes through nginx (setup/nginx.conf), which always
  // connects from loopback and sets X-Forwarded-For to the real client IP.
  // Only trust that header when the TCP connection itself is from loopback,
  // a remote attacker can set whatever X-Forwarded-For they like, but they
  // cannot make their own raw socket connection originate from 127.0.0.1,
  // so this can't be spoofed by anyone except nginx itself. LAN clients
  // (never proxied, DNAT'd straight to this app) fall through to raw below.
  if (raw === '127.0.0.1' || raw === '::1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return raw;
}

// ===== 2FA SESSION TOKENS =====
// Only relevant once admin_2fa_enabled is turned on (opt-in, off by
// default - see Phase 9 of BETA_LAUNCH_PLAN.md). When 2FA is off, nothing
// below is touched and adminAuth behaves exactly as it always has (raw
// password on every request) - zero change, zero risk to what's already
// tested. When 2FA is on, POST /login (below) is the one place that
// checks the OTP code, then issues a short-lived session token; every
// other request authenticates with that token instead of re-sending the
// password+OTP on every single API call (which would break within 30s of
// the OTP rotating, since the SPA makes many rapid successive requests).
// In-memory only, same pattern as spamService's attempt tracking - a
// restart simply requires logging in again, which is an acceptable
// tradeoff for a login-session store, not a security gap.
const sessionTokens = new Map();
const SESSION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function issueSessionToken() {
  const token = 'sess_' + crypto.randomBytes(32).toString('hex');
  sessionTokens.set(token, Date.now() + SESSION_TOKEN_TTL_MS);
  return token;
}

function isValidSessionToken(token) {
  if (!token || !token.startsWith('sess_')) return false;
  const expiresAt = sessionTokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    sessionTokens.delete(token);
    return false;
  }
  return true;
}

// Bug: the admin SPA sends the raw password header on every single API
// call (dozens per page - see comment below), and verifyPassword() runs
// crypto.scryptSync on every one of them. scryptSync is deliberately slow
// and CPU-blocking, and Node is single-threaded, so a page that fires many
// requests at once (e.g. the dashboard's Promise.all) couldn't actually run
// them in parallel server-side - each one blocked the whole process for its
// full hash duration, serializing everything and making "fast" pages take
// several seconds to load. This cache lets repeat requests with the same
// already-verified password skip re-hashing for a few seconds, without
// changing the auth model or requiring any frontend change - the real
// scrypt check still runs on first use per password, and the cache entry
// disappears fast enough that a password change is never meaningfully
// delayed in taking effect.
const verifiedPasswordCache = new Map();
const VERIFIED_PASSWORD_TTL_MS = 10 * 1000;

function isRecentlyVerified(password, expectedHash) {
  const entry = verifiedPasswordCache.get(password);
  if (!entry) return false;
  if (entry.hash !== expectedHash || Date.now() > entry.expiresAt) {
    verifiedPasswordCache.delete(password);
    return false;
  }
  return true;
}

function rememberVerified(password, hash) {
  verifiedPasswordCache.set(password, { hash, expiresAt: Date.now() + VERIFIED_PASSWORD_TTL_MS });
}

// Admin auth middleware
// NOTE: Passwords stored in plaintext (Bug #10). Acceptable for offline single-admin deployments.
// For wider deployment, consider: bcrypt hashing, OAuth2, or certificate-based auth.
//
// Bug: there was no rate limiting at all here, with a plaintext password
// and no dedicated /login route (the admin panel authenticates by sending
// the password header on every request, starting with GET /settings), an
// attacker could brute-force the admin password with unlimited requests.
// Reuses the same spamService already used for coin/session-action abuse.
function adminAuth(req, res, next) {
  const ip = getRealClientIp(req);
  const spamCheck = checkSpam(`admin-auth:${ip}`);
  if (spamCheck.blocked) {
    return res.status(429).json({ success: false, message: spamCheck.message });
  }

  const { password } = req.headers;

  // A valid session token (issued by POST /login once 2FA passed) is
  // accepted in the exact same header slot the raw password already uses
  // - no new header needed, no frontend change required for installs that
  // never enable 2FA. A "sess_" prefix can never collide with a real
  // password (verifyPassword would just fail on it normally), so checking
  // this first is safe either way.
  if (isValidSessionToken(password)) {
    clearAttempts(`admin-auth:${ip}`);
    return next();
  }

  const settings = db.prepare(
    "SELECT value FROM settings WHERE key = 'admin_password'"
  ).get();
  if (!password || !settings) {
    recordAttempt(`admin-auth:${ip}`);
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const passwordOk = isRecentlyVerified(password, settings.value) || verifyPassword(password, settings.value);
  if (!passwordOk) {
    recordAttempt(`admin-auth:${ip}`);
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  rememberVerified(password, settings.value);

  // If 2FA is enabled, a raw password alone is no longer sufficient on its
  // own for ANY request - it must come through POST /login (which checks
  // the OTP too) and use the resulting session token instead. This closes
  // the gap where enabling 2FA would otherwise only protect the login
  // screen while every other endpoint still accepted the bare password.
  const twoFaEnabled = db.prepare("SELECT value FROM settings WHERE key = 'admin_2fa_enabled'").get()?.value === '1';
  if (twoFaEnabled) {
    return res.status(401).json({ success: false, message: 'This account requires 2FA login. Use the login screen.', requires2fa: true });
  }

  clearAttempts(`admin-auth:${ip}`);
  next();
}

// POST /api/admin/login - the only place an OTP code is ever checked.
// Rate-limited the same way as adminAuth itself (same spamService key
// namespace scoped by IP) so this doesn't open a second brute-force door.
router.post('/login', (req, res) => {
  const ip = getRealClientIp(req);
  const spamCheck = checkSpam(`admin-auth:${ip}`);
  if (spamCheck.blocked) {
    return res.status(429).json({ success: false, message: spamCheck.message, remaining: spamCheck.remaining });
  }

  const { password, otp_token } = req.body || {};
  const settings = db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get();
  if (!password || !settings || !verifyPassword(password, settings.value)) {
    recordAttempt(`admin-auth:${ip}`);
    return res.status(401).json({ success: false, message: 'Invalid username or password.' });
  }

  const twoFaEnabled = db.prepare("SELECT value FROM settings WHERE key = 'admin_2fa_enabled'").get()?.value === '1';
  if (twoFaEnabled) {
    if (!otp_token) {
      // Password was correct - tell the frontend to prompt for the code
      // next, without yet revealing whether the eventual code will be
      // right or wrong (that check happens below, still rate-limited).
      return res.json({ success: false, requires2fa: true, message: '2FA code required.' });
    }
    const secretRow = db.prepare("SELECT value FROM settings WHERE key = 'admin_2fa_secret'").get();
    const secret = secretRow && secretRow.value ? decryptSecret(secretRow.value) : '';
    if (!secret || !totpService.verifyToken(secret, otp_token)) {
      recordAttempt(`admin-auth:${ip}`);
      return res.status(401).json({ success: false, requires2fa: true, message: 'Invalid 2FA code.' });
    }
  }

  clearAttempts(`admin-auth:${ip}`);
  const token = issueSessionToken();
  res.json({ success: true, token });
});

// GET /api/admin/sessions
router.get('/sessions', adminAuth, async (req, res) => {
  try {
    const sessions = getActiveSessions();
    const sessionsWithTime = sessions.map(s => ({
      ...s,
      minutes_remaining: Math.max(0, Math.floor((new Date(s.expires_at) - new Date()) / 60000))
    }));

    // Live traffic snapshot per PISO WIFI session (paying customers only -
    // not every device on the network, which is what Network Devices
    // already shows). Same per-mode sources networkDevicesService.js
    // already uses for its own traffic column - MikroTik reads the
    // client's own simple queue, Router Mode reads its tc class.
    // Best-effort: a session with no matching queue/class (most commonly a
    // MikroTik Regular-tier session, which shares a single lane-wide PCQ
    // queue instead of an individual one - see mikrotikService.js's
    // setClientBandwidth) just gets null, never a fabricated number.
    // Separate from data_used_bytes below (a DB column, already present on
    // every `s` from getActiveSessions()) - that's the accurate persisted
    // running total timerService.js's 30s tick maintains for data-capped
    // sessions specifically; this is just "what does the queue/class say
    // right now," useful as a general activity indicator for any session.
    const mikrotikService = require('../services/mikrotikService');
    const networkDevicesService = require('../services/networkDevicesService');
    const { peekClassId } = require('../services/drivers/classIdAllocator');
    const isMikrotik = mikrotikService.isMikrotikModeEnabled();

    // Real-time "is this device actually here right now" signal, same
    // discovered_via-based ARP presence check Network Devices already uses
    // (see networkDevicesService.listDevices, "online" comment there) -
    // reused rather than reimplemented so the two pages never disagree on
    // what "online" means. A session's minutes_remaining/is_paused only
    // reflect paid time, not real network presence: a customer who walked
    // away (or a MAC-duplicated device that never actually associated)
    // still has time left and used to show "Active" indefinitely with no
    // way to tell the operator's books apart from a genuinely connected
    // customer. This never cancels the session or its paid time, only
    // changes what the Status badge shows.
    let onlineByMac = new Map();
    try {
      const devices = await networkDevicesService.listDevices();
      onlineByMac = new Map(devices.map((d) => [d.mac, d.status === 'online']));
    } catch (e) {
      // Best-effort: if the device scan fails for any reason, fall back to
      // showing every session as online rather than wrongly flagging paid
      // customers as disconnected.
    }
    // Shows a real device name (e.g. "Joshs-iPhone") instead of a bare MAC
    // where one's been observed - see
    // networkDevicesService.getDisplayNames().
    const displayNames = networkDevicesService.getDisplayNames(sessionsWithTime.map((s) => s.mac_address));
    sessionsWithTime.forEach((s) => {
      const mac = String(s.mac_address || '').toLowerCase();
      s.online = onlineByMac.has(mac) ? onlineByMac.get(mac) : true;
      s.display_name = displayNames.get(mac) || null;
    });

    await Promise.all(sessionsWithTime.map(async (s) => {
      if (s.is_paused === 1) { s.live_traffic_bytes = null; } else {
        try {
          const traffic = isMikrotik
            ? await mikrotikService.getClientTraffic(s.mac_address)
            : await networkDevicesService.getTcTraffic(peekClassId(s.mac_address));
          s.live_traffic_bytes = traffic ? traffic.totalBytes : null;
        } catch (e) {
          s.live_traffic_bytes = null;
        }
      }
      // Only meaningful for a Data-type plan (data_limit_mb set at credit
      // time) - null for every other session, same as data_used_bytes
      // itself only ever being tracked when there's a cap to track against.
      s.data_remaining_bytes = s.data_limit_mb ? Math.max(0, s.data_limit_mb * 1024 * 1024 - (s.data_used_bytes || 0)) : null;
    }));

    // Bug: `count` included paused sessions, but the dashboard/sidebar/
    // sessions-page all label this "Currently Connected"/"connected",
    // a paused session has its internet blocked, so it isn't connected.
    // `count` is kept as the total row count (the table shows paused rows
    // too, correctly marked); `active_count` is the real "connected" number.
    const activeCount = sessionsWithTime.filter(s => s.is_paused !== 1).length;
    return res.json({
      success: true,
      sessions: sessionsWithTime,
      count: sessionsWithTime.length,
      active_count: activeCount
    });
  } catch (err) {
    console.error('Admin sessions error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== SATELLITE KIOSKS (see server/services/satelliteKioskService.js) =====

// GET /api/admin/satellite-kiosks
router.get('/satellite-kiosks', adminAuth, (req, res) => {
  try {
    res.json({ success: true, kiosks: kioskService.listKiosks() });
  } catch (err) {
    console.error('List satellite kiosks error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/satellite-kiosks, { name } -> returns the unmasked
// device_key exactly once, for the operator to copy into that kiosk's own
// config. It is never returned again after this response.
router.post('/satellite-kiosks', adminAuth, (req, res) => {
  try {
    const kiosk = kioskService.createKiosk(req.body.name);
    res.json({ success: true, kiosk });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PUT /api/admin/satellite-kiosks/:id, { name }
router.put('/satellite-kiosks/:id', adminAuth, (req, res) => {
  try {
    kioskService.renameKiosk(req.params.id, req.body.name);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/admin/satellite-kiosks/:id, preserves that kiosk's
// transaction history, only detaches it (see satelliteKioskService.js)
router.delete('/satellite-kiosks/:id', adminAuth, (req, res) => {
  try {
    kioskService.deleteKiosk(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ===== NETWORK DEVICES (unified inventory, see networkDevicesService.js) =====
// GET /api/admin/network-devices
router.get('/network-devices', adminAuth, async (req, res) => {
  try {
    const networkDevicesService = require('../services/networkDevicesService');
    const devices = await networkDevicesService.listDevices();
    res.json({ success: true, devices, summary: networkDevicesService.summarize(devices) });
  } catch (err) {
    console.error('Network devices list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== NETWORK DEVICES: GROUPS =====
router.get('/network-devices/groups', adminAuth, (req, res) => {
  try {
    const networkDevicesService = require('../services/networkDevicesService');
    res.json({ success: true, groups: networkDevicesService.listGroups() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/network-devices/groups', adminAuth, (req, res) => {
  try {
    const networkDevicesService = require('../services/networkDevicesService');
    const group = networkDevicesService.createGroup(req.body.name);
    res.json({ success: true, group });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete('/network-devices/groups/:id', adminAuth, (req, res) => {
  try {
    const networkDevicesService = require('../services/networkDevicesService');
    networkDevicesService.deleteGroup(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/admin/network-devices/:mac/group, { group_id } (null/absent clears it)
router.post('/network-devices/:mac/group', adminAuth, (req, res) => {
  try {
    const networkDevicesService = require('../services/networkDevicesService');
    networkDevicesService.assignDeviceGroup(req.params.mac, req.body.group_id || null);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/admin/network-devices/:mac/history
router.get('/network-devices/:mac/history', adminAuth, (req, res) => {
  try {
    const networkDevicesService = require('../services/networkDevicesService');
    res.json({ success: true, history: networkDevicesService.getDeviceHistory(req.params.mac) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/network-devices/:mac/block
router.post('/network-devices/:mac/block', adminAuth, async (req, res) => {
  try {
    const networkDevicesService = require('../services/networkDevicesService');
    await networkDevicesService.blockDevice(req.params.mac);
    res.json({ success: true });
  } catch (err) {
    console.error('Device block error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/network-devices/:mac/unblock
router.post('/network-devices/:mac/unblock', adminAuth, async (req, res) => {
  try {
    const networkDevicesService = require('../services/networkDevicesService');
    await networkDevicesService.unblockDevice(req.params.mac);
    res.json({ success: true });
  } catch (err) {
    console.error('Device unblock error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/session/:code
router.delete('/session/:code', adminAuth, async (req, res) => {
  try {
    const { code } = req.params;
    await expireSession(code);
    console.log(`✂️ Admin cut session: ${code}`);
    return res.json({ success: true, message: `Session ${code} terminated` });
  } catch (err) {
    console.error('Admin cut error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/session/:code/addtime
router.post('/session/:code/addtime', adminAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const { minutes } = req.body;

    const m = parseFloat(minutes);
    if (!Number.isFinite(m) || m === 0) {
      return res.status(400).json({ success: false, message: 'Minutes must be a non-zero number' });
    }

    const session = db.prepare(
      "SELECT * FROM sessions WHERE voucher_code = ?"
    ).get(code);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    const newMinutes = Math.max(0, session.minutes_remaining + m);
    const newExpiresAt = new Date(Date.now() + newMinutes * 60 * 1000).toISOString();

    // Keep hard_expires_at in sync (Bug: admin-added time could get silently
    // wiped, resumeSession() and GET /api/session/mac/:mac both force-expire
    // once hard_expires_at passes, regardless of minutes_remaining/expires_at.
    // Shift it by the same delta being added/removed here, never letting it
    // fall behind the new expires_at.
    const currentHardExpires = new Date(session.hard_expires_at).getTime();
    const shiftedHardExpires = currentHardExpires + m * 60 * 1000;
    const newHardExpiresAt = new Date(
      Math.max(shiftedHardExpires, new Date(newExpiresAt).getTime())
    ).toISOString();

    db.prepare(`
      UPDATE sessions SET minutes_remaining = ?, expires_at = ?, hard_expires_at = ? WHERE voucher_code = ?
    `).run(newMinutes, newExpiresAt, newHardExpiresAt, code);

    // Ensure MAC is unlocked (in case of reboot)
    try {
      const { allowClient } = require('../services/networkService');
      await allowClient(session.mac_address);
    } catch(e) {}

    console.log(`➕ Admin added ${m} mins to ${code} (new total: ${newMinutes})`);
    return res.json({
      success: true,
      message: `${m > 0 ? 'Added' : 'Removed'} ${Math.abs(m)} minutes to ${code}`,
      minutes_remaining: newMinutes
    });
  } catch (err) {
    console.error('Admin addtime error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/session/:code/pause, staff-initiated pause (e.g. a
// customer at the counter asks to pause while they step out), reusing the
// exact same pauseSession() the customer-facing portal uses.
router.post('/session/:code/pause', adminAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const session = await pauseSession(code);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found or already paused' });
    }
    console.log(`⏸️ Admin paused: ${code}`);
    return res.json({ success: true, message: `Session ${code} paused`, minutes_remaining: session.minutes_remaining });
  } catch (err) {
    console.error('Admin pause error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/session/:code/resume
router.post('/session/:code/resume', adminAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const session = await resumeSession(code);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found, not paused, or hard expiration passed' });
    }
    console.log(`▶️ Admin resumed: ${code}`);
    return res.json({ success: true, message: `Session ${code} resumed`, minutes_remaining: session.minutes_remaining });
  } catch (err) {
    console.error('Admin resume error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/sales
router.get('/sales', adminAuth, (req, res) => {
  try {
    // Bug found live: "today" was computed via `new Date().toISOString()`,
    // which is ALWAYS UTC in Node regardless of the server's own OS
    // timezone - and created_at is stored as naive UTC too (SQLite's
    // CURRENT_TIMESTAMP), so this "consistently UTC" pairing still
    // disagreed with an operator's actual local calendar day. For roughly
    // the first 8 hours of each Philippine (UTC+8) local day, this made
    // "Today's Revenue" silently show the PREVIOUS day's total instead -
    // real transactions from that morning were filtered out for still
    // matching UTC's "yesterday". Computing `today` through SQLite's own
    // 'localtime' modifier instead - the same "trust the server's OS
    // timezone" convention already established in timerService.js - and
    // using the identical modifier on every date(created_at) comparison
    // below keeps both sides of every comparison in the same timezone.
    const today = db.prepare("SELECT date('now', 'localtime') as d").get().d;

    const todaySales = db.prepare(`
      SELECT COUNT(*) as transaction_count, SUM(coin_value) as total_coins, SUM(minutes_added) as total_minutes
      FROM transactions WHERE date(created_at, 'localtime') = ? AND type = 'coin'
    `).get(today);

    // Main Kiosk (kiosk_id NULL) vs Satellite Kiosks (kiosk_id set) split -
    // see docs/tabs/satellite-kiosks.md. Combined here rather than broken
    // out per-kiosk; the Satellite Kiosks tab itself (/api/admin/satellite-
    // kiosks) already has the per-kiosk breakdown for anyone who drills in.
    const todayMainKiosk = db.prepare(`
      SELECT COUNT(*) as count, SUM(coin_value) as income
      FROM transactions WHERE date(created_at, 'localtime') = ? AND type = 'coin' AND kiosk_id IS NULL
    `).get(today);
    const todaySatelliteKiosks = db.prepare(`
      SELECT COUNT(*) as count, SUM(coin_value) as income
      FROM transactions WHERE date(created_at, 'localtime') = ? AND type = 'coin' AND kiosk_id IS NOT NULL
    `).get(today);

    const todayPromo = db.prepare(`
      SELECT COUNT(*) as promo_count, SUM(coin_value) as promo_income
      FROM transactions WHERE date(created_at, 'localtime') = ? AND type = 'promo'
    `).get(today);

    // Vouchers (printed batches, see the Move-log note in promo.js) are a
    // distinct product from a standalone one-off Promo code, split into
    // their own type at redemption time - broken out here the same way
    // Main Kiosk/Satellite Kiosks are, rather than staying folded into
    // 'promo' and being indistinguishable in reporting.
    const todayVoucher = db.prepare(`
      SELECT COUNT(*) as voucher_count, SUM(coin_value) as voucher_income
      FROM transactions WHERE date(created_at, 'localtime') = ? AND type = 'voucher'
    `).get(today);

    const todayFree = db.prepare(`
      SELECT COUNT(*) as free_count, SUM(minutes_added) as free_minutes
      FROM transactions WHERE date(created_at, 'localtime') = ? AND type = 'free'
    `).get(today);

    // Bug found live: Today's Revenue only ever summed coin+promo+voucher,
    // silently excluding movie/TV rental income (server/routes/coin.js's
    // 'movie'/'online_movie'/'tv_series' transaction types) - a real
    // mismatch against the Week/Month figures below and the Movies tab's
    // own Revenue card (both already use a `type != 'free'` EXCLUSION
    // filter, which naturally includes these; this route's `today` block
    // used narrower per-category INCLUSION filters instead, and movies/TV
    // simply had no category here at all). Added as its own category
    // (not folded into coin_income) so "Revenue by Source" can show it
    // honestly instead of misattributing it to coin sales.
    const todayMovies = db.prepare(`
      SELECT COUNT(*) as movie_count, SUM(coin_value) as movie_income
      FROM transactions WHERE date(created_at, 'localtime') = ?
        AND type IN ('movie_rental', 'online_movie_rental', 'online_movie_rental_credit', 'tv_series_rental', 'tv_series_rental_credit')
    `).get(today);

    // Real average session duration - see session_history's column comment
    // in database.js. Scoped to sessions that actually ENDED today, not
    // ones that started today (a session that started yesterday and just
    // ended belongs in today's average of "how long did a session that
    // just wrapped up actually run").
    const todaySessionDuration = db.prepare(`
      SELECT AVG(duration_seconds) as avg_seconds, COUNT(*) as ended_count
      FROM session_history WHERE date(ended_at, 'localtime') = ?
    `).get(today);

    // Dashboard's date-range pill picks this - defaults to 7 (unchanged
    // behavior for anyone not touching the picker), clamped to a sane
    // range so a stray query param can't force a full-table scan.
    const windowDays = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const weekSales = db.prepare(`
      SELECT date(created_at, 'localtime') as date,
        SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as total,
        COUNT(*) as transactions
      FROM transactions WHERE date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
      GROUP BY date(created_at, 'localtime') ORDER BY date DESC
    `).all(windowDays);

    // Bug: the admin UI showed "Monthly Sales" as weekTotal * 4, a rough
    // guess, not real data (wrong the moment revenue isn't perfectly flat
    // week to week, and dashboard.html didn't even label it an estimate).
    // Compute the real month-to-date total instead.
    const monthSales = db.prepare(`
      SELECT SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as total
      FROM transactions WHERE date(created_at, 'localtime') >= date('now', 'localtime', 'start of month')
    `).get();

    // Bug: the dashboard's Daily/Weekly/Monthly chart-range buttons never
    // actually changed what was charted, every click re-rendered the same
    // fixed 7-day view. `range` now genuinely changes the granularity;
    // `week` above is kept as-is for the "This Week" stat card, which
    // should stay accurate regardless of which chart range is selected.
    const range = ['daily', 'weekly', 'monthly'].includes(req.query.range) ? req.query.range : 'weekly';
    let chart, chartFormat;
    if (range === 'daily') {
      chart = db.prepare(`
        SELECT strftime('%H:00', created_at, 'localtime') as label,
          SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as total,
          COUNT(*) as transactions
        FROM transactions WHERE date(created_at, 'localtime') = date('now', 'localtime')
        GROUP BY strftime('%H', created_at, 'localtime') ORDER BY label ASC
      `).all();
      chartFormat = 'hour';
    } else if (range === 'monthly') {
      chart = db.prepare(`
        SELECT date(created_at, 'localtime') as label,
          SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as total,
          COUNT(*) as transactions
        FROM transactions WHERE date(created_at, 'localtime') >= date('now', 'localtime', '-30 days')
        GROUP BY date(created_at, 'localtime') ORDER BY label ASC
      `).all();
      chartFormat = 'date';
    } else {
      chart = [...weekSales].reverse().map(d => ({ label: d.date, total: d.total, transactions: d.transactions }));
      chartFormat = 'date';
    }

    // New vs Returning client activity, bucketed on the same labels as the
    // revenue chart above (hour for daily, date for weekly/monthly). A
    // client is "new" in a bucket if this is the earliest date it has ever
    // transacted (across all history, not just the visible range) -
    // "returning" otherwise. Only counts transactions with a mac_address
    // (see the column comment in database.js) - rows from before that
    // migration are silently excluded, not miscounted.
    const firstSeenRows = db.prepare(`
      SELECT mac_address, MIN(date(created_at, 'localtime')) as first_date
      FROM transactions WHERE mac_address IS NOT NULL
      GROUP BY mac_address
    `).all();
    const firstSeenByMac = new Map(firstSeenRows.map(r => [r.mac_address, r.first_date]));

    const rangeStartClause = range === 'daily' ? "date('now', 'localtime')"
      : range === 'monthly' ? "date('now', 'localtime', '-30 days')"
      : "date('now', 'localtime', '-7 days')";
    const activityRows = db.prepare(`
      SELECT mac_address, created_at, date(created_at, 'localtime') as local_date,
        ${range === 'daily' ? "strftime('%H:00', created_at, 'localtime')" : "date(created_at, 'localtime')"} as bucket
      FROM transactions
      WHERE mac_address IS NOT NULL AND date(created_at, 'localtime') >= ${rangeStartClause}
      ORDER BY created_at ASC
    `).all();

    // One entry per (bucket, mac) - a client active twice in the same
    // bucket only counts once, matching "how many distinct clients", not
    // "how many transactions".
    const seenInBucket = new Set();
    const bucketCounts = new Map(); // bucket -> { new, returning }
    for (const row of activityRows) {
      const key = `${row.bucket}|${row.mac_address}`;
      if (seenInBucket.has(key)) continue;
      seenInBucket.add(key);
      // Bug found live: this used to slice the raw created_at string
      // directly (a naive UTC value) while firstSeenByMac above is keyed
      // by localtime dates - comparing a UTC date against a localtime
      // date silently misclassified some transactions as "new" vs
      // "returning" for the same few hours each day the dashboard's own
      // revenue bug affected. Using the query's own local_date column
      // keeps both sides of this comparison in the same timezone.
      const isNew = firstSeenByMac.get(row.mac_address) === row.local_date;
      if (!bucketCounts.has(row.bucket)) bucketCounts.set(row.bucket, { new: 0, returning: 0 });
      const counts = bucketCounts.get(row.bucket);
      if (isNew) counts.new++; else counts.returning++;
    }
    const sessionActivity = chart.map(c => ({
      label: c.label,
      new: bucketCounts.get(c.label)?.new || 0,
      returning: bucketCounts.get(c.label)?.returning || 0
    }));

    // Named kiosk attribution for the Recent Transactions table - a plain
    // JOIN rather than a second round-trip from the frontend to resolve
    // kiosk_id -> name.
    const recent = db.prepare(`
      SELECT t.*, sk.name as kiosk_name
      FROM transactions t
      LEFT JOIN satellite_kiosks sk ON sk.id = t.kiosk_id
      ORDER BY t.created_at DESC LIMIT 20
    `).all();

    return res.json({
      success: true,
      today: {
        // The server's own localtime-correct "today" date string, so the
        // client never has to (mis)compute it independently via
        // new Date().toISOString() (always UTC, regardless of the
        // browser's timezone) - see the comment on this route's `today`
        // variable above for the bug this caused in the "vs yesterday"
        // trend calculation.
        date: today,
        coin_income: todaySales.total_coins || 0,
        coin_transactions: todaySales.transaction_count || 0,
        main_kiosk_income: todayMainKiosk.income || 0,
        main_kiosk_transactions: todayMainKiosk.count || 0,
        satellite_kiosk_income: todaySatelliteKiosks.income || 0,
        satellite_kiosk_transactions: todaySatelliteKiosks.count || 0,
        promo_income: todayPromo.promo_income || 0,
        // Was computed above (promo_count) but never actually returned -
        // the Hotspot Dashboard's Revenue by Source breakdown needs a
        // per-category transaction count, not just income.
        promo_transactions: todayPromo.promo_count || 0,
        voucher_income: todayVoucher.voucher_income || 0,
        voucher_transactions: todayVoucher.voucher_count || 0,
        movie_income: todayMovies.movie_income || 0,
        movie_transactions: todayMovies.movie_count || 0,
        total_income: (todaySales.total_coins || 0) + (todayPromo.promo_income || 0) + (todayVoucher.voucher_income || 0) + (todayMovies.movie_income || 0),
        transactions: todaySales.transaction_count || 0,
        minutes_sold: todaySales.total_minutes || 0,
        free_claims: todayFree.free_count || 0,
        free_minutes: todayFree.free_minutes || 0,
        avg_session_duration_seconds: Math.round(todaySessionDuration.avg_seconds || 0),
        sessions_ended_today: todaySessionDuration.ended_count || 0
      },
      week: weekSales,
      window_days: windowDays,
      month: { total_income: monthSales.total || 0 },
      chart,
      chart_format: chartFormat,
      session_activity: sessionActivity,
      recent_transactions: recent
    });

  } catch (err) {
    console.error('Admin sales error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/cash-reconciliation, an operator's own physical coin
// count for a period, checked against what the system logged as credited
// over that same window. Only 'coin' transactions count toward the
// system side, physical cash in the box only ever came from real coin
// insertions, a voucher/promo/free session never put money in the box.
// system_amount is captured now and stored, not recomputed on later
// reads, so a saved reconciliation stays a true historical snapshot.
router.post('/cash-reconciliation', adminAuth, (req, res) => {
  try {
    const { period_start, period_end, physical_amount, notes } = req.body;

    if (!period_start || !period_end) {
      return res.status(400).json({ success: false, message: 'period_start and period_end are required' });
    }
    const physical = parseFloat(physical_amount);
    if (!Number.isFinite(physical) || physical < 0) {
      return res.status(400).json({ success: false, message: 'A valid physical_amount is required' });
    }

    const row = db.prepare(`
      SELECT COALESCE(SUM(coin_value), 0) as total, COUNT(*) as count
      FROM transactions
      WHERE type = 'coin' AND created_at >= ? AND created_at <= ?
    `).get(period_start, period_end);

    const systemAmount = row.total || 0;
    const difference = Math.round((physical - systemAmount) * 100) / 100;

    const result = db.prepare(`
      INSERT INTO cash_reconciliations (period_start, period_end, physical_amount, system_amount, difference, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(period_start, period_end, physical, systemAmount, difference, (notes || '').trim() || null);

    const record = db.prepare('SELECT * FROM cash_reconciliations WHERE id = ?').get(result.lastInsertRowid);
    return res.json({ success: true, record: { ...record, transaction_count: row.count } });
  } catch (err) {
    console.error('Cash reconciliation error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/cash-reconciliation?limit=20, recent reconciliation
// history so a mismatch has a record to point back to instead of only
// existing in whatever the operator remembers from that day.
router.get('/cash-reconciliation', adminAuth, (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const records = db.prepare(`
      SELECT * FROM cash_reconciliations ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    return res.json({ success: true, records });
  } catch (err) {
    console.error('Cash reconciliation list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/analytics/summary?days=7, the Analytics page's single
// aggregation endpoint (one round trip, matching the design guide's
// ===== USERS: GUESTS =====
// GET /api/admin/users/guests?days=N - real guest (anonymous hotspot
// customer) sessions, live + recently ended. This app has no customer
// account system at all (see /users/accounts below), so "Guests" here
// covers the entire real customer base - matches the actual product,
// not a subset of it.
//
// "Source" (Coin Vendo / Voucher / Free Access) comes from a real join
// against `transactions` on voucher_code, the same linkage /sales
// already relies on. No data-usage-in-bytes field is returned - this
// app has no per-session byte counters, matching Live Sessions' own
// scope note.
router.get('/users/guests', adminAuth, (req, res) => {
  try {
    // days=0 means "today only" (date('now', '-0 days') = today's date) -
    // the previous `parseInt(...) || 7` fallback treated an explicit 0 as
    // falsy and silently widened it to 7, making "today only" impossible
    // to request at all.
    const parsedDays = parseInt(req.query.days, 10);
    const days = Math.min(Math.max(Number.isFinite(parsedDays) ? parsedDays : 7, 0), 90);

    // Bug found live: a plain LEFT JOIN to transactions fans out one row
    // PER TRANSACTION on that voucher_code, not one row per session/guest -
    // a customer who topped up more than once (e.g. inserted coins in two
    // separate batches) showed up as several duplicate "different guest
    // sessions" in this list, even though Live Sessions correctly showed
    // just the one real session. Correlated subqueries pick a single
    // representative transaction (the most recent, non-convert one) per
    // voucher_code instead, so this is back to one row per actual session.
    const active = db.prepare(`
      SELECT s.voucher_code, s.mac_address, s.ip_address, s.minutes_remaining,
        s.is_paused, s.created_at, s.hard_expires_at, s.redeemed_code,
        (SELECT t.type FROM transactions t WHERE t.voucher_code = s.voucher_code
          AND t.type != 'convert' AND t.type != 'convert_down' ORDER BY t.id DESC LIMIT 1) as source_type,
        (SELECT t.coin_value FROM transactions t WHERE t.voucher_code = s.voucher_code
          AND t.type != 'convert' AND t.type != 'convert_down' ORDER BY t.id DESC LIMIT 1) as coin_value
      FROM sessions s
      ORDER BY s.created_at DESC
    `).all();

    const ended = db.prepare(`
      SELECT sh.voucher_code, sh.mac_address, sh.started_at, sh.ended_at, sh.duration_seconds,
        (SELECT t.type FROM transactions t WHERE t.voucher_code = sh.voucher_code
          AND t.type != 'convert' AND t.type != 'convert_down' ORDER BY t.id DESC LIMIT 1) as source_type,
        (SELECT t.coin_value FROM transactions t WHERE t.voucher_code = sh.voucher_code
          AND t.type != 'convert' AND t.type != 'convert_down' ORDER BY t.id DESC LIMIT 1) as coin_value
      FROM session_history sh
      WHERE date(sh.ended_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
      ORDER BY sh.ended_at DESC LIMIT 100
    `).all(days);

    const kpiPeriod = db.prepare(`
      SELECT COUNT(*) as sessions, SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as revenue
      FROM transactions WHERE date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
    `).get(days);

    // Shows a real device name (e.g. "Joshs-iPhone") instead of a bare
    // MAC where one's been observed - see
    // networkDevicesService.getDisplayNames().
    const displayNames = require('../services/networkDevicesService').getDisplayNames([
      ...active.map((s) => s.mac_address), ...ended.map((s) => s.mac_address),
    ]);

    return res.json({
      success: true,
      active: active.map((s) => ({
        voucher_code: s.voucher_code, mac_address: s.mac_address, ip_address: s.ip_address,
        minutes_remaining: s.minutes_remaining, is_paused: s.is_paused, created_at: s.created_at,
        hard_expires_at: s.hard_expires_at, redeemed_code: s.redeemed_code,
        source_type: s.source_type, coin_value: s.coin_value,
        display_name: displayNames.get(String(s.mac_address || '').toLowerCase()) || null,
      })),
      recent: ended.map((s) => ({
        voucher_code: s.voucher_code, mac_address: s.mac_address, started_at: s.started_at,
        ended_at: s.ended_at, duration_seconds: s.duration_seconds,
        source_type: s.source_type, coin_value: s.coin_value,
        display_name: displayNames.get(String(s.mac_address || '').toLowerCase()) || null,
      })),
      kpi: { totalSessionsPeriod: kpiPeriod.sessions || 0, totalRevenuePeriod: kpiPeriod.revenue || 0, activeNow: active.filter((s) => s.is_paused !== 1).length },
    });
  } catch (err) {
    console.error('Users guests error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== USERS: DEVICES =====
// GET /api/admin/users/devices?days=N - real device list, aggregated
// from every MAC address this box has ever actually seen across
// transactions and session_history (the only two durable, permanent
// records - `sessions` itself is deleted on expiry). No vendor/OS/device-
// type field is returned - this app does no device fingerprinting, so
// that would have to be invented. Friendly names come from the real
// client_labels table (Network > Devices' existing "Name Your Devices"
// feature) where an operator has set one.
router.get('/users/devices', adminAuth, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

    const macRows = db.prepare(`
      SELECT mac_address,
        MIN(created_at) as first_seen,
        MAX(created_at) as last_seen,
        COUNT(*) as transaction_count
      FROM transactions
      WHERE mac_address IS NOT NULL AND mac_address != '' AND date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
      GROUP BY mac_address
    `).all(days);

    const sessionCounts = db.prepare(`
      SELECT mac_address, COUNT(*) as session_count, SUM(duration_seconds) as total_duration_seconds
      FROM session_history
      WHERE mac_address IS NOT NULL AND date(ended_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
      GROUP BY mac_address
    `).all(days);
    const sessionCountByMac = new Map(sessionCounts.map((r) => [r.mac_address, r]));

    const activeMacs = new Set(db.prepare('SELECT mac_address FROM sessions').all().map((r) => r.mac_address));
    // Bug found live: client_labels normalizes mac_address to lowercase
    // on write (see POST /network/client-labels), but transactions/
    // session_history store whatever case the client sent - a label set
    // through the existing "Name Your Devices" feature never matched up
    // here because the lookup key case didn't match. Normalize both
    // sides to lowercase for the join.
    const labels = db.prepare('SELECT mac_address, label FROM client_labels').all();
    const labelByMac = new Map(labels.map((r) => [r.mac_address.toLowerCase(), r.label]));
    const trusted = new Set(db.prepare('SELECT mac_address FROM trusted_devices').all().map((r) => r.mac_address.toLowerCase()));
    // Falls back to the device's own auto-captured DHCP hostname (e.g.
    // "Joshs-iPhone") when no manual label has been set - same
    // client_labels-wins-over-hostname precedence Network Devices already
    // uses. See networkDevicesService.getDisplayNames().
    const hostnames = require('../services/networkDevicesService').getDisplayNames(macRows.map((r) => r.mac_address));

    const devices = macRows.map((r) => ({
      mac_address: r.mac_address,
      label: labelByMac.get(r.mac_address.toLowerCase()) || hostnames.get(r.mac_address.toLowerCase()) || null,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      session_count: sessionCountByMac.get(r.mac_address)?.session_count || 0,
      total_duration_seconds: sessionCountByMac.get(r.mac_address)?.total_duration_seconds || 0,
      online: activeMacs.has(r.mac_address),
      trusted: trusted.has(r.mac_address.toLowerCase()),
    })).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));

    return res.json({ success: true, devices });
  } catch (err) {
    console.error('Users devices error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/analytics/summary?days=7, the Analytics page's single
// aggregation endpoint (one round trip, matching the design guide's
// "prefer backend aggregation" rule rather than N separate widget
// calls). Compares the selected period against the immediately prior
// period of the same length, real data only.
//
// Deliberately does NOT include: data usage in GB (this app has no
// per-session/per-client bandwidth-volume accounting, only live
// throughput and coarse rate shaping - there is nothing to sum),
// per-access-point traffic (no AP concept in Standalone/Router Mode),
// or a historical WAN-uptime percentage / failover count (wanHealthService
// only ever reports a live snapshot, nothing is sampled and stored over
// time yet). Returning these as zero would look like real measured data
// that happens to be zero, which is misleading - they're omitted from
// the response entirely instead, and the frontend does not render those
// widgets as a result.
router.get('/analytics/summary', adminAuth, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);

    // Bug found live: revenue must NOT be filtered by mac_address - coin-
    // slot transactions legitimately have no MAC recorded (matching
    // /sales' own todaySales query, which never filters on it either).
    // Only the distinct-user COUNT needs that filter; an earlier version
    // of this query applied it to revenue too and silently undercounted
    // real coin revenue whenever a box had any MAC-less transactions.
    const period = db.prepare(`
      SELECT
        SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as revenue,
        COUNT(DISTINCT CASE WHEN mac_address IS NOT NULL THEN mac_address END) as users,
        COUNT(*) as transactions
      FROM transactions
      WHERE date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
    `).get(days);

    const prevPeriod = db.prepare(`
      SELECT
        SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as revenue,
        COUNT(DISTINCT CASE WHEN mac_address IS NOT NULL THEN mac_address END) as users,
        COUNT(*) as transactions
      FROM transactions
      WHERE date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days') AND date(created_at, 'localtime') < date('now', 'localtime', '-' || ? || ' days')
    `).get(days * 2, days);

    const sessionsPeriod = db.prepare(`
      SELECT COUNT(*) as sessions, AVG(duration_seconds) as avg_duration
      FROM session_history WHERE date(ended_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
    `).get(days);
    const sessionsPrev = db.prepare(`
      SELECT COUNT(*) as sessions, AVG(duration_seconds) as avg_duration
      FROM session_history WHERE date(ended_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days') AND date(ended_at, 'localtime') < date('now', 'localtime', '-' || ? || ' days')
    `).get(days * 2, days);

    const pctChange = (curr, prev) => {
      if (!prev) return curr ? 100 : 0;
      return Math.round(((curr - prev) / prev) * 1000) / 10;
    };
    const metric = (curr, prev) => ({ value: curr || 0, previousValue: prev || 0, changePercent: pctChange(curr || 0, prev || 0) });

    const revenue = period.revenue || 0;
    const users = period.users || 0;
    const avgRevenuePerUser = users > 0 ? Math.round((revenue / users) * 100) / 100 : 0;
    const prevAvgRevenuePerUser = (prevPeriod.users || 0) > 0 ? Math.round(((prevPeriod.revenue || 0) / prevPeriod.users) * 100) / 100 : 0;

    // Daily revenue+sessions series for the primary chart.
    const revenueSeries = db.prepare(`
      SELECT date(created_at, 'localtime') as date,
        SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as revenue,
        COUNT(*) as sessions
      FROM transactions
      WHERE date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
      GROUP BY date(created_at, 'localtime') ORDER BY date ASC
    `).all(days);

    // Revenue breakdown by real transaction type.
    const breakdownRows = db.prepare(`
      SELECT type, SUM(coin_value) as amount
      FROM transactions
      WHERE date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days') AND type != 'free'
      GROUP BY type ORDER BY amount DESC
    `).all(days);
    const breakdownTotal = breakdownRows.reduce((sum, r) => sum + (r.amount || 0), 0);
    const typeLabels = { coin: 'Coin Sales', voucher: 'Voucher Sales', promo: 'Promo Redemptions' };
    const revenueBreakdown = breakdownRows.map((r) => ({
      type: r.type,
      label: typeLabels[r.type] || r.type,
      amount: r.amount || 0,
      percent: breakdownTotal > 0 ? Math.round(((r.amount || 0) / breakdownTotal) * 1000) / 10 : 0,
    }));

    // Sessions by hour-of-day (0-23), real session_history rows in period.
    const hourRows = db.prepare(`
      SELECT CAST(strftime('%H', started_at, 'localtime') as INTEGER) as hour, COUNT(*) as count
      FROM session_history
      WHERE started_at IS NOT NULL AND date(ended_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
      GROUP BY hour
    `).all(days);
    const hourMap = new Map(hourRows.map((r) => [r.hour, r.count]));
    const sessionsByHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourMap.get(h) || 0 }));

    // New vs returning + repeat users, same "first-ever-transaction-date"
    // logic already proven in /sales, generalized to the selected period.
    const firstSeenRows = db.prepare(`
      SELECT mac_address, MIN(date(created_at, 'localtime')) as first_date
      FROM transactions WHERE mac_address IS NOT NULL GROUP BY mac_address
    `).all();
    const firstSeenByMac = new Map(firstSeenRows.map((r) => [r.mac_address, r.first_date]));
    const periodMacRows = db.prepare(`
      SELECT mac_address, date(created_at, 'localtime') as tx_date, COUNT(*) as tx_count
      FROM transactions
      WHERE mac_address IS NOT NULL AND date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
      GROUP BY mac_address, tx_date
    `).all(days);
    const macTxCounts = new Map();
    let newSessions = 0;
    let returningSessions = 0;
    periodMacRows.forEach((r) => {
      const isNew = firstSeenByMac.get(r.mac_address) === r.tx_date;
      if (isNew) newSessions += r.tx_count; else returningSessions += r.tx_count;
      macTxCounts.set(r.mac_address, (macTxCounts.get(r.mac_address) || 0) + r.tx_count);
    });
    const repeatUsers = Array.from(macTxCounts.values()).filter((c) => c > 1).length;

    // Top spenders (real per-client revenue ranking) for the selected
    // period - same substitution as the Dashboard's Top Spenders widget,
    // for the same reason (no per-client GB usage tracked).
    const topSpenders = db.prepare(`
      SELECT mac_address, SUM(coin_value) as total, COUNT(*) as transaction_count
      FROM transactions
      WHERE date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days') AND mac_address IS NOT NULL AND mac_address != ''
      GROUP BY mac_address ORDER BY total DESC LIMIT 5
    `).all(days);
    const topSpenderDurations = db.prepare(`
      SELECT mac_address, AVG(duration_seconds) as avg_duration, COUNT(*) as session_count
      FROM session_history
      WHERE date(ended_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days') AND mac_address IS NOT NULL
      GROUP BY mac_address
    `).all(days);
    const durationByMac = new Map(topSpenderDurations.map((r) => [r.mac_address, r]));
    const topUsers = topSpenders.map((s) => ({
      mac_address: s.mac_address,
      total: s.total,
      transaction_count: s.transaction_count,
      session_count: durationByMac.get(s.mac_address)?.session_count || 0,
      avg_duration_seconds: Math.round(durationByMac.get(s.mac_address)?.avg_duration || 0),
    }));

    // What customers actually tap on the portal home screen, ranked -
    // see server/routes/portal.js's POST /track. Real data only: an
    // event type nobody's tapped yet simply doesn't appear, never a
    // fabricated zero row.
    const portalClicks = db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM portal_events
      WHERE date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
      GROUP BY event_type
      ORDER BY count DESC
    `).all(days);

    return res.json({
      success: true,
      period: { days },
      kpi: {
        revenue: metric(revenue, prevPeriod.revenue || 0),
        sessions: metric(sessionsPeriod.sessions || 0, sessionsPrev.sessions || 0),
        users: metric(users, prevPeriod.users || 0),
        avgSessionDurationSeconds: metric(Math.round(sessionsPeriod.avg_duration || 0), Math.round(sessionsPrev.avg_duration || 0)),
        avgRevenuePerUser: metric(avgRevenuePerUser, prevAvgRevenuePerUser),
      },
      revenueSeries,
      revenueBreakdown,
      sessionsByHour,
      sessionAnalytics: {
        newSessions,
        returningSessions,
        avgSessionDurationSeconds: Math.round(sessionsPeriod.avg_duration || 0),
        repeatUsers,
      },
      topUsers,
      portalClicks,
    });
  } catch (err) {
    console.error('Analytics summary error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/dashboard/top-spenders-today, real per-client revenue
// ranking for today (Dashboard's "Top Users" slot in the mockup asked for
// data-usage-in-GB, which this app doesn't track per client; revenue is
// the closest real per-client ranking this app actually has, grouped
// from the same transactions table sales stats already use).
router.get('/dashboard/top-spenders-today', adminAuth, (req, res) => {
  try {
    const today = db.prepare("SELECT date('now', 'localtime') as d").get().d;
    const rows = db.prepare(`
      SELECT mac_address, SUM(coin_value) as total, COUNT(*) as transaction_count
      FROM transactions
      WHERE date(created_at, 'localtime') = ? AND mac_address IS NOT NULL AND mac_address != ''
      GROUP BY mac_address
      ORDER BY total DESC
      LIMIT 5
    `).all(today);
    // Shows a real device name (e.g. "Joshs-iPhone") instead of a bare
    // MAC where one's been observed - see
    // networkDevicesService.getDisplayNames().
    const names = require('../services/networkDevicesService').getDisplayNames(rows.map((r) => r.mac_address));
    for (const r of rows) r.display_name = names.get(r.mac_address) || null;
    return res.json({ success: true, spenders: rows });
  } catch (err) {
    console.error('Top spenders error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/dashboard/visitors - the top of the funnel Top
// Spenders/Live Sessions can never show, since those only ever include
// someone who's already paid. This is everyone currently ON the WiFi
// (real ARP/DHCP presence, same source Network Devices already uses) with
// NO active session - never opened Insert Coin, or opened it and gave up
// before actually paying. Excludes vendos and access points (this app's
// own infrastructure, not customers) and anything with an active session
// (that's a converted visitor, already counted elsewhere).
router.get('/dashboard/visitors', adminAuth, async (req, res) => {
  try {
    const networkDevicesService = require('../services/networkDevicesService');
    const devices = await networkDevicesService.listDevices();
    const sessionMacs = new Set(
      db.prepare('SELECT mac_address FROM sessions').all().map((r) => String(r.mac_address || '').toLowerCase())
    );
    const visitors = devices.filter((d) =>
      d.status === 'online' &&
      d.vendo_id === null &&
      d.type !== 'Access Point' &&
      !sessionMacs.has(d.mac)
    );
    return res.json({
      success: true,
      count: visitors.length,
      visitors: visitors.map((v) => ({ mac: v.mac, name: v.name, ip: v.ip })),
    });
  } catch (err) {
    console.error('Dashboard visitors error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/transactions/export, full transaction history for CSV
// export. /sales' recent_transactions is capped at 20 for the dashboard
// preview table; this returns everything for bookkeeping purposes.
router.get('/transactions/export', adminAuth, (req, res) => {
  try {
    const transactions = db.prepare(
      'SELECT * FROM transactions ORDER BY created_at DESC'
    ).all();
    return res.json({ success: true, transactions });
  } catch (err) {
    console.error('Admin transactions export error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/promos, one-off codes only. Codes created as part of a
// group (voucher_groups) are deliberately excluded here: they already have
// their own dedicated card below (Voucher Groups), and showing every
// individual grouped code in this flat table too just duplicated them,
// making a batch of 50+ codes drown out the handful of real one-off codes.
router.get('/promos', adminAuth, (req, res) => {
  try {
    const promos = db.prepare('SELECT * FROM promo_vouchers WHERE group_id IS NULL ORDER BY created_at DESC').all();
    return res.json({ success: true, promos });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/promos, a one-off code, generated the same way a
// voucher group's codes are (see generateCustomVoucherCode() below) rather
// than the old fixed "PROMO-XXXXXX" format, so a single voucher and a
// batch-created one look and behave the same to a customer.
router.post('/promos', adminAuth, (req, res) => {
  try {
    const { duration_days, duration_minutes, price, download_mbps, upload_mbps } = req.body;

    // Support both duration_minutes (new) and duration_days (old)
    const minutes = duration_minutes || (duration_days * 1440);
    const p = parseInt(price, 10);

    if (!minutes || minutes <= 0) {
      return res.status(400).json({ success: false, message: 'Duration must be a positive number' });
    }
    if (!Number.isFinite(p) || p < 0) {
      return res.status(400).json({ success: false, message: 'Price must be a non-negative number' });
    }

    // Optional per-voucher bandwidth override - blank/omitted means "use
    // whatever the global Bandwidth Control setting (Security page) says",
    // same as a coin-paid session gets.
    const downloadMbps = (download_mbps !== undefined && download_mbps !== null && download_mbps !== '')
      ? parseInt(download_mbps, 10) : null;
    const uploadMbps = (upload_mbps !== undefined && upload_mbps !== null && upload_mbps !== '')
      ? parseInt(upload_mbps, 10) : null;
    if (download_mbps !== undefined && download_mbps !== null && download_mbps !== '' && (!Number.isFinite(downloadMbps) || downloadMbps <= 0)) {
      return res.status(400).json({ success: false, message: 'Download speed must be a positive number' });
    }
    if (upload_mbps !== undefined && upload_mbps !== null && upload_mbps !== '' && (!Number.isFinite(uploadMbps) || uploadMbps <= 0)) {
      return res.status(400).json({ success: false, message: 'Upload speed must be a positive number' });
    }

    const code = generateCustomVoucherCode(6, 'mixed', 'upper');

    // Store as fractional days for backward compat
    const durationDays = minutes / 1440;
    db.prepare('INSERT INTO promo_vouchers (code, duration_days, price, download_mbps, upload_mbps) VALUES (?, ?, ?, ?, ?)')
      .run(code, durationDays, p, downloadMbps, uploadMbps);
    console.log(`🎫 Promo created: ${code}, ${minutes} mins${downloadMbps ? ` (custom ${downloadMbps}/${uploadMbps || downloadMbps}Mbps)` : ''}`);
    return res.json({ success: true, code, duration_minutes: minutes, price: p });
  } catch (err) {
    console.error('Admin create promo error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/promos/:id
router.delete('/promos/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM promo_vouchers WHERE id = ?').run(req.params.id);
    return res.json({ success: true, message: 'Promo deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== VOUCHER GROUPS (batch creation, configurable code format) =====

function generateCustomVoucherCode(length, charset, caseOption) {
  const sets = {
    letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    numbers: '0123456789',
    mixed: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  };
  const pool = sets[charset] || sets.mixed;

  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) {
      // crypto.randomInt(), not Math.random() - these are real,
      // customer-redeemable secrets (₱ value attached), not cosmetic IDs.
      code += pool.charAt(randomInt(pool.length));
    }
    if (caseOption === 'lower') {
      code = code.toLowerCase();
    } else if (caseOption === 'mixed') {
      code = code.split('').map(c => randomInt(2) === 0 ? c.toLowerCase() : c.toUpperCase()).join('');
    }
    // Bug-avoidance: promo.js's redeem normalization treats a code starting
    // with the literal prefixes "PROMO" or "RJ" specially (inserts a dash).
    // A custom-format code that happens to start with one of those would
    // get silently mangled on redemption. Regenerate rather than risk it.
    if (/^(PROMO|RJ)/.test(code)) continue;
    const exists = db.prepare('SELECT id FROM promo_vouchers WHERE code = ?').get(code);
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique code, try a longer length or wider character set');
}

// POST /api/admin/vouchers/groups, batch-create N vouchers at once with a
// configurable code format (length/charset/case), tagged together so they
// can be viewed and printed as one batch later.
router.post('/vouchers/groups', adminAuth, (req, res) => {
  try {
    let { name, quantity, duration_minutes, price, code_length, code_charset, code_case, print_caption, print_logo_url, plan_id } = req.body;

    // A selected Plan is the source of truth for duration/price (spec:
    // "a voucher group should reference an existing Plan, do not duplicate
    // all plan configuration inside each voucher group") - still copied
    // into the group's own columns so every existing read site (redemption,
    // printing, exports) keeps working unchanged without a join.
    let planIdInt = null;
    if (plan_id !== undefined && plan_id !== null && plan_id !== '') {
      planIdInt = parseInt(plan_id, 10);
      const plan = Number.isFinite(planIdInt) ? db.prepare('SELECT * FROM plans WHERE id = ?').get(planIdInt) : null;
      if (!plan) return res.status(400).json({ success: false, message: 'Selected plan was not found.' });
      duration_minutes = plan.duration_minutes;
      price = plan.price;
    }

    const qty = parseInt(quantity, 10);
    const minutes = parseFloat(duration_minutes);
    const p = parseInt(price, 10);
    const length = parseInt(code_length, 10);
    const charset = ['letters', 'numbers', 'mixed'].includes(code_charset) ? code_charset : 'mixed';
    const caseOption = ['upper', 'lower', 'mixed'].includes(code_case) ? code_case : 'upper';

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Group name is required' });
    }
    if (!Number.isFinite(qty) || qty < 1 || qty > 500) {
      return res.status(400).json({ success: false, message: 'Quantity must be between 1 and 500' });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ success: false, message: 'Duration must be a positive number' });
    }
    if (!Number.isFinite(p) || p < 0) {
      return res.status(400).json({ success: false, message: 'Price must be a non-negative number' });
    }
    if (!Number.isFinite(length) || length < 6 || length > 20) {
      return res.status(400).json({ success: false, message: 'Code length must be between 6 and 20' });
    }

    const insertGroup = db.prepare(`
      INSERT INTO voucher_groups (name, quantity, duration_minutes, price, print_caption, print_logo_url, plan_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const groupResult = insertGroup.run(name.trim(), qty, minutes, p, print_caption || null, print_logo_url || null, planIdInt);
    const groupId = groupResult.lastInsertRowid;

    const durationDays = minutes / 1440;
    const insertVoucher = db.prepare(`
      INSERT INTO promo_vouchers (code, duration_days, price, group_id) VALUES (?, ?, ?, ?)
    `);

    const codes = [];
    const insertBatch = db.transaction(() => {
      for (let i = 0; i < qty; i++) {
        const code = generateCustomVoucherCode(length, charset, caseOption);
        insertVoucher.run(code, durationDays, p, groupId);
        codes.push(code);
      }
    });
    insertBatch();

    console.log(`🎫 Voucher group created: "${name}", ${qty} codes, ${minutes} mins each`);
    return res.json({ success: true, group_id: groupId, codes });
  } catch (err) {
    console.error('Admin create voucher group error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// GET /api/admin/vouchers/groups, list all groups with usage counts
// GET /api/admin/vouchers/redemption-summary?days=30 - real voucher
// redemption revenue over time, for the Vouchers Overview page. Sources
// only transactions.type IN ('voucher','promo') - the real distinction
// promo.js's redeem route already makes between a group-generated code
// and a standalone one (see that route's own comment) - coin-slot
// revenue is deliberately excluded, this card is voucher-specific.
router.get('/vouchers/redemption-summary', adminAuth, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const series = db.prepare(`
      SELECT date(created_at, 'localtime') as date, COUNT(*) as redeemed, SUM(coin_value) as revenue
      FROM transactions
      WHERE type IN ('voucher', 'promo') AND date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
      GROUP BY date(created_at, 'localtime') ORDER BY date ASC
    `).all(days);
    const totals = db.prepare(`
      SELECT COUNT(*) as redeemed, SUM(coin_value) as revenue
      FROM transactions
      WHERE type IN ('voucher', 'promo') AND date(created_at, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
    `).get(days);
    return res.json({
      success: true,
      series,
      totalRedeemed: totals.redeemed || 0,
      totalRevenue: totals.revenue || 0,
    });
  } catch (err) {
    console.error('Voucher redemption summary error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/vouchers/groups', adminAuth, (req, res) => {
  try {
    // Bug: used_count lumped 'active' (redeemed, session currently running)
    // and 'used' (session fully ended) together as one bucket, so there was
    // no way to tell "50 people are on this right now" from "50 people used
    // this and left" at a glance. Broken out into all 3 real states.
    const groups = db.prepare(`
      SELECT g.*,
        COUNT(v.id) as actual_count,
        SUM(CASE WHEN v.status = 'unused' THEN 1 ELSE 0 END) as unused_count,
        SUM(CASE WHEN v.status = 'active' THEN 1 ELSE 0 END) as active_count,
        SUM(CASE WHEN v.status = 'used' THEN 1 ELSE 0 END) as used_count
      FROM voucher_groups g
      LEFT JOIN promo_vouchers v ON v.group_id = g.id
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `).all();
    return res.json({ success: true, groups });
  } catch (err) {
    console.error('Admin list voucher groups error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/vouchers/groups/:id, a group's vouchers, for printing
router.get('/vouchers/groups/:id', adminAuth, (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM voucher_groups WHERE id = ?').get(req.params.id);
    if (!group) {
      return res.status(404).json({ success: false, message: 'Voucher group not found' });
    }
    const vouchers = db.prepare('SELECT * FROM promo_vouchers WHERE group_id = ? ORDER BY id ASC').all(req.params.id);
    return res.json({ success: true, group, vouchers });
  } catch (err) {
    console.error('Admin get voucher group error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/vouchers/groups/:id, deletes the group and its vouchers
router.delete('/vouchers/groups/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM promo_vouchers WHERE group_id = ?').run(req.params.id);
    db.prepare('DELETE FROM voucher_groups WHERE id = ?').run(req.params.id);
    return res.json({ success: true, message: 'Voucher group deleted' });
  } catch (err) {
    console.error('Admin delete voucher group error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== PLANS =====
// The single source of truth for an internet access product. Voucher
// groups optionally reference a plan (voucher_groups.plan_id) instead of
// duplicating price/duration; Client Portal, Coin Vendo, and ZenPay
// integration are real roadmap items and are NOT wired up here - the
// "channel_*" columns just record operator intent for when they are.

function planRowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    status: row.status,
    price: row.price,
    duration_minutes: row.duration_minutes,
    validity_minutes: row.validity_minutes,
    download_mbps: row.download_mbps,
    upload_mbps: row.upload_mbps,
    is_premium: !!row.is_premium,
    data_limit_mb: row.data_limit_mb,
    device_limit: row.device_limit,
    session_limit: row.session_limit,
    schedule_start: row.schedule_start,
    schedule_end: row.schedule_end,
    channels: {
      voucher: !!row.channel_voucher,
      portal: !!row.channel_portal,
      coin_vendo: !!row.channel_coin_vendo,
      account: !!row.channel_account,
    },
    display_order: row.display_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Keeps the coin slot's rates table (the one thing coinCreditService.js
// actually reads at insert time) in sync with a Plan's "Coin Vendo"
// availability channel, so checking that box on a Plan is real instead of
// the "(not yet connected)" no-op it used to be. Coin Vendo Rates used to
// be a second, separate editor on this same page - removed in favor of
// this, so there's exactly one place to manage coin pricing.
// A rates row needs whole-peso pricing and a real duration to mean
// anything to the coin slot, so a Plan missing either (e.g. a Data or
// Unlimited plan with no duration_minutes) just doesn't get a linked row -
// same as unchecking the channel.
function syncPlanCoinVendoRate(planId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  const existing = db.prepare('SELECT id FROM rates WHERE plan_id = ?').get(planId);

  const eligible = plan && plan.channel_coin_vendo && plan.status === 'active'
    && Number.isInteger(plan.price) && plan.price > 0 && plan.duration_minutes > 0;

  if (!eligible) {
    if (existing) db.prepare('DELETE FROM rates WHERE id = ?').run(existing.id);
    return;
  }

  // coinCreditService.js tells Normal and Premium tiers apart purely by
  // whether a rates row has a download_mbps override - so only carry the
  // plan's speed fields through when is_premium is actually checked, even
  // if a Regular plan happens to have its own download_mbps set for
  // unrelated reasons (e.g. a capped voucher plan). A Regular coin-vendo
  // rate must always land as NULL/NULL here so it falls back to the global
  // bandwidth cap, not accidentally read as Premium.
  const fields = {
    coin_value: plan.price,
    minutes: plan.duration_minutes,
    expiration_minutes: plan.validity_minutes || plan.duration_minutes,
    label: plan.name,
    download_mbps: plan.is_premium ? (plan.download_mbps || null) : null,
    upload_mbps: plan.is_premium ? (plan.upload_mbps || plan.download_mbps || null) : null,
    data_limit_mb: plan.data_limit_mb || null,
  };

  if (existing) {
    db.prepare(`
      UPDATE rates SET coin_value = ?, minutes = ?, expiration_minutes = ?, label = ?, download_mbps = ?, upload_mbps = ?, data_limit_mb = ?
      WHERE id = ?
    `).run(fields.coin_value, fields.minutes, fields.expiration_minutes, fields.label, fields.download_mbps, fields.upload_mbps, fields.data_limit_mb, existing.id);
  } else {
    db.prepare(`
      INSERT INTO rates (coin_value, minutes, expiration_minutes, label, download_mbps, upload_mbps, data_limit_mb, plan_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fields.coin_value, fields.minutes, fields.expiration_minutes, fields.label, fields.download_mbps, fields.upload_mbps, fields.data_limit_mb, planId);
  }
}

const PLAN_TYPES = ['time', 'data', 'unlimited', 'custom'];

function validatePlanInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) errors.push('Plan name is required.');
    if (name.length > 80) errors.push('Plan name must be 80 characters or fewer.');
    out.name = name;
  }
  if (body.description !== undefined) out.description = String(body.description || '').trim().slice(0, 300) || null;

  if (!partial || body.type !== undefined) {
    const type = PLAN_TYPES.includes(body.type) ? body.type : null;
    if (!type) errors.push('Plan type must be one of: ' + PLAN_TYPES.join(', '));
    out.type = type;
  }

  if (body.status !== undefined) {
    out.status = ['active', 'inactive'].includes(body.status) ? body.status : 'active';
  } else if (!partial) {
    out.status = 'active';
  }

  if (!partial || body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) errors.push('Price must be a non-negative number.');
    out.price = price;
  }

  if (body.duration_minutes !== undefined) {
    const v = body.duration_minutes === null || body.duration_minutes === '' ? null : Number(body.duration_minutes);
    if (v !== null && (!Number.isFinite(v) || v <= 0)) errors.push('Duration must be greater than zero.');
    out.duration_minutes = v;
  }
  if (body.validity_minutes !== undefined) {
    const v = body.validity_minutes === null || body.validity_minutes === '' ? null : Number(body.validity_minutes);
    if (v !== null && (!Number.isFinite(v) || v <= 0)) errors.push('Validity must be greater than zero.');
    out.validity_minutes = v;
  }
  if (body.download_mbps !== undefined) {
    const v = body.download_mbps === null || body.download_mbps === '' ? null : Number(body.download_mbps);
    if (v !== null && (!Number.isFinite(v) || v < 0)) errors.push('Download speed cannot be negative.');
    out.download_mbps = v;
  }
  if (body.upload_mbps !== undefined) {
    const v = body.upload_mbps === null || body.upload_mbps === '' ? null : Number(body.upload_mbps);
    if (v !== null && (!Number.isFinite(v) || v < 0)) errors.push('Upload speed cannot be negative.');
    out.upload_mbps = v;
  }
  if (body.is_premium !== undefined) {
    out.is_premium = body.is_premium ? 1 : 0;
  } else if (!partial) {
    out.is_premium = 0;
  }
  // Premium's whole point is trading duration for a real speed boost - a
  // Premium plan with no download speed set is indistinguishable from
  // Regular once it reaches the coin slot (syncPlanCoinVendoRate keys
  // Normal vs Premium off download_mbps being set), so catch that at
  // save time instead of letting it silently misfile.
  const willBePremium = out.is_premium !== undefined ? !!out.is_premium
    : (partial ? undefined : false);
  const downloadAfterSave = out.download_mbps !== undefined ? out.download_mbps : undefined;
  if (willBePremium && downloadAfterSave === null) {
    errors.push('Premium plans need a Download Speed set - that\'s what makes them Premium.');
  }
  if (body.data_limit_mb !== undefined) {
    const v = body.data_limit_mb === null || body.data_limit_mb === '' ? null : Number(body.data_limit_mb);
    if (v !== null && (!Number.isFinite(v) || v < 0)) errors.push('Data limit cannot be negative.');
    out.data_limit_mb = v;
  }
  if (body.device_limit !== undefined) {
    const v = body.device_limit === null || body.device_limit === '' ? 1 : Number(body.device_limit);
    if (!Number.isFinite(v) || v < 1) errors.push('Device limit must be at least 1.');
    out.device_limit = v;
  }
  if (body.session_limit !== undefined) {
    const v = body.session_limit === null || body.session_limit === '' ? null : Number(body.session_limit);
    if (v !== null && (!Number.isFinite(v) || v < 1)) errors.push('Session limit must be at least 1.');
    out.session_limit = v;
  }
  if (body.schedule_start !== undefined) out.schedule_start = body.schedule_start || null;
  if (body.schedule_end !== undefined) out.schedule_end = body.schedule_end || null;

  const channels = body.channels || {};
  if (body.channels !== undefined || !partial) {
    out.channel_voucher = channels.voucher !== false ? 1 : 0;
    out.channel_portal = channels.portal ? 1 : 0;
    out.channel_coin_vendo = channels.coin_vendo ? 1 : 0;
    out.channel_account = channels.account ? 1 : 0;
  }

  if (body.display_order !== undefined) {
    const v = Number(body.display_order);
    out.display_order = Number.isFinite(v) ? v : 0;
  }

  return { errors, out };
}

// GET /api/admin/plans, list all plans with real "used today" / total
// usage counts, derived from session_history joined through promo_vouchers
// -> voucher_groups.plan_id. Coin-vendo/portal usage isn't counted since
// those channels aren't wired to a plan yet (would be double-counting or
// fabricating a number that doesn't map to anything real).
router.get('/plans', adminAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.*,
        COALESCE(u.used_today, 0) as used_today,
        COALESCE(u.used_total, 0) as used_total
      FROM plans p
      LEFT JOIN (
        SELECT vg.plan_id as plan_id,
          SUM(CASE WHEN date(sh.ended_at, 'localtime') = date('now', 'localtime') THEN 1 ELSE 0 END) as used_today,
          COUNT(sh.id) as used_total
        FROM session_history sh
        JOIN promo_vouchers pv ON pv.code = sh.voucher_code
        JOIN voucher_groups vg ON vg.id = pv.group_id
        WHERE vg.plan_id IS NOT NULL
        GROUP BY vg.plan_id
      ) u ON u.plan_id = p.id
      ORDER BY p.display_order ASC, p.created_at DESC
    `).all();
    return res.json({ success: true, plans: rows.map(r => ({ ...planRowToJson(r), used_today: r.used_today, used_total: r.used_total })) });
  } catch (err) {
    console.error('Admin list plans error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/plans/:id', adminAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Plan not found' });
    const groupCount = db.prepare('SELECT COUNT(*) as c FROM voucher_groups WHERE plan_id = ?').get(req.params.id).c;
    return res.json({ success: true, plan: planRowToJson(row), voucher_group_count: groupCount });
  } catch (err) {
    console.error('Admin get plan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/plans', adminAuth, (req, res) => {
  try {
    const { errors, out } = validatePlanInput(req.body);
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

    const result = db.prepare(`
      INSERT INTO plans (
        name, description, type, status, price, duration_minutes, validity_minutes,
        download_mbps, upload_mbps, is_premium, data_limit_mb, device_limit, session_limit,
        schedule_start, schedule_end, channel_voucher, channel_portal, channel_coin_vendo,
        channel_account, display_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      out.name, out.description || null, out.type, out.status, out.price,
      out.duration_minutes ?? null, out.validity_minutes ?? null,
      out.download_mbps ?? null, out.upload_mbps ?? null, out.is_premium ?? 0, out.data_limit_mb ?? null,
      out.device_limit ?? 1, out.session_limit ?? null,
      out.schedule_start ?? null, out.schedule_end ?? null,
      out.channel_voucher, out.channel_portal, out.channel_coin_vendo, out.channel_account,
      out.display_order ?? 0
    );
    console.log(`📦 Plan created: "${out.name}" (₱${out.price})`);
    syncPlanCoinVendoRate(result.lastInsertRowid);
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(result.lastInsertRowid);
    return res.json({ success: true, plan: planRowToJson(row) });
  } catch (err) {
    console.error('Admin create plan error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.patch('/plans/:id', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Plan not found' });

    const { errors, out } = validatePlanInput(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

    const fields = Object.keys(out);
    if (!fields.length) return res.json({ success: true, plan: planRowToJson(existing) });

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => out[f] ?? null);
    db.prepare(`UPDATE plans SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, req.params.id);

    console.log(`📦 Plan updated: "${existing.name}" (#${req.params.id})`);
    syncPlanCoinVendoRate(req.params.id);
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
    return res.json({ success: true, plan: planRowToJson(row) });
  } catch (err) {
    console.error('Admin update plan error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.post('/plans/:id/duplicate', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Plan not found' });

    let newName = `${existing.name} (Copy)`;
    let suffix = 2;
    while (db.prepare('SELECT id FROM plans WHERE name = ?').get(newName)) {
      newName = `${existing.name} (Copy ${suffix})`;
      suffix++;
    }

    const result = db.prepare(`
      INSERT INTO plans (
        name, description, type, status, price, duration_minutes, validity_minutes,
        download_mbps, upload_mbps, is_premium, data_limit_mb, device_limit, session_limit,
        schedule_start, schedule_end, channel_voucher, channel_portal, channel_coin_vendo,
        channel_account, display_order
      ) VALUES (?, ?, ?, 'inactive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newName, existing.description, existing.type, existing.price,
      existing.duration_minutes, existing.validity_minutes,
      existing.download_mbps, existing.upload_mbps, existing.is_premium, existing.data_limit_mb,
      existing.device_limit, existing.session_limit,
      existing.schedule_start, existing.schedule_end,
      existing.channel_voucher, existing.channel_portal, existing.channel_coin_vendo, existing.channel_account,
      existing.display_order
    );
    console.log(`📦 Plan duplicated: "${existing.name}" -> "${newName}"`);
    syncPlanCoinVendoRate(result.lastInsertRowid);
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(result.lastInsertRowid);
    return res.json({ success: true, plan: planRowToJson(row) });
  } catch (err) {
    console.error('Admin duplicate plan error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.post('/plans/:id/activate', adminAuth, (req, res) => {
  try {
    const result = db.prepare("UPDATE plans SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ success: false, message: 'Plan not found' });
    syncPlanCoinVendoRate(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin activate plan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/plans/:id/deactivate', adminAuth, (req, res) => {
  try {
    const result = db.prepare("UPDATE plans SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ success: false, message: 'Plan not found' });
    syncPlanCoinVendoRate(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin deactivate plan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE only allowed when no voucher group has ever referenced this plan -
// deactivate is the correct action for a plan with history (section 25/17
// of the spec: "prefer deactivation for plans that have already been used").
router.delete('/plans/:id', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Plan not found' });
    const groupCount = db.prepare('SELECT COUNT(*) as c FROM voucher_groups WHERE plan_id = ?').get(req.params.id).c;
    if (groupCount > 0) {
      return res.status(409).json({
        success: false,
        message: `This plan cannot be deleted because it is referenced by ${groupCount} voucher group(s). Deactivate it instead.`,
      });
    }
    db.prepare('DELETE FROM rates WHERE plan_id = ?').run(req.params.id);
    db.prepare('DELETE FROM plans WHERE id = ?').run(req.params.id);
    console.log(`📦 Plan deleted: "${existing.name}" (#${req.params.id})`);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete plan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/plans/active/list, lightweight list for pickers (e.g.
// the Create Voucher Group form's Plan selector) - active plans only.
router.get('/plans-active/list', adminAuth, (req, res) => {
  try {
    const rows = db.prepare("SELECT id, name, price, duration_minutes, type FROM plans WHERE status = 'active' ORDER BY display_order ASC, name ASC").all();
    return res.json({ success: true, plans: rows });
  } catch (err) {
    console.error('Admin list active plans error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== VOUCHER DESIGNER (Vouchers > Templates) =====
// v1 scope only: curated element set, no shapes/images/layers/undo -
// see this session's scoping decision. elements_json stores the full
// canvas layout, never the resolved voucher value itself (dynamic
// fields like {Voucher Code} stay symbolic - "field": "voucher.code" -
// resolved at print time from the real voucher record, never baked into
// the template as static text).

router.get('/voucher-templates', adminAuth, (req, res) => {
  try {
    const templates = db.prepare('SELECT id, name, description, width_in, height_in, background_color, is_system, created_at, updated_at FROM voucher_templates ORDER BY is_system DESC, created_at DESC').all();
    return res.json({ success: true, templates });
  } catch (err) {
    console.error('List voucher templates error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/voucher-templates/:id', adminAuth, (req, res) => {
  try {
    const template = db.prepare('SELECT * FROM voucher_templates WHERE id = ?').get(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found' });
    template.elements = JSON.parse(template.elements_json);
    return res.json({ success: true, template });
  } catch (err) {
    console.error('Get voucher template error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/voucher-templates', adminAuth, (req, res) => {
  try {
    const { name, description, width_in, height_in, background_color, elements } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Template name is required' });
    if (!Array.isArray(elements)) return res.status(400).json({ success: false, message: 'elements must be an array' });

    const result = db.prepare(`
      INSERT INTO voucher_templates (name, description, width_in, height_in, background_color, elements_json, is_system)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(
      name.trim(), description || '',
      parseFloat(width_in) || 3.5, parseFloat(height_in) || 2,
      background_color || '#ffffff', JSON.stringify(elements)
    );
    return res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Create voucher template error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/voucher-templates/:id - system templates (is_system=1)
// can't be overwritten in place, only duplicated via a fresh POST (Save
// as New Template) - matches the spec's "built-in templates should be
// protected" rule and this app's existing "never silently mutate a
// system default" convention elsewhere (e.g. rates.js's own defaults).
router.patch('/voucher-templates/:id', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT is_system FROM voucher_templates WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Template not found' });
    if (existing.is_system) return res.status(403).json({ success: false, message: 'System templates can\'t be edited directly - use "Save as New Template".' });

    const { name, description, width_in, height_in, background_color, elements } = req.body;
    if (!Array.isArray(elements)) return res.status(400).json({ success: false, message: 'elements must be an array' });

    db.prepare(`
      UPDATE voucher_templates SET name = ?, description = ?, width_in = ?, height_in = ?, background_color = ?, elements_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      (name || '').trim(), description || '',
      parseFloat(width_in) || 3.5, parseFloat(height_in) || 2,
      background_color || '#ffffff', JSON.stringify(elements), req.params.id
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('Update voucher template error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/voucher-templates/:id', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT is_system FROM voucher_templates WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Template not found' });
    if (existing.is_system) return res.status(403).json({ success: false, message: 'System templates can\'t be deleted.' });
    db.prepare('DELETE FROM voucher_templates WHERE id = ?').run(req.params.id);
    return res.json({ success: true, message: 'Template deleted' });
  } catch (err) {
    console.error('Delete voucher template error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/rates
router.get('/rates', adminAuth, (req, res) => {
  try {
    const rates = getRates();
    return res.json({ success: true, rates });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/rates
// Bandwidth fields are optional on both routes below - null/absent means
// a normal rate (uses the global bandwidth cap, same as before Premium
// rates existed); a positive download_mbps marks it Premium
// (coinCreditService.js applies it as a session-level override, "high
// speed, less time"). Upload defaults to the download value when omitted,
// same convention setClientBandwidth() callers already use elsewhere -
// callers below force upload to null whenever download is null too, so
// an admin can't save a half-set rate (upload without download) that
// coinCreditService.js's premium check (keyed on download_mbps alone)
// would silently treat as a normal rate while an orphaned upload value
// sits in the row doing nothing.
function parseOptionalMbps(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

router.post('/rates', adminAuth, (req, res) => {
  try {
    const { coin_value, minutes, expiration_minutes, label } = req.body;

    // Validate inputs
    const cv = parseInt(coin_value, 10);
    const m = parseInt(minutes, 10);
    const em = parseInt(expiration_minutes, 10);
    const downloadMbps = parseOptionalMbps(req.body.download_mbps);
    const uploadMbps = downloadMbps ? (parseOptionalMbps(req.body.upload_mbps) || downloadMbps) : null;

    if (!Number.isFinite(cv) || cv <= 0) {
      return res.status(400).json({ success: false, message: 'coin_value must be a positive number' });
    }
    if (!Number.isFinite(m) || m <= 0) {
      return res.status(400).json({ success: false, message: 'minutes must be a positive number' });
    }
    if (!Number.isFinite(em) || em <= 0) {
      return res.status(400).json({ success: false, message: 'expiration_minutes must be a positive number' });
    }
    if (!label || label.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'label is required' });
    }

    db.prepare('INSERT INTO rates (coin_value, minutes, expiration_minutes, label, download_mbps, upload_mbps) VALUES (?, ?, ?, ?, ?, ?)')
      .run(cv, m, em, label.trim(), downloadMbps, uploadMbps);
    return res.json({ success: true, message: 'Rate added' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/admin/rates/:id
router.put('/rates/:id', adminAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { coin_value, minutes, expiration_minutes, label } = req.body;

    // Validate inputs
    const cv = parseInt(coin_value, 10);
    const m = parseInt(minutes, 10);
    const em = parseInt(expiration_minutes, 10);
    const downloadMbps = parseOptionalMbps(req.body.download_mbps);
    const uploadMbps = downloadMbps ? (parseOptionalMbps(req.body.upload_mbps) || downloadMbps) : null;

    if (!Number.isFinite(cv) || cv <= 0) {
      return res.status(400).json({ success: false, message: 'coin_value must be a positive number' });
    }
    if (!Number.isFinite(m) || m <= 0) {
      return res.status(400).json({ success: false, message: 'minutes must be a positive number' });
    }
    if (!Number.isFinite(em) || em <= 0) {
      return res.status(400).json({ success: false, message: 'expiration_minutes must be a positive number' });
    }
    if (!label || label.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'label is required' });
    }

    db.prepare('UPDATE rates SET coin_value = ?, minutes = ?, expiration_minutes = ?, label = ?, download_mbps = ?, upload_mbps = ? WHERE id = ?')
      .run(cv, m, em, label.trim(), downloadMbps, uploadMbps, id);
    return res.json({ success: true, message: 'Rate updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/rates/:id
router.delete('/rates/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM rates WHERE id = ?').run(req.params.id);
    return res.json({ success: true, message: 'Rate deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/settings
router.get('/settings', adminAuth, (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings').all();
    const settingsObj = {};
    const sensitiveKeys = ['admin_password', 'admin_username', 'mikrotik_pass', 'openwrt_pass'];
    settings.forEach(s => {
      if (!sensitiveKeys.includes(s.key)) settingsObj[s.key] = s.value;
    });
    // The raw/encrypted password never leaves this endpoint, but the admin
    // panel still needs to know a password IS saved so it can show a
    // masked placeholder instead of always looking blank (which made it
    // look like nothing was ever saved, even though it was).
    const mikrotikPass = settings.find(s => s.key === 'mikrotik_pass');
    settingsObj.mikrotik_pass_set = !!(mikrotikPass && mikrotikPass.value);
    const openwrtPass = settings.find(s => s.key === 'openwrt_pass');
    settingsObj.openwrt_pass_set = !!(openwrtPass && openwrtPass.value);
    return res.json({ success: true, settings: settingsObj });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/router/password, reveals the saved MikroTik password on
// demand. Deliberately a separate endpoint from GET /settings (which never
// includes it) so the plaintext password is only ever sent to the browser
// when an authenticated admin explicitly clicks "Show," not on every page
// load.
router.get('/router/password', adminAuth, (req, res) => {
  try {
    const { decryptSecret } = require('../utils/secretCrypto');
    const row = db.prepare("SELECT value FROM settings WHERE key = 'mikrotik_pass'").get();
    const password = row && row.value ? decryptSecret(row.value) : '';
    res.json({ success: true, password });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not retrieve password' });
  }
});

// POST /api/admin/settings
router.post('/settings', adminAuth, async (req, res) => {
  try {
    const updates = req.body;

    // Server-side enforcement of the free-tier Standalone-only lock - the
    // Network page's UI disables the MikroTik button for free-tier
    // accounts, but that's only a UX hint. The real gate has to be here,
    // since a client is never trusted to enforce its own restrictions
    // (same principle as the admin/wallet security discussion - the
    // browser asks, the server decides). Existing installs already in
    // mikrotik/openwrt mode are untouched - this only blocks newly
    // switching INTO a router mode without Premium.
    if (updates.network_mode === 'mikrotik' || updates.network_mode === 'openwrt') {
      // Real entitlement check (server/services/entitlementService.js),
      // not a raw account_tier settings read - see that file's own header
      // for the gap this closed (account_tier used to be settable through
      // this exact same generic loop, with nothing stopping an admin from
      // just granting themselves Premium).
      const { canUse } = require('../services/entitlementService');
      const currentMode = db.prepare("SELECT value FROM settings WHERE key = 'network_mode'").get()?.value || 'standalone';
      if (!canUse('router_mode') && currentMode !== updates.network_mode) {
        return res.status(403).json({ success: false, message: 'Router mode (MikroTik/OpenWRT) is a Premium feature. Upgrade to unlock it.' });
      }
    }

    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'admin_password') {
        // Never store the raw password (Bug: was plaintext at rest).
        // Setting a new one always counts as satisfying the forced-change
        // requirement, whether this is the first change or a routine one.
        upsert.run('admin_password', hashPassword(String(value)));
        upsert.run('must_change_password', '0');
        verifiedPasswordCache.clear();
        continue;
      }
      if (key === 'mikrotik_pass' || key === 'openwrt_pass') {
        // Router credentials have real resale value here, never store raw
        // (Bug: was plaintext at rest, same class as admin_password above).
        // Blank means "leave current value alone" (matches the frontend's
        // "leave blank to keep current" pattern for admin_password).
        if (String(value) !== '') {
          upsert.run(key, encryptSecret(String(value)));
        }
        continue;
      }
      upsert.run(key, String(value));
    }
    console.log('⚙️ Settings updated:', Object.keys(updates).join(', '));

    // Bug: switching Network Mode (Standalone <-> External Router) here
    // only ever updated the DB - nothing re-ran setup-network.sh, so the
    // box kept running whatever nftables/dnsmasq/tc state the OLD mode had
    // set up until the next reboot or an unrelated VLAN change happened to
    // trigger a re-apply. An owner flipping the mode switch and expecting
    // it to take effect immediately (the UI gives no indication otherwise)
    // would see stale behavior with no visible error.
    if ('network_mode' in updates || 'enable_pihole' in updates) {
      // Bug found live: this used to be fire-and-forget, so the DNS
      // Filtering check right below could run WHILE this script's own
      // interface-identity detection was still bouncing the link (visible
      // in journalctl as a burst of DHCPDISCOVER/DHCPACK on the LAN
      // interface right as this fires) - os.networkInterfaces() could
      // catch that interface mid-renegotiation with no IPv4 address
      // assigned yet, making getOwnLanIp() (setDnsFilterServers below)
      // intermittently fail to find a match even with server_lan_mac set
      // correctly. Await it so the network has actually settled first.
      await applyNetworkSetup();
    }

    // DNS Filtering in Controller Mode: standalone mode's dnsmasq picks up
    // the Pi-hole redirect automatically via applyNetworkSetup() above, but
    // Controller Mode has no local dnsmasq - the router itself needs to be
    // told where to send DNS queries instead. Best-effort: a stale/wrong
    // dnsFilterWarning here doesn't block the toggle from saving, same
    // pattern as portalHostnameWarning below.
    let dnsFilterWarning = null;
    if ('enable_pihole' in updates) {
      const mode = db.prepare("SELECT value FROM settings WHERE key = 'network_mode'").get()?.value || 'standalone';
      if (mode === 'mikrotik') {
        const applied = await require('../services/mikrotikService').setDnsFilterServers(updates.enable_pihole === '1');
        if (!applied) {
          dnsFilterWarning = 'DNS Filtering setting was saved, but could not be applied on the router (check the Server\'s Network Connection is set correctly and the router is reachable).';
        }
      }
    }

    // Bug: Customer Portal Address ("Give customers an easy, memorable
    // address for checking or adding time later") saved to the database
    // and did nothing else - nothing ever made it actually resolve to
    // anything. A customer closing the portal tab had no way back in
    // except the raw gateway IP, since the OS's captive-portal auto-popup
    // only fires before they have real internet, not after they've paid.
    // Standalone mode: applyNetworkSetup() above already regenerates
    // dnsmasq's address= line for it whenever network_mode/enable_pihole
    // changed - but portal_hostname needs the same re-apply when changed
    // on its own too. Router mode has no local dnsmasq to update; ask the
    // router directly for a static DNS record instead.
    // Bug found live: setPortalDnsName()'s result was never checked here -
    // a failure (no server_lan_mac configured, MikroTik unreachable, etc.)
    // still returned the same "Settings updated" success response, an
    // operator setting a hostname had no way to tell it silently didn't
    // apply on the router until a customer reported the address not
    // working days later.
    let portalHostnameWarning = null;
    if ('portal_hostname' in updates) {
      const mode = db.prepare("SELECT value FROM settings WHERE key = 'network_mode'").get()?.value || 'standalone';
      if (mode === 'mikrotik') {
        if (updates.portal_hostname) {
          const applied = await require('../services/mikrotikService').setPortalDnsName(updates.portal_hostname);
          if (!applied) {
            portalHostnameWarning = 'Portal hostname was saved, but could not be applied on the router (check the LAN Connection MAC is set correctly and the router is reachable). Customers may not be able to reach it by name yet.';
          }
        }
      } else {
        applyNetworkSetup();
      }
    }

    return res.json({ success: true, message: 'Settings updated', warning: portalHostnameWarning || dnsFilterWarning });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/spam-settings
router.get('/spam-settings', adminAuth, (req, res) => {
  try {
    const getSetting = (key, def) => {
      const s = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return s ? s.value : def;
    };
    return res.json({
      success: true,
      enable_bandwidth_cap: getSetting('enable_bandwidth_cap', '0'),
      bandwidth_cap_download_mbps: getSetting('bandwidth_cap_download_mbps', '5'),
      bandwidth_cap_upload_mbps: getSetting('bandwidth_cap_upload_mbps', '5'),
      enable_bandwidth_burst: getSetting('enable_bandwidth_burst', '0'),
      bandwidth_burst_mbps: getSetting('bandwidth_burst_mbps', '20'),
      bandwidth_burst_seconds: getSetting('bandwidth_burst_seconds', '8'),
      max_mbps: getSetting('max_mbps', '5'),
      spam_max_attempts: getSetting('spam_max_attempts', '3'),
      spam_block_minutes: getSetting('spam_block_minutes', '1')
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/spam-settings
router.post('/spam-settings', adminAuth, (req, res) => {
  try {
    const { enable_bandwidth_cap, bandwidth_cap_download_mbps, bandwidth_cap_upload_mbps, enable_bandwidth_burst, bandwidth_burst_mbps, bandwidth_burst_seconds, max_mbps, spam_max_attempts, spam_block_minutes } = req.body;
    const updateSetting = (key, value) => {
      if (value === undefined) return;
      const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
      if (existing) {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value), key);
      } else {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
      }
    };
    updateSetting('enable_bandwidth_cap', enable_bandwidth_cap);
    updateSetting('bandwidth_cap_download_mbps', bandwidth_cap_download_mbps);
    updateSetting('bandwidth_cap_upload_mbps', bandwidth_cap_upload_mbps);
    updateSetting('enable_bandwidth_burst', enable_bandwidth_burst);
    updateSetting('bandwidth_burst_mbps', bandwidth_burst_mbps);
    updateSetting('bandwidth_burst_seconds', bandwidth_burst_seconds);
    updateSetting('max_mbps', max_mbps);
    updateSetting('spam_max_attempts', spam_max_attempts);
    updateSetting('spam_block_minutes', spam_block_minutes);
    console.log('⚙️ Spam/bandwidth settings updated');

    // A bandwidth-cap change only ever affected sessions created after
    // this save, an already-connected client kept its old speed until it
    // reconnected. Reapply to every currently active session now, so the
    // change is felt immediately, not just by future sessions. Fired
    // without awaiting it, this can touch many sessions over the network
    // (MikroTik mode) and the settings save itself should not wait on that.
    if (enable_bandwidth_cap !== undefined || bandwidth_cap_download_mbps !== undefined
      || bandwidth_cap_upload_mbps !== undefined || enable_bandwidth_burst !== undefined
      || bandwidth_burst_mbps !== undefined || bandwidth_burst_seconds !== undefined) {
      require('../services/sessionService').reapplyDefaultBandwidthToActiveSessions()
        .then((count) => { if (count) console.log(`📶 Reapplied bandwidth settings to ${count} active session(s)`); })
        .catch((e) => console.error('Failed to reapply bandwidth to active sessions:', e.message));
    }

    return res.json({ success: true, message: 'Settings updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Real bug found live: a file over the 5MB limit (or a file extension/
// mimetype the fileFilter above rejects) throws inside multer's own
// middleware, which - with no error-handling wired up for it - fell
// through to Express's default error handler: a raw HTML stack-trace
// page, not JSON. The client's `await res.json()` then threw its own
// parse error, showing a generic "Upload error" with zero indication of
// what actually went wrong (too big? wrong format?). Wrapping the multer
// call directly lets this route catch that error itself and reply with
// the same clean {success:false, message} shape every other failure
// here already uses.
function uploadImageMiddleware(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'That image is too large - max 5MB.'
      : (err.message || 'Upload failed.');
    res.status(400).json({ success: false, message });
  });
}

// POST /api/admin/upload/:type
router.post('/upload/:type', adminAuth, uploadImageMiddleware, (req, res) => {
  try {
    const { type } = req.params;
    if (!['logo', 'banner', 'voucher', 'promo', 'rental_logo', 'rental_wallpaper'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid upload type' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const fileUrl = `/portal/assets/${req.file.filename}`;

    // 'voucher' logos belong to a specific voucher_groups row (passed in by
    // the caller when creating the group), not a single global setting.
    if (type === 'voucher') {
      console.log(`📸 Uploaded voucher logo: ${fileUrl}`);
      return res.json({ success: true, url: fileUrl, message: 'Logo uploaded successfully' });
    }

    // 'promo' images are a whole ordered LIST (the portal's ad/promo
    // carousel), not a single overwritten setting like logo/banner below.
    if (type === 'promo') {
      const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM promo_banner_images').get().m;
      db.prepare('INSERT INTO promo_banner_images (image_path, sort_order) VALUES (?, ?)')
        .run(fileUrl, (maxOrder ?? -1) + 1);
      console.log(`📸 Uploaded promo banner image: ${fileUrl}`);
      return res.json({ success: true, url: fileUrl, message: 'Promo image uploaded successfully' });
    }

    // 'rental_wallpaper' is also a list (like 'promo' above), one active
    // at a time - see the /rental/wallpapers* routes for activate/delete.
    if (type === 'rental_wallpaper') {
      db.prepare('INSERT INTO rental_wallpapers (image_path, active) VALUES (?, 0)').run(fileUrl);
      console.log(`📸 Uploaded rental wallpaper: ${fileUrl}`);
      return res.json({ success: true, url: fileUrl, message: 'Wallpaper uploaded successfully' });
    }

    const key = type === 'logo' ? 'logo_url' : type === 'rental_logo' ? 'rental_logo_url' : 'banner_url';
    const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
    if (existing) {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(fileUrl, key);
    } else {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, fileUrl);
    }
    console.log(`📸 Uploaded ${type}: ${fileUrl}`);
    return res.json({ success: true, url: fileUrl, message: `${type} uploaded successfully` });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// ── Promo/ad carousel (portal's banner) ─────────────────────────────
router.get('/promo-banner-images', adminAuth, (req, res) => {
  try {
    const images = db.prepare('SELECT * FROM promo_banner_images ORDER BY sort_order ASC').all();
    res.json({ success: true, images });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/promo-banner-images/:id', adminAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT image_path FROM promo_banner_images WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM promo_banner_images WHERE id = ?').run(req.params.id);
    if (row) {
      const filePath = path.join(__dirname, '../../public', row.image_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/promo-banner-images/reorder - body: { ids: [3, 1, 2] }
// (the full id list in the operator's desired display order).
router.post('/promo-banner-images/reorder', adminAuth, (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const update = db.prepare('UPDATE promo_banner_images SET sort_order = ? WHERE id = ?');
    ids.forEach((id, index) => update.run(index, id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/assets
router.get('/assets', adminAuth, (req, res) => {
  try {
    const logo = db.prepare("SELECT value FROM settings WHERE key = 'logo_url'").get();
    const banner = db.prepare("SELECT value FROM settings WHERE key = 'banner_url'").get();
    return res.json({
      success: true,
      logo_url: logo ? logo.value : null,
      banner_url: banner ? banner.value : null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/backup
router.get('/backup', adminAuth, (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings').all();
    const settingsObj = {};
    settings.forEach(s => { settingsObj[s.key] = s.value; });

    const rates = db.prepare('SELECT * FROM rates ORDER BY coin_value ASC').all();
    const promos = db.prepare('SELECT * FROM promo_vouchers ORDER BY created_at DESC').all();
    const transactions = db.prepare('SELECT * FROM transactions ORDER BY created_at DESC').all();
    // Bug found during pre-beta backup/restore drill: this backup silently
    // omitted every table added after the original backup/restore routes
    // were written - voucher_groups (batch names/pricing), satellite_kiosks
    // (device keys, unrecoverable once lost - a kiosk would need to be
    // re-paired), session_history (average session duration data). A
    // "restore my backup after a disaster" flow would have permanently
    // lost all of it with no warning.
    const voucherGroups = db.prepare('SELECT * FROM voucher_groups ORDER BY created_at DESC').all();
    const satelliteKiosks = db.prepare('SELECT * FROM satellite_kiosks ORDER BY created_at DESC').all();
    const sessionHistory = db.prepare('SELECT * FROM session_history ORDER BY id DESC').all();

    const backup = {
      version: '1.1.0',
      exported_at: new Date().toISOString(),
      settings: settingsObj,
      rates,
      promo_vouchers: promos,
      transactions,
      voucher_groups: voucherGroups,
      satellite_kiosks: satelliteKiosks,
      session_history: sessionHistory,
    };

    console.log('💾 Backup exported');
    return res.json({ success: true, backup });
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ success: false, message: 'Backup failed' });
  }
});

// POST /api/admin/restore
router.post('/restore', adminAuth, (req, res) => {
  try {
    const { backup } = req.body;

    if (!backup || !backup.version) {
      return res.status(400).json({ success: false, message: 'Invalid backup file' });
    }

    // Validate backup structure (Bug #18)
    for (const key of ['rates', 'promo_vouchers', 'transactions', 'voucher_groups', 'satellite_kiosks', 'session_history']) {
      if (backup[key] && !Array.isArray(backup[key])) {
        return res.status(400).json({ success: false, message: `Invalid ${key} format` });
      }
    }

    // Bug found during pre-beta backup/restore drill: everything below used
    // to run as a sequence of separate, uncommitted statements outside any
    // transaction. If validation of a LATER table threw (a malformed row,
    // caught below by the same per-row checks that already existed), every
    // table processed BEFORE that point had already been DELETEd and
    // reinserted - the operator was left with a database that was neither
    // the original data nor the backup, mid-restore, with no way back
    // short of a file-level DB backup they may not have. Verified live:
    // reproduced this exact corruption with a 3-row promo_vouchers backup
    // where the 2nd row was malformed - the table ended up with different
    // contents than either the pre-restore state or the intended backup.
    // db.transaction() makes the whole restore atomic: any throw anywhere
    // below rolls back every change made so far in this call, leaving the
    // original data completely untouched.
    //
    // Also restores voucher_groups/satellite_kiosks/session_history (were
    // silently dropped by both backup and restore before this fix - see
    // GET /backup above) and preserves original row IDs for
    // voucher_groups/satellite_kiosks/promo_vouchers/transactions instead
    // of letting them re-auto-increment, since promo_vouchers.group_id and
    // transactions.kiosk_id are real references to those tables' ids - the
    // previous "skip ID to avoid conflicts" approach silently orphaned
    // every voucher batch grouping and kiosk attribution on restore, since
    // the restored group_id/kiosk_id no longer pointed at anything. Every
    // table here is already DELETEd before reinsert, so there's no actual
    // ID-collision risk being avoided by skipping IDs in the first place.
    const runRestore = db.transaction(() => {
      // Bug found running this exact drill: promo_vouchers.group_id has a
      // real enforced FOREIGN KEY to voucher_groups(id) (`PRAGMA
      // foreign_key_list(promo_vouchers)` confirms it). Deleting
      // voucher_groups BEFORE promo_vouchers - the natural order if you
      // restore table-by-table - fails immediately with "FOREIGN KEY
      // constraint failed", since the old promo_vouchers rows still
      // reference the voucher_groups rows being deleted. Fixed by doing
      // every DELETE first, children before parents, then every INSERT,
      // parents before children - the two orders are opposites of each
      // other and can't be done table-by-table in one pass.
      if (backup.transactions) db.prepare('DELETE FROM transactions').run();
      if (backup.promo_vouchers) db.prepare('DELETE FROM promo_vouchers').run();
      if (backup.session_history) db.prepare('DELETE FROM session_history').run();
      if (backup.rates) db.prepare('DELETE FROM rates').run();
      if (backup.satellite_kiosks) db.prepare('DELETE FROM satellite_kiosks').run();
      if (backup.voucher_groups) db.prepare('DELETE FROM voucher_groups').run();

      if (backup.settings) {
        const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        for (const [key, value] of Object.entries(backup.settings)) {
          upsert.run(key, String(value));
        }
      }

      if (backup.rates && backup.rates.length > 0) {
        const insertRate = db.prepare(
          'INSERT INTO rates (coin_value, minutes, expiration_minutes, label) VALUES (?, ?, ?, ?)'
        );
        for (const r of backup.rates) {
          if (!r.coin_value || !r.minutes || !r.expiration_minutes || !r.label) {
            throw new Error('Invalid rate data');
          }
          insertRate.run(r.coin_value, r.minutes, r.expiration_minutes, r.label);
        }
      }

      // Restored before promo_vouchers/transactions since both reference
      // these tables' ids.
      if (backup.voucher_groups && backup.voucher_groups.length > 0) {
        const insertGroup = db.prepare(
          'INSERT INTO voucher_groups (id, name, quantity, duration_minutes, price, print_caption, print_logo_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const g of backup.voucher_groups) {
          if (!g.id || !g.name) throw new Error('Invalid voucher group data');
          insertGroup.run(g.id, g.name, g.quantity || 0, g.duration_minutes || 0, g.price || 0, g.print_caption || null, g.print_logo_url || null, g.created_at || new Date().toISOString());
        }
      }

      if (backup.satellite_kiosks && backup.satellite_kiosks.length > 0) {
        const insertKiosk = db.prepare(
          'INSERT INTO satellite_kiosks (id, name, device_key, last_seen, created_at) VALUES (?, ?, ?, ?, ?)'
        );
        for (const k of backup.satellite_kiosks) {
          if (!k.id || !k.name || !k.device_key) throw new Error('Invalid satellite kiosk data');
          insertKiosk.run(k.id, k.name, k.device_key, k.last_seen || null, k.created_at || new Date().toISOString());
        }
      }

      if (backup.promo_vouchers && backup.promo_vouchers.length > 0) {
        const insertPromo = db.prepare(`
          INSERT INTO promo_vouchers
          (id, code, duration_days, price, status, mac_address, created_at, expires_at, group_id, download_mbps, upload_mbps)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const p of backup.promo_vouchers) {
          if (!p.id || !p.code || !p.duration_days) throw new Error('Invalid promo data');
          insertPromo.run(p.id, p.code, p.duration_days, p.price || 0, p.status || 'unused', p.mac_address || null, p.created_at || new Date().toISOString(), p.expires_at || null, p.group_id || null, p.download_mbps || null, p.upload_mbps || null);
        }
      }

      if (backup.transactions && backup.transactions.length > 0) {
        const insertTx = db.prepare(`
          INSERT INTO transactions
          (id, voucher_code, coin_value, minutes_added, type, created_at, kiosk_id, mac_address)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const t of backup.transactions) {
          if (!t.id || !t.voucher_code || typeof t.minutes_added !== 'number') throw new Error('Invalid transaction data');
          insertTx.run(t.id, t.voucher_code, t.coin_value || 0, t.minutes_added, t.type || 'coin', t.created_at || new Date().toISOString(), t.kiosk_id || null, t.mac_address || null);
        }
      }

      if (backup.session_history && backup.session_history.length > 0) {
        const insertHist = db.prepare(
          'INSERT INTO session_history (id, voucher_code, mac_address, started_at, ended_at, duration_seconds) VALUES (?, ?, ?, ?, ?, ?)'
        );
        for (const h of backup.session_history) {
          if (!h.id || !h.voucher_code) throw new Error('Invalid session history data');
          insertHist.run(h.id, h.voucher_code, h.mac_address || null, h.started_at || null, h.ended_at || new Date().toISOString(), h.duration_seconds || 0);
        }
      }
    });

    runRestore();

    console.log('♻️ Restore completed with validation (transactional)');
    return res.json({ success: true, message: 'Restore completed successfully' });
  } catch (err) {
    console.error('Restore error (rolled back, original data untouched):', err);
    res.status(500).json({ success: false, message: 'Restore failed, no changes were made: ' + err.message });
  }
});

// Bug: the Dashboard's "WiFi AP" status badge was hardcoded HTML
// ("Online", no id, nothing ever touches it), it would say Online even
// if the AP interface were physically down. Checks the actual LAN
// interface link state (same interface bandwidth shaping already targets).
//
// Bug found live, still in mikrotik/router mode: this always checked THIS
// server's own LAN interface link state - meaningless there, since in
// router mode this box is just another device on the MikroTik's network
// (setup-network.sh's own comment says exactly that) and the real AP is a
// separate device plugged into the router, not this server's NIC at all.
// Router mode now asks the router itself for the physical link state of
// whichever port(s) are assigned the 'gated' role (the customer WiFi
// lane) - that's the actual signal for "is the AP's uplink port alive."
async function getWifiApStatus() {
  const mode = db.prepare("SELECT value FROM settings WHERE key = 'network_mode'").get()?.value || 'standalone';

  if (mode === 'mikrotik') {
    try {
      const gatedPorts = db.prepare("SELECT port_name FROM router_ports WHERE role = 'gated'").all().map(r => r.port_name);
      if (gatedPorts.length === 0) return { status: 'unknown', detail: 'No gated (customer WiFi) port assigned yet. Set one up in Network > Ports and Roles.' };
      const ports = await require('../services/mikrotikService').getRouterPorts();
      const relevant = ports.filter(p => gatedPorts.includes(p.name));
      if (relevant.length === 0) return { status: 'unknown', detail: 'Assigned port not found on the router.' };
      const anyUp = relevant.some(p => p.running);
      return {
        status: anyUp ? 'up' : 'down',
        detail: `Router port${relevant.length > 1 ? 's' : ''} ${relevant.map(p => p.name).join(', ')}: ${anyUp ? 'link up' : 'no link detected'}`
      };
    } catch (e) {
      return { status: 'unknown', detail: 'Could not reach the router to check port status.' };
    }
  }

  try {
    const lanIf = db.prepare("SELECT value FROM settings WHERE key = 'lan_interface'").get()?.value || 'enp0s8';
    const output = execSync(`ip link show ${lanIf}`, { timeout: 2000 }).toString();
    if (/state UP/.test(output)) return { status: 'up', detail: `Interface ${lanIf}: link up` };
    if (/state DOWN/.test(output)) return { status: 'down', detail: `Interface ${lanIf}: no link detected` };
    return { status: 'unknown', detail: `Interface ${lanIf}: state unknown` };
  } catch (e) {
    return { status: 'unknown', detail: 'Could not read interface state.' };
  }
}

// Bug: os.cpus()[i].times are cumulative tick counts since the system
// booted, not since the last check, computing usage from a single
// snapshot gives "average load since boot" (barely moves, and on a
// server that's been up for weeks looks nothing like current load).
// Real usage needs two samples with a delay and the delta between them.
async function getCpuUsagePercents(cpusBefore, sampleMs = 300) {
  await new Promise(resolve => setTimeout(resolve, sampleMs));
  const cpusAfter = os.cpus();
  return cpusBefore.map((before, i) => {
    const after = cpusAfter[i].times;
    const idleDelta = after.idle - before.times.idle;
    const totalDelta = Object.keys(after).reduce(
      (sum, key) => sum + (after[key] - before.times[key]), 0
    );
    return totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
  });
}

// Bug: os.freemem() counts reclaimable page cache/buffers as "used",
// on Linux that overstates real memory pressure (this project's docs
// elsewhere are explicit about caring about accurate RAM usage on
// low-spec hardware). /proc/meminfo's MemAvailable is the real figure
// `free -m`'s "available" column uses; fall back to os.freemem() where
// that file doesn't exist (non-Linux, or old kernels pre-3.14).
function getAvailableMem() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (match) return parseInt(match[1], 10) * 1024;
  } catch (e) {}
  return os.freemem();
}

// GET /api/admin/sysinfo
// GET /api/admin/network-stats, Dashboard's optional (comprehensive mode
// only) live bandwidth graph. Standalone mode computes a rate from two
// interface byte-counter samples (module-level cache below); router mode
// asks the MikroTik directly for an instant rate on the gated port(s),
// which needs no sampling at all. Either path fails soft to 0/0 rather
// than erroring - this is a nice-to-have graph, not core function.
let lastIfSample = null; // { bytes: {rx, tx}, time }

router.get('/network-stats', adminAuth, async (req, res) => {
  try {
    const mode = db.prepare("SELECT value FROM settings WHERE key = 'network_mode'").get()?.value || 'standalone';

    if (mode === 'mikrotik') {
      const gatedPorts = db.prepare("SELECT port_name FROM router_ports WHERE role = 'gated'").all().map(r => r.port_name);
      if (gatedPorts.length === 0) return res.json({ success: true, download_mbps: 0, upload_mbps: 0 });
      const traffic = await require('../services/mikrotikService').getInterfaceTraffic(gatedPorts);
      return res.json({ success: true, ...traffic });
    }

    const lanIf = db.prepare("SELECT value FROM settings WHERE key = 'lan_interface'").get()?.value || 'enp0s8';
    const rxBytes = parseInt(fs.readFileSync(`/sys/class/net/${lanIf}/statistics/rx_bytes`, 'utf8').trim(), 10);
    const txBytes = parseInt(fs.readFileSync(`/sys/class/net/${lanIf}/statistics/tx_bytes`, 'utf8').trim(), 10);
    const now = Date.now();

    if (!lastIfSample) {
      lastIfSample = { rxBytes, txBytes, time: now };
      return res.json({ success: true, download_mbps: 0, upload_mbps: 0 });
    }

    const elapsedSec = (now - lastIfSample.time) / 1000;
    const download_mbps = elapsedSec > 0 ? Math.round(((rxBytes - lastIfSample.rxBytes) * 8 / 1000000 / elapsedSec) * 10) / 10 : 0;
    const upload_mbps = elapsedSec > 0 ? Math.round(((txBytes - lastIfSample.txBytes) * 8 / 1000000 / elapsedSec) * 10) / 10 : 0;
    lastIfSample = { rxBytes, txBytes, time: now };

    return res.json({ success: true, download_mbps: Math.max(0, download_mbps), upload_mbps: Math.max(0, upload_mbps) });
  } catch (err) {
    return res.json({ success: true, download_mbps: 0, upload_mbps: 0 });
  }
});

// GET /api/admin/hardware/gpio-capability, lets the Main Kiosk Coin Slot
// settings page tell an operator up front whether their actual hardware
// can support direct-GPIO wiring at all, instead of letting them configure
// something that can never work on a Windows box, a generic Linux PC, or a
// VM with no GPIO header. Satellite Kiosk is unaffected by this check - an
// ESP32 relaying over WiFi/HTTP works on any hardware.
router.get('/hardware/gpio-capability', adminAuth, (req, res) => {
  try {
    const { detectGpioCapability } = require('../services/hardwareDetection');
    return res.json({ success: true, ...detectGpioCapability() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/sysinfo', adminAuth, async (req, res) => {
  try {
    const cpus = os.cpus();
    const cpuUsage = await getCpuUsagePercents(cpus);

    const totalMem = os.totalmem();
    const freeMem = getAvailableMem();
    const usedMem = totalMem - freeMem;

    const uptimeSecs = os.uptime();
    const days = Math.floor(uptimeSecs / 86400);
    const hours = Math.floor((uptimeSecs % 86400) / 3600);
    const mins = Math.floor((uptimeSecs % 3600) / 60);
    const uptime = `${days}d ${hours}h ${mins}m`;
    // Bug: the Dashboard's "Server Uptime" widget never called this endpoint
    // at all, it ran its own client-side timer starting from page load, so
    // every browser refresh reset it to 00:00:00 regardless of how long the
    // actual server had been running. Raw seconds let it seed a real base.
    const uptimeSeconds = Math.floor(uptimeSecs);

    const nets = os.networkInterfaces();
    let ipAddress = 'N/A';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          ipAddress = net.address;
          break;
        }
      }
      if (ipAddress !== 'N/A') break;
    }

    let machineId = 'N/A';
    try {
      machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    } catch(e) {}

    let gateway = 'N/A';
    try {
      const route = execSync('ip route show default', { timeout: 2000 }).toString();
      const match = route.match(/via\s+(\S+)/);
      if (match) gateway = match[1];
    } catch(e) {}

    let storage = { total: 'N/A', used: 'N/A', free: 'N/A', percent: 0 };
    try {
      const df = execSync('df -h / --output=size,used,avail,pcent', { timeout: 2000 }).toString();
      const lines = df.trim().split('\n');
      if (lines[1]) {
        const parts = lines[1].trim().split(/\s+/);
        storage = {
          total: parts[0],
          used: parts[1],
          free: parts[2],
          percent: parseInt(parts[3]) || 0
        };
      }
    } catch(e) {}

    const licenseSetting = db.prepare(
      "SELECT value FROM settings WHERE key = 'license'"
    ).get();
    const license = licenseSetting ? licenseSetting.value : 'Private';
    const wifiAp = await getWifiApStatus();
    const paymentMethods = db.prepare("SELECT value FROM settings WHERE key = 'payment_methods'").get()?.value || 'both';
    const hardwareTier = require('../services/hardwareDetection').detect();

    return res.json({
      success: true,
      sysinfo: {
        platform: os.type() + ' ' + os.release(),
        processor: cpus[0].model,
        cpu_cores: cpus.length,
        cpu_usage: cpuUsage,
        total_mem: totalMem,
        used_mem: usedMem,
        free_mem: freeMem,
        mem_percent: Math.round((usedMem / totalMem) * 100),
        uptime,
        wifi_ap_status: wifiAp.status,
        wifi_ap_detail: wifiAp.detail,
        payment_methods: paymentMethods,
        uptime_seconds: uptimeSeconds,
        ip_address: ipAddress,
        gateway,
        machine_id: machineId,
        device_id: require('../services/deviceIdentity').getDeviceIdentity().id,
        license_status: require('../services/licenseService').getLicenseStatus(),
        storage,
        version: 'v' + require('../../package.json').version,
        license,
        hardware_tier: hardwareTier
      }
    });

  } catch (err) {
    console.error('Sysinfo error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/vendo/register
// Bug: this required adminAuth, but it's called by the ESP32 vendo
// hardware itself (on boot, and every ~60s as a heartbeat), the firmware
// has no admin password and was never built to send one, so every single
// registration/heartbeat call has always been silently rejected with 401.
// In practice this meant the Devices page and the Dashboard's "Coin Slot"
// status could never show a real vendo as online. Matches the existing
// unauthenticated-trusted-LAN-hardware pattern already used for POST
// /api/coin (also called directly by the ESP32, also no admin password).
router.post('/vendo/register', (req, res) => {
  try {
    const { name, ip, version, device_secret } = req.body;

    if (!req.body.mac || !name) {
      return res.status(400).json({ success: false, message: 'MAC and name required' });
    }

    // Normalize casing, vendos.mac_address is UNIQUE with an ON CONFLICT
    // upsert below, which only matches same-case duplicates.
    const mac = String(req.body.mac).trim().toLowerCase();

    // Vendo Protocol spec: "Never automatically adopt a device merely
    // because it advertises itself." A MAC this box has never seen before
    // registers as an unapproved candidate; re-registration (the 60s
    // heartbeat) never touches status either way, so an admin's adopt/
    // ignore decision sticks regardless of how often the device checks in.
    // Registration itself still always succeeds either way - real deployed
    // hardware expects a normal response, and nothing here gates any real
    // capability behind adoption (this table has never been used for
    // financial attribution), so this is a visibility/approval gate, not
    // an access-control one.
    const existing = db.prepare('SELECT id, device_secret, status FROM vendos WHERE mac_address = ?').get(mac);

    // Bug: trust in this MAC (adoption, trusted-device bypass) was based on
    // the bare MAC address alone, trivially spoofable by anything on the
    // same LAN claiming to be it. Same secret pattern already used for
    // Satellite Kiosks (device_key): generated once on first registration,
    // handed back to the firmware to store, then required on every future
    // call. A device that's already been issued one but doesn't send it
    // back (or sends the wrong one) is rejected outright, someone else's
    // hardware can still register under a NEW candidate MAC, but it can't
    // impersonate an already-known one. A legacy row from before this
    // feature existed (device_secret NULL) gets one issued on its next
    // check-in instead of being locked out.
    if (existing && existing.device_secret && device_secret !== existing.device_secret) {
      console.warn(`⚠️ Vendo register rejected: ${mac} sent a missing/incorrect device secret`);
      return res.status(403).json({ success: false, message: 'Invalid device secret' });
    }

    let issuedSecret = existing ? existing.device_secret : null;
    if (!issuedSecret) {
      issuedSecret = require('crypto').randomBytes(20).toString('hex');
    }

    if (existing) {
      db.prepare(`
        UPDATE vendos SET name = ?, ip_address = ?, firmware = ?, device_secret = ?, last_seen = CURRENT_TIMESTAMP
        WHERE mac_address = ?
      `).run(name, ip || '', version || '', issuedSecret, mac);
    } else {
      db.prepare(`
        INSERT INTO vendos (mac_address, name, ip_address, firmware, device_secret, last_seen, status)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'candidate')
      `).run(mac, name, ip || '', version || '', issuedSecret);
      require('../services/alertEventService').logAlertEvent('info', 'vendo_candidate_detected', `New device "${name}" detected`, `MAC ${mac} is broadcasting but not yet approved - see Devices to adopt or ignore it.`);
    }

    // No auth on this route (see note above) means anyone on the LAN could
    // otherwise POST a fake ip here and hijack vendo_ip, the address
    // portal.js's /relay/:action route sends every "Insert Coin" relay
    // trigger to. Confining it to private LAN ranges at least keeps a
    // hijack attempt on-network rather than redirecting relay calls to an
    // arbitrary external address.
    const isPrivateLanIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip || '');
    if (ip && isPrivateLanIp) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run('vendo_ip', ip);
    }

    console.log(`📡 Vendo registered: ${name} (${mac}) at ${ip}`);
    // `status` lets firmware know whether it's genuinely adopted - a real
    // brownout/connectivity incident showed the device had no way to tell
    // "I'm bound to this server" from "I've never been approved", so it
    // fell back into its own setup hotspot on any long connectivity gap
    // regardless of adoption state. Firmware now persists this and only
    // auto-opens setup mode when it's NOT adopted; the only way an
    // already-adopted device sees 'candidate' again is a genuine unbind
    // (an admin deleting it from Devices, so this exact mac comes back
    // as a brand-new row on its next check-in) - that's the deliberate,
    // only-other path back to setup mode this was scoped to support.
    return res.json({ success: true, message: 'Vendo registered', device_secret: issuedSecret, status: existing ? existing.status : 'candidate' });

  } catch (err) {
    console.error('Vendo register error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/vendo/coin-queue-sync - device-facing (no adminAuth, mirrors
// /api/coin's trusted-LAN-hardware pattern), device_secret required. Lets
// a coin acceptor upload coin events it detected but couldn't send live
// (server/network unreachable at the time - firmware's own postCoin()
// retry window, ~18s, had already exhausted) once it reconnects, instead
// of those coins being permanently lost with zero record. These are, by
// definition, coins that arrived with no live customer pending-window
// match possible (the customer's own phone interaction already timed out
// minutes/hours ago by the time this sync happens) - credited the same
// way the existing no-pending-match fail-safe already handles this
// (coin.js's coin_credited_no_pending_match path): to the device's own
// mac, clearly flagged, real money never silently dropped, an operator
// can review and manually reconcile with a customer if identifiable.
router.post('/vendo/coin-queue-sync', async (req, res) => {
  try {
    const mac = String(req.body?.mac || '').trim().toLowerCase();
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (!mac || events.length === 0) {
      return res.status(400).json({ success: false, message: 'mac and events required' });
    }
    const vendo = db.prepare('SELECT device_secret FROM vendos WHERE mac_address = ?').get(mac);
    if (!vendo) return res.status(404).json({ success: false, message: 'Unknown device' });
    if (vendo.device_secret && req.body?.device_secret !== vendo.device_secret) {
      return res.status(403).json({ success: false, message: 'Invalid device secret' });
    }

    const { creditCoinValue, NoMatchingRateError } = require('../services/coinCreditService');
    const { logAlertEvent } = require('../services/alertEventService');
    let credited = 0;
    let failed = 0;
    for (const ev of events) {
      const coinValue = parseInt(ev?.value, 10);
      if (!coinValue || coinValue <= 0) { failed++; continue; }
      try {
        db.prepare('INSERT INTO coin_pulse_log (mac_address, coin_value) VALUES (?, ?)').run(mac, coinValue);
      } catch (e) {}
      try {
        await creditCoinValue(mac, coinValue, '', null);
        credited++;
      } catch (e) {
        if (!(e instanceof NoMatchingRateError)) console.error('Coin queue sync credit error:', e.message);
        failed++;
      }
    }
    logAlertEvent(
      'warning',
      'coin_queue_synced',
      `Delayed coin sync from ${mac}: ${events.length} event(s)`,
      `This device queued ${events.length} coin event(s) while it couldn't reach the server (₱${credited > 0 ? 'credited to the device\'s own address, review and reconcile with a customer if identifiable' : 'none matched a rate'}). ${failed > 0 ? `${failed} could not be matched to any rate.` : ''}`
    );
    console.log(`🔄 Vendo ${mac} synced ${events.length} queued coin event(s): ${credited} credited, ${failed} failed`);
    return res.json({ success: true, credited, failed });
  } catch (err) {
    console.error('Coin queue sync error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/vendo/device-log-sync - device-facing, same auth pattern.
// A small lifecycle log (WiFi lost/regained, setup mode entered, coin
// queued/synced) the device keeps locally and uploads once reconnected -
// this incident showed "the logs can't tell it, just Self-heal check
// passed" - having the DEVICE's own account of what it experienced,
// even hours later, is real diagnostic signal a server-side log alone
// can never produce (the server has no visibility into what a
// disconnected device was doing). No dedicated admin UI yet - stored for
// now, queryable directly; worth a real page once there's a sense of
// what an operator actually wants to see.
router.post('/vendo/device-log-sync', (req, res) => {
  try {
    const mac = String(req.body?.mac || '').trim().toLowerCase();
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (!mac || events.length === 0) {
      return res.status(400).json({ success: false, message: 'mac and events required' });
    }
    const vendo = db.prepare('SELECT device_secret FROM vendos WHERE mac_address = ?').get(mac);
    if (!vendo) return res.status(404).json({ success: false, message: 'Unknown device' });
    if (vendo.device_secret && req.body?.device_secret !== vendo.device_secret) {
      return res.status(403).json({ success: false, message: 'Invalid device secret' });
    }
    const insert = db.prepare('INSERT INTO vendo_device_log (mac_address, message, device_at) VALUES (?, ?, ?)');
    for (const ev of events.slice(0, 200)) {
      insert.run(mac, String(ev?.message || '').slice(0, 500), ev?.at || null);
    }
    return res.json({ success: true, stored: Math.min(events.length, 200) });
  } catch (err) {
    console.error('Device log sync error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Every firmware push used to go straight to every vendo's next check-in
// with no way to stage it first - fine for a one-device test setup, risky
// for a fleet where a bad build now means every coin slot in the field
// bricks itself overnight. `vendo_firmware_auto_update` ('0'/'1', default
// on so existing behavior doesn't change for anyone who never touches this)
// decides whether a push goes live immediately (sets `released`) or just
// stages the version+file until the admin explicitly clicks Release
// (POST /vendo/firmware/release below). Returns whether auto-update is on,
// so callers can word their success message accordingly.
function stageOrReleaseVendoFirmware(upsert) {
  const autoUpdate = db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_auto_update'").get()?.value !== '0';
  upsert.run('vendo_firmware_released', autoUpdate ? '1' : '0');
  return autoUpdate;
}

// GET /api/admin/vendo/firmware, current pushed version, for the Devices
// page's own display (admin-authenticated, this one's a UI read, not
// something the ESP32 itself needs to call).
router.get('/vendo/firmware', adminAuth, (req, res) => {
  try {
    const version = db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_version'").get()?.value || null;
    const uploadedAt = db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_uploaded_at'").get()?.value || null;
    const hasFile = fs.existsSync(firmwarePath);
    const autoUpdate = db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_auto_update'").get()?.value !== '0';
    const released = db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_released'").get()?.value === '1';
    return res.json({ success: true, version, uploaded_at: uploadedAt, has_file: hasFile, auto_update: autoUpdate, released: autoUpdate || released });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/vendo/firmware, push a new firmware .bin (compiled via
// Arduino IDE's Sketch > Export Compiled Binary) for every ESP32 vendo to
// pick up over its next OTA check (esp32/firmware/rj_pisowifi/ota.cpp),
// instead of needing a USB cable and Arduino IDE on-site for every update.
router.post('/vendo/firmware', adminAuth, firmwareUpload.single('firmware'), (req, res) => {
  try {
    const { version } = req.body;
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No firmware file uploaded' });
    }
    if (!version || !String(version).trim()) {
      return res.status(400).json({ success: false, message: 'Version is required (must match FIRMWARE_VERSION in config.h)' });
    }
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    upsert.run('vendo_firmware_version', String(version).trim());
    // devices.js's timeAgo() expects SQLite's own CURRENT_TIMESTAMP shape
    // ("YYYY-MM-DD HH:MM:SS", space-separated, no "Z") - a plain
    // toISOString() has a "T" and trailing "Z" already, which timeAgo()'s
    // own "add a Z" step would double up into an unparseable string.
    upsert.run('vendo_firmware_uploaded_at', new Date().toISOString().slice(0, 19).replace('T', ' '));
    const autoUpdate = stageOrReleaseVendoFirmware(upsert);
    console.log(`📦 Vendo firmware updated: ${version}${autoUpdate ? '' : ' (staged, not yet released)'}`);
    return res.json({
      success: true,
      message: autoUpdate
        ? 'Firmware uploaded. Vendos will pick it up on their next check-in'
        : 'Firmware staged. Click "Release Update" to push it to devices',
    });
  } catch (err) {
    console.error('Vendo firmware upload error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/vendo/firmware/bundled, what version ships with this app
// right now (public/admin/assets/firmware/manifest.json), so the admin
// panel can show a one-click "Update to vX.X.X" button instead of making
// the admin locate and upload a .bin by hand every time.
router.get('/vendo/firmware/bundled', adminAuth, (req, res) => {
  try {
    const manifestPath = path.join(__dirname, '../../public/admin/assets/firmware/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const currentVersion = db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_version'").get()?.value || null;
    return res.json({ success: true, esp8266: manifest.esp8266, currentVersion });
  } catch (err) {
    console.error('Bundled vendo firmware read error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/vendo/firmware/push-bundled, one click, no file upload:
// copies the ESP8266 build already shipped with this app straight into
// the OTA slot every adopted vendo checks against. Same effect as the
// manual upload route above, just sourcing the file from
// assets/firmware/ instead of a multipart upload.
router.post('/vendo/firmware/push-bundled', adminAuth, (req, res) => {
  try {
    const manifestPath = path.join(__dirname, '../../public/admin/assets/firmware/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = manifest.esp8266;
    if (!entry || !entry.files?.[0]?.file) {
      return res.status(500).json({ success: false, message: 'No bundled ESP8266 firmware found' });
    }
    const bundledPath = path.join(__dirname, '../../public/admin/assets/firmware', entry.files[0].file);
    if (!fs.existsSync(bundledPath)) {
      return res.status(500).json({ success: false, message: 'Bundled firmware file is missing' });
    }
    fs.copyFileSync(bundledPath, firmwarePath);
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    upsert.run('vendo_firmware_version', entry.version);
    upsert.run('vendo_firmware_uploaded_at', new Date().toISOString().slice(0, 19).replace('T', ' '));
    const autoUpdate = stageOrReleaseVendoFirmware(upsert);
    console.log(`📦 Vendo firmware updated (bundled): ${entry.version}${autoUpdate ? '' : ' (staged, not yet released)'}`);
    return res.json({
      success: true,
      version: entry.version,
      message: autoUpdate
        ? `Pushed ${entry.version}. Vendos will pick it up on their next check-in`
        : `Staged ${entry.version}. Click "Release Update" to push it to devices`,
    });
  } catch (err) {
    console.error('Push bundled vendo firmware error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/vendo/firmware/auto-update, toggles whether a firmware
// push goes live to the fleet immediately (on) or just stages until the
// admin explicitly releases it (off, see /release below).
router.post('/vendo/firmware/auto-update', adminAuth, (req, res) => {
  try {
    const enabled = !!req.body.enabled;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vendo_firmware_auto_update', enabled ? '1' : '0');
    console.log(`📦 Vendo firmware auto-update: ${enabled ? 'ON' : 'OFF'}`);
    return res.json({ success: true, auto_update: enabled });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/vendo/firmware/release, manually releases an already-
// staged version to the fleet (auto-update off path only; a no-op, still
// success, if there's nothing staged or auto-update is already on).
router.post('/vendo/firmware/release', adminAuth, (req, res) => {
  try {
    const version = db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_version'").get()?.value;
    if (!version) return res.status(400).json({ success: false, message: 'No firmware staged yet' });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('vendo_firmware_released', '1')").run();
    console.log(`📦 Vendo firmware released to fleet: ${version}`);
    return res.json({ success: true, version });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/vendo/firmware/version, unauthenticated, same reasoning
// as /vendo/register above: called directly by ESP32 firmware with no
// admin password. Just the version string so a device can cheaply decide
// whether it needs to bother downloading the actual binary.
router.get('/vendo/firmware/version', (req, res) => {
  try {
    // Staged-but-not-released firmware (auto-update off, admin hasn't
    // clicked Release yet) must not be advertised here - a device treats
    // any non-matching version as "go download and flash this now", so
    // reporting an unreleased version would defeat the whole point of the
    // manual-release gate.
    const released = db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_released'").get()?.value === '1';
    const version = released
      ? db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_version'").get()?.value || ''
      : '';
    return res.json({ version });
  } catch (err) {
    res.status(500).json({ version: '' });
  }
});

// GET /api/admin/vendo/firmware/download, unauthenticated, same reasoning
// as above. Serves the raw .bin an ESP32 flashes itself with via ota.cpp.
router.get('/vendo/firmware/download', (req, res) => {
  if (!fs.existsSync(firmwarePath)) {
    return res.status(404).json({ success: false, message: 'No firmware uploaded yet' });
  }
  res.sendFile(firmwarePath, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ success: false, message: 'Failed to send firmware' });
    }
  });
});

// GET /api/admin/vendos
router.get('/vendos', adminAuth, (req, res) => {
  try {
    const vendos = db.prepare(`SELECT * FROM vendos ORDER BY last_seen DESC`).all();
    return res.json({ success: true, vendos });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/vendos/:id, removes a stale/replaced ESP32 entry from
// the Devices list. The device re-registers itself via POST /vendo/register
// on its next check-in if it's still actually live (as a fresh candidate,
// needing re-adoption, its device_secret is gone with the row). Also
// revokes the trust adopt granted it: leaving a removed device's bypass in
// place would mean "removed" doesn't actually mean removed, it'd keep
// skipping the captive portal forever.
router.delete('/vendos/:id', adminAuth, async (req, res) => {
  try {
    const vendo = db.prepare('SELECT * FROM vendos WHERE id = ?').get(req.params.id);
    if (!vendo) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }
    db.prepare('DELETE FROM vendos WHERE id = ?').run(req.params.id);

    const trusted = db.prepare('SELECT id FROM trusted_devices WHERE mac_address = ?').get(vendo.mac_address);
    if (trusted) {
      db.prepare('DELETE FROM trusted_devices WHERE id = ?').run(trusted.id);
      const { blockClient } = require('../services/networkService');
      try {
        await blockClient(vendo.mac_address);
      } catch (err) {
        console.error('Vendo removed but revoking trust bypass failed:', err.message);
      }
    }

    require('../services/networkDevicesService').logDeviceEvent(vendo.mac_address, 'vendo_removed', `"${vendo.name}" removed from StarkFi`);
    console.log(`🗑️  Vendo removed: ${vendo.mac_address} (${vendo.name})`);
    return res.json({ success: true, message: 'Device removed' });
  } catch (err) {
    console.error('Vendo delete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/vendos/:id, rename. Updates both this box's own record
// (what the Devices list shows) and pushes the new name to the device
// itself (its /rename, server-only gated) so its own LCD/status agree
// instead of drifting from what the admin panel calls it.
router.patch('/vendos/:id', adminAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    const vendo = db.prepare('SELECT ip_address FROM vendos WHERE id = ?').get(req.params.id);
    if (!vendo) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }
    db.prepare('UPDATE vendos SET name = ? WHERE id = ?').run(name, req.params.id);

    if (vendo.ip_address) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        await fetch(`http://${vendo.ip_address}/rename?name=${encodeURIComponent(name)}`, { method: 'POST', signal: controller.signal });
      } catch (err) {
        // Saved either way, the device's own LCD/status will just show
        // the old name until its next successful contact with this box,
        // same fallback shape as the trust-bypass/adopt flow above.
        console.error('Vendo renamed but could not reach device to sync:', err.message);
      } finally {
        clearTimeout(timeout);
      }
    }

    return res.json({ success: true, message: 'Device renamed' });
  } catch (err) {
    console.error('Vendo rename error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/vendos/:id/health, live detail beyond what the Devices
// list shows (uptime, static-IP config, relay/WiFi state), fetched
// straight from the device's own /status rather than duplicating any of
// it into this box's database.
router.get('/vendos/:id/health', adminAuth, async (req, res) => {
  try {
    const vendo = db.prepare('SELECT ip_address FROM vendos WHERE id = ?').get(req.params.id);
    if (!vendo) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }
    if (!vendo.ip_address) {
      return res.status(400).json({ success: false, message: 'No known IP for this device yet' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let statusRes;
    try {
      statusRes = await fetch(`http://${vendo.ip_address}/status`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    const status = await statusRes.json();
    return res.json({ success: true, ...status });
  } catch (err) {
    console.error('Vendo health error:', err.message);
    res.status(502).json({ success: false, message: 'Could not reach device. It may be offline' });
  }
});

// POST /api/admin/vendos/:id/network, { static_ip, device_ip, gateway, subnet }
// Proxies to the device's own /network (server-only gated). Restarts the
// device to apply, same as the firmware side already requires.
router.post('/vendos/:id/network', adminAuth, async (req, res) => {
  try {
    const vendo = db.prepare('SELECT ip_address FROM vendos WHERE id = ?').get(req.params.id);
    if (!vendo) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }
    if (!vendo.ip_address) {
      return res.status(400).json({ success: false, message: 'No known IP for this device yet' });
    }

    const { static_ip, device_ip, gateway, subnet } = req.body;
    const body = new URLSearchParams({ static_ip: static_ip ? 'true' : 'false' });
    if (static_ip) {
      if (!device_ip || !gateway || !subnet) {
        return res.status(400).json({ success: false, message: 'device_ip, gateway, and subnet are required for a static IP' });
      }
      body.set('device_ip', device_ip);
      body.set('gateway', gateway);
      body.set('subnet', subnet);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(`http://${vendo.ip_address}/network`, { method: 'POST', body, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    return res.json({ success: true, message: 'Network settings applied. Device is restarting' });
  } catch (err) {
    console.error('Vendo network update error:', err.message);
    res.status(502).json({ success: false, message: 'Could not reach device. It may be offline' });
  }
});

// PUT /api/admin/vendos/:id/restart-schedule, { time: 'HH:MM' | null }
// Read by timerService.js's minute-tick cron, which restarts the device at
// that local time each day (comparing against last_scheduled_restart so a
// slow tick or a server restart doesn't fire it twice in the same minute
// window, or skip a day if the cron runs a few seconds late/early).
router.put('/vendos/:id/restart-schedule', adminAuth, (req, res) => {
  try {
    const time = req.body.time ? String(req.body.time).trim() : null;
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return res.status(400).json({ success: false, message: 'Time must be in 24h HH:MM format' });
    }
    const result = db.prepare('UPDATE vendos SET restart_schedule = ? WHERE id = ?').run(time, req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }
    return res.json({ success: true, message: time ? `Scheduled to restart daily at ${time}` : 'Scheduled restart cleared' });
  } catch (err) {
    console.error('Vendo restart-schedule error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/vendos/:id/coinslot-purpose, { purpose: 'wifi'|'pc'|'both' }
// Read by coin.js's POST / (ESP32 coin-pulse handler) to decide which
// business line this specific coin acceptor may credit.
router.patch('/vendos/:id/coinslot-purpose', adminAuth, (req, res) => {
  try {
    const purpose = String(req.body.purpose || '').trim();
    if (!['wifi', 'pc', 'both'].includes(purpose)) {
      return res.status(400).json({ success: false, message: "purpose must be 'wifi', 'pc', or 'both'" });
    }
    const result = db.prepare('UPDATE vendos SET coinslot_purpose = ? WHERE id = ?').run(purpose, req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }
    return res.json({ success: true, message: 'Coinslot purpose saved' });
  } catch (err) {
    console.error('Vendo coinslot-purpose error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/vendos/:id/adopt, approves a candidate device (a MAC
// this box has never seen before, per POST /vendo/register above). Also
// trusts it in the same step - a Vendo shares the customer WiFi/VLAN and
// would otherwise sit behind the captive portal like any paying customer,
// unable to reach this server at all. Adopting used to require a second,
// manual step (Trusted Devices card: copy the MAC, paste it, submit) for
// something that's true of every adopted Vendo without exception - folded
// in here so there's one action instead of two.
router.post('/vendos/:id/adopt', adminAuth, async (req, res) => {
  try {
    const vendo = db.prepare('SELECT mac_address, name FROM vendos WHERE id = ?').get(req.params.id);
    const result = db.prepare("UPDATE vendos SET status = 'adopted' WHERE id = ?").run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }
    if (vendo) {
      require('../services/networkDevicesService').logDeviceEvent(vendo.mac_address, 'vendo_adopted', `"${vendo.name}" adopted`);

      // OR IGNORE instead of a separate check-then-insert: mac_address is
      // UNIQUE, so a double-click or client retry racing two adopt calls
      // for the same device would otherwise throw an uncaught constraint
      // violation on the loser, surfacing as a spurious 500 to the admin
      // even though the device was already successfully adopted+trusted
      // by the winner.
      const inserted = db.prepare('INSERT OR IGNORE INTO trusted_devices (mac_address, label) VALUES (?, ?)')
        .run(vendo.mac_address, `Vendo: ${vendo.name}`);
      if (inserted.changes > 0) {
        const { allowClient } = require('../services/networkService');
        try {
          await allowClient(vendo.mac_address);
        } catch (err) {
          // Row is saved either way, timerService.js's boot-time restore
          // will retry the actual bypass later (e.g. router unreachable
          // right now), same fallback the manual Trusted Devices flow relied on.
          console.error('Vendo adopted but trust bypass failed to apply immediately:', err.message);
        }
      }
    }
    return res.json({ success: true, message: 'Device adopted' });
  } catch (err) {
    console.error('Vendo adopt error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/vendos/:id/restart, proxies to the device's own
// server-only-gated POST /restart (esp8266/firmware/.../web_server.cpp),
// so an owner doesn't need to walk over and power-cycle a coin slot that's
// misbehaving. Requires the device's last-known IP, same LAN reachability
// assumption every other direct-to-vendo call in this app already makes.
router.post('/vendos/:id/restart', adminAuth, async (req, res) => {
  try {
    const vendo = db.prepare('SELECT mac_address, name, ip_address FROM vendos WHERE id = ?').get(req.params.id);
    if (!vendo) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }
    if (!vendo.ip_address) {
      return res.status(400).json({ success: false, message: 'No known IP for this device yet' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(`http://${vendo.ip_address}/restart`, { method: 'POST', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    require('../services/networkDevicesService').logDeviceEvent(vendo.mac_address, 'vendo_restarted', `"${vendo.name}" restarted from admin panel`);
    console.log(`🔄 Vendo restart requested: ${vendo.mac_address} (${vendo.name})`);
    return res.json({ success: true, message: 'Restart command sent' });
  } catch (err) {
    console.error('Vendo restart error:', err.message);
    res.status(502).json({ success: false, message: 'Could not reach device. It may be offline' });
  }
});

// PUT /api/admin/vendos/:id/role, { role: 'main' | 'sub' | 'standalone' }
// Purely organizational (spec section 17) - doesn't hard-code a single
// "main" Vendo, an operator can mark multiple as Main across sites.
router.put('/vendos/:id/role', adminAuth, (req, res) => {
  try {
    const role = String(req.body.role || '').trim();
    if (!['main', 'sub', 'standalone'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid role' });
    }
    const result = db.prepare('UPDATE vendos SET role = ? WHERE id = ?').run(role, req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Vendo role update error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== TRUSTED DEVICES =====
// Devices that should always have internet access, never gated behind
// payment (see database.js's trusted_devices table comment for why this
// exists, a coin-slot ESP32 sharing WiFi with paying customers because
// the access point can't reliably tag a second SSID onto its own VLAN,
// bugslog.md Bug #78). Trusting a device calls the same allowClient()
// bypass a paid session uses, works identically in both standalone and
// router mode since networkService.js already picks the right backend.

// GET /api/admin/trusted-devices
router.get('/trusted-devices', adminAuth, (req, res) => {
  try {
    const devices = db.prepare('SELECT * FROM trusted_devices ORDER BY created_at DESC').all();
    return res.json({ success: true, devices });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/trusted-devices
router.post('/trusted-devices', adminAuth, async (req, res) => {
  try {
    const { mac_address, label } = req.body;
    const mac = String(mac_address || '').trim().toLowerCase();
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
      return res.status(400).json({ success: false, message: 'Invalid MAC address' });
    }

    const existing = db.prepare('SELECT id FROM trusted_devices WHERE mac_address = ?').get(mac);
    if (existing) {
      return res.status(409).json({ success: false, message: 'This device is already trusted' });
    }

    const result = db.prepare(
      'INSERT INTO trusted_devices (mac_address, label) VALUES (?, ?)'
    ).run(mac, String(label || '').trim());

    const { allowClient } = require('../services/networkService');
    try {
      await allowClient(mac);
    } catch (err) {
      // Row is saved either way, timerService.js's boot-time restore will
      // retry the actual bypass later (e.g. router unreachable right now).
      console.error('Trusted device saved but bypass failed to apply immediately:', err.message);
    }

    console.log(`🔓 Trusted device added: ${mac} (${label || 'no label'})`);
    return res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Trusted device add error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/trusted-devices/:id
router.delete('/trusted-devices/:id', adminAuth, async (req, res) => {
  try {
    const device = db.prepare('SELECT * FROM trusted_devices WHERE id = ?').get(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, message: 'Trusted device not found' });
    }

    db.prepare('DELETE FROM trusted_devices WHERE id = ?').run(req.params.id);

    const { blockClient } = require('../services/networkService');
    try {
      await blockClient(device.mac_address);
    } catch (err) {
      console.error('Trusted device removed from list but revoking access failed:', err.message);
    }

    console.log(`🔒 Trusted device removed: ${device.mac_address}`);
    return res.json({ success: true, message: 'Trusted device removed' });
  } catch (err) {
    console.error('Trusted device remove error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/check-update
router.get('/check-update', adminAuth, async (req, res) => {
  try {
    const pkg = require('../../package.json');
    const currentVersion = pkg.version;

    const https = require('https');
    const options = {
      hostname: 'api.github.com',
      path: '/repos/jnunez2001/rj-pisowifi/releases/latest',
      headers: { 'User-Agent': 'RJ-PisoWifi' }
    };

    const req = https.get(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const release = JSON.parse(data);
          const latestVersion = release.tag_name?.replace('v', '') || currentVersion;
          const hasUpdate = latestVersion !== currentVersion;
          return res.json({
            success: true,
            current_version: currentVersion,
            latest_version: latestVersion,
            has_update: hasUpdate,
            release_notes: release.body || '',
            release_name: release.name || `v${latestVersion}`
          });
        } catch(e) {
          return res.json({
            success: true,
            current_version: currentVersion,
            latest_version: currentVersion,
            has_update: false,
            release_notes: ''
          });
        }
      });
    }).on('error', () => {
      return res.json({
        success: true,
        current_version: currentVersion,
        latest_version: currentVersion,
        has_update: false,
        release_notes: ''
      });
    });

    // Timeout after 5 seconds
    req.setTimeout(5000, () => {
      req.destroy();
      return res.json({
        success: true,
        current_version: currentVersion,
        latest_version: currentVersion,
        has_update: false,
        release_notes: ''
      });
    });

  } catch(err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/install-update (Bug #21 - verify git state before pulling)
router.post('/install-update', adminAuth, (req, res) => {
  const appDir = process.cwd();

  // Safety checks before pulling (Bug #21)
  try {
    // Verify it's a git repo
    execSync('git rev-parse --git-dir', { cwd: appDir });
    // Verify remote is https://github.com/jnunez2001/rj-pisowifi (trusted)
    const remoteUrl = execSync('git config --get remote.origin.url', { cwd: appDir }).toString().trim();
    if (!remoteUrl.includes('jnunez2001/rj-pisowifi')) {
      console.error('❌ Remote URL mismatch:', remoteUrl);
      return res.status(400).json({ success: false, message: 'Git remote misconfigured' });
    }
    // Bug found during pre-beta update-resilience drill: nothing checked
    // for uncommitted local changes before pulling. `git pull` on a dirty
    // working tree can fail outright ("local changes would be overwritten
    // by merge") or, worse, silently merge in a way that leaves the box
    // running a hybrid of two versions - neither the old nor the new code
    // cleanly. Refusing up front is the safe failure mode; this should
    // never happen in practice (an appliance-style deployment has no
    // reason to have local edits) but costs nothing to check.
    const dirty = execSync('git status --porcelain', { cwd: appDir }).toString().trim();
    if (dirty) {
      console.error('❌ Refusing update: uncommitted local changes present:', dirty);
      return res.status(400).json({ success: false, message: 'This box has uncommitted local file changes. Resolve them first (contact support if unsure) before updating.' });
    }
  } catch(e) {
    console.error('❌ Git verification failed:', e.message);
    return res.status(400).json({ success: false, message: 'Git repository invalid' });
  }

  // Bug found during the same drill: an update that includes a database
  // migration had no rollback point if that migration went wrong - the
  // Reliability Practices section of the roadmap plan explicitly calls
  // for "backup before risky changes, always" and this risky change
  // (arbitrary new code plus whatever schema migrations it runs on next
  // boot) had none. A plain file copy, not the JSON export the admin
  // Backup & Restore feature uses - faster, and correct even if the new
  // code's migration logic itself is what's broken (a JSON export/import
  // round-trip depends on the OLD code's route still existing to restore
  // through, a raw file copy doesn't).
  let preUpdateBackupPath = null;
  try {
    const dbPath = process.env.DB_PATH || path.join(appDir, 'server/database/rjpisowifi.db');
    if (fs.existsSync(dbPath)) {
      preUpdateBackupPath = `${dbPath}.pre-update-${Date.now()}.bak`;
      fs.copyFileSync(dbPath, preUpdateBackupPath);
      console.log(`💾 Pre-update database backup: ${preUpdateBackupPath}`);
    }
  } catch (e) {
    // Non-fatal - log it, but a failed backup attempt shouldn't block an
    // otherwise-valid update forever (matches this file's own pattern for
    // every other non-critical background step).
    console.error('⚠️ Pre-update DB backup failed (continuing anyway):', e.message);
  }

  // Record what to roll back to if the new code boots but turns out to be
  // broken - see updateRollbackService.js, checked on the next boot.
  try {
    const previousCommit = execSync('git rev-parse HEAD', { cwd: appDir }).toString().trim();
    require('../services/updateRollbackService').recordPendingUpdate(appDir, previousCommit, preUpdateBackupPath);
  } catch (e) {
    console.error('⚠️ Could not record rollback state (continuing anyway):', e.message);
  }

  res.json({ success: true, message: 'Update started! Server will restart shortly.' });
  setTimeout(() => {
    exec(`cd ${appDir} && git pull`, (err, stdout) => {
      if (err) { console.error('Git pull error:', err); return; }
      console.log('Git pull:', stdout);
      exec('sudo systemctl restart rj-pisowifi', (err) => {
        if (err) console.error('Restart error:', err);
        else console.log('✅ Updated and restarted!');
      });
    });
  }, 500);
});

// ===== 2FA MANAGEMENT (opt-in, off by default) =====
// Single pending-secret slot, not per-session - matches this app's current
// single-admin-account reality (no multi-staff accounts yet). A generated
// secret is NOT saved to the database until POST /2fa/confirm proves the
// admin actually scanned it and can produce a valid code - otherwise a
// half-finished setup (secret generated, browser closed before scanning)
// could lock the admin out with a 2FA flag pointing at a secret nobody
// ever actually saved into their authenticator app.
let pending2faSecret = null;

// POST /api/admin/2fa/setup - generates a new secret, does not enable
// anything yet.
router.post('/2fa/setup', adminAuth, (req, res) => {
  pending2faSecret = totpService.generateSecret();
  const otpauthUrl = totpService.buildOtpAuthUrl(pending2faSecret, 'admin', 'StarkFi');
  res.json({ success: true, secret: pending2faSecret, otpauth_url: otpauthUrl });
});

// POST /api/admin/2fa/confirm - proves the admin actually scanned the
// secret above and can produce a valid code before it's saved/enabled.
router.post('/2fa/confirm', adminAuth, (req, res) => {
  const { token } = req.body || {};
  if (!pending2faSecret) {
    return res.status(400).json({ success: false, message: 'No pending 2FA setup - call /2fa/setup first.' });
  }
  if (!totpService.verifyToken(pending2faSecret, token)) {
    return res.status(401).json({ success: false, message: 'That code doesn\'t match. Check your authenticator app and try again.' });
  }
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  upsert.run('admin_2fa_secret', encryptSecret(pending2faSecret));
  upsert.run('admin_2fa_enabled', '1');
  pending2faSecret = null;
  console.log('🔐 Admin 2FA enabled');
  res.json({ success: true, message: '2FA is now enabled.' });
});

// POST /api/admin/2fa/disable - requires the current password again as
// confirmation (a security-lowering action, same "ask again" principle as
// the withdrawal-confirmation design from the wallet security discussion),
// even though the caller is already authenticated via adminAuth.
router.post('/2fa/disable', adminAuth, (req, res) => {
  const { password } = req.body || {};
  const settings = db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get();
  if (!password || !settings || !verifyPassword(password, settings.value)) {
    return res.status(401).json({ success: false, message: 'Incorrect password.' });
  }
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  upsert.run('admin_2fa_enabled', '0');
  upsert.run('admin_2fa_secret', '');
  console.log('🔓 Admin 2FA disabled');
  res.json({ success: true, message: '2FA has been disabled.' });
});

// GET /api/admin/2fa/status
router.get('/2fa/status', adminAuth, (req, res) => {
  const enabled = db.prepare("SELECT value FROM settings WHERE key = 'admin_2fa_enabled'").get()?.value === '1';
  res.json({ success: true, enabled });
});

// GET /api/admin/version
router.get('/version', adminAuth, (req, res) => {
  const pkg = require('../../package.json');
  res.json({ success: true, version: pkg.version });
});

// GET /api/admin/system/datetime - current server clock/timezone/NTP
// state, plus the full valid timezone list for the Settings dropdown.
router.get('/system/datetime', adminAuth, async (req, res) => {
  try {
    const systemDateTimeService = require('../services/systemDateTimeService');
    const [status, timezones] = await Promise.all([
      systemDateTimeService.getStatus(),
      systemDateTimeService.listTimezones()
    ]);
    return res.json({ success: true, ...status, timezones });
  } catch (err) {
    console.error('System datetime status error:', err);
    res.status(500).json({ success: false, message: 'Could not read the server\'s clock settings.' });
  }
});

// POST /api/admin/system/datetime - { ntp_enabled, timezone }. A real
// system-level change, deliberately NTP-first (see
// systemDateTimeService.js's header comment for why there's no manual
// date-typing field here).
router.post('/system/datetime', adminAuth, async (req, res) => {
  try {
    const systemDateTimeService = require('../services/systemDateTimeService');
    if (typeof req.body.ntp_enabled === 'boolean') {
      await systemDateTimeService.setNtpEnabled(req.body.ntp_enabled);
    }
    if (req.body.timezone) {
      await systemDateTimeService.setTimezone(String(req.body.timezone));
    }
    console.log(`🕐 Admin updated server date/time settings: ntp_enabled=${req.body.ntp_enabled}, timezone=${req.body.timezone}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('System datetime update error:', err);
    res.status(500).json({ success: false, message: err.message || 'Could not update the server\'s clock settings.' });
  }
});

// POST /api/admin/system/reboot, the admin panel requires typing "REBOOT"
// before this fires, but the server checks the exact same word again
// server-side too, since a client-side-only check is trivially bypassable
// by anyone calling the API directly (this is a real power action, not a
// cosmetic one). Uses execFile (Bug #22 pattern), no shell interpolation.
router.post('/system/reboot', adminAuth, (req, res) => {
  if (req.body.confirm !== 'REBOOT') {
    return res.status(400).json({ success: false, message: 'Confirmation text did not match' });
  }
  console.log('🔄 Admin triggered server reboot');
  res.json({ success: true, message: 'Rebooting now. This may take a minute.' });
  setTimeout(() => {
    execFile('sudo', ['reboot'], (err) => {
      if (err) console.error('Reboot command failed:', err.message);
    });
  }, 500);
});

// POST /api/admin/system/shutdown, same server-side confirmation
// requirement as reboot above. Unlike reboot, this does NOT come back on
// its own, flagged clearly in the confirmation dialog on the frontend.
router.post('/system/shutdown', adminAuth, (req, res) => {
  if (req.body.confirm !== 'SHUTDOWN') {
    return res.status(400).json({ success: false, message: 'Confirmation text did not match' });
  }
  console.log('🛑 Admin triggered server shutdown');
  res.json({ success: true, message: 'Shutting down now.' });
  setTimeout(() => {
    execFile('sudo', ['shutdown', '-h', 'now'], (err) => {
      if (err) console.error('Shutdown command failed:', err.message);
    });
  }, 500);
});

const { applyNetworkConfig, refreshConsoleBanner } = require('../services/hostNetworkService');

// POST /api/admin/network (Bug #22 - use execFile for safer execution)
router.post('/network', adminAuth, (req, res) => {
  try {
    const { type, ip, gateway, dns, subnet } = req.body;

    // Validate input (Bug #22 - path traversal defense)
    if (!['dhcp', 'static'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid network type' });
    }
    if (type === 'static') {
      // Presence alone isn't enough - a placeholder like the admin panel's
      // own "N/A" display text is a truthy, non-empty string, and got
      // submitted as a literal gateway value once already, writing an
      // invalid netplan config to disk (netplan then refused to apply
      // *any* config, "invalid IP family '-1'"). Actual IPv4 shape check
      // closes that off regardless of what the frontend sends.
      const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
      const isValidIpv4 = (v) => typeof v === 'string' && IPV4_RE.test(v) &&
        v.split('.').every((octet) => Number(octet) <= 255);
      if (!isValidIpv4(ip) || !isValidIpv4(gateway)) {
        return res.status(400).json({ success: false, message: 'A valid IP address and gateway are required for static' });
      }
    }

    applyNetworkConfig({ type, ip, gateway, dns, subnet })
      .then(() => {
        // All commands succeeded, update settings
        const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        upsert.run('network_type', type);
        upsert.run('static_ip', ip || '');
        upsert.run('static_gateway', gateway || '');
        upsert.run('static_dns', dns || '8.8.8.8');
        upsert.run('static_subnet', subnet || '24');

        console.log(`🌐 Network changed to: ${type}`);
        refreshConsoleBanner();
        return res.json({ success: true, message: `Network set to ${type}` });
      })
      .catch((err) => {
        console.error('Network apply error:', err);
        res.status(500).json({ success: false, message: 'Failed to apply network settings' });
      });
  } catch(err) {
    console.error('Network error:', err);
    res.status(500).json({ success: false, message: 'Failed to apply network settings' });
  }
});

// GET /api/admin/network/wan-health, real, measured latency/packet-loss/
// link-state check against a public host, scored 0-100 with each
// deduction traceable to a stated reason (never fabricated). Standalone
// mode also reports the local WAN interface's link state; MikroTik mode's
// WAN health (would need RouterOS-side data) isn't built yet.
router.get('/network/wan-health', adminAuth, async (req, res) => {
  try {
    const { checkWanHealth } = require('../services/wanHealthService');
    const health = await checkWanHealth();
    return res.json({ success: true, health });
  } catch (err) {
    console.error('WAN health check error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/network/multi-wan, status only (primary/backup lanes,
// which is currently active, failure/success streak counters). Failover
// itself runs on multiWanService.js's own 2-minute cron, not triggered by
// this endpoint - there's no "apply" action here, just visibility. A
// second router_ports row with role='wan' (lowest id = primary) is what
// makes multi-WAN active at all; with 0 or 1 WAN lanes this just reports
// there's no backup configured.
router.get('/network/multi-wan', adminAuth, (req, res) => {
  try {
    const multiWanService = require('../services/multiWanService');
    return res.json({ success: true, status: multiWanService.getStatus() });
  } catch (err) {
    console.error('Multi-WAN status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== DATABASE ENCRYPTION AT REST (opt-in, Settings > Storage) =====

// GET /api/admin/storage/encryption-status
router.get('/storage/encryption-status', adminAuth, (req, res) => {
  try {
    const { hasEncryptionKey } = require('../utils/dbEncryption');
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../database/rjpisowifi.db');
    return res.json({ success: true, encrypted: hasEncryptionKey(dbPath) });
  } catch (err) {
    console.error('Encryption status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/storage/encrypt, one-way migration, requires explicit
// confirmation. Makes its own fresh pre-migration backup copy (separate
// from the nightly scheduled one) immediately before migrating, so the
// backup dbEncryption.js requires can never be stale relative to what's
// about to be migrated. The server process must be restarted after this
// completes - config/database.js decides which driver to load once, at
// require time, at boot.
router.post('/storage/encrypt', adminAuth, async (req, res) => {
  try {
    const { confirmed } = req.body || {};
    if (!confirmed) {
      return res.status(400).json({
        success: false,
        message: 'This is a one-way database migration. Re-submit with {"confirmed": true} to proceed. The server must be restarted afterward.',
      });
    }

    const { hasEncryptionKey, migrateToEncrypted } = require('../utils/dbEncryption');
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../database/rjpisowifi.db');
    if (hasEncryptionKey(dbPath)) {
      return res.status(409).json({ success: false, message: 'This database is already encrypted.' });
    }

    const backupDir = path.join(path.dirname(dbPath), 'auto-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `pre-encryption-${stamp}.db.bak`);
    fs.copyFileSync(dbPath, backupPath);

    const result = migrateToEncrypted(dbPath, backupPath);
    console.log(`🔒 Database encrypted at rest. Backup: ${backupPath}. Plaintext copy kept at: ${result.plaintextBackupKeptAt}`);
    return res.json({
      success: true,
      message: 'Database encrypted successfully. Restart the server now for it to take effect.',
      backupPath,
      plaintextBackupKeptAt: result.plaintextBackupKeptAt,
    });
  } catch (err) {
    console.error('Database encryption error:', err);
    res.status(500).json({ success: false, message: 'Encryption failed: ' + err.message });
  }
});

// ===== DATA RETENTION POLICY (Settings > Storage) =====

const retentionSchema = z.object({
  table: z.enum(['session_history', 'free_claims', 'watchdog_events', 'network_config_versions']),
  days: z.coerce.number().int().min(1).max(3650),
});

// GET /api/admin/storage/retention-policy
router.get('/storage/retention-policy', adminAuth, (req, res) => {
  try {
    const dataRetentionService = require('../services/dataRetentionService');
    return res.json({ success: true, policy: dataRetentionService.getPolicy() });
  } catch (err) {
    console.error('Retention policy read error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/storage/retention-policy
router.post('/storage/retention-policy', adminAuth, validateBody(retentionSchema), (req, res) => {
  try {
    const dataRetentionService = require('../services/dataRetentionService');
    dataRetentionService.setRetentionDays(req.body.table, req.body.days);
    return res.json({ success: true, message: 'Retention policy updated' });
  } catch (err) {
    console.error('Retention policy update error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/storage/retention-cleanup-now, manual trigger, doesn't
// wait for the daily 03:00 cron.
router.post('/storage/retention-cleanup-now', adminAuth, (req, res) => {
  try {
    const dataRetentionService = require('../services/dataRetentionService');
    const results = dataRetentionService.runCleanup();
    return res.json({ success: true, results });
  } catch (err) {
    console.error('Retention cleanup error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/telemetry/status, no UI toggle exists yet (backend
// mechanism only, see telemetryService.js header); this just surfaces
// whether it's enabled and how many rows are queued, for diagnostics.
router.get('/telemetry/status', adminAuth, (req, res) => {
  try {
    const telemetryService = require('../services/telemetryService');
    return res.json({ success: true, status: telemetryService.getOutboxStatus() });
  } catch (err) {
    console.error('Telemetry status read error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/telemetry/toggle, { enabled: boolean }. Kept API-only
// (no admin UI wired to it yet) until a real Privacy Policy exists to
// disclose what's collected, per telemetryService.js's header.
router.post('/telemetry/toggle', adminAuth, (req, res) => {
  try {
    const enabled = req.body && req.body.enabled ? '1' : '0';
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('telemetry_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(enabled);
    return res.json({ success: true, telemetry_enabled: enabled === '1' });
  } catch (err) {
    console.error('Telemetry toggle error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/network
router.get('/network', adminAuth, (req, res) => {
  try {
    const getSetting = (key, def) => {
      const s = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return s ? s.value : def;
    };
    return res.json({
      success: true,
      type: getSetting('network_type', 'dhcp'),
      ip: getSetting('static_ip', ''),
      gateway: getSetting('static_gateway', ''),
      dns: getSetting('static_dns', '8.8.8.8'),
      subnet: getSetting('static_subnet', '24')
    });
  } catch(err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== ADMIN PORTAL ADDRESS (renamable .local mDNS hostname) =====
// Was previously fixed to whatever install.sh baked in at setup time
// ("rjcyberzone.local"), with no way to change it afterward short of SSHing
// in. Reads the live system hostname directly (os.hostname()) rather than
// a settings-table value, so this can never drift from what avahi is
// actually advertising.
const HOSTNAME_REGEX = /^[a-zA-Z0-9-]{1,63}$/;

router.get('/hostname', adminAuth, (req, res) => {
  try {
    res.json({ success: true, hostname: os.hostname() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not read hostname' });
  }
});

router.post('/hostname', adminAuth, (req, res) => {
  const { hostname } = req.body;
  if (!hostname || !HOSTNAME_REGEX.test(hostname)) {
    return res.status(400).json({
      success: false,
      message: 'Hostname can only contain letters, numbers, and hyphens (max 63 characters)'
    });
  }

  execFile('sudo', ['hostnamectl', 'set-hostname', hostname], { timeout: 5000 }, (err) => {
    if (err) {
      console.error('Hostname change error:', err);
      return res.status(500).json({ success: false, message: 'Failed to change hostname' });
    }

    execFile('sudo', ['systemctl', 'restart', 'avahi-daemon'], { timeout: 5000 }, (err2) => {
      if (err2) {
        console.error('Avahi restart error:', err2);
        return res.status(500).json({ success: false, message: 'Hostname changed but failed to restart mDNS service' });
      }

      console.log(`🌐 Admin hostname changed to: ${hostname}.local`);
      res.json({ success: true, hostname, message: `Admin panel now reachable at ${hostname}.local` });
    });
  });
});

// ===== DNS FILTERING (blocking service status/stats) =====
// GET /api/admin/dns-filter/status
router.get('/dns-filter/status', adminAuth, async (req, res) => {
  try {
    const status = await require('../services/dnsFilterService').getStatus();
    return res.json({ success: true, ...status });
  } catch (err) {
    return res.json({ success: true, available: false });
  }
});

// POST /api/admin/dns-filter/update-lists, refreshes the block list inside
// the isolated container. Best-effort: if the container isn't running this
// just fails quietly, same fail-open reasoning as everywhere else this
// add-on touches.
router.post('/dns-filter/update-lists', adminAuth, (req, res) => {
  execFile('docker', ['exec', 'rj-pihole', 'pihole', '-g'], { timeout: 60000 }, (err) => {
    if (err) {
      console.error('DNS filter list update failed:', err.message);
      return res.status(500).json({ success: false, message: 'Could not update block lists right now' });
    }
    return res.json({ success: true, message: 'Block lists updated' });
  });
});

// ===== VLAN MANAGEMENT =====
// Lets an owner reproduce the "everything on one unmanaged switch, VLAN
// tags separate the traffic" wiring pattern common in other piso-wifi
// setups: an ISP that requires a VLAN-tagged uplink (mode 'wan'), and/or
// an access point tagging customer WiFi traffic to keep it off the ISP's
// wire (mode 'lan'). Applying a change re-runs setup-network.sh so the
// owner never has to SSH in and run it by hand.

// Returns a Promise (resolves after the script finishes either way, never
// rejects - callers that need to know about failure already get that via
// the optional callback param, same as before). Callers that need
// something ELSE to only run once the network has actually finished
// settling (e.g. the DNS Filtering apply below, which reads this box's
// live interface state) must await this - previously this was always
// fire-and-forget, so a fast-following read of os.networkInterfaces()
// could land mid-renegotiation while this script's own interface-identity
// detection logic was still bouncing the link, intermittently seeing no
// IPv4 address on the right interface at all.
// Bug found live: two settings saves fired seconds apart (e.g. a fast
// double-click on the DNS Filtering toggle) each spawned their own
// overlapping `sudo bash setup-network.sh` run. Both processes' own
// interface-identity detection independently pkill+restart dhclient on
// the SAME interface, fighting each other - confirmed live via
// journalctl, one run took 16+ seconds to finish (usually well under a
// second) with repeated DHCPDISCOVER/DHCPACK churn the whole time, long
// enough to blow past both the retry window below AND get close to this
// function's own 20s timeout. A second call while one is already running
// now shares that same in-flight run instead of starting a competing one.
let inFlightNetworkSetup = null;

function applyNetworkSetup(callback) {
  if (inFlightNetworkSetup) {
    if (callback) inFlightNetworkSetup.then(callback);
    return inFlightNetworkSetup;
  }
  const scriptPath = path.join(__dirname, '../../setup/setup-network.sh');
  inFlightNetworkSetup = new Promise((resolve) => {
    // Bug: only err.message was ever logged on failure - that's just
    // "Command failed: sudo bash .../setup-network.sh", the exit code and
    // reason (a real script error, a timeout, sudo denying it) with no way
    // to tell which from the log alone. execFile's callback gets stdout/
    // stderr too - log them so a real failure is actually diagnosable
    // instead of a dead end every time.
    execFile('sudo', ['bash', scriptPath], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('setup-network.sh re-apply failed:', err.message);
        if (stderr) console.error('setup-network.sh stderr:', stderr);
        if (stdout) console.error('setup-network.sh stdout:', stdout);
      }
      inFlightNetworkSetup = null;
      if (callback) callback(err);
      resolve(err);
    });
  });
  return inFlightNetworkSetup;
}

// GET /api/admin/network/interfaces, physical interfaces available as a
// VLAN base (wired/wireless naming only, skips loopback/virtual ones this
// script itself creates like nft/tc-managed devices or prior VLAN subs).
router.get('/network/interfaces', adminAuth, (req, res) => {
  try {
    if (!fs.existsSync('/sys/class/net')) {
      // Not on Linux (e.g. local dev on Windows) - nothing to list.
      return res.json({ success: true, interfaces: [] });
    }
    const names = fs.readdirSync('/sys/class/net').filter(n =>
      /^(eth|enp|ens|enx|wlan|wlx|wlp)/.test(n) && !n.includes('.')
    );
    const interfaces = names.map(name => {
      let operstate = 'unknown';
      try {
        operstate = fs.readFileSync(`/sys/class/net/${name}/operstate`, 'utf8').trim();
      } catch (e) {}
      let mac = '';
      try {
        mac = fs.readFileSync(`/sys/class/net/${name}/address`, 'utf8').trim();
      } catch (e) {}
      return { name, status: operstate, mac };
    });
    return res.json({ success: true, interfaces });
  } catch (err) {
    console.error('Interfaces list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/network/vlans
router.get('/network/vlans', adminAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM vlans ORDER BY id DESC').all();
    const vlans = rows.map(v => {
      const ifName = `${v.base_interface}.${v.vlan_id}`;
      let status = 'down';
      try {
        status = fs.readFileSync(`/sys/class/net/${ifName}/operstate`, 'utf8').trim();
      } catch (e) {}
      return { ...v, interface_name: ifName, status };
    });
    return res.json({ success: true, vlans });
  } catch (err) {
    console.error('VLAN list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/network/vlans
router.post('/network/vlans', adminAuth, (req, res) => {
  try {
    const { base_interface, vlan_id, mode, protocol, static_ip, static_gateway, static_netmask } = req.body;

    if (!base_interface || !/^[a-zA-Z0-9]+$/.test(base_interface)) {
      return res.status(400).json({ success: false, message: 'Invalid base interface' });
    }
    const vlanIdNum = parseInt(vlan_id, 10);
    if (!Number.isInteger(vlanIdNum) || vlanIdNum < 1 || vlanIdNum > 4094) {
      return res.status(400).json({ success: false, message: 'VLAN ID must be between 1 and 4094' });
    }
    if (!['lan', 'wan'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'Mode must be lan or wan' });
    }
    const proto = protocol === 'static' ? 'static' : 'dhcp';
    if (proto === 'static' && (!static_ip || !static_gateway || !static_netmask)) {
      return res.status(400).json({ success: false, message: 'Static IP, gateway, and netmask are required for static protocol' });
    }

    const existing = db.prepare(
      'SELECT id FROM vlans WHERE base_interface = ? AND vlan_id = ?'
    ).get(base_interface, vlanIdNum);
    if (existing) {
      return res.status(409).json({ success: false, message: 'This VLAN ID already exists on that interface' });
    }

    const result = db.prepare(`
      INSERT INTO vlans (base_interface, vlan_id, mode, protocol, static_ip, static_gateway, static_netmask)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(base_interface, vlanIdNum, mode, proto, static_ip || null, static_gateway || null, static_netmask || null);

    console.log(`🔀 VLAN created: ${base_interface}.${vlanIdNum} (${mode}/${proto})`);
    applyNetworkSetup();

    return res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('VLAN create error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/network/vlans/:id
router.delete('/network/vlans/:id', adminAuth, (req, res) => {
  try {
    const vlan = db.prepare('SELECT * FROM vlans WHERE id = ?').get(req.params.id);
    if (!vlan) {
      return res.status(404).json({ success: false, message: 'VLAN not found' });
    }

    const ifName = `${vlan.base_interface}.${vlan.vlan_id}`;
    // Bug: setup-network.sh only ever creates VLAN sub-interfaces, it never
    // tears down ones that get removed from the DB - without this, a
    // deleted VLAN's interface (and whatever IP/routes/dnsmasq were bound
    // to it) would keep running until the next reboot.
    execFile('sudo', ['ip', 'link', 'delete', ifName], () => {
      db.prepare('DELETE FROM vlans WHERE id = ?').run(req.params.id);
      console.log(`🔀 VLAN deleted: ${ifName}`);
      applyNetworkSetup();
      return res.json({ success: true, message: 'VLAN deleted' });
    });
  } catch (err) {
    console.error('VLAN delete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/network/mikrotik/capabilities, real, read-only discovery
// of what THIS specific router actually supports (packages, queue types
// incl. CAKE, and menu-path probes for WireGuard/IPsec/BGP/OSPF/RADIUS/
// Hotspot/L2TP/OVPN) rather than assuming from RouterOS version or board
// name. See mikrotikCapabilityModel.js.
router.get('/network/mikrotik/capabilities', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const { detectMikrotikCapabilities } = require('../services/mikrotikCapabilityModel');
    const capabilities = await detectMikrotikCapabilities();
    return res.json({ success: true, ...capabilities });
  } catch (err) {
    console.error('MikroTik capability detection error:', err);
    res.status(500).json({ success: false, message: 'Failed to reach router: ' + err.message });
  }
});

// ===== MIKROTIK VLAN MANAGER (network power parity with Standalone) =====
// Same conceptual shape as the Standalone /network/vlans endpoints just
// above, but executes over the RouterOS API instead of local `ip link`,
// via mikrotikService.js's listVlans/createVlan/deleteVlan. Router Mode
// previously had no VLAN configuration surface at all - an operator had
// to set VLANs up by hand in WinBox before StarkFi could do anything with
// them.

const mikrotikVlanSchema = z.object({
  parentInterface: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid interface name'),
  vlanId: z.coerce.number().int().min(1).max(4094),
  name: z.string().trim().max(64).optional(),
  ipAddress: z.string().trim().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/, 'Must be CIDR form, e.g. 192.168.13.1/24').optional().or(z.literal('')),
});

// GET /api/admin/network/mikrotik/vlans
router.get('/network/mikrotik/vlans', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const vlans = await mikrotikService.listVlans();
    return res.json({ success: true, vlans });
  } catch (err) {
    console.error('MikroTik VLAN list error:', err);
    res.status(500).json({ success: false, message: 'Failed to reach router: ' + err.message });
  }
});

// POST /api/admin/network/mikrotik/vlans
router.post('/network/mikrotik/vlans', adminAuth, validateBody(mikrotikVlanSchema), async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const { parentInterface, vlanId, name, ipAddress } = req.body;
    const created = await mikrotikService.createVlan({ parentInterface, vlanId, name, ipAddress: ipAddress || null });
    console.log(`🔀 MikroTik VLAN created: ${created.name} (VLAN ${created.vlan_id} on ${created.parent_interface})`);
    return res.json({ success: true, vlan: created });
  } catch (err) {
    if (err instanceof (require('../services/mikrotikService').MikrotikVlanConflictError)) {
      return res.status(409).json({ success: false, message: err.message });
    }
    console.error('MikroTik VLAN create error:', err);
    res.status(500).json({ success: false, message: 'Failed to create VLAN: ' + err.message });
  }
});

// DELETE /api/admin/network/mikrotik/vlans/:id, :id is RouterOS's own
// ".id" (e.g. "*3"), not a local database row id, since this table isn't
// mirrored locally at all - MikroTik itself is the only source of truth
// for its own VLAN interfaces.
router.delete('/network/mikrotik/vlans/:id', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const result = await mikrotikService.deleteVlan(req.params.id);
    if (!result.removed) {
      return res.status(404).json({ success: false, message: 'VLAN not found on router' });
    }
    console.log(`🔀 MikroTik VLAN deleted: ${req.params.id}`);
    return res.json({ success: true, message: 'VLAN deleted' });
  } catch (err) {
    console.error('MikroTik VLAN delete error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete VLAN: ' + err.message });
  }
});

// ===== MIKROTIK DHCP MANAGER (network power parity with Standalone) =====
// A VLAN from the manager above is just an addressed interface until it
// can hand out addresses - this is the other half. mikrotikService.js's
// listDhcpServers/createDhcpServer/deleteDhcpServer create/remove the
// linked pool + DHCP server + network objects together.

const CIDR_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const mikrotikDhcpSchema = z.object({
  interfaceName: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'Invalid interface name'),
  poolRange: z.string().trim().regex(new RegExp(`^${IPV4_REGEX.source.slice(1, -1)}-${IPV4_REGEX.source.slice(1, -1)}$`), 'Must be IP-IP form, e.g. 192.168.13.10-192.168.13.250'),
  network: z.string().trim().regex(CIDR_REGEX, 'Must be CIDR form, e.g. 192.168.13.0/24'),
  gateway: z.string().trim().regex(IPV4_REGEX, 'Invalid gateway IP'),
  dnsServers: z.string().trim().regex(IPV4_REGEX).optional().or(z.literal('')),
  name: z.string().trim().max(64).optional(),
});

// GET /api/admin/network/mikrotik/dhcp
router.get('/network/mikrotik/dhcp', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const servers = await mikrotikService.listDhcpServers();
    return res.json({ success: true, servers });
  } catch (err) {
    console.error('MikroTik DHCP list error:', err);
    res.status(500).json({ success: false, message: 'Failed to reach router: ' + err.message });
  }
});

// POST /api/admin/network/mikrotik/dhcp
router.post('/network/mikrotik/dhcp', adminAuth, validateBody(mikrotikDhcpSchema), async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const { interfaceName, poolRange, network, gateway, dnsServers, name } = req.body;
    const created = await mikrotikService.createDhcpServer({ interfaceName, poolRange, network, gateway, dnsServers: dnsServers || null, name });
    console.log(`📡 MikroTik DHCP server created: ${created.name} on ${created.interface}`);
    return res.json({ success: true, server: created });
  } catch (err) {
    if (err instanceof (require('../services/mikrotikService').MikrotikDhcpConflictError)) {
      return res.status(409).json({ success: false, message: err.message });
    }
    console.error('MikroTik DHCP create error:', err);
    res.status(500).json({ success: false, message: 'Failed to create DHCP server: ' + err.message });
  }
});

// DELETE /api/admin/network/mikrotik/dhcp/:id, RouterOS ".id", same
// reasoning as the VLAN delete route above (no local mirror table).
router.delete('/network/mikrotik/dhcp/:id', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const result = await mikrotikService.deleteDhcpServer(req.params.id);
    if (!result.removed) {
      return res.status(404).json({ success: false, message: 'DHCP server not found on router' });
    }
    console.log(`📡 MikroTik DHCP server deleted: ${req.params.id}`);
    return res.json({ success: true, message: 'DHCP server deleted' });
  } catch (err) {
    console.error('MikroTik DHCP delete error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete DHCP server: ' + err.message });
  }
});

// ===== MIKROTIK PORT/INTERFACE ROLE ASSIGNMENT (network power parity) =====
// Uses RouterOS interface-lists via mikrotikService.js's
// listInterfaceRoles/setInterfaceRole - the building block the firewall
// zone builder and NAT manager below reference.

const mikrotikRoleSchema = z.object({
  interfaceName: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid interface name'),
  role: z.enum(['wan', 'lan', 'guest', 'unused']),
  confirmed: z.boolean().optional(),
  reason: z.string().trim().max(200).optional(),
});

// GET /api/admin/network/mikrotik/roles
router.get('/network/mikrotik/roles', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const roles = await mikrotikService.listInterfaceRoles();
    return res.json({ success: true, roles });
  } catch (err) {
    console.error('MikroTik role list error:', err);
    res.status(500).json({ success: false, message: 'Failed to reach router: ' + err.message });
  }
});

// POST /api/admin/network/mikrotik/roles, goes through configSafety.js's
// applyMikrotikRoleChangeTransaction (risk check -> require confirmation on
// a management-path-risky change -> apply -> verify connectivity ->
// automatic rollback to the interface's previous role on failure). This is
// the one MikroTik write that can strand the router's own uplink, the same
// class of risk Standalone's provision/apply route already guards against.
router.post('/network/mikrotik/roles', adminAuth, validateBody(mikrotikRoleSchema), async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const { interfaceName, role } = req.body;
    const { confirmed, reason } = req.body || {};
    const { applyMikrotikRoleChangeTransaction } = require('../services/configSafety');
    const result = await applyMikrotikRoleChangeTransaction({
      interfaceName, role, operator: 'admin', reason: reason || '', riskConfirmed: !!confirmed,
    });

    if (result.requiresConfirmation) {
      return res.status(409).json({
        success: false,
        requiresConfirmation: true,
        reasons: result.reasons,
        message: 'This change affects the router\'s own internet uplink. Review and confirm to proceed.',
      });
    }
    if (!result.success) {
      console.error('MikroTik role assign error:', result.message);
      return res.status(500).json({ success: false, message: result.message, rolledBack: result.rolledBack });
    }
    console.log(`🔌 MikroTik interface role set: ${result.result.interface} → ${result.result.role} (verified reachable)`);
    return res.json({ success: true, result: result.result });
  } catch (err) {
    console.error('MikroTik role assign error:', err);
    res.status(500).json({ success: false, message: 'Failed to set role: ' + err.message });
  }
});

// ===== MIKROTIK FIREWALL ZONE BUILDER (network power parity - MikroTik
// half of the isolation gap found while building Standalone's fix) =====
// Simple ALLOW/DENY between zones (interface-list roles from above), not
// raw firewall rule syntax - matches the dev-handoff spec's own "Guest ->
// LAN: DENY" example. Every rule is tagged and only ever deleted by this
// feature if it created it (mikrotikService.js's own safety check).

const mikrotikZonePolicySchema = z.object({
  fromZone: z.enum(['wan', 'lan', 'guest']),
  toZone: z.enum(['wan', 'lan', 'guest']),
  action: z.enum(['accept', 'drop', 'reject']),
});

// GET /api/admin/network/mikrotik/firewall-zones
router.get('/network/mikrotik/firewall-zones', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const policies = await mikrotikService.listFirewallZonePolicies();
    return res.json({ success: true, policies });
  } catch (err) {
    console.error('MikroTik zone policy list error:', err);
    res.status(500).json({ success: false, message: 'Failed to reach router: ' + err.message });
  }
});

// POST /api/admin/network/mikrotik/firewall-zones
router.post('/network/mikrotik/firewall-zones', adminAuth, validateBody(mikrotikZonePolicySchema), async (req, res) => {
  try {
    const { canUse } = require('../services/entitlementService');
    if (!canUse('firewall_zones')) {
      return res.status(403).json({ success: false, message: 'Custom firewall zone policies are a Pro feature. StarkFi is currently using the recommended secure firewall configuration.' });
    }
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const { fromZone, toZone, action } = req.body;
    const created = await mikrotikService.createFirewallZonePolicy({ fromZone, toZone, action });
    console.log(`🛡️ MikroTik zone policy created: ${created.from_zone} → ${created.to_zone} = ${created.action}`);
    return res.json({ success: true, policy: created });
  } catch (err) {
    if (err instanceof (require('../services/mikrotikService').MikrotikZonePolicyConflictError)) {
      return res.status(409).json({ success: false, message: err.message });
    }
    console.error('MikroTik zone policy create error:', err);
    res.status(500).json({ success: false, message: 'Failed to create policy: ' + err.message });
  }
});

// DELETE /api/admin/network/mikrotik/firewall-zones/:id
router.delete('/network/mikrotik/firewall-zones/:id', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const result = await mikrotikService.deleteFirewallZonePolicy(req.params.id);
    if (!result.removed) {
      return res.status(404).json({ success: false, message: result.reason === 'not_a_zone_policy' ? 'That rule was not created by this feature' : 'Policy not found on router' });
    }
    console.log(`🛡️ MikroTik zone policy deleted: ${req.params.id}`);
    return res.json({ success: true, message: 'Policy deleted' });
  } catch (err) {
    console.error('MikroTik zone policy delete error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete policy: ' + err.message });
  }
});

// ===== MIKROTIK NAT/PORT-FORWARD MANAGER (network power parity) =====
// Mirrors Standalone mode's Port Forwarding UI. RouterOS dstnat rules
// scoped to the WAN interface list, tagged and only-delete-your-own,
// same discipline as the firewall zone manager above.

const mikrotikPortForwardSchema = z.object({
  protocol: z.enum(['tcp', 'udp']),
  externalPort: z.coerce.number().int().min(1).max(65535),
  internalIp: z.string().trim().regex(IPV4_REGEX, 'Invalid internal IP'),
  internalPort: z.coerce.number().int().min(1).max(65535),
});

// GET /api/admin/network/mikrotik/port-forwards
router.get('/network/mikrotik/port-forwards', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const forwards = await mikrotikService.listPortForwards();
    return res.json({ success: true, forwards });
  } catch (err) {
    console.error('MikroTik port forward list error:', err);
    res.status(500).json({ success: false, message: 'Failed to reach router: ' + err.message });
  }
});

// POST /api/admin/network/mikrotik/port-forwards
router.post('/network/mikrotik/port-forwards', adminAuth, validateBody(mikrotikPortForwardSchema), async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const { protocol, externalPort, internalIp, internalPort } = req.body;
    const created = await mikrotikService.createPortForward({ protocol, externalPort, internalIp, internalPort });
    console.log(`🔀 MikroTik port forward created: ${created.protocol}/${created.external_port} → ${created.internal_ip}:${created.internal_port}`);
    return res.json({ success: true, forward: created });
  } catch (err) {
    if (err instanceof (require('../services/mikrotikService').MikrotikPortForwardConflictError)) {
      return res.status(409).json({ success: false, message: err.message });
    }
    console.error('MikroTik port forward create error:', err);
    res.status(500).json({ success: false, message: 'Failed to create forward: ' + err.message });
  }
});

// DELETE /api/admin/network/mikrotik/port-forwards/:id
router.delete('/network/mikrotik/port-forwards/:id', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    if (!mikrotikService.isMikrotikModeEnabled()) {
      return res.status(400).json({ success: false, message: 'MikroTik mode is not enabled' });
    }
    const result = await mikrotikService.deletePortForward(req.params.id);
    if (!result.removed) {
      return res.status(404).json({ success: false, message: result.reason === 'not_a_port_forward' ? 'That rule was not created by this feature' : 'Forward not found on router' });
    }
    console.log(`🔀 MikroTik port forward deleted: ${req.params.id}`);
    return res.json({ success: true, message: 'Port forward deleted' });
  } catch (err) {
    console.error('MikroTik port forward delete error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete forward: ' + err.message });
  }
});

// ===== DNS MANAGER (network power parity - both modes) =====
// Previously hardcoded to 8.8.8.8/8.8.4.4 in setup-network.sh with no
// operator control at all. dns_upstream_1/2 settings are the source of
// truth for Standalone mode (read by setup-network.sh); when MikroTik
// mode is active, the same values are also pushed live to the router's
// own /ip/dns, so one setting covers whichever mode is actually running.

const dnsSchema = z.object({
  dns1: z.string().trim().regex(IPV4_REGEX, 'Invalid primary DNS IP'),
  dns2: z.string().trim().regex(IPV4_REGEX, 'Invalid secondary DNS IP').optional().or(z.literal('')),
});

// GET /api/admin/network/dns
router.get('/network/dns', adminAuth, async (req, res) => {
  try {
    const dns1 = db.prepare("SELECT value FROM settings WHERE key = 'dns_upstream_1'").get()?.value || '8.8.8.8';
    const dns2 = db.prepare("SELECT value FROM settings WHERE key = 'dns_upstream_2'").get()?.value || '8.8.4.4';
    const mikrotikService = require('../services/mikrotikService');
    let live = null;
    if (mikrotikService.isMikrotikModeEnabled()) {
      try {
        live = await mikrotikService.getDnsServers();
      } catch (e) {
        console.error('MikroTik DNS read failed (showing saved settings instead):', e.message);
      }
    }
    return res.json({ success: true, dns1, dns2, live });
  } catch (err) {
    console.error('DNS settings read error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/network/dns
router.post('/network/dns', adminAuth, validateBody(dnsSchema), async (req, res) => {
  const { dns1, dns2 } = req.body;
  try {
    db.prepare("INSERT INTO settings (key, value) VALUES ('dns_upstream_1', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(dns1);
    db.prepare("INSERT INTO settings (key, value) VALUES ('dns_upstream_2', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(dns2 || '');
  } catch (err) {
    console.error('DNS settings save error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save DNS settings: ' + err.message });
  }

  // The DB save above is the source of truth and already succeeded by this
  // point - real bug found live: this used to let a MikroTik push failure
  // (e.g. router unreachable) fail the WHOLE request, telling the admin
  // "Failed to save" even though their setting was in fact saved and will
  // still apply (Standalone reads dns_upstream_1/2 directly; MikroTik will
  // pick it up on its next successful push). Now the DB save's own success
  // is what the response reports, with the live-push failure surfaced as a
  // warning rather than a false failure.
  const mikrotikService = require('../services/mikrotikService');
  if (mikrotikService.isMikrotikModeEnabled()) {
    const servers = [dns1, dns2].filter(Boolean);
    try {
      await mikrotikService.setDnsServers(servers);
      console.log(`🌐 DNS servers updated (MikroTik live + saved): ${servers.join(', ')}`);
      return res.json({ success: true, message: 'DNS settings saved' });
    } catch (err) {
      console.error('DNS settings saved, but MikroTik live push failed:', err.message);
      return res.json({ success: true, message: 'Saved, but could not push to the router right now: ' + err.message, routerPushFailed: true });
    }
  }
  console.log(`🌐 DNS servers saved (applies on next Standalone network apply): ${[dns1, dns2].filter(Boolean).join(', ')}`);
  return res.json({ success: true, message: 'DNS settings saved' });
});

// ===== NAMED BANDWIDTH PROFILES (network power) =====
// Previously an admin had to type raw Mbps numbers into every voucher's
// optional override fields by hand each time - no saved "Premium: 30/15"
// preset to pick from. A voucher can optionally reference a profile
// (bandwidth_profile_id) instead of/alongside its own direct
// download_mbps/upload_mbps fields; promo.js's redeem route resolves the
// profile's numbers when the voucher itself doesn't have direct values.

const bandwidthProfileSchema = z.object({
  name: z.string().trim().min(1).max(64),
  downloadMbps: z.coerce.number().int().min(1).max(10000),
  uploadMbps: z.coerce.number().int().min(1).max(10000),
  burstMbps: z.coerce.number().int().min(0).max(10000).optional(),
});

// GET /api/admin/bandwidth-profiles
router.get('/bandwidth-profiles', adminAuth, (req, res) => {
  try {
    const profiles = db.prepare('SELECT * FROM bandwidth_profiles ORDER BY name').all();
    return res.json({ success: true, profiles });
  } catch (err) {
    console.error('Bandwidth profile list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/bandwidth-profiles
router.post('/bandwidth-profiles', adminAuth, validateBody(bandwidthProfileSchema), (req, res) => {
  try {
    const { canUse } = require('../services/entitlementService');
    if (!canUse('bandwidth_profiles')) {
      return res.status(403).json({ success: false, message: 'Named bandwidth profiles are a Pro feature. Upgrade to create custom traffic policies.' });
    }
    const { name, downloadMbps, uploadMbps, burstMbps } = req.body;
    const result = db.prepare(
      'INSERT INTO bandwidth_profiles (name, download_mbps, upload_mbps, burst_mbps) VALUES (?, ?, ?, ?)'
    ).run(name, downloadMbps, uploadMbps, burstMbps || 0);
    console.log(`📶 Bandwidth profile created: ${name} (${downloadMbps}/${uploadMbps}Mbps)`);
    return res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Bandwidth profile create error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/bandwidth-profiles/:id, vouchers referencing this
// profile keep working: the FK has no ON DELETE CASCADE/RESTRICT, so a
// deleted profile just leaves bandwidth_profile_id pointing at nothing;
// promo.js's resolution falls back to the voucher's own direct fields (or
// the global cap) in that case, same fail-open pattern used elsewhere.
router.delete('/bandwidth-profiles/:id', adminAuth, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM bandwidth_profiles WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: 'Profile not found' });
    }
    return res.json({ success: true, message: 'Profile deleted' });
  } catch (err) {
    console.error('Bandwidth profile delete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== TIER 1 STANDALONE FEATURES: static DHCP leases, client naming,
// port forwarding, diagnostics (STANDALONE_ARCHITECTURE_PLAN.md) =====

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
function isValidPort(n) {
  const p = parseInt(n, 10);
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

// ── Static DHCP leases ──────────────────────────────────────────
router.get('/network/leases', adminAuth, (req, res) => {
  try {
    const leases = db.prepare('SELECT * FROM static_leases ORDER BY id DESC').all();
    res.json({ success: true, leases });
  } catch (err) {
    console.error('Leases list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/network/leases', adminAuth, (req, res) => {
  try {
    const { mac_address, ip_address, label } = req.body;
    const mac = String(mac_address || '').trim().toLowerCase();
    const ip = String(ip_address || '').trim();
    if (!MAC_REGEX.test(mac)) {
      return res.status(400).json({ success: false, message: 'Invalid MAC address' });
    }
    if (!IP_REGEX.test(ip)) {
      return res.status(400).json({ success: false, message: 'Invalid IP address' });
    }
    const existing = db.prepare('SELECT id FROM static_leases WHERE mac_address = ?').get(mac);
    if (existing) {
      return res.status(409).json({ success: false, message: 'This device already has a reserved IP' });
    }
    const result = db.prepare(
      'INSERT INTO static_leases (mac_address, ip_address, label) VALUES (?, ?, ?)'
    ).run(mac, ip, String(label || '').trim());
    console.log(`📌 Static lease created: ${mac} → ${ip}`);
    applyNetworkSetup();
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Lease create error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/network/leases/:id', adminAuth, (req, res) => {
  try {
    const lease = db.prepare('SELECT * FROM static_leases WHERE id = ?').get(req.params.id);
    if (!lease) {
      return res.status(404).json({ success: false, message: 'Lease not found' });
    }
    db.prepare('DELETE FROM static_leases WHERE id = ?').run(req.params.id);
    console.log(`📌 Static lease deleted: ${lease.mac_address}`);
    applyNetworkSetup();
    res.json({ success: true, message: 'Lease deleted' });
  } catch (err) {
    console.error('Lease delete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Client naming ───────────────────────────────────────────────
router.get('/network/client-labels', adminAuth, (req, res) => {
  try {
    const labels = db.prepare('SELECT * FROM client_labels ORDER BY updated_at DESC').all();
    res.json({ success: true, labels });
  } catch (err) {
    console.error('Client labels list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/network/client-labels', adminAuth, (req, res) => {
  try {
    const { mac_address, label } = req.body;
    const mac = String(mac_address || '').trim().toLowerCase();
    const lbl = String(label || '').trim();
    if (!MAC_REGEX.test(mac)) {
      return res.status(400).json({ success: false, message: 'Invalid MAC address' });
    }
    if (!lbl) {
      db.prepare('DELETE FROM client_labels WHERE mac_address = ?').run(mac);
      require('../services/networkDevicesService').logDeviceEvent(mac, 'renamed', 'Custom name cleared');
      return res.json({ success: true, message: 'Label cleared' });
    }
    db.prepare(`
      INSERT INTO client_labels (mac_address, label, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mac_address) DO UPDATE SET label = excluded.label, updated_at = CURRENT_TIMESTAMP
    `).run(mac, lbl);
    require('../services/networkDevicesService').logDeviceEvent(mac, 'renamed', `Renamed to "${lbl}"`);
    res.json({ success: true, message: 'Label saved' });
  } catch (err) {
    console.error('Client label save error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Port forwarding (standalone mode only, MikroTik owns NAT in router mode) ──
router.get('/network/port-forwards', adminAuth, (req, res) => {
  try {
    const forwards = db.prepare('SELECT * FROM port_forwards ORDER BY id DESC').all();
    res.json({ success: true, forwards });
  } catch (err) {
    console.error('Port forwards list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/network/port-forwards', adminAuth, (req, res) => {
  try {
    const { label, protocol, external_port, internal_ip, internal_port } = req.body;
    const proto = protocol === 'udp' ? 'udp' : 'tcp';
    if (!isValidPort(external_port) || !isValidPort(internal_port)) {
      return res.status(400).json({ success: false, message: 'Ports must be between 1 and 65535' });
    }
    const ip = String(internal_ip || '').trim();
    if (!IP_REGEX.test(ip)) {
      return res.status(400).json({ success: false, message: 'Invalid internal IP address' });
    }
    const result = db.prepare(`
      INSERT INTO port_forwards (label, protocol, external_port, internal_ip, internal_port, enabled)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(String(label || '').trim(), proto, parseInt(external_port, 10), ip, parseInt(internal_port, 10));
    console.log(`↪️  Port forward created: ${proto}/${external_port} → ${ip}:${internal_port}`);
    applyNetworkSetup();
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Port forward create error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/network/port-forwards/:id/toggle', adminAuth, (req, res) => {
  try {
    const fwd = db.prepare('SELECT * FROM port_forwards WHERE id = ?').get(req.params.id);
    if (!fwd) {
      return res.status(404).json({ success: false, message: 'Port forward not found' });
    }
    db.prepare('UPDATE port_forwards SET enabled = ? WHERE id = ?').run(fwd.enabled ? 0 : 1, req.params.id);
    applyNetworkSetup();
    res.json({ success: true, enabled: !fwd.enabled });
  } catch (err) {
    console.error('Port forward toggle error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/network/port-forwards/:id', adminAuth, (req, res) => {
  try {
    const fwd = db.prepare('SELECT * FROM port_forwards WHERE id = ?').get(req.params.id);
    if (!fwd) {
      return res.status(404).json({ success: false, message: 'Port forward not found' });
    }
    db.prepare('DELETE FROM port_forwards WHERE id = ?').run(req.params.id);
    console.log(`↪️  Port forward deleted: ${fwd.protocol}/${fwd.external_port}`);
    applyNetworkSetup();
    res.json({ success: true, message: 'Port forward deleted' });
  } catch (err) {
    console.error('Port forward delete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── In-panel diagnostics ────────────────────────────────────────
// Target validated as a hostname or IP only (no flags/spaces) before ever
// reaching execFile, execFile itself doesn't go through a shell, but a
// value like "-c 100" would still be accepted as a legitimate-looking ping
// argument and let a caller turn a 4-packet ping into a flood, so the
// format is restricted regardless.
const DIAG_TARGET_REGEX = /^[a-zA-Z0-9.-]{1,253}$/;

router.post('/network/diagnostics/ping', adminAuth, (req, res) => {
  const target = String(req.body.target || '').trim();
  if (!DIAG_TARGET_REGEX.test(target)) {
    return res.status(400).json({ success: false, message: 'Invalid target' });
  }
  execFile('ping', ['-c', '4', '-W', '2', target], { timeout: 15000 }, (err, stdout, stderr) => {
    res.json({ success: true, output: (stdout || '') + (stderr || '') || (err ? err.message : '') });
  });
});

router.post('/network/diagnostics/traceroute', adminAuth, (req, res) => {
  const target = String(req.body.target || '').trim();
  if (!DIAG_TARGET_REGEX.test(target)) {
    return res.status(400).json({ success: false, message: 'Invalid target' });
  }
  execFile('traceroute', ['-m', '15', '-w', '2', target], { timeout: 30000 }, (err, stdout, stderr) => {
    res.json({ success: true, output: (stdout || '') + (stderr || '') || (err ? err.message : '') });
  });
});

router.get('/diagnostics/run', adminAuth, (req, res) => {
  try {
    const report = require('../services/systemDiagnosticsService').runChecks();
    res.json({ success: true, report });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/support-bundle', adminAuth, (req, res) => {
  try {
    const bundle = require('../services/supportBundleService').buildBundle();
    const filename = `starkfi-support-bundle-${Date.now()}.txt`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(bundle);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/disk-space', adminAuth, (req, res) => {
  try {
    const info = require('../services/systemDiagnosticsService').getDiskSpace();
    res.json({ success: true, ...info });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/backup/scheduled/list', adminAuth, (req, res) => {
  try {
    const backups = require('../services/scheduledBackupService').listBackups();
    res.json({ success: true, backups });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/diagnostics/last-boot', adminAuth, (req, res) => {
  try {
    const report = require('../services/systemDiagnosticsService').getLastBootReport();
    res.json({ success: true, report });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Shared by GET /logs and its CSV export below. Merges THREE sources into
// one time-ordered feed: watchdog_events (self-heal check history),
// network_config_versions (config-change audit trail, already built by
// configSafety.js), and alert_events (the general info/warning/critical
// feed already fed by logAlertEvent() from all over this app - coin
// activity, vendo connect/disconnect, tethering detection, the
// coin_credited_no_pending_match fail-safe, etc). Real incident: this
// page used to be watchdog+config only, so "all it ever said was
// Self-heal check passed" while a real, alert-logged problem (a coin
// silently crediting the wrong mac) was invisible here even though it
// WAS being recorded elsewhere - this closes that gap by surfacing
// everything in one place instead of requiring an operator to already
// know which of several separate tables to go look in. Financial
// TRANSACTION records (the money itself) still stay out of this -
// Sales Report already owns that view - this is operational/event
// history, not a ledger.
function queryUnifiedLogs(limit) {
  const watchdog = db.prepare(
    'SELECT id, status, issues_json, checked_at FROM watchdog_events ORDER BY checked_at DESC LIMIT ?'
  ).all(limit).map((r) => ({
    source: 'watchdog',
    time: r.checked_at,
    level: r.status === 'ok' ? 'info' : 'warning',
    message: r.status === 'ok' ? 'Self-heal check passed' : 'Self-heal check found issues',
    // Bug found live: each issue is a structured {severity, code, message}
    // object (see watchdogService.js's persistResult()), not a plain
    // string - naively .join()-ing the array rendered "[object Object]".
    detail: (() => { try { return JSON.parse(r.issues_json).map((i) => i.message || i).join(', '); } catch (e) { return ''; } })(),
  }));
  const configChanges = db.prepare(
    'SELECT id, created_at, operator, reason, applied, rolled_back, verify_status FROM network_config_versions ORDER BY created_at DESC LIMIT ?'
  ).all(limit).map((r) => ({
    source: 'config',
    time: r.created_at,
    level: r.rolled_back ? 'warning' : 'info',
    message: r.rolled_back
      ? 'Network config change rolled back'
      : r.applied ? 'Network config applied' : 'Network config change recorded',
    detail: `${r.operator || 'admin'}${r.reason ? ', ' + r.reason : ''}`,
  }));
  const alerts = db.prepare(
    'SELECT id, severity, code, title, detail, created_at FROM alert_events ORDER BY created_at DESC LIMIT ?'
  ).all(limit).map((r) => ({
    source: 'alert',
    time: r.created_at,
    level: r.severity, // already 'info' | 'warning' | 'critical'
    message: r.title,
    detail: r.detail || '',
  }));
  return watchdog.concat(configChanges, alerts)
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, limit);
}

router.get('/logs', adminAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    return res.json({ success: true, logs: queryUnifiedLogs(limit) });
  } catch (err) {
    console.error('Logs error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/logs/export - same merged feed, as a downloadable CSV
// for sending along with a support request.
router.get('/logs/export', adminAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    const logs = queryUnifiedLogs(limit);
    const header = 'time,level,source,message,detail\n';
    const csvEscape = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const body = logs.map((l) => [l.time, l.level, l.source, l.message, l.detail].map(csvEscape).join(',')).join('\n');
    const filename = `starkfi-logs-${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(header + body);
  } catch (err) {
    console.error('Logs export error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports - customer-submitted issue reports from the
// portal's "Report a Problem" button (portal.js's POST /report).
router.get('/reports', adminAuth, (req, res) => {
  try {
    const status = req.query.status; // optional filter: 'open' | 'resolved'
    const rows = status
      ? db.prepare('SELECT * FROM customer_reports WHERE status = ? ORDER BY created_at DESC').all(status)
      : db.prepare('SELECT * FROM customer_reports ORDER BY created_at DESC').all();
    return res.json({ success: true, reports: rows });
  } catch (err) {
    console.error('Reports list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/reports/:id/resolve', adminAuth, (req, res) => {
  try {
    db.prepare(`
      UPDATE customer_reports SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Report resolve error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Marks a report as spam - distinct from resolve, for a report that was
// never a real issue (a prank message) rather than one that got handled.
// Doesn't block the MAC by itself - see POST /reports/block-mac for that.
router.post('/reports/:id/spam', adminAuth, (req, res) => {
  try {
    db.prepare(`
      UPDATE customer_reports SET status = 'spam', resolved_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Report spam-mark error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Silences one MAC's report channel entirely (portal.js's POST /report
// checks report_blocked_macs before accepting a new one) - for a customer
// using the button to prank rather than report a real issue. Does not
// touch their WiFi/session access at all, only the report button.
router.post('/reports/block-mac', adminAuth, (req, res) => {
  try {
    const mac = String(req.body?.mac || '').trim().toLowerCase();
    if (!mac) return res.status(400).json({ success: false, message: 'Missing MAC address' });
    db.prepare('INSERT OR IGNORE INTO report_blocked_macs (mac_address) VALUES (?)').run(mac);
    return res.json({ success: true });
  } catch (err) {
    console.error('Report block-mac error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/reports/unblock-mac', adminAuth, (req, res) => {
  try {
    const mac = String(req.body?.mac || '').trim().toLowerCase();
    db.prepare('DELETE FROM report_blocked_macs WHERE mac_address = ?').run(mac);
    return res.json({ success: true });
  } catch (err) {
    console.error('Report unblock-mac error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/reports/blocked-macs', adminAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT mac_address, blocked_at FROM report_blocked_macs ORDER BY blocked_at DESC').all();
    return res.json({ success: true, blocked: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports/:id/messages - the two-way thread under one
// report (admin replies, customer follow-ups, system entries like an
// approve-credit action).
router.get('/reports/:id/messages', adminAuth, (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT * FROM report_messages WHERE report_id = ? ORDER BY created_at ASC'
    ).all(req.params.id);
    return res.json({ success: true, messages: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/reports/:id/reply', adminAuth, (req, res) => {
  try {
    const message = String(req.body?.message || '').trim().slice(0, 1000);
    if (!message) return res.status(400).json({ success: false, message: 'Message required' });
    db.prepare(
      "INSERT INTO report_messages (report_id, sender, message) VALUES (?, 'admin', ?)"
    ).run(req.params.id, message);
    return res.json({ success: true });
  } catch (err) {
    console.error('Report reply error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/coin-pulse-log?mac=xx&hours=24 - the "backup sensor"
// proof for a disputed report: every raw coin pulse the server actually
// received from that MAC's vendo in the given window, logged the instant
// it arrived (coin.js's POST /), independent of whether it ended up
// credited. Empty result for the disputed time window is itself real
// evidence - it means the hardware never sent a signal at all.
router.get('/coin-pulse-log', adminAuth, (req, res) => {
  try {
    const mac = String(req.query.mac || '').trim().toLowerCase();
    if (!mac) return res.status(400).json({ success: false, message: 'mac required' });
    const hours = Math.min(parseInt(req.query.hours, 10) || 24, 24 * 30);
    const rows = db.prepare(`
      SELECT coin_value, kiosk_id, received_at FROM coin_pulse_log
      WHERE mac_address = ? AND received_at >= datetime('now', ?)
      ORDER BY received_at DESC
    `).all(mac, `-${hours} hours`);
    return res.json({ success: true, pulses: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Shared by GET /coinslot-activity and its CSV export below - every raw
// coin pulse this server has ever received (coin_pulse_log, written the
// instant a pulse arrives in coin.js's POST /, independent of whether it
// ended up credited), joined against vendos so each row can show a real
// device name instead of a bare mac, and flagged when the pulse's mac
// matches a KNOWN VENDO's own mac_address - the exact signature of the
// "no customer's Insert Coin window was open" fallback path (see coin.js's
// coin_credited_no_pending_match alert) rather than a genuine customer.
function queryCoinslotActivity({ vendoId, hours, limit, offset }) {
  const params = [];
  let where = "received_at >= datetime('now', ?)";
  params.push(`-${hours} hours`);
  if (vendoId) {
    where += ' AND cpl.mac_address = (SELECT mac_address FROM vendos WHERE id = ?)';
    params.push(vendoId);
  }
  const rows = db.prepare(`
    SELECT cpl.id, cpl.mac_address, cpl.coin_value, cpl.kiosk_id, cpl.received_at,
      v.id as vendo_id, v.name as vendo_name,
      CASE WHEN v.id IS NOT NULL THEN 1 ELSE 0 END as is_vendo_fallback
    FROM coin_pulse_log cpl
    LEFT JOIN vendos v ON v.mac_address = cpl.mac_address
    WHERE ${where}
    ORDER BY cpl.received_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as c FROM coin_pulse_log cpl WHERE ${where}`).get(...params).c;
  return { rows, total };
}

// GET /api/admin/coinslot-activity?vendo_id=&hours=24&page=1 - the general
// debugging feed this incident showed was missing: every coin pulse
// received, filterable by device/time range, with the vendo-fallback
// failure mode (coin.js's coin_credited_no_pending_match case) visibly
// flagged per row instead of requiring a manual database query to find.
router.get('/coinslot-activity', adminAuth, (req, res) => {
  try {
    const vendoId = req.query.vendo_id ? parseInt(req.query.vendo_id, 10) : null;
    const hours = Math.min(parseInt(req.query.hours, 10) || 24, 24 * 90);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 50;
    const { rows, total } = queryCoinslotActivity({ vendoId, hours, limit, offset: (page - 1) * limit });
    return res.json({ success: true, pulses: rows, total, page, limit });
  } catch (err) {
    console.error('Coinslot activity error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/coinslot-activity/export?vendo_id=&hours=24 - same query,
// no pagination cap beyond a sane hard ceiling, returned as a downloadable
// CSV for offline debugging/sharing with support.
router.get('/coinslot-activity/export', adminAuth, (req, res) => {
  try {
    const vendoId = req.query.vendo_id ? parseInt(req.query.vendo_id, 10) : null;
    const hours = Math.min(parseInt(req.query.hours, 10) || 24, 24 * 90);
    const { rows } = queryCoinslotActivity({ vendoId, hours, limit: 50000, offset: 0 });

    const header = 'received_at,mac_address,vendo_name,coin_value,kiosk_id,vendo_fallback\n';
    const csvEscape = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const body = rows.map((r) =>
      [r.received_at, r.mac_address, r.vendo_name || '', r.coin_value, r.kiosk_id ?? '', r.is_vendo_fallback ? 'yes' : 'no']
        .map(csvEscape).join(',')
    ).join('\n');

    const filename = `coinslot-activity-${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(header + body);
  } catch (err) {
    console.error('Coinslot activity export error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Shared by GET /vendo-device-log and its CSV export below - a device's
// own account of its lifecycle events (WiFi lost/regained, setup mode
// skipped/entered, coin queued/synced, self-heal reboots), synced up from
// firmware once reconnected (see POST /vendo/device-log-sync above). This
// incident showed the gap directly: "the logs can't tell it, just
// Self-heal check passed" - the server has zero visibility into what a
// disconnected device was doing, this is the device's own side of that
// story. device_at is the device's own millis() at the time (relative
// ordering only, meaningless as a real timestamp - a device can be up for
// weeks and millis() has no wall-clock relation), so rows are ordered and
// filtered by received_at (this server's real clock) instead.
function queryVendoDeviceLog({ vendoId, hours, limit, offset }) {
  const params = [];
  let where = "vdl.received_at >= datetime('now', ?)";
  params.push(`-${hours} hours`);
  if (vendoId) {
    where += ' AND vdl.mac_address = (SELECT mac_address FROM vendos WHERE id = ?)';
    params.push(vendoId);
  }
  const rows = db.prepare(`
    SELECT vdl.id, vdl.mac_address, vdl.message, vdl.device_at, vdl.received_at,
      v.id as vendo_id, v.name as vendo_name
    FROM vendo_device_log vdl
    LEFT JOIN vendos v ON v.mac_address = vdl.mac_address
    WHERE ${where}
    ORDER BY vdl.received_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as c FROM vendo_device_log vdl WHERE ${where}`).get(...params).c;
  return { rows, total };
}

// GET /api/admin/vendo-device-log?vendo_id=&hours=24&page=1
router.get('/vendo-device-log', adminAuth, (req, res) => {
  try {
    const vendoId = req.query.vendo_id ? parseInt(req.query.vendo_id, 10) : null;
    const hours = Math.min(parseInt(req.query.hours, 10) || 24, 24 * 90);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 50;
    const { rows, total } = queryVendoDeviceLog({ vendoId, hours, limit, offset: (page - 1) * limit });
    return res.json({ success: true, entries: rows, total, page, limit });
  } catch (err) {
    console.error('Vendo device log error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/vendo-device-log/export?vendo_id=&hours=24
router.get('/vendo-device-log/export', adminAuth, (req, res) => {
  try {
    const vendoId = req.query.vendo_id ? parseInt(req.query.vendo_id, 10) : null;
    const hours = Math.min(parseInt(req.query.hours, 10) || 24, 24 * 90);
    const { rows } = queryVendoDeviceLog({ vendoId, hours, limit: 50000, offset: 0 });

    const header = 'received_at,mac_address,vendo_name,message\n';
    const csvEscape = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const body = rows.map((r) =>
      [r.received_at, r.mac_address, r.vendo_name || '', r.message].map(csvEscape).join(',')
    ).join('\n');

    const filename = `vendo-device-log-${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(header + body);
  } catch (err) {
    console.error('Vendo device log export error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/reports/:id/approve-credit - manually credits a
// disputed peso amount to that report's MAC's currently active session,
// reusing the exact same math as POST /session/:code/addtime. Leaves a
// system message in the report's thread as a visible paper trail and
// marks the report resolved.
router.post('/reports/:id/approve-credit', adminAuth, async (req, res) => {
  try {
    const pesos = parseFloat(req.body?.pesos);
    if (!Number.isFinite(pesos) || pesos <= 0) {
      return res.status(400).json({ success: false, message: 'Enter a valid peso amount' });
    }
    const report = db.prepare('SELECT * FROM customer_reports WHERE id = ?').get(req.params.id);
    if (!report || !report.mac_address) {
      return res.status(404).json({ success: false, message: 'Report or device MAC not found' });
    }
    const session = db.prepare(
      "SELECT * FROM sessions WHERE mac_address = ? ORDER BY id DESC LIMIT 1"
    ).get(report.mac_address);
    if (!session) {
      return res.status(404).json({ success: false, message: 'No session found for this device' });
    }

    const { getMinutesForCoin } = require('../services/voucherService');
    const minutes = getMinutesForCoin(pesos);
    if (!minutes) {
      return res.status(400).json({ success: false, message: `No rate configured for ₱${pesos}` });
    }

    const newMinutes = session.minutes_remaining + minutes;
    const newExpiresAt = new Date(Date.now() + newMinutes * 60 * 1000).toISOString();
    const currentHardExpires = new Date(session.hard_expires_at).getTime();
    const newHardExpiresAt = new Date(
      Math.max(currentHardExpires + minutes * 60 * 1000, new Date(newExpiresAt).getTime())
    ).toISOString();

    db.prepare(`
      UPDATE sessions SET minutes_remaining = ?, expires_at = ?, hard_expires_at = ? WHERE voucher_code = ?
    `).run(newMinutes, newExpiresAt, newHardExpiresAt, session.voucher_code);

    db.prepare(`
      INSERT INTO transactions (voucher_code, coin_value, minutes_added, type, mac_address)
      VALUES (?, ?, ?, 'admin_credit', ?)
    `).run(session.voucher_code, pesos, minutes, report.mac_address);

    db.prepare(`
      UPDATE customer_reports SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.params.id);

    db.prepare(`
      INSERT INTO report_messages (report_id, sender, message) VALUES (?, 'system', ?)
    `).run(req.params.id, `Admin credited ₱${pesos} (${minutes} min) to this device.`);

    try {
      const { allowClient } = require('../services/networkService');
      await allowClient(session.mac_address);
    } catch (e) {}

    return res.json({ success: true, minutes_remaining: newMinutes });
  } catch (err) {
    console.error('Report approve-credit error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Local Movie Server (server/services/movieService.js) ───────────────
const movieService = require('../services/movieService');

router.get('/movies/ffmpeg-check', adminAuth, async (req, res) => {
  const installed = await movieService.checkFfmpeg();
  res.json({ success: true, installed });
});

router.get('/movies', adminAuth, (req, res) => {
  try {
    res.json({ success: true, movies: movieService.getMovies() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/movies/scan', adminAuth, async (req, res) => {
  try {
    const result = await movieService.scanMoviesFolder();
    res.json(result);
  } catch (err) {
    console.error('Movie scan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Movies > Online (server/services/onlineMovieCatalog.js + tmdbService.js) ──
// Everything here is additive to the LOCAL movie library routes above -
// nothing there was changed. This is the admin-facing config for the
// Online Movies tab: which streaming source to embed from, the TMDb key
// that powers posters/search/feed-sync, and which titles carry a price.
const onlineMovieCatalog = require('../services/onlineMovieCatalog');
const tmdbService = require('../services/tmdbService');

router.get('/movies/online-settings', adminAuth, (req, res) => {
  const tmdbKeySet = !!db.prepare("SELECT value FROM settings WHERE key = 'tmdb_api_key'").get()?.value;
  const feedStatus = tmdbService.getFeedStatus();
  res.json({ success: true, tmdb_key_set: tmdbKeySet, feed: feedStatus });
});

// ── Streaming Sources (streaming_sources) ───────────────────────────────
// One combined list for both Movies and TV Shows (owner request: a real
// provider is usually one server offering both, e.g. vidcore.org/embed/
// movie/{tmdb_id} AND vidcore.org/embed/tv/{tmdb_id}/{season}/{episode} -
// two separately-managed "Server 1/2/3" sections just duplicated the same
// list). Either template can be blank (a provider that only serves one
// kind), but at least one is required. A customer switches between
// sources from the player overlay if one is slow/down/ad-heavy (see
// GET /api/portal/online-movies/sources, /api/portal/tv-shows/sources,
// and each :id/embed route's ?source_id= param).
const SEASON_PLACEHOLDER_RE = /\{season(_number)?\}/;
const EPISODE_PLACEHOLDER_RE = /\{episode(_number)?\}/;

function validateStreamingTemplates(movieTemplate, tvTemplate) {
  if (!movieTemplate && !tvTemplate) {
    return 'A Movie URL, a Series URL, or both are required.';
  }
  if (movieTemplate && !movieTemplate.includes('{tmdb_id}')) {
    return 'The Movie URL must contain the literal {tmdb_id} placeholder.';
  }
  if (tvTemplate) {
    if (!tvTemplate.includes('{tmdb_id}')) {
      return 'The Series URL must contain the literal {tmdb_id} placeholder.';
    }
    if (!SEASON_PLACEHOLDER_RE.test(tvTemplate) || !EPISODE_PLACEHOLDER_RE.test(tvTemplate)) {
      return 'The Series URL must contain a season placeholder ({season} or {season_number}) and an episode placeholder ({episode} or {episode_number}).';
    }
  }
  return null;
}

router.get('/movies/streaming-sources', adminAuth, (req, res) => {
  const sources = db.prepare('SELECT * FROM streaming_sources ORDER BY sort_order, id').all();
  res.json({ success: true, sources });
});

router.post('/movies/streaming-sources', adminAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const movieTemplate = String(req.body?.movie_url_template || '').trim() || null;
  const tvTemplate = String(req.body?.tv_url_template || '').trim() || null;
  if (!name) return res.status(400).json({ success: false, message: 'A name is required.' });
  const error = validateStreamingTemplates(movieTemplate, tvTemplate);
  if (error) return res.status(400).json({ success: false, message: error });

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM streaming_sources').get().m;
  const isFirst = db.prepare('SELECT COUNT(*) as c FROM streaming_sources').get().c === 0;
  const result = db.prepare('INSERT INTO streaming_sources (name, movie_url_template, tv_url_template, is_default, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(name, movieTemplate, tvTemplate, isFirst ? 1 : 0, maxOrder + 1);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.post('/movies/streaming-sources/:id', adminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, movie_url_template, tv_url_template, is_default } = req.body || {};
  if (movie_url_template !== undefined || tv_url_template !== undefined) {
    const current = db.prepare('SELECT movie_url_template, tv_url_template FROM streaming_sources WHERE id = ?').get(id);
    const nextMovie = movie_url_template !== undefined ? (String(movie_url_template).trim() || null) : current?.movie_url_template;
    const nextTv = tv_url_template !== undefined ? (String(tv_url_template).trim() || null) : current?.tv_url_template;
    const error = validateStreamingTemplates(nextMovie, nextTv);
    if (error) return res.status(400).json({ success: false, message: error });
  }
  if (is_default) {
    // Only one default at a time - clear the others first.
    db.prepare('UPDATE streaming_sources SET is_default = 0').run();
  }
  db.prepare(`
    UPDATE streaming_sources SET
      name = COALESCE(?, name),
      movie_url_template = CASE WHEN ? THEN ? ELSE movie_url_template END,
      tv_url_template = CASE WHEN ? THEN ? ELSE tv_url_template END,
      is_default = COALESCE(?, is_default)
    WHERE id = ?
  `).run(
    name || null,
    movie_url_template !== undefined ? 1 : 0, movie_url_template !== undefined ? (String(movie_url_template).trim() || null) : null,
    tv_url_template !== undefined ? 1 : 0, tv_url_template !== undefined ? (String(tv_url_template).trim() || null) : null,
    is_default ? 1 : (is_default === false ? 0 : null), id
  );
  res.json({ success: true });
});

router.delete('/movies/streaming-sources/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM streaming_sources WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// ── Top 10 Ranking (front-row curation for the customer home screen) ────
// Shared by Movies and TV Shows - see server/routes/portal.js's
// computeTop10() for what each mode actually does. Kept under /movies/*
// (not split into a /tv-shows/* twin) since the admin card managing this
// is one shared card, same reasoning as the streaming sources merge.
const TOP10_MODES = ['most_viewed', 'tmdb_trending', 'custom'];

router.get('/movies/top10-settings', adminAuth, (req, res) => {
  const movieMode = db.prepare("SELECT value FROM settings WHERE key = 'movie_top10_mode'").get()?.value || 'most_viewed';
  const seriesMode = db.prepare("SELECT value FROM settings WHERE key = 'series_top10_mode'").get()?.value || 'most_viewed';
  res.json({ success: true, movie_mode: movieMode, series_mode: seriesMode });
});

router.post('/movies/top10-settings', adminAuth, (req, res) => {
  const { movie_mode, series_mode } = req.body || {};
  if (movie_mode !== undefined) {
    if (!TOP10_MODES.includes(movie_mode)) return res.status(400).json({ success: false, message: 'Invalid movie_mode.' });
    db.prepare(`INSERT INTO settings (key, value) VALUES ('movie_top10_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(movie_mode);
  }
  if (series_mode !== undefined) {
    if (!TOP10_MODES.includes(series_mode)) return res.status(400).json({ success: false, message: 'Invalid series_mode.' });
    db.prepare(`INSERT INTO settings (key, value) VALUES ('series_top10_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(series_mode);
  }
  res.json({ success: true });
});

router.get('/movies/top10-picks', adminAuth, (req, res) => {
  const mediaType = req.query.media_type === 'tv' ? 'tv' : 'movie';
  const picks = db.prepare('SELECT * FROM custom_top_picks WHERE media_type = ? ORDER BY sort_order, id').all(mediaType);
  res.json({ success: true, picks });
});

router.post('/movies/top10-picks', adminAuth, (req, res) => {
  const mediaType = req.body?.media_type === 'tv' ? 'tv' : 'movie';
  const tmdbId = parseInt(req.body?.tmdb_id, 10);
  const title = String(req.body?.title || '').trim().slice(0, 200);
  if (!tmdbId || !title) return res.status(400).json({ success: false, message: 'A title and TMDb ID are required.' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM custom_top_picks WHERE media_type = ?').get(mediaType).m;
  try {
    db.prepare('INSERT INTO custom_top_picks (media_type, tmdb_id, title, sort_order) VALUES (?, ?, ?, ?)')
      .run(mediaType, tmdbId, title, maxOrder + 1);
    res.json({ success: true });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return res.status(400).json({ success: false, message: 'Already in the Top 10 picks.' });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// {direction: 'up'|'down'} - swaps this pick's sort_order with its
// neighbor on that side. Simpler and less error-prone over the wire than
// having the client re-post a whole reordered array.
router.post('/movies/top10-picks/:id/move', adminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const direction = req.body?.direction === 'up' ? 'up' : 'down';
  const current = db.prepare('SELECT * FROM custom_top_picks WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ success: false, message: 'Pick not found' });
  const neighbor = direction === 'up'
    ? db.prepare('SELECT * FROM custom_top_picks WHERE media_type = ? AND sort_order < ? ORDER BY sort_order DESC LIMIT 1').get(current.media_type, current.sort_order)
    : db.prepare('SELECT * FROM custom_top_picks WHERE media_type = ? AND sort_order > ? ORDER BY sort_order ASC LIMIT 1').get(current.media_type, current.sort_order);
  if (!neighbor) return res.json({ success: true });
  const swap = db.transaction(() => {
    db.prepare('UPDATE custom_top_picks SET sort_order = ? WHERE id = ?').run(neighbor.sort_order, current.id);
    db.prepare('UPDATE custom_top_picks SET sort_order = ? WHERE id = ?').run(current.sort_order, neighbor.id);
  });
  swap();
  res.json({ success: true });
});

router.delete('/movies/top10-picks/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM custom_top_picks WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

router.post('/movies/tmdb-key', adminAuth, (req, res) => {
  const apiKey = String(req.body?.api_key || '').trim();
  if (!apiKey) return res.status(400).json({ success: false, message: 'Enter a key first.' });
  const { encryptSecret } = require('../utils/secretCrypto');
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('tmdb_api_key', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(encryptSecret(apiKey));
  res.json({ success: true });
});

// Tests whatever key is passed in the body (so the admin can test BEFORE
// saving), falling back to the already-saved key if the field was left
// blank (re-verify an existing key). Same try/await/200-or-400 shape as
// every other "Test Connection" route in this file (router/test-connection
// etc.).
router.post('/movies/tmdb-test', adminAuth, async (req, res) => {
  try {
    const apiKey = String(req.body?.api_key || '').trim() || null;
    await tmdbService.testConnection(apiKey);
    res.json({ success: true, message: 'Connected' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Connection failed' });
  }
});

router.get('/movies/tmdb-search', adminAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ success: true, results: [] });
    const results = await tmdbService.searchMovies(q);
    res.json({ success: true, results });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Search failed' });
  }
});

// Pulls Trending/Popular/Top Rated from TMDb into tmdb_movie_feed - this is
// what grows the catalog without anyone hand-typing ids. Admin-triggered
// (button in the UI), not on any timer, so a slow TMDb response doesn't
// hold up anything else - the admin sees a spinner and a result count.
router.post('/movies/tmdb-sync', adminAuth, async (req, res) => {
  try {
    const result = await tmdbService.syncFeed();
    if (result.skipped) return res.status(400).json({ success: false, message: 'Set a TMDb API key first.' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('TMDb feed sync error:', err);
    res.status(500).json({ success: false, message: err.message || 'Sync failed' });
  }
});

// GET /movies/online-catalog?q=&page=&limit= - the Price Groups table.
// Search filters by title (case-insensitive substring); with no query,
// paginates the full merged catalog (starter list + synced feed) so a
// catalog of hundreds of titles doesn't have to render all at once.
// Sort field -> comparator. Click-to-sort on the Price Groups table headers
// (public/admin/pages/movies.html's om-sortable <th>s) instead of a
// separate filter control - lets the owner find "just the paid ones" (or
// sort by price/priority/rental hours) directly in the table they're
// already looking at.
const CATALOG_SORTERS = {
  title: (a, b) => a.title.localeCompare(b.title),
  tier: (a, b) => a.tier.localeCompare(b.tier) || a.title.localeCompare(b.title),
  price: (a, b) => a.price_pesos - b.price_pesos || a.title.localeCompare(b.title),
  priority: (a, b) => (a.priority || 0) - (b.priority || 0) || a.title.localeCompare(b.title),
  rental_hours: (a, b) => (a.rental_hours || 0) - (b.rental_hours || 0) || a.title.localeCompare(b.title),
};

router.get('/movies/online-catalog', adminAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const sortKey = CATALOG_SORTERS[req.query.sort] ? req.query.sort : 'title';
  const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));

  let all = onlineMovieCatalog.getAll();
  if (q) all = all.filter((m) => m.title.toLowerCase().includes(q));
  all.sort(CATALOG_SORTERS[sortKey]);
  if (dir === 'desc') all.reverse();

  const total = all.length;
  const start = (page - 1) * limit;
  const pageItems = all.slice(start, start + limit).map((m) => ({
    ...m,
    poster: tmdbService.getCachedPosterUrl(m.id),
  }));

  res.json({ success: true, movies: pageItems, total, page, limit });
});

router.post('/movies/online-catalog/price', adminAuth, (req, res) => {
  const tmdbId = parseInt(req.body?.tmdb_id, 10);
  const title = String(req.body?.title || '').trim();
  const tier = req.body?.tier === 'paid' ? 'paid' : 'free';
  const pricePesos = tier === 'paid' ? Math.max(0, parseInt(req.body?.price_pesos, 10) || 0) : 0;
  const priority = parseInt(req.body?.priority, 10) || 0;
  const rentalHours = tier === 'paid' ? Math.max(0, parseInt(req.body?.rental_hours, 10) || 0) : 0;
  if (!tmdbId || !title) {
    return res.status(400).json({ success: false, message: 'A movie and title are required.' });
  }
  onlineMovieCatalog.unhide(tmdbId);
  db.prepare(`
    INSERT INTO online_movie_pricing (tmdb_id, title, tier, price_pesos, priority, rental_hours, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tmdb_id) DO UPDATE SET title = excluded.title, tier = excluded.tier,
      price_pesos = excluded.price_pesos, priority = excluded.priority,
      rental_hours = excluded.rental_hours, updated_at = CURRENT_TIMESTAMP
  `).run(tmdbId, title, tier, pricePesos, priority, rentalHours);
  res.json({ success: true });
});

// Group delete (Price Groups' "Delete Selected" bulk action) - same
// permanent-hide semantics as the single-row Delete button, just applied to
// every selected id in one transaction (see onlineMovieCatalog.hideMany()).
router.post('/movies/online-catalog/bulk-delete', adminAuth, (req, res) => {
  const ids = Array.isArray(req.body?.movies) ? req.body.movies.map((m) => (typeof m === 'object' ? m.tmdb_id : m)) : [];
  if (ids.length === 0) return res.status(400).json({ success: false, message: 'No movies selected.' });
  onlineMovieCatalog.hideMany(ids);
  res.json({ success: true, removed: ids.length });
});

// Add a title by TMDb ID alone, no search needed - looks the title up from
// TMDb automatically (so the catalog never shows a blank/wrong name) and
// prices it in one step. Coin-gated the moment this returns, since a
// tier:'paid' row is what hasActiveOnlineRental() checks against.
router.post('/movies/online-catalog/add-by-id', adminAuth, async (req, res) => {
  const tmdbId = parseInt(req.body?.tmdb_id, 10);
  const tier = req.body?.tier === 'paid' ? 'paid' : 'free';
  const pricePesos = tier === 'paid' ? Math.max(0, parseInt(req.body?.price_pesos, 10) || 0) : 0;
  if (!tmdbId) return res.status(400).json({ success: false, message: 'Enter a TMDb ID first.' });

  try {
    const movie = await tmdbService.getMovieById(tmdbId);
    onlineMovieCatalog.unhide(movie.id);
    db.prepare(`
      INSERT INTO online_movie_pricing (tmdb_id, title, tier, price_pesos, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tmdb_id) DO UPDATE SET title = excluded.title, tier = excluded.tier,
        price_pesos = excluded.price_pesos, updated_at = CURRENT_TIMESTAMP
    `).run(movie.id, movie.title, tier, pricePesos);
    res.json({ success: true, title: movie.title });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Could not add that ID.' });
  }
});

// Bulk import from a plain .txt file - one TMDb ID per line (anything else
// on the line, e.g. "634649 # Spider-Man" or "634649,Some Title", is
// ignored; only the first number found on each line is used). Every valid,
// not-already-in-the-catalog id gets looked up on TMDb and added as Free -
// same defaults as adding one at a time, just in bulk. This is genuinely
// the ONLY way an admin can add many titles at once without typing each id
// individually, so it's worth being tolerant of messy input rather than
// rejecting the whole file over one bad line.
router.post('/movies/online-catalog/import', adminAuth, idListUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

  const text = req.file.buffer.toString('utf8');
  const ids = [...new Set(
    text.split(/\r?\n/)
      .map((line) => line.match(/\d+/))
      .filter(Boolean)
      .map((m) => parseInt(m[0], 10))
  )];

  if (ids.length === 0) {
    return res.status(400).json({ success: false, message: 'No numeric TMDb IDs found in that file.' });
  }

  const existing = new Set(onlineMovieCatalog.getAll().map((m) => m.id));
  const toFetch = ids.filter((id) => !existing.has(id));

  const upsert = db.prepare(`
    INSERT INTO online_movie_pricing (tmdb_id, title, tier, price_pesos, updated_at)
    VALUES (?, ?, 'free', 0, CURRENT_TIMESTAMP)
    ON CONFLICT(tmdb_id) DO UPDATE SET title = excluded.title, updated_at = CURRENT_TIMESTAMP
  `);

  let added = 0;
  let failed = 0;
  const CONCURRENCY = 5;
  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((id) => tmdbService.getMovieById(id)));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        onlineMovieCatalog.unhide(result.value.id);
        upsert.run(result.value.id, result.value.title);
        added++;
      } else {
        failed++;
      }
    }
  }

  res.json({
    success: true,
    total_lines_found: ids.length,
    already_in_catalog: ids.length - toFetch.length,
    added,
    failed,
  });
});

// Plain-text export of every TMDb ID currently in the catalog (starter
// feed + admin pricing), one per line with the title as a trailing comment
// for human readability - re-importable via the route above (it only reads
// the leading number, ignoring everything after it).
router.get('/movies/online-catalog/export', adminAuth, (req, res) => {
  const movies = onlineMovieCatalog.getAll().slice().sort((a, b) => a.title.localeCompare(b.title));
  const lines = movies.map((m) => `${m.id} # ${m.title}`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="online-movies-tmdb-ids.txt"');
  res.send(lines.join('\n') + '\n');
});

router.post('/movies/online-catalog/bulk-price', adminAuth, (req, res) => {
  const ids = Array.isArray(req.body?.movies) ? req.body.movies : [];
  const tier = req.body?.tier === 'paid' ? 'paid' : 'free';
  const pricePesos = tier === 'paid' ? Math.max(0, parseInt(req.body?.price_pesos, 10) || 0) : 0;
  if (ids.length === 0) return res.status(400).json({ success: false, message: 'No movies selected.' });

  const upsert = db.prepare(`
    INSERT INTO online_movie_pricing (tmdb_id, title, tier, price_pesos, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tmdb_id) DO UPDATE SET tier = excluded.tier, price_pesos = excluded.price_pesos, updated_at = CURRENT_TIMESTAMP
  `);
  const applyAll = db.transaction((items) => {
    for (const item of items) upsert.run(item.tmdb_id, item.title, tier, pricePesos);
  });
  applyAll(ids);
  res.json({ success: true, updated: ids.length });
});

// Removing a pricing row just reverts that title to free (the starter
// list / synced feed entry, if any, is untouched) - it does NOT delete the
// title from the catalog itself.
router.delete('/movies/online-catalog/price/:tmdbId', adminAuth, (req, res) => {
  db.prepare('DELETE FROM online_movie_pricing WHERE tmdb_id = ?').run(parseInt(req.params.tmdbId, 10));
  res.json({ success: true });
});

// Fully removes a title from the Online Movies catalog (the Price Groups
// table's Delete button) - for anything not appropriate for customers to
// see. Unlike the /price/:tmdbId route above, this also records the id in
// online_movie_hidden so it can't silently come back the next time an
// admin clicks "Sync from TMDb" - see onlineMovieCatalog.js's hide().
router.delete('/movies/online-catalog/:tmdbId', adminAuth, (req, res) => {
  const tmdbId = parseInt(req.params.tmdbId, 10);
  if (!tmdbId) return res.status(400).json({ success: false, message: 'Invalid movie id.' });
  onlineMovieCatalog.hide(tmdbId);
  res.json({ success: true });
});

// A sentinel far-future expiry, not a real schema flag - see the comment
// on POST /movies/online-rentals/grant below for why this was chosen over
// a schema migration (online_movie_rentals.expires_at is NOT NULL and
// every existing read already just compares it against datetime('now'),
// so this needed no other code to change at all).
const PERMANENT_RENTAL_EXPIRY = '9999-12-31 23:59:59';

// GET /movies/online-rentals?q=&page= - lets the owner look up or audit
// who has an active/permanent unlock on a paid title. q matches against
// either the MAC address or the movie title (joins tmdb_movie_feed/
// online_movie_pricing purely for display - enforcement never depends on
// this route, see portal.js's hasActiveOnlineRental()).
router.get('/movies/online-rentals', adminAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 30;

  const rows = db.prepare(`
    SELECT r.id, r.movie_id, r.mac_address, r.rented_at, r.expires_at,
      COALESCE(p.title, f.title, 'TMDb #' || r.movie_id) as title
    FROM online_movie_rentals r
    LEFT JOIN online_movie_pricing p ON p.tmdb_id = r.movie_id
    LEFT JOIN tmdb_movie_feed f ON f.tmdb_id = r.movie_id
    ORDER BY r.rented_at DESC
  `).all();

  const filtered = q
    ? rows.filter((r) => r.mac_address.toLowerCase().includes(q) || r.title.toLowerCase().includes(q))
    : rows;
  const total = filtered.length;
  const start = (page - 1) * limit;
  const pageItems = filtered.slice(start, start + limit).map((r) => ({
    ...r,
    permanent: r.expires_at === PERMANENT_RENTAL_EXPIRY,
    active: r.expires_at === PERMANENT_RENTAL_EXPIRY || new Date(r.expires_at) > new Date(),
  }));

  res.json({ success: true, rentals: pageItems, total, page, limit });
});

// Manually grants (or extends) one device's access to one paid title -
// e.g. a VIP customer, a troubleshooting override, or a permanent unlock
// that's never surfaced to the customer as anything special (per owner
// request: it should look exactly like a normal unlock on their end, no
// "you have permanent access" messaging anywhere). `permanent: true` uses
// a far-future sentinel expiry instead of a schema change - every existing
// active-rental check already just compares expires_at against
// datetime('now')/`new Date()`, so a date this far out is already treated
// as "always active" with no other code needing to know this is special.
router.post('/movies/online-rentals/grant', adminAuth, (req, res) => {
  const mac = String(req.body?.mac || '').trim().toLowerCase();
  const tmdbId = parseInt(req.body?.tmdb_id, 10);
  const permanent = !!req.body?.permanent;
  const hours = Math.max(1, parseInt(req.body?.hours, 10) || 48);
  if (!mac || !tmdbId) return res.status(400).json({ success: false, message: 'A device MAC and a movie are required.' });

  const movie = onlineMovieCatalog.getById(tmdbId);
  if (!movie) return res.status(404).json({ success: false, message: 'That movie is not in the catalog.' });

  const expiresAt = permanent ? PERMANENT_RENTAL_EXPIRY : new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO online_movie_rentals (movie_id, mac_address, expires_at) VALUES (?, ?, ?)').run(movie.id, mac, expiresAt);
  res.json({ success: true, expires_at: expiresAt });
});

// Revokes one specific grant (undo a manual grant, or cut a normal rental
// short) - deletes the row outright rather than back-dating expires_at, so
// it simply stops matching hasActiveOnlineRental()'s query.
router.delete('/movies/online-rentals/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM online_movie_rentals WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// GET /movies/top-searches - what customers actually typed and then opened
// a result for (server/routes/portal.js's POST /online-movies/search-hit
// is what logs these) - real demand signal, separate from Most Watched
// (which only reflects titles you already have) or TMDb's own popularity
// ranking (which reflects the whole world, not your customers).
// GET /movies/revenue - Movies tab's Revenue card. Sums real transactions
// rows rather than re-deriving anything from movie_rentals/
// online_movie_rentals (those are access-control state, not a ledger - a
// rental row's existence says nothing about how much was actually paid,
// and gets overwritten/expires independently of what was charged).
// Covers both local ('movie_rental') and online ('online_movie_rental' -
// coin-paid, and 'online_movie_rental_credit' - paid from a Movie Credit
// balance) - see server/routes/coin.js and portal.js's
// unlock-with-credit route for where these get written. Money that's
// still sitting unspent in movie_credits (an over/underpay not yet
// converted or applied) is deliberately NOT counted here - see the
// comment on addMovieCredit() in coin.js: it was never logged as revenue
// at collection time, only once it's actually earned via a completed
// rental or a WiFi-time conversion, so this can't double-count it.
router.get('/movies/revenue', adminAuth, (req, res) => {
  const MOVIE_TYPES = ['movie_rental', 'online_movie_rental', 'online_movie_rental_credit', 'tv_series_rental', 'tv_series_rental_credit'];
  const placeholders = MOVIE_TYPES.map(() => '?').join(',');
  const today = db.prepare("SELECT date('now', 'localtime') as d").get().d;

  const sumFor = (whereClause, ...params) => db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'movie_rental' THEN coin_value ELSE 0 END), 0) as local,
      COALESCE(SUM(CASE WHEN type IN ('online_movie_rental', 'online_movie_rental_credit') THEN coin_value ELSE 0 END), 0) as online,
      COALESCE(SUM(CASE WHEN type IN ('tv_series_rental', 'tv_series_rental_credit') THEN coin_value ELSE 0 END), 0) as tv,
      COUNT(*) as rentals
    FROM transactions WHERE type IN (${placeholders}) ${whereClause}
  `).get(...MOVIE_TYPES, ...params);

  const toTotals = (row) => ({ local: row.local, online: row.online, tv: row.tv, total: row.local + row.online + row.tv, rentals: row.rentals });

  const todayTotals = toTotals(sumFor("AND date(created_at, 'localtime') = ?", today));
  const monthTotals = toTotals(sumFor("AND strftime('%Y-%m', created_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')"));
  const allTimeTotals = toTotals(sumFor(''));

  const topRows = db.prepare(`
    SELECT voucher_code, SUM(coin_value) as revenue, COUNT(*) as rentals
    FROM transactions WHERE type IN (${placeholders})
    GROUP BY voucher_code ORDER BY revenue DESC LIMIT 10
  `).all(...MOVIE_TYPES);

  const topMovies = topRows.map((row) => {
    const onlineMatch = row.voucher_code.match(/^ONLINE-MOVIE-(\d+)$/);
    const localMatch = row.voucher_code.match(/^MOVIE-(\d+)$/);
    const tvMatch = row.voucher_code.match(/^TV-SERIES-(\d+)$/);
    let title = row.voucher_code;
    let kind = 'unknown';
    if (onlineMatch) {
      kind = 'online';
      const id = parseInt(onlineMatch[1], 10);
      title = db.prepare('SELECT title FROM online_movie_pricing WHERE tmdb_id = ?').get(id)?.title
        || db.prepare('SELECT title FROM tmdb_movie_feed WHERE tmdb_id = ?').get(id)?.title
        || `TMDb #${id}`;
    } else if (localMatch) {
      kind = 'local';
      const movie = movieService.getMovie(localMatch[1]);
      title = movie?.title || `Movie #${localMatch[1]}`;
    } else if (tvMatch) {
      kind = 'tv';
      const id = parseInt(tvMatch[1], 10);
      title = db.prepare('SELECT title FROM tv_series_pricing WHERE tmdb_id = ?').get(id)?.title
        || db.prepare('SELECT title FROM tv_series_feed WHERE tmdb_id = ?').get(id)?.title
        || `TMDb TV #${id}`;
    }
    return { title, kind, revenue: row.revenue, rentals: row.rentals };
  });

  res.json({ success: true, today: todayTotals, month: monthTotals, all_time: allTimeTotals, top_movies: topMovies });
});

// ?media_type= (default 'movie') - online_movie_searches is shared with
// TV Shows (see database.js's column comment), filtered here so each
// section's Top Searches panel only shows its own kind.
router.get('/movies/top-searches', adminAuth, (req, res) => {
  const mediaType = req.query.media_type === 'tv' ? 'tv' : 'movie';
  const rows = db.prepare(`
    SELECT query, COUNT(*) as hits, MAX(searched_at) as last_searched
    FROM online_movie_searches WHERE media_type = ?
    GROUP BY LOWER(query)
    ORDER BY hits DESC, last_searched DESC
    LIMIT 20
  `).all(mediaType);
  res.json({ success: true, searches: rows });
});

// GET /movies/requests?status=&media_type= - the Requests panel, shared
// with TV Shows (movie_requests table) - defaults to 'movie' so the
// existing Movies > Online panel keeps showing only what it always did.
// Defaults to showing everything (within that media_type), newest first;
// ?status=pending narrows to just what still needs a decision.
router.get('/movies/requests', adminAuth, (req, res) => {
  const status = ['pending', 'added', 'declined'].includes(req.query.status) ? req.query.status : '';
  const mediaType = req.query.media_type === 'tv' ? 'tv' : 'movie';
  const rows = status
    ? db.prepare('SELECT * FROM movie_requests WHERE media_type = ? AND status = ? ORDER BY created_at DESC').all(mediaType, status)
    : db.prepare('SELECT * FROM movie_requests WHERE media_type = ? ORDER BY created_at DESC').all(mediaType);
  res.json({ success: true, requests: rows });
});

// Marks a request reviewed (added to the catalog, or declined) - purely a
// status label for the admin's own tracking, doesn't touch the catalog
// itself (adding the actual title is still the normal TMDb search/add-by-id
// flow above).
router.post('/movies/requests/:id/status', adminAuth, (req, res) => {
  const status = req.body?.status;
  if (!['pending', 'added', 'declined'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status.' });
  }
  db.prepare('UPDATE movie_requests SET status = ? WHERE id = ?').run(status, parseInt(req.params.id, 10));
  res.json({ success: true });
});

router.delete('/movies/requests/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM movie_requests WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// ============================================================
// TV SHOWS (series/anime/K-drama) - mirrors the entire Online Movies
// admin section above, against tvCatalogService/tmdbTvService and the
// tv_series_*/tv_streaming_sources/tv_poster_cache tables instead. See
// database.js's header comment on those tables for why this is a fully
// separate system rather than a "kind" flag bolted onto the movie one.
// Shares: the TMDb API key (/movies/tmdb-key, /movies/tmdb-test - one key
// works for both TMDb API surfaces), the Revenue card (extended above to
// include a `tv` bucket), and movie_requests/online_movie_searches (via
// ?media_type=tv, see those routes above) - not shared: the catalog,
// pricing, hidden-list, streaming sources, and rentals, all their own
// tables so a TV series id can never collide with a movie id.
// ============================================================
const tvCatalogService = require('../services/tvCatalogService');
const tmdbTvService = require('../services/tmdbTvService');

router.get('/tv-shows/online-settings', adminAuth, (req, res) => {
  const tmdbKeySet = !!db.prepare("SELECT value FROM settings WHERE key = 'tmdb_api_key'").get()?.value;
  const feedStatus = tmdbTvService.getFeedStatus();
  res.json({ success: true, tmdb_key_set: tmdbKeySet, feed: feedStatus });
});

// Streaming Sources for TV now lives entirely under /movies/streaming-
// sources (streaming_sources table, tv_url_template column) - see that
// section's comment above for why the two were merged into one list.

router.get('/tv-shows/tmdb-search', adminAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ success: true, results: [] });
    const results = await tmdbTvService.searchSeries(q);
    res.json({ success: true, results });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Search failed' });
  }
});

router.post('/tv-shows/tmdb-sync', adminAuth, async (req, res) => {
  try {
    const result = await tmdbTvService.syncFeed();
    if (result.skipped) return res.status(400).json({ success: false, message: 'Set a TMDb API key first.' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('TMDb TV feed sync error:', err);
    res.status(500).json({ success: false, message: err.message || 'Sync failed' });
  }
});

const TV_CATALOG_SORTERS = {
  title: (a, b) => a.title.localeCompare(b.title),
  tier: (a, b) => a.tier.localeCompare(b.tier) || a.title.localeCompare(b.title),
  price: (a, b) => a.price_pesos - b.price_pesos || a.title.localeCompare(b.title),
  priority: (a, b) => (a.priority || 0) - (b.priority || 0) || a.title.localeCompare(b.title),
  rental_hours: (a, b) => (a.rental_hours || 0) - (b.rental_hours || 0) || a.title.localeCompare(b.title),
};

router.get('/tv-shows/catalog', adminAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const sortKey = TV_CATALOG_SORTERS[req.query.sort] ? req.query.sort : 'title';
  const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));

  let all = tvCatalogService.getAll();
  if (q) all = all.filter((s) => s.title.toLowerCase().includes(q));
  all.sort(TV_CATALOG_SORTERS[sortKey]);
  if (dir === 'desc') all.reverse();

  const total = all.length;
  const start = (page - 1) * limit;
  const pageItems = all.slice(start, start + limit).map((s) => ({
    ...s,
    poster: tmdbTvService.getCachedPosterUrl(s.id),
  }));

  res.json({ success: true, series: pageItems, total, page, limit });
});

router.post('/tv-shows/catalog/price', adminAuth, (req, res) => {
  const tmdbId = parseInt(req.body?.tmdb_id, 10);
  const title = String(req.body?.title || '').trim();
  const tier = req.body?.tier === 'paid' ? 'paid' : 'free';
  const pricePesos = tier === 'paid' ? Math.max(0, parseInt(req.body?.price_pesos, 10) || 0) : 0;
  const priority = parseInt(req.body?.priority, 10) || 0;
  const rentalHours = tier === 'paid' ? Math.max(0, parseInt(req.body?.rental_hours, 10) || 0) : 0;
  if (!tmdbId || !title) {
    return res.status(400).json({ success: false, message: 'A series and title are required.' });
  }
  tvCatalogService.unhide(tmdbId);
  db.prepare(`
    INSERT INTO tv_series_pricing (tmdb_id, title, tier, price_pesos, priority, rental_hours, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tmdb_id) DO UPDATE SET title = excluded.title, tier = excluded.tier,
      price_pesos = excluded.price_pesos, priority = excluded.priority,
      rental_hours = excluded.rental_hours, updated_at = CURRENT_TIMESTAMP
  `).run(tmdbId, title, tier, pricePesos, priority, rentalHours);
  res.json({ success: true });
});

router.post('/tv-shows/catalog/bulk-delete', adminAuth, (req, res) => {
  const ids = Array.isArray(req.body?.series) ? req.body.series.map((s) => (typeof s === 'object' ? s.tmdb_id : s)) : [];
  if (ids.length === 0) return res.status(400).json({ success: false, message: 'No series selected.' });
  tvCatalogService.hideMany(ids);
  res.json({ success: true, removed: ids.length });
});

router.post('/tv-shows/catalog/add-by-id', adminAuth, async (req, res) => {
  const tmdbId = parseInt(req.body?.tmdb_id, 10);
  const tier = req.body?.tier === 'paid' ? 'paid' : 'free';
  const pricePesos = tier === 'paid' ? Math.max(0, parseInt(req.body?.price_pesos, 10) || 0) : 0;
  if (!tmdbId) return res.status(400).json({ success: false, message: 'Enter a TMDb ID first.' });

  try {
    const series = await tmdbTvService.getSeriesById(tmdbId);
    tvCatalogService.unhide(series.id);
    db.prepare(`
      INSERT INTO tv_series_pricing (tmdb_id, title, tier, price_pesos, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tmdb_id) DO UPDATE SET title = excluded.title, tier = excluded.tier,
        price_pesos = excluded.price_pesos, updated_at = CURRENT_TIMESTAMP
    `).run(series.id, series.title, tier, pricePesos);
    res.json({ success: true, title: series.title });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Could not add that ID.' });
  }
});

router.post('/tv-shows/catalog/import', adminAuth, idListUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

  const text = req.file.buffer.toString('utf8');
  const ids = [...new Set(
    text.split(/\r?\n/)
      .map((line) => line.match(/\d+/))
      .filter(Boolean)
      .map((m) => parseInt(m[0], 10))
  )];

  if (ids.length === 0) {
    return res.status(400).json({ success: false, message: 'No numeric TMDb IDs found in that file.' });
  }

  const existing = new Set(tvCatalogService.getAll().map((s) => s.id));
  const toFetch = ids.filter((id) => !existing.has(id));

  const upsert = db.prepare(`
    INSERT INTO tv_series_pricing (tmdb_id, title, tier, price_pesos, updated_at)
    VALUES (?, ?, 'free', 0, CURRENT_TIMESTAMP)
    ON CONFLICT(tmdb_id) DO UPDATE SET title = excluded.title, updated_at = CURRENT_TIMESTAMP
  `);

  let added = 0;
  let failed = 0;
  const CONCURRENCY = 5;
  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((id) => tmdbTvService.getSeriesById(id)));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        tvCatalogService.unhide(result.value.id);
        upsert.run(result.value.id, result.value.title);
        added++;
      } else {
        failed++;
      }
    }
  }

  res.json({
    success: true,
    total_lines_found: ids.length,
    already_in_catalog: ids.length - toFetch.length,
    added,
    failed,
  });
});

router.get('/tv-shows/catalog/export', adminAuth, (req, res) => {
  const series = tvCatalogService.getAll().slice().sort((a, b) => a.title.localeCompare(b.title));
  const lines = series.map((s) => `${s.id} # ${s.title}`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tv-shows-tmdb-ids.txt"');
  res.send(lines.join('\n') + '\n');
});

router.post('/tv-shows/catalog/bulk-price', adminAuth, (req, res) => {
  const ids = Array.isArray(req.body?.series) ? req.body.series : [];
  const tier = req.body?.tier === 'paid' ? 'paid' : 'free';
  const pricePesos = tier === 'paid' ? Math.max(0, parseInt(req.body?.price_pesos, 10) || 0) : 0;
  if (ids.length === 0) return res.status(400).json({ success: false, message: 'No series selected.' });

  const upsert = db.prepare(`
    INSERT INTO tv_series_pricing (tmdb_id, title, tier, price_pesos, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tmdb_id) DO UPDATE SET tier = excluded.tier, price_pesos = excluded.price_pesos, updated_at = CURRENT_TIMESTAMP
  `);
  const applyAll = db.transaction((items) => {
    for (const item of items) upsert.run(item.tmdb_id, item.title, tier, pricePesos);
  });
  applyAll(ids);
  res.json({ success: true, updated: ids.length });
});

router.delete('/tv-shows/catalog/price/:tmdbId', adminAuth, (req, res) => {
  db.prepare('DELETE FROM tv_series_pricing WHERE tmdb_id = ?').run(parseInt(req.params.tmdbId, 10));
  res.json({ success: true });
});

router.delete('/tv-shows/catalog/:tmdbId', adminAuth, (req, res) => {
  const tmdbId = parseInt(req.params.tmdbId, 10);
  if (!tmdbId) return res.status(400).json({ success: false, message: 'Invalid series id.' });
  tvCatalogService.hide(tmdbId);
  res.json({ success: true });
});

// ── Rentals (grant/revoke/lookup) - unlocks the WHOLE series ────────────
router.get('/tv-shows/rentals', adminAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 30;

  const rows = db.prepare(`
    SELECT r.id, r.series_id, r.mac_address, r.rented_at, r.expires_at,
      COALESCE(p.title, f.title, 'TMDb TV #' || r.series_id) as title
    FROM tv_series_rentals r
    LEFT JOIN tv_series_pricing p ON p.tmdb_id = r.series_id
    LEFT JOIN tv_series_feed f ON f.tmdb_id = r.series_id
    ORDER BY r.rented_at DESC
  `).all();

  const filtered = q
    ? rows.filter((r) => r.mac_address.toLowerCase().includes(q) || r.title.toLowerCase().includes(q))
    : rows;
  const total = filtered.length;
  const start = (page - 1) * limit;
  const pageItems = filtered.slice(start, start + limit).map((r) => ({
    ...r,
    permanent: r.expires_at === PERMANENT_RENTAL_EXPIRY,
    active: r.expires_at === PERMANENT_RENTAL_EXPIRY || new Date(r.expires_at) > new Date(),
  }));

  res.json({ success: true, rentals: pageItems, total, page, limit });
});

router.post('/tv-shows/rentals/grant', adminAuth, (req, res) => {
  const mac = String(req.body?.mac || '').trim().toLowerCase();
  const tmdbId = parseInt(req.body?.tmdb_id, 10);
  const permanent = !!req.body?.permanent;
  const hours = Math.max(1, parseInt(req.body?.hours, 10) || 48);
  if (!mac || !tmdbId) return res.status(400).json({ success: false, message: 'A device MAC and a series are required.' });

  const series = tvCatalogService.getById(tmdbId);
  if (!series) return res.status(404).json({ success: false, message: 'That series is not in the catalog.' });

  const expiresAt = permanent ? PERMANENT_RENTAL_EXPIRY : new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO tv_series_rentals (series_id, mac_address, expires_at) VALUES (?, ?, ?)').run(series.id, mac, expiresAt);
  res.json({ success: true, expires_at: expiresAt });
});

router.delete('/tv-shows/rentals/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM tv_series_rentals WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// ── Requests (Movies > TV Shows > TV Requests panel) ────────────────────
// Same movie_requests table as Movies (media_type='tv'), same rate limit
// (server/routes/portal.js's POST /tv-requests). Status update/delete reuse
// the existing /movies/requests/:id/status and /movies/requests/:id routes
// verbatim (they operate on the shared table by id, media-type-agnostic).

router.post('/tv-shows/requests/:id/status', adminAuth, (req, res) => {
  const status = req.body?.status;
  if (!['pending', 'added', 'declined'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status.' });
  }
  db.prepare('UPDATE movie_requests SET status = ? WHERE id = ?').run(status, parseInt(req.params.id, 10));
  res.json({ success: true });
});

router.delete('/tv-shows/requests/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM movie_requests WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

router.post('/movies/:id', adminAuth, (req, res) => {
  try {
    const { title, tier, price_pesos } = req.body || {};
    const movie = movieService.getMovie(req.params.id);
    if (!movie) return res.status(404).json({ success: false, message: 'Movie not found' });
    if (tier && !['free', 'premium'].includes(tier)) {
      return res.status(400).json({ success: false, message: 'Invalid tier' });
    }
    db.prepare(`
      UPDATE movies SET title = COALESCE(?, title), tier = COALESCE(?, tier),
        price_pesos = COALESCE(?, price_pesos) WHERE id = ?
    `).run(title || null, tier || null, Number.isFinite(parseInt(price_pesos, 10)) ? parseInt(price_pesos, 10) : null, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Kicks off the one-time transcode for a movie (idempotent - a no-op if
// already ready or already in progress). Doesn't wait for it to finish;
// the admin/customer UI polls GET /movies for status.
router.post('/movies/:id/prepare', adminAuth, (req, res) => {
  try {
    movieService.ensureTranscoded(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/movies/:id', adminAuth, (req, res) => {
  try {
    movieService.deleteMovie(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// ── PC Rental ────────────────────────────────────────────────────────
// Device pairing (register/status) lives in server/routes/rental.js -
// these are the staff-facing management routes only.
function rentalStatusFor(pc) {
  const session = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(pc.id);
  const member = session?.member_id ? db.prepare('SELECT username, seconds FROM rental_members WHERE id = ?').get(session.member_id) : null;
  // A logged-in member's remaining time is their own live balance (read-
  // only here - the actual decrement only happens in GET /api/rental/
  // status, the device's own poll, so this admin view never double-drains
  // it). A guest-credited PC still uses the fixed hard_expires_at.
  const remainingMinutes = member
    ? Math.max(0, member.seconds / 60)
    : Math.max(0, (session?.hard_expires_at ? new Date(session.hard_expires_at).getTime() - Date.now() : 0) / 60000);
  const todaySales = db.prepare(`
    SELECT COALESCE(SUM(coin_value), 0) AS total FROM rental_transactions
    WHERE pc_id = ? AND type = 'coin' AND datetime(created_at, 'localtime') >= datetime('now', 'localtime', 'start of day')
  `).get(pc.id).total;
  return {
    ...pc,
    minutes_remaining: Math.round(remainingMinutes * 10) / 10,
    is_paused: session ? !!session.is_paused : false,
    locked: !(pc.status === 'adopted' && !(session?.is_paused) && remainingMinutes > 0),
    today_sales: todaySales,
    last_insert: session?.updated_at || null,
    logged_in_user: member ? member.username : 'GUEST'
  };
}

router.get('/rental/pcs', adminAuth, (req, res) => {
  try {
    const pcs = db.prepare('SELECT * FROM rental_pcs ORDER BY created_at DESC').all().map(rentalStatusFor);
    res.json({ success: true, pcs });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/rental/pcs/:id/adopt', adminAuth, (req, res) => {
  try {
    db.prepare("UPDATE rental_pcs SET status = 'adopted' WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/rental/pcs/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM rental_sessions WHERE pc_id = ?').run(req.params.id);
    db.prepare('DELETE FROM rental_transactions WHERE pc_id = ?').run(req.params.id);
    db.prepare('DELETE FROM rental_pcs WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/rental/pcs/:id/addtime - staff-triggered direct credit
// (payment method: manual, no coin box), same math as the existing
// POST /session/:code/addtime.
router.post('/rental/pcs/:id/addtime', adminAuth, (req, res) => {
  try {
    const minutes = parseFloat(req.body?.minutes);
    if (!Number.isFinite(minutes) || minutes === 0) {
      return res.status(400).json({ success: false, message: 'Minutes must be a non-zero number' });
    }
    const pcId = req.params.id;
    const pc = db.prepare('SELECT * FROM rental_pcs WHERE id = ?').get(pcId);
    if (!pc) return res.status(404).json({ success: false, message: 'PC not found' });

    let session = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(pcId);
    if (!session) {
      db.prepare('INSERT INTO rental_sessions (pc_id, minutes_remaining) VALUES (?, 0)').run(pcId);
      session = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(pcId);
    }

    const currentRemainingMs = session.hard_expires_at ? Math.max(0, new Date(session.hard_expires_at).getTime() - Date.now()) : 0;
    const newExpiresAt = new Date(Date.now() + currentRemainingMs + minutes * 60000).toISOString();

    db.prepare('UPDATE rental_sessions SET minutes_remaining = ?, expires_at = ?, hard_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE pc_id = ?')
      .run(minutes, newExpiresAt, newExpiresAt, pcId);
    db.prepare("INSERT INTO rental_transactions (pc_id, coin_value, minutes_added, type) VALUES (?, 0, ?, 'admin_credit')")
      .run(pcId, minutes);

    console.log(`➕ Admin added ${minutes} mins to rental PC "${pc.name}"`);
    res.json({ success: true });
  } catch (err) {
    console.error('Rental addtime error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/rental/pcs/:id/lock', adminAuth, (req, res) => {
  try {
    db.prepare('UPDATE rental_sessions SET is_paused = 1 WHERE pc_id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/rental/pcs/:id/unlock', adminAuth, (req, res) => {
  try {
    db.prepare('UPDATE rental_sessions SET is_paused = 0 WHERE pc_id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/rental/rates', adminAuth, (req, res) => {
  try {
    const rates = db.prepare('SELECT * FROM rental_rates ORDER BY coin_value ASC').all();
    res.json({ success: true, rates });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/rental/rates', adminAuth, (req, res) => {
  try {
    const coinValue = parseInt(req.body?.coin_value, 10);
    const minutes = parseFloat(req.body?.minutes);
    const points = parseInt(req.body?.points, 10) || 0;
    if (!Number.isFinite(coinValue) || coinValue <= 0) {
      return res.status(400).json({ success: false, message: 'coin_value must be a positive number' });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ success: false, message: 'minutes must be a positive number' });
    }
    // tier column stays in the schema but is no longer set/shown - the
    // VIP/VVIP/NON-VIP split was simplified away in favor of a plain
    // guest-vs-member model, see rental_members.seconds.
    db.prepare('INSERT INTO rental_rates (coin_value, minutes, points) VALUES (?, ?, ?)').run(coinValue, minutes, points);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/rental/rates/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM rental_rates WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PC Rental: Members (login accounts, separate from anonymous guest
// PCs) ───────────────────────────────────────────────────────────────
router.get('/rental/members', adminAuth, (req, res) => {
  try {
    const members = db.prepare('SELECT id, username, name, seconds, credit_pesos, points, created_at, last_active FROM rental_members ORDER BY created_at DESC').all();
    res.json({ success: true, members });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/rental/members', adminAuth, (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    db.prepare('INSERT INTO rental_members (username, password_hash, name) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), name || username);
    res.json({ success: true });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ success: false, message: 'Username already taken' });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/rental/members/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM rental_members WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/rental/members/:id/manage-time - staff directly
// adjusts a member's time balance, credit, or points, same "manual
// override" role as rental_pcs' own addtime route.
router.post('/rental/members/:id/manage-time', adminAuth, (req, res) => {
  try {
    const field = req.body?.field;
    const validFields = ['seconds', 'credit_pesos', 'points'];
    if (!validFields.includes(field)) {
      return res.status(400).json({ success: false, message: 'Invalid field' });
    }
    const delta = parseInt(req.body?.delta, 10);
    if (!Number.isFinite(delta)) {
      return res.status(400).json({ success: false, message: 'delta must be a number' });
    }
    db.prepare(`UPDATE rental_members SET ${field} = MAX(0, ${field} + ?) WHERE id = ?`).run(delta, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PC Rental: Redeem Rates + History (points economy) ─────────────────
router.get('/rental/redeem-rates', adminAuth, (req, res) => {
  try {
    const rates = db.prepare('SELECT * FROM rental_redeem_rates ORDER BY points ASC').all();
    res.json({ success: true, rates });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/rental/redeem-rates', adminAuth, (req, res) => {
  try {
    const points = parseInt(req.body?.points, 10);
    const rewardSeconds = parseInt(req.body?.reward_seconds, 10);
    if (!Number.isFinite(points) || points <= 0) {
      return res.status(400).json({ success: false, message: 'points must be a positive number' });
    }
    if (!Number.isFinite(rewardSeconds) || rewardSeconds <= 0) {
      return res.status(400).json({ success: false, message: 'reward_seconds must be a positive number' });
    }
    db.prepare('INSERT INTO rental_redeem_rates (points, reward_seconds) VALUES (?, ?)').run(points, rewardSeconds);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/rental/redeem-rates/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM rental_redeem_rates WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/rental/redemptions', adminAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT r.id, r.points_spent, r.reward_seconds, r.remaining_points, r.redeemed_at, m.username
      FROM rental_redemptions r JOIN rental_members m ON m.id = r.member_id
      ORDER BY r.redeemed_at DESC LIMIT 200
    `).all();
    res.json({ success: true, redemptions: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/rental/members/:id/redeem - staff-triggered redemption
// (member self-service redemption from the Windows client isn't built
// yet, so this is the only way to redeem for now). Adds the reward
// seconds straight to the member's one time balance.
router.post('/rental/members/:id/redeem', adminAuth, (req, res) => {
  try {
    const redeemRateId = parseInt(req.body?.redeem_rate_id, 10);
    const rate = db.prepare('SELECT * FROM rental_redeem_rates WHERE id = ?').get(redeemRateId);
    if (!rate) return res.status(404).json({ success: false, message: 'Redeem rate not found' });

    const member = db.prepare('SELECT * FROM rental_members WHERE id = ?').get(req.params.id);
    if (!member) return res.status(404).json({ success: false, message: 'Member not found' });
    if (member.points < rate.points) {
      return res.status(400).json({ success: false, message: 'Not enough points' });
    }

    const remainingPoints = member.points - rate.points;
    db.prepare('UPDATE rental_members SET points = ?, seconds = seconds + ? WHERE id = ?')
      .run(remainingPoints, rate.reward_seconds, member.id);
    db.prepare('INSERT INTO rental_redemptions (member_id, points_spent, reward_seconds, remaining_points) VALUES (?, ?, ?, ?)')
      .run(member.id, rate.points, rate.reward_seconds, remainingPoints);

    res.json({ success: true, remaining_points: remainingPoints });
  } catch (err) {
    console.error('Rental redeem error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/rental/reports/summary - the Dashboard's stat cards and
// the Reports tab's revenue cards, both real sums over rental_transactions
// (coin_value only, so admin_credit rows don't inflate "sales").
router.get('/rental/reports/summary', adminAuth, (req, res) => {
  try {
    const sumSince = (sqliteModifier) => db.prepare(`
      SELECT COALESCE(SUM(coin_value), 0) AS total FROM rental_transactions
      WHERE type = 'coin' AND created_at >= datetime('now', ?)
    `).get(sqliteModifier).total;
    // 'start of day' is a real calendar-day boundary (needs both sides in
    // the server's local timezone, same bug/fix as the WiFi Dashboard's
    // Today's Revenue) - the others are rolling elapsed-time windows,
    // correct as-is regardless of timezone.
    const todaySince = db.prepare(`
      SELECT COALESCE(SUM(coin_value), 0) AS total FROM rental_transactions
      WHERE type = 'coin' AND datetime(created_at, 'localtime') >= datetime('now', 'localtime', 'start of day')
    `).get().total;

    res.json({
      success: true,
      today: todaySince,
      weekly: sumSince('-7 days'),
      monthly: sumSince('-30 days'),
      yearly: sumSince('-365 days')
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PC Rental Settings: app password, whitelisted apps, wallpapers ─────
// A separate override password (same "fail-safe" role zencafe-os's own
// design notes called for), never sent/stored in plaintext - exact same
// set/verify pattern as terminal_password above, deliberately NOT part
// of the generic bulk /api/admin/settings save so it can't accidentally
// round-trip in plaintext through that form.
router.post('/rental/app-password', adminAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
  }
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'rental_app_password'").get()?.value;
  if (existing && !verifyPassword(current_password, existing)) {
    return res.status(401).json({ success: false, message: 'Current app password is incorrect' });
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rental_app_password', ?)")
    .run(hashPassword(String(new_password)));
  res.json({ success: true, message: 'App password updated' });
});

router.get('/rental/whitelisted-apps', adminAuth, (req, res) => {
  try {
    const apps = db.prepare('SELECT * FROM rental_whitelisted_apps ORDER BY app_name ASC').all();
    res.json({ success: true, apps });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/rental/whitelisted-apps', adminAuth, (req, res) => {
  try {
    const appName = String(req.body?.app_name || '').trim();
    if (!appName) return res.status(400).json({ success: false, message: 'app_name required' });
    db.prepare('INSERT INTO rental_whitelisted_apps (app_name) VALUES (?)').run(appName);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/rental/whitelisted-apps/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM rental_whitelisted_apps WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PC Rental: Café Home game/app catalog (V1.0.0 blueprint) ──────────
// Metadata only - no icon/banner columns, see database.js's comment on
// rental_apps for why (artwork stays local to each PC).
router.get('/rental/categories', adminAuth, (req, res) => {
  try {
    const categories = db.prepare('SELECT * FROM rental_categories ORDER BY display_order ASC, name ASC').all();
    res.json({ success: true, categories });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/rental/categories', adminAuth, (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const displayOrder = parseInt(req.body?.display_order, 10) || 0;
    if (!name) return res.status(400).json({ success: false, message: 'name required' });
    db.prepare('INSERT INTO rental_categories (name, display_order) VALUES (?, ?)').run(name, displayOrder);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/rental/categories/:id', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM rental_categories WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Category not found' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
    const displayOrder = req.body?.display_order !== undefined ? parseInt(req.body.display_order, 10) || 0 : existing.display_order;
    const enabled = req.body?.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled;
    if (!name) return res.status(400).json({ success: false, message: 'name required' });
    db.prepare('UPDATE rental_categories SET name = ?, display_order = ?, enabled = ? WHERE id = ?')
      .run(name, displayOrder, enabled, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/rental/categories/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM rental_categories WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/rental/apps', adminAuth, (req, res) => {
  try {
    const apps = db.prepare('SELECT * FROM rental_apps ORDER BY display_order ASC, name ASC').all();
    res.json({ success: true, apps });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/rental/apps', adminAuth, (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const executablePath = String(req.body?.executable_path || '').trim();
    const categoryId = req.body?.category_id ? parseInt(req.body.category_id, 10) : null;
    const type = req.body?.type === 'app' ? 'app' : 'game';
    const description = String(req.body?.description || '').trim();
    const featured = req.body?.featured ? 1 : 0;
    const displayOrder = parseInt(req.body?.display_order, 10) || 0;
    if (!name) return res.status(400).json({ success: false, message: 'name required' });
    if (!executablePath) return res.status(400).json({ success: false, message: 'executable_path required' });
    db.prepare(`
      INSERT INTO rental_apps (name, category_id, type, executable_path, description, featured, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, categoryId, type, executablePath, description, featured, displayOrder);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/rental/apps/:id', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM rental_apps WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'App not found' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
    const executablePath = req.body?.executable_path !== undefined ? String(req.body.executable_path).trim() : existing.executable_path;
    const categoryId = req.body?.category_id !== undefined
      ? (req.body.category_id ? parseInt(req.body.category_id, 10) : null)
      : existing.category_id;
    const type = req.body?.type !== undefined ? (req.body.type === 'app' ? 'app' : 'game') : existing.type;
    const description = req.body?.description !== undefined ? String(req.body.description).trim() : existing.description;
    const featured = req.body?.featured !== undefined ? (req.body.featured ? 1 : 0) : existing.featured;
    const enabled = req.body?.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled;
    const displayOrder = req.body?.display_order !== undefined ? parseInt(req.body.display_order, 10) || 0 : existing.display_order;
    if (!name) return res.status(400).json({ success: false, message: 'name required' });
    if (!executablePath) return res.status(400).json({ success: false, message: 'executable_path required' });
    db.prepare(`
      UPDATE rental_apps SET name = ?, category_id = ?, type = ?, executable_path = ?,
        description = ?, featured = ?, enabled = ?, display_order = ? WHERE id = ?
    `).run(name, categoryId, type, executablePath, description, featured, enabled, displayOrder, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/rental/apps/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM rental_apps WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/rental/wallpapers', adminAuth, (req, res) => {
  try {
    const wallpapers = db.prepare('SELECT * FROM rental_wallpapers ORDER BY created_at DESC').all();
    res.json({ success: true, wallpapers });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/rental/wallpapers/:id/activate', adminAuth, (req, res) => {
  try {
    db.prepare('UPDATE rental_wallpapers SET active = 0').run();
    db.prepare('UPDATE rental_wallpapers SET active = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/rental/wallpapers/:id', adminAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT image_path FROM rental_wallpapers WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM rental_wallpapers WHERE id = ?').run(req.params.id);
    if (row) {
      const filePath = path.join(__dirname, '../../public', row.image_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/alerts, merges two sources, both real:
//  - live-recomputed checks (watchdog self-heal, WAN health score, disk
//    space) - same as before, nothing here is persisted per-alert
//  - the persisted alert_events log (server/services/alertEventService.js),
//    which is where individual occurrences/transitions (a coin credited, a
//    device connecting, a watchdog issue's edge) actually get a stable id
//    and back the notification bell's history.
// No alert here is synthetic - each one traces to a real check or a real
// event that already happened.
router.get('/alerts', adminAuth, async (req, res) => {
  try {
    const alerts = [];

    try {
      const { getRecentAlertEvents } = require('../services/alertEventService');
      getRecentAlertEvents(30).forEach((e) => {
        alerts.push({
          id: `event-${e.id}`,
          severity: e.severity,
          code: e.code,
          title: e.title,
          detail: e.detail || '',
          // SQLite's CURRENT_TIMESTAMP has no timezone marker (stored as
          // UTC but looks local) - without forcing it, the client's
          // `new Date(...)` parses it as local time, throwing off both
          // the displayed time and the "unseen since last visit" check
          // by the browser's UTC offset (silently wrong for any operator
          // outside UTC, which is this app's whole actual market).
          time: e.created_at.replace(' ', 'T') + 'Z',
        });
      });
    } catch (e) {}

    const recentWatchdog = db.prepare(
      "SELECT status, issues_json, checked_at FROM watchdog_events WHERE status != 'ok' ORDER BY checked_at DESC LIMIT 5"
    ).all();
    recentWatchdog.forEach((r) => {
      let issues = [];
      try { issues = JSON.parse(r.issues_json); } catch (e) {}
      // Bug found live: issues are structured {severity, code, message}
      // objects (watchdogService.js), not plain strings - naively
      // .join()-ing rendered "[object Object]". Also now surfaces the
      // real per-issue severity instead of hardcoding 'warning' for
      // every watchdog alert, even critical ones.
      const hasCritical = issues.some((i) => i.severity === 'critical');
      alerts.push({
        severity: hasCritical ? 'critical' : 'warning',
        title: 'Self-heal check found an issue',
        detail: issues.map((i) => i.message || i).join(', ') || 'See Logs for details.',
        time: r.checked_at.replace(' ', 'T') + 'Z',
      });
    });

    try {
      const { checkWanHealth } = require('../services/wanHealthService');
      const health = await checkWanHealth();
      if (health.score < 80) {
        alerts.push({
          severity: health.score < 40 ? 'critical' : 'warning',
          title: 'WAN health degraded',
          detail: (health.reasons || []).join(', ') || `Health score ${health.score}/100`,
          time: health.measured_at,
        });
      }
    } catch (e) {}

    try {
      const { getDiskSpace } = require('../services/systemDiagnosticsService');
      const disk = getDiskSpace();
      if (disk && disk.checked && disk.usePercent != null && disk.usePercent >= 90) {
        alerts.push({
          severity: disk.usePercent >= 97 ? 'critical' : 'warning',
          title: 'Disk space running low',
          detail: `${disk.usePercent}% used, ${disk.availMb} MB free`,
          time: new Date().toISOString(),
        });
      }
    } catch (e) {}

    alerts.sort((a, b) => new Date(b.time) - new Date(a.time));
    return res.json({ success: true, alerts });
  } catch (err) {
    console.error('Alerts error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== STANDALONE PORTS AND ROLES + PROVISIONING
// (STANDALONE_ARCHITECTURE_PLAN.md - VLAN-based multi-lane engine) =====
// Reuses router_ports the same way router/MikroTik mode does, but scoped
// strictly to interfaces that actually exist on THIS box - a MikroTik's
// own saved port names (ether1, ether2...) never match a real local
// interface, so switching modes can never let one mode's saved lanes leak
// into the other's save/delete logic.

function getLocalPhysicalInterfaces() {
  if (!fs.existsSync('/sys/class/net')) return [];
  return fs.readdirSync('/sys/class/net').filter((n) =>
    /^(eth|enp|ens|enx|wlan|wlx|wlp)/.test(n) && !n.includes('.')
  );
}

router.get('/network/standalone/ports', adminAuth, (req, res) => {
  try {
    const localNames = getLocalPhysicalInterfaces();
    const physical_ports = localNames.map((name) => {
      let operstate = 'unknown';
      try { operstate = fs.readFileSync(`/sys/class/net/${name}/operstate`, 'utf8').trim(); } catch (e) {}
      let mac = '';
      try { mac = fs.readFileSync(`/sys/class/net/${name}/address`, 'utf8').trim(); } catch (e) {}
      return { name, status: operstate, mac };
    });

    const allLanes = localNames.length
      ? db.prepare(`SELECT * FROM router_ports WHERE port_name IN (${localNames.map(() => '?').join(',')}) ORDER BY port_name, vlan_id`).all(...localNames)
      : [];
    const lanes = allLanes.map((l) => ({
      id: l.id,
      port_name: l.port_name,
      vlan_id: l.vlan_id || 0,
      role: l.role,
      lane_name: l.lane_name,
      speed_mbps: l.speed_mbps,
      burst_mbps: l.burst_mbps,
      isolate_clients: !!l.isolate_clients,
      // Lane-to-lane firewall isolation (distinct from isolate_clients'
      // AP/bridge-level client-to-client isolation) - see the column
      // comment in database.js and setup-network.sh's NFT_ISOLATION_RULES.
      // Standalone-mode only for now - MikroTik mode has no equivalent
      // enforcement yet.
      isolate_from_other_lanes: l.isolate_from_other_lanes === null || l.isolate_from_other_lanes === undefined ? true : !!l.isolate_from_other_lanes,
      bridge_with_id: l.bridge_with_id,
    }));

    const planSetting = db.prepare("SELECT value FROM settings WHERE key = 'isp_plan_mbps'").get();
    const guaranteedTotal = lanes.reduce((sum, l) => sum + (l.role !== 'unused' && l.role !== 'wan' && !l.bridge_with_id ? (l.speed_mbps || 0) : 0), 0);
    const hardware = require('../services/hardwareDetection').detect();

    return res.json({
      success: true,
      physical_ports,
      lanes,
      isp_plan_mbps: planSetting ? parseInt(planSetting.value, 10) || 0 : 0,
      guaranteed_total_mbps: guaranteedTotal,
      max_vlan_lanes: hardware.features.maxVlanLanes,
    });
  } catch (err) {
    console.error('Standalone ports list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/network/standalone/ports, same shape/validation as
// POST /router/ports, but stale-row deletion is scoped to this box's own
// real interfaces only, so saving Standalone lanes can never wipe out
// router-mode lane definitions saved for a MikroTik, or vice versa.
router.post('/network/standalone/ports', adminAuth, (req, res) => {
  try {
    const { lanes } = req.body;
    if (!Array.isArray(lanes)) {
      return res.status(400).json({ success: false, message: 'lanes array required' });
    }

    // A second 'wan'-role lane is what actually activates multi-WAN
    // failover (see the comment on GET /network/multi-wan) - gate it
    // there rather than adding a separate endpoint, so an unentitled
    // install saving its port layout is blocked from ever getting a
    // second WAN lane in the first place, not just from viewing status.
    //
    // Bug caught before commit: this only compared against the request,
    // not the currently-saved state, so an install that already has 2 WAN
    // lanes (e.g. downgraded from Pro) would be hard-blocked from saving
    // ANY port change at all - saveLanePorts() on the frontend always
    // resubmits the full lane list, so even renaming an unrelated gated
    // lane would 403. Only block when the request would INCREASE the WAN
    // lane count beyond what's already saved, matching the same
    // "allow staying put, block switching in" shape as the router_mode
    // gate right above this file's /settings handler.
    //
    // Second bug caught in a later review pass: router_ports is one
    // shared table for BOTH standalone and MikroTik/Controller-mode lanes
    // (no mode column), and this endpoint's own stale-row cleanup further
    // down is deliberately scoped to only this box's real local
    // interfaces so it never touches MikroTik lane rows. That means a
    // leftover MikroTik 'wan' row (e.g. from before a mode switch) was
    // silently counting toward currentWanCount here, letting it either
    // over-block a legitimate single-WAN save or, worse, undercount-block
    // and let a genuine new second Standalone WAN lane slip through once
    // enough foreign rows had accumulated.
    //
    // Scoped the "currently saved" count to port names present in THIS
    // submitted request rather than re-detecting local interfaces via
    // /sys/class/net - saveLanePorts() on the frontend always resubmits
    // every lane this mode currently manages (see the comment above), so
    // the request's own port_name set already IS "this mode's lane
    // universe", with no dependency on sysfs/platform quirks (caught this
    // dev machine has no /sys/class/net at all, which made an earlier
    // version of this fix force currentWanCount to 0 and wrongly re-block
    // a same-lanes resave - exactly the regression the original fix
    // commit existed to prevent).
    const { canUse } = require('../services/entitlementService');
    const requestedWanCount = lanes.filter((l) => l.role === 'wan').length;
    if (requestedWanCount > 1 && !canUse('multi_wan')) {
      const submittedNames = [...new Set(lanes.map((l) => l.port_name).filter(Boolean))];
      const currentWanCount = submittedNames.length
        ? db.prepare(`SELECT COUNT(*) as c FROM router_ports WHERE role = 'wan' AND port_name IN (${submittedNames.map(() => '?').join(',')})`).get(...submittedNames).c
        : 0;
      if (requestedWanCount > currentWanCount) {
        return res.status(403).json({ success: false, message: 'Multi-WAN failover (a second WAN lane) is a Pro feature. Upgrade to add a backup connection.' });
      }
    }

    const localNames = getLocalPhysicalInterfaces();
    const validRoles = ['wan', 'gated', 'open', 'unused'];
    const keyOf = (l) => `${l.port_name}::${parseInt(l.vlan_id, 10) || 0}`;
    const byKey = new Map(lanes.map((l) => [keyOf(l), l]));

    for (const l of lanes) {
      if (!l.port_name || !localNames.includes(l.port_name) || !validRoles.includes(l.role)) {
        return res.status(400).json({ success: false, message: `Invalid lane entry: ${JSON.stringify(l)}` });
      }
      if (l.bridge_with_port) {
        const targetKey = `${l.bridge_with_port}::${parseInt(l.bridge_with_vlan, 10) || 0}`;
        if (targetKey === keyOf(l)) {
          return res.status(400).json({ success: false, message: `${l.port_name} (VLAN ${l.vlan_id || 'none'}) can't join its own lane` });
        }
        const target = byKey.get(targetKey);
        if (!target) {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port}: that lane isn't in this request` });
        }
        if (target.role === 'wan' || target.role === 'unused') {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port}: that lane has no role (${target.role})` });
        }
        if (target.bridge_with_port) {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port}: that lane is itself joined to another one. Join the other lane's primary instead.` });
        }
      }
    }

    const hardware = require('../services/hardwareDetection').detect();
    const activeLaneCount = lanes.filter((l) => (l.role === 'gated' || l.role === 'open') && !l.bridge_with_port).length;
    if (activeLaneCount > hardware.features.maxVlanLanes) {
      return res.status(400).json({ success: false, message: `This hardware tier (${hardware.tier}) supports up to ${hardware.features.maxVlanLanes} lanes, ${activeLaneCount} were submitted` });
    }

    // Stale-row deletion scoped to real local interfaces only (see comment
    // above) - a router-mode lane saved for e.g. "ether1" never matches any
    // of these names, so it's never touched by this delete.
    const deleteStale = db.prepare(`
      DELETE FROM router_ports WHERE port_name IN (${localNames.map(() => '?').join(',') || "''"})
      AND (port_name || '::' || vlan_id) NOT IN (${lanes.map(() => '?').join(',') || "''"})
    `);
    if (localNames.length > 0) {
      deleteStale.run(...localNames, ...lanes.map((l) => keyOf(l)));
    }

    const upsert = db.prepare(`
      INSERT INTO router_ports (port_name, vlan_id, role, lane_name, speed_mbps, burst_mbps, isolate_clients, isolate_from_other_lanes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(port_name, vlan_id) DO UPDATE SET
        role = excluded.role,
        lane_name = excluded.lane_name,
        speed_mbps = excluded.speed_mbps,
        burst_mbps = excluded.burst_mbps,
        isolate_clients = excluded.isolate_clients,
        isolate_from_other_lanes = excluded.isolate_from_other_lanes,
        updated_at = CURRENT_TIMESTAMP
    `);
    for (const l of lanes) {
      upsert.run(
        l.port_name,
        parseInt(l.vlan_id, 10) || 0,
        l.role,
        String(l.lane_name || ''),
        parseInt(l.speed_mbps, 10) || 0,
        parseInt(l.burst_mbps, 10) || 0,
        l.isolate_clients === false ? 0 : 1,
        l.isolate_from_other_lanes === false ? 0 : 1
      );
    }
    const findId = db.prepare('SELECT id FROM router_ports WHERE port_name = ? AND vlan_id = ?');
    const setBridge = db.prepare('UPDATE router_ports SET bridge_with_id = ? WHERE port_name = ? AND vlan_id = ?');
    for (const l of lanes) {
      const vlanId = parseInt(l.vlan_id, 10) || 0;
      if (l.bridge_with_port) {
        const target = findId.get(l.bridge_with_port, parseInt(l.bridge_with_vlan, 10) || 0);
        setBridge.run(target ? target.id : null, l.port_name, vlanId);
      } else {
        setBridge.run(null, l.port_name, vlanId);
      }
    }

    return res.json({ success: true, message: 'Port roles saved' });
  } catch (err) {
    console.error('Standalone ports save error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/network/standalone/provision/preview, mirrors, in Node,
// the same lane-numbering rule setup-network.sh itself uses (head lanes in
// id order, octet = 50 + position) purely for display. setup-network.sh
// remains the actual source of truth; this never touches the network.
router.get('/network/standalone/provision/preview', adminAuth, (req, res) => {
  try {
    const localNames = getLocalPhysicalInterfaces();
    const heads = localNames.length
      ? db.prepare(`
          SELECT * FROM router_ports
          WHERE role IN ('gated','open') AND bridge_with_id IS NULL AND port_name IN (${localNames.map(() => '?').join(',')})
          ORDER BY id
        `).all(...localNames)
      : [];
    const steps = [];
    heads.forEach((h, idx) => {
      const octet = 50 + idx + 1;
      const iface = h.vlan_id ? `${h.port_name}.${h.vlan_id}` : h.port_name;
      const members = db.prepare('SELECT port_name, vlan_id FROM router_ports WHERE bridge_with_id = ?').all(h.id);
      const laneIf = members.length ? `br-lane${h.id}` : iface;
      steps.push(`Lane "${h.lane_name || iface}" (${h.role}): ${laneIf} → 10.${octet}.0.1/24, ${h.speed_mbps || 100}mbit${members.length ? `, bridged with ${members.map((m) => m.vlan_id ? `${m.port_name}.${m.vlan_id}` : m.port_name).join(', ')}` : ''}`);
    });
    const warnings = [];
    if (heads.length === 0) {
      steps.push('No gated/open lanes configured yet, the legacy single-lane 10.0.0.0/24 setup will be used, unchanged.');
    } else {
      // Any device with a manually-saved server address (the clearest
      // example: an ESP32 coin-slot vendo, configured once through its own
      // setup portal) has no way to learn its gateway changed - it just
      // silently stops reaching this server. Surfaced here, right before
      // Apply, since that's the one moment an admin can still act on it
      // before a live device goes dark with no obvious cause.
      warnings.push('Any device with a manually-saved server address (e.g. an ESP32 coin-slot vendo) needs its saved address updated to match its lane\'s new gateway shown below - it has no way to detect this change on its own.');
    }
    res.json({ success: true, steps, warnings, lane_count: heads.length });
  } catch (err) {
    console.error('Standalone provision preview error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/network/standalone/provision/apply, the actual
// "Configure" action. Previously ran setup-network.sh directly with no
// safety net (idempotent re-runs were the only protection, which doesn't
// help if the NEW desired state itself is dangerous - e.g. removing the
// only WAN role). Now goes through configSafety.js: risk check ->
// require confirmation on a management-path-risky change -> apply ->
// verify connectivity -> automatic rollback to the last known-good
// configuration if verification fails.
router.post('/network/standalone/provision/apply', adminAuth, async (req, res) => {
  try {
    const { confirmed, reason } = req.body || {};
    const { applyNetworkChangeTransaction } = require('../services/configSafety');
    const result = await applyNetworkChangeTransaction({
      operator: 'admin',
      reason: reason || '',
      riskConfirmed: !!confirmed,
    });

    if (result.requiresConfirmation) {
      return res.status(409).json({
        success: false,
        requiresConfirmation: true,
        reasons: result.reasons,
        message: 'This change affects the box\'s own network reachability. Review and confirm to proceed.',
      });
    }

    if (!result.success) {
      console.error('Standalone provision apply failed:', result.message);
      return res.status(500).json({ success: false, message: result.message, rolledBack: result.rolledBack });
    }

    console.log('⚡ Standalone lane engine provisioned (verified reachable)');
    res.json({ success: true, message: 'Configuration applied and verified' });
  } catch (err) {
    console.error('Standalone provision apply error:', err);
    res.status(500).json({ success: false, message: 'Provisioning failed: ' + err.message });
  }
});

// ===== ROUTER MODE (MikroTik), ROUTER_MODE_PLAN.md Stage 3 =====

// GET /api/admin/router/ports, live-scans the router's actual physical
// ports (no hardcoded model list) and returns every saved lane definition
// alongside them. A physical port can carry more than one lane (an
// untagged one plus any number of VLAN-tagged ones sharing the same
// wire), so this returns two separate lists rather than merging them into
// one row per port the way earlier versions did.
router.get('/router/ports', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    const livePorts = await mikrotikService.getRouterPorts();
    const physical_ports = livePorts.map((p) => ({
      name: p.name, mac: p.mac, running: p.running, disabled: p.disabled,
    }));

    const lanes = db.prepare('SELECT * FROM router_ports ORDER BY port_name, vlan_id').all().map((l) => ({
      id: l.id,
      port_name: l.port_name,
      vlan_id: l.vlan_id || 0,
      role: l.role,
      lane_name: l.lane_name,
      speed_mbps: l.speed_mbps,
      burst_mbps: l.burst_mbps,
      isolate_clients: !!l.isolate_clients,
      bridge_with_id: l.bridge_with_id,
    }));

    const planSetting = db.prepare("SELECT value FROM settings WHERE key = 'isp_plan_mbps'").get();
    // A lane joined to another one (bridge_with_id set) doesn't carry its
    // own speed - it inherits the primary's - so it must not be counted
    // a second time here.
    const guaranteedTotal = lanes.reduce((sum, l) => sum + (l.role !== 'unused' && l.role !== 'wan' && !l.bridge_with_id ? (l.speed_mbps || 0) : 0), 0);

    return res.json({
      success: true,
      physical_ports,
      lanes,
      isp_plan_mbps: planSetting ? parseInt(planSetting.value, 10) || 0 : 0,
      guaranteed_total_mbps: guaranteedTotal,
    });
  } catch (err) {
    console.error('Router ports scan error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to reach router' });
  }
});

// POST /api/admin/router/ports, replaces the full set of saved lane
// definitions with exactly what's submitted (so removing a lane in the UI
// actually removes it here too, not just orphans it).
// Body: { lanes: [{ port_name, vlan_id, role, lane_name, speed_mbps,
// burst_mbps, isolate_clients, bridge_with_port, bridge_with_vlan }, ...] }
// bridge_with_port/vlan identifies another lane in the SAME request this
// one joins (e.g. a VLAN-tagged lane on one port joining an untagged lane
// on a different port) - kept flat on purpose, a lane can join a primary,
// but a primary that's itself joining something else isn't allowed, so
// there's never a chain to resolve.
router.post('/router/ports', adminAuth, (req, res) => {
  try {
    const { lanes } = req.body;
    if (!Array.isArray(lanes)) {
      return res.status(400).json({ success: false, message: 'lanes array required' });
    }

    // Same multi-WAN entitlement gate as POST /network/standalone/ports
    // (that endpoint's own comment explains why) - this MikroTik/
    // Controller-mode twin was missing it entirely, a real tier bypass:
    // a Free/Grow install in router (MikroTik) mode could submit two
    // 'wan'-role lanes here and get real multi-WAN failover for free,
    // since the standalone endpoint's check never runs for this path.
    // Scoped to this request's own submitted port names (not a
    // /sys/class/net lookup - see the standalone endpoint's comment for
    // why that was unreliable), matching the symmetric fix there.
    {
      const { canUse } = require('../services/entitlementService');
      const requestedWanCount = lanes.filter((l) => l.role === 'wan').length;
      if (requestedWanCount > 1 && !canUse('multi_wan')) {
        const submittedNames = [...new Set(lanes.map((l) => l.port_name).filter(Boolean))];
        const currentWanCount = submittedNames.length
          ? db.prepare(`SELECT COUNT(*) as c FROM router_ports WHERE role = 'wan' AND port_name IN (${submittedNames.map(() => '?').join(',')})`).get(...submittedNames).c
          : 0;
        if (requestedWanCount > currentWanCount) {
          return res.status(403).json({ success: false, message: 'Multi-WAN failover (a second WAN lane) is a Pro feature. Upgrade to add a backup connection.' });
        }
      }
    }

    const validRoles = ['wan', 'gated', 'open', 'unused'];
    const keyOf = (l) => `${l.port_name}::${parseInt(l.vlan_id, 10) || 0}`;
    const byKey = new Map(lanes.map((l) => [keyOf(l), l]));

    for (const l of lanes) {
      if (!l.port_name || !validRoles.includes(l.role)) {
        return res.status(400).json({ success: false, message: `Invalid lane entry: ${JSON.stringify(l)}` });
      }
      if (l.bridge_with_port) {
        const targetKey = `${l.bridge_with_port}::${parseInt(l.bridge_with_vlan, 10) || 0}`;
        if (targetKey === keyOf(l)) {
          return res.status(400).json({ success: false, message: `${l.port_name} (VLAN ${l.vlan_id || 'none'}) can't join its own lane` });
        }
        const target = byKey.get(targetKey);
        if (!target) {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port} (VLAN ${l.bridge_with_vlan || 'none'}): that lane isn't in this request` });
        }
        if (target.role === 'wan' || target.role === 'unused') {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port}: that lane has no role (${target.role})` });
        }
        if (target.bridge_with_port) {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port}: that lane is itself joined to another one. Join the other lane's primary instead.` });
        }
      }
    }

    const submittedKeys = lanes.map((l) => keyOf(l));
    const deleteStale = db.prepare(`DELETE FROM router_ports WHERE (port_name || '::' || vlan_id) NOT IN (${submittedKeys.map(() => '?').join(',') || "''"})`);
    if (submittedKeys.length > 0) deleteStale.run(...submittedKeys);
    else db.prepare('DELETE FROM router_ports').run();

    const upsert = db.prepare(`
      INSERT INTO router_ports (port_name, vlan_id, role, lane_name, speed_mbps, burst_mbps, isolate_clients, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(port_name, vlan_id) DO UPDATE SET
        role = excluded.role,
        lane_name = excluded.lane_name,
        speed_mbps = excluded.speed_mbps,
        burst_mbps = excluded.burst_mbps,
        isolate_clients = excluded.isolate_clients,
        updated_at = CURRENT_TIMESTAMP
    `);
    // First pass: every lane exists as a real row before any bridge_with_id
    // can be resolved to a real id.
    for (const l of lanes) {
      upsert.run(
        l.port_name,
        parseInt(l.vlan_id, 10) || 0,
        l.role,
        String(l.lane_name || ''),
        parseInt(l.speed_mbps, 10) || 0,
        parseInt(l.burst_mbps, 10) || 0,
        l.isolate_clients === false ? 0 : 1
      );
    }
    // Second pass: resolve bridge_with_port/vlan into a real row id now
    // that every lane in this batch definitely has one.
    const findId = db.prepare('SELECT id FROM router_ports WHERE port_name = ? AND vlan_id = ?');
    const setBridge = db.prepare('UPDATE router_ports SET bridge_with_id = ? WHERE port_name = ? AND vlan_id = ?');
    for (const l of lanes) {
      const vlanId = parseInt(l.vlan_id, 10) || 0;
      if (l.bridge_with_port) {
        const target = findId.get(l.bridge_with_port, parseInt(l.bridge_with_vlan, 10) || 0);
        setBridge.run(target ? target.id : null, l.port_name, vlanId);
      } else {
        setBridge.run(null, l.port_name, vlanId);
      }
    }

    return res.json({ success: true, message: 'Port roles saved' });
  } catch (err) {
    console.error('Router ports save error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/router/status, live status card, read straight from the
// router (ROUTER_MODE_PLAN.md §4.7), not our own database.
router.get('/router/status', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    const status = await mikrotikService.getLiveStatus();
    return res.json({ success: true, status });
  } catch (err) {
    console.error('Router status error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to reach router' });
  }
});

// POST /api/admin/router/test-connection
router.post('/router/test-connection', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    await mikrotikService.testConnection();
    return res.json({ success: true, message: 'Connected' });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || 'Connection failed' });
  }
});

// POST /api/admin/router/openwrt-test-connection
router.post('/router/openwrt-test-connection', adminAuth, async (req, res) => {
  try {
    const openwrtDriver = require('../services/drivers/openwrtDriver');
    const ok = await openwrtDriver.ping();
    if (ok) return res.json({ success: true, message: 'Connected' });
    return res.status(400).json({ success: false, message: 'Not reachable' });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || 'Connection failed' });
  }
});

// POST /api/admin/router/terminal, runs a raw MikroTik API command
// straight from the admin panel, so a quick check or fix doesn't require
// opening WinBox separately. Deliberately unrestricted, same as WinBox's
// own terminal: this account already has full admin-level MikroTik
// credentials on file, so there's nothing meaningfully protected by trying
// to sandbox individual commands here.
router.post('/router/terminal', adminAuth, async (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ success: false, message: 'Enter a command' });
  }

  // Tokenize on whitespace, keeping quoted sections (values with spaces,
  // e.g. a comment) together as one word. Commands are expected in the
  // same combined-path form every other call in this codebase already
  // uses (e.g. "/ip/hotspot/ip-binding/print"), not the space-separated
  // form the interactive CLI console alone accepts.
  //
  // Bug found live: a key=value parameter word typed the natural WinBox
  // CLI way (e.g. "servers=10.50.0.31") isn't a valid MikroTik API word -
  // the API layer requires a leading "=" ("=servers=10.50.0.31", see
  // mikrotikApiClient.js's own protocol notes) to mark it as a parameter
  // rather than a bare positional argument. Without it, RouterOS's API
  // just silently ignores the word - no error, the command "succeeds"
  // with an empty response, and nothing actually changes. WinBox's own
  // interactive console does this translation invisibly; this endpoint
  // didn't, so every operator typing commands the way WinBox teaches them
  // to would hit a command that looks like it worked but did nothing.
  // Auto-prefix any word after the command path that looks like
  // key=value and doesn't already start with = or ? (query filters keep
  // their own leading ? untouched).
  const words = command.trim().match(/"[^"]*"|'[^']*'|\S+/g).map((w, i) => {
    const unquoted = (w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))
      ? w.slice(1, -1)
      : w;
    if (i > 0 && /^[a-zA-Z0-9_-]+=/.test(unquoted)) {
      return `=${unquoted}`;
    }
    return unquoted;
  });

  try {
    const { getMikrotikConfig } = require('../services/mikrotikConfigHelper');
    const { withMikrotik } = require('../services/mikrotikApiClient');
    const config = getMikrotikConfig();
    if (!config.ip) {
      return res.status(400).json({ success: false, message: 'MikroTik is not configured yet' });
    }

    const result = await withMikrotik(config, (client) => client.talk(words));
    res.json({ success: true, result });
  } catch (err) {
    console.error('Router terminal error:', err);
    res.status(400).json({ success: false, message: err.message || 'Command failed' });
  }
});

// ===== SYSTEM TERMINAL =====
// Real shell access to the box this app itself runs on, not just the
// router - deliberately gated behind a SEPARATE password from
// admin_password, re-checked every session, on top of already being
// logged into the admin panel. Same "one command in, one result back"
// shape as the Router Terminal above rather than a persistent
// interactive PTY (node-pty/xterm.js) - no new native dependency to
// build on an already-fragile install (see passwordHash.js's own note
// on this), and a per-command model can't leave an orphaned shell
// process running if a browser tab just closes.
//
// terminalSessions: short-lived in-memory tokens (not the admin session
// token) issued only after the separate terminal password is verified.
// Tracks each session's own working directory server-side so `cd`
// feels persistent across commands, the same as a real shell, even
// though each command is its own independent process.
const terminalSessions = new Map();
const TERMINAL_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes of inactivity

function pruneTerminalSessions() {
  const now = Date.now();
  for (const [token, s] of terminalSessions) {
    if (now > s.expiresAt) terminalSessions.delete(token);
  }
}

// GET /api/admin/terminal/status - whether the separate terminal password
// has ever been set, so the frontend can show "set a password first"
// instead of a login form nothing could ever satisfy.
router.get('/terminal/status', adminAuth, (req, res) => {
  const configured = !!db.prepare("SELECT value FROM settings WHERE key = 'terminal_password'").get()?.value;
  res.json({ success: true, configured });
});

// POST /api/admin/terminal/set-password - sets or changes the terminal-only
// password. Requires the CURRENT terminal password too once one exists
// (not just being logged into the admin panel) - otherwise anyone who
// guessed/observed the admin login could silently set their own terminal
// password and grant themselves shell access going forward.
router.post('/terminal/set-password', adminAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
  }
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'terminal_password'").get()?.value;
  if (existing && !verifyPassword(current_password, existing)) {
    return res.status(401).json({ success: false, message: 'Current terminal password is incorrect' });
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('terminal_password', ?)")
    .run(hashPassword(String(new_password)));
  // Changing the password invalidates every session issued under the old
  // one - same reasoning as changing admin_password elsewhere in this app.
  terminalSessions.clear();
  res.json({ success: true, message: 'Terminal password updated' });
});

// POST /api/admin/terminal/auth - verifies the separate terminal password
// and issues a short-lived session token. Rate-limited the SAME way
// admin login itself is (spamService, same IP-keyed pattern) - this is a
// second real password guard, not meaningfully different from a login
// form in terms of brute-force risk.
router.post('/terminal/auth', adminAuth, (req, res) => {
  const ip = getRealClientIp(req);
  const spamCheck = checkSpam(`terminal-auth:${ip}`);
  if (spamCheck.blocked) {
    return res.status(429).json({ success: false, message: spamCheck.message });
  }
  const { password } = req.body || {};
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'terminal_password'").get()?.value;
  if (!stored) {
    return res.status(400).json({ success: false, message: 'No terminal password has been set yet - set one first' });
  }
  if (!password || !verifyPassword(password, stored)) {
    recordAttempt(`terminal-auth:${ip}`);
    return res.status(401).json({ success: false, message: 'Incorrect terminal password' });
  }
  clearAttempts(`terminal-auth:${ip}`);

  pruneTerminalSessions();
  const token = crypto.randomBytes(24).toString('hex');
  terminalSessions.set(token, { cwd: os.homedir() || '/', expiresAt: Date.now() + TERMINAL_SESSION_TTL_MS });
  res.json({ success: true, token });
});

// POST /api/admin/terminal/run - executes one shell command, returns its
// output. `cd` is handled specially (child_process can't change THIS
// process's own working directory for a future call) - resolved and
// verified against the session's tracked cwd, same as a real shell would
// reject `cd` into a nonexistent directory rather than silently no-op.
router.post('/terminal/run', adminAuth, (req, res) => {
  const { token, command } = req.body || {};
  const session = token && terminalSessions.get(token);
  if (!session || Date.now() > session.expiresAt) {
    if (session) terminalSessions.delete(token);
    return res.status(401).json({ success: false, message: 'Terminal session expired - re-enter the password' });
  }
  session.expiresAt = Date.now() + TERMINAL_SESSION_TTL_MS; // sliding expiry, same as an active SSH session
  if (!command || typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ success: false, message: 'Enter a command' });
  }

  const trimmed = command.trim();
  const cdMatch = trimmed.match(/^cd(?:\s+(.*))?$/);
  if (cdMatch) {
    const target = (cdMatch[1] || '').trim() || os.homedir() || '/';
    const resolved = path.resolve(session.cwd, target.replace(/^~/, os.homedir() || ''));
    try {
      if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
      session.cwd = resolved;
      return res.json({ success: true, stdout: '', stderr: '', cwd: session.cwd });
    } catch (e) {
      return res.json({ success: true, stdout: '', stderr: `cd: ${target}: No such file or directory`, cwd: session.cwd });
    }
  }

  execFile('bash', ['-c', trimmed], { cwd: session.cwd, timeout: 20000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
    res.json({
      success: true,
      stdout: stdout || '',
      stderr: stderr || (err && !stdout ? err.message : ''),
      cwd: session.cwd,
    });
  });
});

// GET /api/admin/router/local-interfaces, this server's own network
// connections, so the admin can pick which one is on the gated lane
// (Bug: auto-guessing this on a multi-NIC machine could reserve the wrong
// device's address, silently breaking the walled-garden fixed-address
// guarantee, see mikrotikProvisioner.js's getOwnMac()).
router.get('/router/local-interfaces', adminAuth, (req, res) => {
  try {
    const provisioner = require('../services/mikrotikProvisioner');
    const interfaces = provisioner.listLocalInterfaces();
    return res.json({ success: true, interfaces });
  } catch (err) {
    console.error('Local interfaces list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/router/provision/preview, shows exactly what "Configure"
// would run, without touching the router (ROUTER_MODE_PLAN.md §4.6).
// ?ports=ether4,ether5 scopes it to just the lane(s) touching those ports
// (see mikrotikProvisioner.js's buildPlan scopePortNames) instead of the
// whole router - what the per-port "Apply" action in the Routers page uses.
router.get('/router/provision/preview', adminAuth, async (req, res) => {
  try {
    const provisioner = require('../services/mikrotikProvisioner');
    const scopePortNames = req.query.ports
      ? String(req.query.ports).split(',').map((p) => p.trim()).filter(Boolean)
      : undefined;
    const preview = await provisioner.preview(scopePortNames);
    return res.json({ success: true, ...preview });
  } catch (err) {
    console.error('Provision preview error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to build preview' });
  }
});

// POST /api/admin/router/provision/apply, the actual "Configure" action.
// Always backs up the router's current config first, stops immediately on
// the first failed step rather than pushing a half-applied config further.
// Body { ports: ['ether4'] } scopes this to just the lane(s) touching
// those physical ports - only their bridge/VLAN/DHCP/hotspot steps run,
// router-wide steps (WAN NAT, fasttrack, API user, etc.) are skipped, so
// editing one port's lane assignment doesn't have to re-touch every other
// port on the router to take effect.
router.post('/router/provision/apply', adminAuth, async (req, res) => {
  try {
    const provisioner = require('../services/mikrotikProvisioner');
    const scopePortNames = Array.isArray(req.body?.ports) && req.body.ports.length > 0
      ? req.body.ports.map((p) => String(p).trim()).filter(Boolean)
      : undefined;
    const result = await provisioner.apply(scopePortNames);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('Provision apply error:', err.message);
    res.status(500).json({
      success: false,
      message: err.message || 'Provisioning failed',
      log: err.log || [],
      warnings: err.warnings || [],
      backedUp: !!err.backedUp,
    });
  }
});

// ===== ROUTERS (fleet registry) =====
// Real, separate MikroTik devices StarkFi connects to and monitors, distinct
// from this box's own single mikrotik_host/user/pass settings (Network
// page). Only 'mikrotik' has a working adapter (mikrotikApiClient.js) -
// other manufacturers are accepted as a label but test-connection returns
// an honest "not yet supported" instead of pretending to connect.
const ROUTER_MANUFACTURERS = ['mikrotik', 'tplink', 'openwrt', 'ubiquiti'];
const ROUTER_MODES = ['controller', 'standalone'];
const ROUTER_STATUSES = ['online', 'offline', 'connecting', 'warning', 'configuration_required', 'unreachable'];

function routerRowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    manufacturer: row.manufacturer,
    model: row.model,
    mode: row.mode,
    site_id: row.site_id,
    site_name: row.site_name || null,
    host: row.host,
    port: row.port,
    ssl: !!row.ssl,
    username: row.username,
    has_password: !!row.password_encrypted,
    status: row.status,
    firmware_version: row.firmware_version,
    uptime_seconds: row.uptime_seconds,
    cpu_percent: row.cpu_percent,
    memory_percent: row.memory_percent,
    last_seen_at: row.last_seen_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// GET /api/admin/routers/self, represents THIS box's own real gateway,
// not a row in the `routers` fleet table. When network_mode is
// 'standalone', this box's existing, already-functional network engine
// (nftables/tc via hostNetworkService.js, DHCP/DNS/NAT/firewall/hotspot -
// all real, pre-existing capability, not new) is genuinely acting as the
// router - so "StarkFi Router" in the Routers module must surface real data
// from that engine (WAN health, live bandwidth, CPU/uptime) instead of
// being a disconnected label with a fake row and a doomed MikroTik-API
// test-connection, which is what it was before this fix. When
// network_mode is 'mikrotik'/'openwrt', this box is itself in Controller
// Mode (see Network page) and isn't acting as a router, so this reports
// inactive rather than pretending.
router.get('/routers/self', adminAuth, async (req, res) => {
  try {
    const mode = db.prepare("SELECT value FROM settings WHERE key = 'network_mode'").get()?.value || 'standalone';
    const active = mode === 'standalone';

    if (!active) {
      return res.json({ success: true, active: false, mode });
    }

    const cpus = os.cpus();
    // Bug: getCpuUsagePercents returns one percentage PER CORE (an array),
    // not a single number - Math.round() on an array is NaN, which
    // JSON.stringify() silently turns into `null`. Average across cores
    // for one overall figure, same as any other "CPU Usage" readout in
    // this app.
    const perCoreUsage = await getCpuUsagePercents(cpus);
    const cpuPercent = perCoreUsage.length
      ? Math.round(perCoreUsage.reduce((sum, p) => sum + p, 0) / perCoreUsage.length)
      : null;
    const totalMem = os.totalmem();
    const freeMem = getAvailableMem();
    const memPercent = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null;

    let wan = null;
    try {
      const { checkWanHealth } = require('../services/wanHealthService');
      wan = await checkWanHealth();
    } catch (e) {
      wan = null;
    }

    return res.json({
      success: true,
      active: true,
      mode,
      uptime_seconds: Math.floor(os.uptime()),
      cpu_percent: cpuPercent,
      memory_percent: memPercent,
      wan,
    });
  } catch (err) {
    console.error('Router self-status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== ACCESS POINTS (v1: manual registry + real reachability monitoring) =====
// Deliberately scoped down (per explicit product decision): no discovery
// scan, no vendor adapters, no SSID/radio/VLAN management. An admin adds
// an AP by hand (name/IP/MAC/vendor/model/site) and StarkFi can genuinely
// ping it to know if it's reachable - status/last_seen/last_latency are
// never written except by that real check, so an AP nobody has pinged
// yet honestly stays 'unknown' rather than defaulting to a fake "online".

const AP_TARGET_REGEX = /^[a-zA-Z0-9.:-]{1,253}$/;

function apRowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    ip_address: row.ip_address,
    mac_address: row.mac_address,
    vendor: row.vendor,
    model: row.model,
    hostname: row.hostname,
    site_id: row.site_id,
    site_name: row.site_name || null,
    notes: row.notes,
    status: row.status,
    management_state: row.management_state || 'unmanaged',
    vlan_id: row.vlan_id,
    vlan_evidence: row.vlan_evidence,
    discovered_via: row.discovered_via,
    last_seen_at: row.last_seen_at,
    last_latency_ms: row.last_latency_ms,
    adapter_type: row.adapter_type || null,
    adapter_last_error: row.adapter_last_error || null,
    adapter_last_polled_at: row.adapter_last_polled_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

router.get('/access-points', adminAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*, s.name as site_name FROM access_points a
      LEFT JOIN sites s ON s.id = a.site_id
      ORDER BY a.created_at DESC
    `).all();
    return res.json({ success: true, accessPoints: rows.map(apRowToJson) });
  } catch (err) {
    console.error('Admin list access points error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/access-points/:id', adminAuth, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT a.*, s.name as site_name FROM access_points a LEFT JOIN sites s ON s.id = a.site_id WHERE a.id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Access point not found' });
    return res.json({ success: true, accessPoint: apRowToJson(row) });
  } catch (err) {
    console.error('Admin get access point error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

function validateApInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) errors.push('AP name is required.');
    out.name = name;
  }
  if (body.ip_address !== undefined) {
    const ip = String(body.ip_address || '').trim();
    if (ip && !AP_TARGET_REGEX.test(ip)) errors.push('IP address / hostname looks invalid.');
    out.ip_address = ip || null;
  }
  if (body.mac_address !== undefined) out.mac_address = String(body.mac_address || '').trim().toLowerCase() || null;
  if (body.vendor !== undefined) out.vendor = String(body.vendor || '').trim().slice(0, 100) || null;
  if (body.model !== undefined) out.model = String(body.model || '').trim().slice(0, 100) || null;
  if (body.site_id !== undefined) {
    const v = body.site_id === null || body.site_id === '' ? null : parseInt(body.site_id, 10);
    out.site_id = Number.isFinite(v) ? v : null;
  }
  if (body.notes !== undefined) out.notes = String(body.notes || '').trim().slice(0, 500) || null;
  // VLAN evidence fields, populated only where this app has real network
  // evidence for a manually-added AP (see the "VLAN Evidence" detail tab),
  // never free-typed by the manual-add form.
  if (body.hostname !== undefined) out.hostname = String(body.hostname || '').trim().slice(0, 200) || null;
  if (body.vlan_id !== undefined) {
    const v = body.vlan_id === null || body.vlan_id === '' ? null : parseInt(body.vlan_id, 10);
    out.vlan_id = Number.isFinite(v) ? v : null;
  }
  if (body.vlan_evidence !== undefined) out.vlan_evidence = String(body.vlan_evidence || '').trim().slice(0, 300) || null;
  if (body.discovered_via !== undefined) {
    out.discovered_via = ['arp', 'dhcp', 'arp+dhcp', 'manual'].includes(body.discovered_via) ? body.discovered_via : 'manual';
  }
  return { errors, out };
}

router.post('/access-points', adminAuth, (req, res) => {
  try {
    const { errors, out } = validateApInput(req.body);
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
    const result = db.prepare(`
      INSERT INTO access_points (name, ip_address, mac_address, vendor, model, site_id, notes, hostname, vlan_id, vlan_evidence, discovered_via)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      out.name, out.ip_address || null, out.mac_address || null, out.vendor || null, out.model || null, out.site_id ?? null, out.notes || null,
      out.hostname || null, out.vlan_id ?? null, out.vlan_evidence || null, out.discovered_via || 'manual'
    );
    console.log(`📶 Access point added: "${out.name}"`);
    const row = db.prepare('SELECT a.*, s.name as site_name FROM access_points a LEFT JOIN sites s ON s.id = a.site_id WHERE a.id = ?').get(result.lastInsertRowid);
    return res.json({ success: true, accessPoint: apRowToJson(row) });
  } catch (err) {
    console.error('Admin create access point error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.patch('/access-points/:id', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM access_points WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Access point not found' });
    const { errors, out } = validateApInput(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
    const fields = Object.keys(out);
    if (!fields.length) return res.json({ success: true, accessPoint: apRowToJson(existing) });
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => out[f] ?? null);
    db.prepare(`UPDATE access_points SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, req.params.id);
    console.log(`📶 Access point updated: "${existing.name}" (#${req.params.id})`);
    const row = db.prepare('SELECT a.*, s.name as site_name FROM access_points a LEFT JOIN sites s ON s.id = a.site_id WHERE a.id = ?').get(req.params.id);
    return res.json({ success: true, accessPoint: apRowToJson(row) });
  } catch (err) {
    console.error('Admin update access point error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.delete('/access-points/:id', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM access_points WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Access point not found' });
    db.prepare('DELETE FROM access_points WHERE id = ?').run(req.params.id);
    console.log(`📶 Access point removed: "${existing.name}" (#${req.params.id})`);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete access point error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/access-points/:id/ping, the one place this module
// actually touches the network. A real ICMP ping (same execFile pattern
// as /network/diagnostics/ping), parses real round-trip latency, and
// persists real status/last_seen_at - never simulated.
router.post('/access-points/:id/ping', adminAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM access_points WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Access point not found' });
  if (!existing.ip_address || !AP_TARGET_REGEX.test(existing.ip_address)) {
    return res.status(400).json({ success: false, message: 'This AP has no valid IP address/hostname to ping.' });
  }
  execFile('ping', ['-c', '2', '-W', '2', existing.ip_address], { timeout: 8000 }, (err, stdout) => {
    const match = (stdout || '').match(/time[=<]([\d.]+)/);
    const reachable = !err && !!match;
    const latency = match ? parseFloat(match[1]) : null;
    const status = reachable ? 'online' : 'offline';
    db.prepare(`
      UPDATE access_points SET status = ?, last_seen_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_seen_at END,
        last_latency_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(status, reachable ? 1 : 0, latency, req.params.id);
    const row = db.prepare('SELECT a.*, s.name as site_name FROM access_points a LEFT JOIN sites s ON s.id = a.site_id WHERE a.id = ?').get(req.params.id);
    return res.json({ success: true, accessPoint: apRowToJson(row) });
  });
});

// POST /api/admin/access-points/:id/identify, unauthenticated vendor
// fingerprint (AP_INTEGRATION_ARCHITECTURE.md section 6: identify() never
// takes credentials). Used to suggest an adapter before asking for a
// password, not to prove the password works.
router.post('/access-points/:id/identify', adminAuth, async (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM access_points WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Access point not found' });
    if (!existing.ip_address) return res.status(400).json({ success: false, message: 'This AP has no IP address.' });
    const { identifyDevice } = require('../services/apAdapters/apIntegrationService');
    const result = await identifyDevice(existing.ip_address);
    return res.json({ success: true, identified: result });
  } catch (err) {
    console.error('AP identify error:', err);
    res.status(500).json({ success: false, message: err.message || 'Identify failed' });
  }
});

// POST /api/admin/access-points/:id/adopt, connects a real adapter,
// verifies the credentials by authenticating once, stores them encrypted
// (never plaintext, never echoed back), and moves management_state to
// 'monitored'. Body: { adapter_type, password }.
router.post('/access-points/:id/adopt', adminAuth, async (req, res) => {
  try {
    const { adapter_type, password } = req.body || {};
    if (!adapter_type) return res.status(400).json({ success: false, message: 'adapter_type is required.' });
    if (!password) return res.status(400).json({ success: false, message: 'Password is required.' });
    const { adoptDevice } = require('../services/apAdapters/apIntegrationService');
    const result = await adoptDevice(req.params.id, adapter_type, { password });
    console.log(`📶 Access point #${req.params.id} adopted via ${adapter_type} adapter`);
    return res.json({ success: true, ...result });
  } catch (err) {
    // 401 is reserved sitewide for "your StarkFi admin session expired" (see
    // apiCall()'s handleAuthFailure() in app.js, which force-logs-out on
    // any 401) - a wrong password for the *AP device itself* is a
    // different failure and must not trigger that, so it's 400 here.
    const status = err.name === 'AuthenticationFailed' ? 400 : 500;
    console.error('AP adopt error:', err);
    res.status(status).json({ success: false, message: err.message || 'Adopt failed' });
  }
});

// POST /api/admin/access-points/:id/unadopt, reverts to unmanaged and
// discards the stored credentials.
router.post('/access-points/:id/unadopt', adminAuth, (req, res) => {
  try {
    const { unadoptDevice } = require('../services/apAdapters/apIntegrationService');
    unadoptDevice(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('AP unadopt error:', err);
    res.status(500).json({ success: false, message: err.message || 'Unadopt failed' });
  }
});

// GET /api/admin/access-points/:id/live, real adapter poll (device info,
// status, wireless, clients). Separate from the plain ICMP /ping route:
// this only works once an AP has been adopted, and returns much richer
// data than a ping can.
router.get('/access-points/:id/live', adminAuth, async (req, res) => {
  try {
    const { pollDevice } = require('../services/apAdapters/apIntegrationService');
    const data = await pollDevice(req.params.id);
    return res.json({ success: true, live: data });
  } catch (err) {
    console.error('AP live poll error:', err);
    res.status(500).json({ success: false, message: err.message || 'Poll failed' });
  }
});

// GET /api/admin/entitlements, lets the frontend render locked-feature
// UI ("PRO FEATURE, upgrade to unlock") without duplicating tier logic.
// The list of capability names here must stay in sync with
// entitlementService.js's TIER_CAPABILITIES; backend enforcement at each
// write endpoint (see /bandwidth-profiles, /network/mikrotik/firewall-zones,
// /network/standalone/ports) is what actually matters - this is display
// only, never trust a frontend capability check for authorization.
router.get('/entitlements', adminAuth, (req, res) => {
  try {
    const { getCurrentTier, canUse } = require('../services/entitlementService');
    const tier = getCurrentTier();
    const capabilities = ['router_mode', 'multi_wan', 'bandwidth_profiles', 'firewall_zones'];
    const entitlements = {};
    for (const cap of capabilities) entitlements[cap] = canUse(cap);
    return res.json({ success: true, tier, entitlements });
  } catch (err) {
    console.error('Entitlements error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/sites', adminAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, name, is_default FROM sites ORDER BY is_default DESC, name ASC').all();
    return res.json({ success: true, sites: rows });
  } catch (err) {
    console.error('Admin list sites error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/routers', adminAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT r.*, s.name as site_name
      FROM routers r
      LEFT JOIN sites s ON s.id = r.site_id
      ORDER BY r.created_at DESC
    `).all();
    return res.json({ success: true, routers: rows.map(routerRowToJson) });
  } catch (err) {
    console.error('Admin list routers error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/routers/:id', adminAuth, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT r.*, s.name as site_name FROM routers r LEFT JOIN sites s ON s.id = r.site_id WHERE r.id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Router not found' });
    return res.json({ success: true, router: routerRowToJson(row) });
  } catch (err) {
    console.error('Admin get router error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

function validateRouterInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) errors.push('Router name is required.');
    out.name = name;
  }
  if (body.manufacturer !== undefined || !partial) {
    const m = ROUTER_MANUFACTURERS.includes(body.manufacturer) ? body.manufacturer : 'mikrotik';
    out.manufacturer = m;
  }
  if (body.model !== undefined) out.model = String(body.model || '').trim().slice(0, 100) || null;
  if (body.mode !== undefined || !partial) {
    out.mode = ROUTER_MODES.includes(body.mode) ? body.mode : 'controller';
  }
  if (body.site_id !== undefined) {
    const v = body.site_id === null || body.site_id === '' ? null : parseInt(body.site_id, 10);
    out.site_id = Number.isFinite(v) ? v : null;
  }
  if (body.host !== undefined) out.host = String(body.host || '').trim().slice(0, 255) || null;
  if (body.port !== undefined) {
    const v = body.port === null || body.port === '' ? null : parseInt(body.port, 10);
    if (v !== null && (!Number.isFinite(v) || v < 1 || v > 65535)) errors.push('Port must be between 1 and 65535.');
    out.port = v;
  }
  if (body.ssl !== undefined) out.ssl = body.ssl ? 1 : 0;
  if (body.username !== undefined) out.username = String(body.username || '').trim().slice(0, 100) || null;

  return { errors, out };
}

router.post('/routers', adminAuth, (req, res) => {
  try {
    const { errors, out } = validateRouterInput(req.body);
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

    const password = req.body.password ? encryptSecret(String(req.body.password)) : null;

    const result = db.prepare(`
      INSERT INTO routers (name, manufacturer, model, mode, site_id, host, port, ssl, username, password_encrypted, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'configuration_required')
    `).run(
      out.name, out.manufacturer, out.model || null, out.mode, out.site_id ?? null,
      out.host || null, out.port ?? null, out.ssl ?? 0, out.username || null, password
    );
    console.log(`📡 Router registered: "${out.name}" (${out.manufacturer}, ${out.mode})`);
    const row = db.prepare('SELECT r.*, s.name as site_name FROM routers r LEFT JOIN sites s ON s.id = r.site_id WHERE r.id = ?').get(result.lastInsertRowid);
    return res.json({ success: true, router: routerRowToJson(row) });
  } catch (err) {
    console.error('Admin create router error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.patch('/routers/:id', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Router not found' });

    const { errors, out } = validateRouterInput(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

    if (req.body.password) out.password_encrypted = encryptSecret(String(req.body.password));

    const fields = Object.keys(out);
    if (!fields.length) return res.json({ success: true, router: routerRowToJson(existing) });

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => out[f] ?? null);
    db.prepare(`UPDATE routers SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, req.params.id);

    console.log(`📡 Router updated: "${existing.name}" (#${req.params.id})`);
    const row = db.prepare('SELECT r.*, s.name as site_name FROM routers r LEFT JOIN sites s ON s.id = r.site_id WHERE r.id = ?').get(req.params.id);
    return res.json({ success: true, router: routerRowToJson(row) });
  } catch (err) {
    console.error('Admin update router error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.delete('/routers/:id', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Router not found' });
    db.prepare('DELETE FROM routers WHERE id = ?').run(req.params.id);
    console.log(`📡 Router removed: "${existing.name}" (#${req.params.id})`);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete router error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/routers/:id/test-connection, the one place this module
// actually talks to real hardware. Opens a real MikroTik API connection
// with the router's own stored credentials, reads real /system/resource
// data (RouterOS version, uptime, CPU, free memory), and persists it so
// the dashboard/detail page show genuine numbers, not fabricated ones.
router.post('/routers/:id/test-connection', adminAuth, async (req, res) => {
  const existing = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Router not found' });

  if (existing.manufacturer !== 'mikrotik') {
    return res.status(400).json({
      success: false,
      message: `${existing.manufacturer} is not yet supported - only MikroTik has a working connection adapter today.`,
    });
  }
  if (!existing.host || !existing.username || !existing.password_encrypted) {
    db.prepare("UPDATE routers SET status = 'configuration_required', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    return res.status(400).json({ success: false, message: 'Host, username, and password are required before testing the connection.' });
  }

  try {
    const { withMikrotik } = require('../services/mikrotikApiClient');
    const config = {
      ip: existing.host,
      port: existing.port || undefined,
      ssl: !!existing.ssl,
      user: existing.username,
      pass: decryptSecret(existing.password_encrypted),
    };
    const result = await withMikrotik(config, (client) => client.talk(['/system/resource/print']));
    const resource = result.re && result.re[0] ? result.re[0] : {};
    const uptimeSeconds = parseMikrotikUptime(resource.uptime);
    const cpuPercent = resource['cpu-load'] !== undefined ? parseInt(resource['cpu-load'], 10) : null;
    const totalMem = parseInt(resource['total-memory'], 10);
    const freeMem = parseInt(resource['free-memory'], 10);
    const memPercent = (Number.isFinite(totalMem) && Number.isFinite(freeMem) && totalMem > 0)
      ? Math.round(((totalMem - freeMem) / totalMem) * 100)
      : null;

    db.prepare(`
      UPDATE routers SET status = 'online', firmware_version = ?, uptime_seconds = ?, cpu_percent = ?, memory_percent = ?,
        last_seen_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(resource.version || null, uptimeSeconds, cpuPercent, memPercent, req.params.id);

    const row = db.prepare('SELECT r.*, s.name as site_name FROM routers r LEFT JOIN sites s ON s.id = r.site_id WHERE r.id = ?').get(req.params.id);
    return res.json({ success: true, router: routerRowToJson(row) });
  } catch (err) {
    db.prepare("UPDATE routers SET status = 'unreachable', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run((err.message || 'Connection failed').slice(0, 300), req.params.id);
    console.error('Router test-connection error:', err.message);
    return res.status(400).json({ success: false, message: `Unable to connect to router. ${err.message || 'Check the host, credentials, and network connection.'}` });
  }
});

// MikroTik reports uptime as e.g. "4w2d3h4m5s" - parse into seconds.
function parseMikrotikUptime(str) {
  if (!str || typeof str !== 'string') return null;
  const re = /(\d+)([wdhms])/g;
  const unitSeconds = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  let match;
  let matched = false;
  while ((match = re.exec(str)) !== null) {
    matched = true;
    total += parseInt(match[1], 10) * (unitSeconds[match[2]] || 0);
  }
  return matched ? total : null;
}

// GET /api/admin/routers/:id/interfaces, real interface list + traffic
// from the router itself, for the Router Detail > Interfaces tab.
router.get('/routers/:id/interfaces', adminAuth, async (req, res) => {
  const existing = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Router not found' });
  if (existing.manufacturer !== 'mikrotik') {
    return res.status(400).json({ success: false, message: `${existing.manufacturer} is not yet supported.` });
  }
  if (!existing.host || !existing.username || !existing.password_encrypted) {
    return res.status(400).json({ success: false, message: 'This router is not fully configured yet.' });
  }
  try {
    const { withMikrotik } = require('../services/mikrotikApiClient');
    const config = {
      ip: existing.host,
      port: existing.port || undefined,
      ssl: !!existing.ssl,
      user: existing.username,
      pass: decryptSecret(existing.password_encrypted),
    };
    const result = await withMikrotik(config, (client) => client.talk(['/interface/print']));
    const interfaces = (result.re || []).map(i => ({
      name: i.name,
      type: i.type,
      online: i.running === 'true',
      disabled: i.disabled === 'true',
      rx_bytes: i['rx-byte'] ? parseInt(i['rx-byte'], 10) : null,
      tx_bytes: i['tx-byte'] ? parseInt(i['tx-byte'], 10) : null,
    }));
    return res.json({ success: true, interfaces });
  } catch (err) {
    console.error('Router interfaces error:', err.message);
    return res.status(400).json({ success: false, message: `Unable to reach router. ${err.message || ''}` });
  }
});

module.exports = router;
