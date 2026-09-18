// Admin login helpers: saved ("trusted") devices, the recovery code used by
// "Forgot password", and password reset / session revocation.
//
// Everything takes `db` as an argument so it can be tested against a
// throwaway database. Secrets are never stored raw:
//   - device tokens: SHA-256 (they're 256 bits of randomness, so a fast hash
//     is fine and lets us look one up by hash directly)
//   - recovery code + admin password: scrypt via utils/passwordHash
//
// Sessions: session tokens live in memory in routes/admin.js. To be able to
// sign every session out (password reset, from another process such as the
// console reset script), each token records the "sessions epoch" it was
// issued under; bumping `admin_sessions_epoch` in the database invalidates
// them all at once.

const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('../utils/passwordHash');

const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_TRUSTED_DEVICES = 20;
const MIN_PASSWORD_LENGTH = 8;

// No 0/O/1/I so a code read off paper can't be mistyped.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_trusted_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT UNIQUE NOT NULL,
      label TEXT,
      ip_address TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER NOT NULL
    );
  `);
}

function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------- sessions epoch ----------

function getSessionsEpoch(db) {
  return getSetting(db, 'admin_sessions_epoch') || '0';
}

function bumpSessionsEpoch(db) {
  const next = String((parseInt(getSessionsEpoch(db), 10) || 0) + 1);
  setSetting(db, 'admin_sessions_epoch', next);
  return next;
}

// ---------- trusted devices ----------

// "Chrome on macOS" style label from a User-Agent string. Best effort only,
// it's just to help the admin recognise a device in the list.
function describeUserAgent(ua) {
  const s = String(ua || '');
  let browser = 'Browser';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';

  let os = 'Unknown OS';
  if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';
  return `${browser} on ${os}`;
}

function createTrustedDevice(db, { label, ip } = {}) {
  ensureSchema(db);
  const now = Date.now();
  // Keep the table bounded: purge expired rows, then drop the oldest ones
  // beyond the cap.
  db.prepare('DELETE FROM admin_trusted_devices WHERE expires_at <= ?').run(now);
  const count = db.prepare('SELECT COUNT(*) as n FROM admin_trusted_devices').get().n;
  if (count >= MAX_TRUSTED_DEVICES) {
    db.prepare(`
      DELETE FROM admin_trusted_devices WHERE id IN (
        SELECT id FROM admin_trusted_devices ORDER BY created_at ASC LIMIT ?
      )
    `).run(count - MAX_TRUSTED_DEVICES + 1);
  }

  const token = 'dev_' + crypto.randomBytes(32).toString('hex');
  const expiresAt = now + DEVICE_TTL_MS;
  const info = db.prepare(`
    INSERT INTO admin_trusted_devices (token_hash, label, ip_address, created_at, last_used_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sha256(token), String(label || 'Unknown device').slice(0, 80), String(ip || ''), now, now, expiresAt);
  return { token, id: Number(info.lastInsertRowid), expiresAt };
}

// Returns { ok: true, id } for a valid, unexpired device token (and records
// the use), otherwise { ok: false }. Expired rows are removed on sight.
function exchangeDeviceToken(db, token) {
  ensureSchema(db);
  if (typeof token !== 'string' || !token.startsWith('dev_') || token.length > 200) return { ok: false };
  const row = db.prepare('SELECT id, expires_at FROM admin_trusted_devices WHERE token_hash = ?').get(sha256(token));
  if (!row) return { ok: false };
  const now = Date.now();
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM admin_trusted_devices WHERE id = ?').run(row.id);
    return { ok: false };
  }
  db.prepare('UPDATE admin_trusted_devices SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return { ok: true, id: row.id };
}

function listTrustedDevices(db) {
  ensureSchema(db);
  return db.prepare(`
    SELECT id, label, ip_address, created_at, last_used_at, expires_at
    FROM admin_trusted_devices WHERE expires_at > ? ORDER BY last_used_at DESC
  `).all(Date.now());
}

function revokeTrustedDevice(db, id) {
  ensureSchema(db);
  return db.prepare('DELETE FROM admin_trusted_devices WHERE id = ?').run(id).changes > 0;
}

// Sign-out from a device that holds its own token: no login needed, holding
// the token is the proof.
function revokeDeviceByToken(db, token) {
  ensureSchema(db);
  if (typeof token !== 'string') return false;
  return db.prepare('DELETE FROM admin_trusted_devices WHERE token_hash = ?').run(sha256(token)).changes > 0;
}

function revokeAllTrustedDevices(db) {
  ensureSchema(db);
  return db.prepare('DELETE FROM admin_trusted_devices').run().changes;
}

// ---------- recovery code ----------

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generateRecoveryCode(db) {
  let raw = '';
  for (let i = 0; i < 16; i++) raw += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  const code = raw.match(/.{4}/g).join('-');
  setSetting(db, 'admin_recovery_code_hash', hashPassword(raw));
  setSetting(db, 'admin_recovery_code_created_at', String(Date.now()));
  return code;
}

function getRecoveryCodeStatus(db) {
  const hash = getSetting(db, 'admin_recovery_code_hash');
  if (!hash) return { exists: false, createdAt: null };
  return { exists: true, createdAt: parseInt(getSetting(db, 'admin_recovery_code_created_at'), 10) || null };
}

function verifyRecoveryCode(db, code) {
  const hash = getSetting(db, 'admin_recovery_code_hash');
  if (!hash) return false;
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== 16) return false;
  return verifyPassword(normalized, hash);
}

// ---------- password reset ----------

function validateNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    return `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (pw.length > 200) return 'New password is too long.';
  return null;
}

// Sets the password and signs everything else out: saved devices are
// revoked and every existing session token stops working.
function applyPasswordReset(db, newPassword) {
  setSetting(db, 'admin_password', hashPassword(newPassword));
  setSetting(db, 'must_change_password', '0');
  revokeAllTrustedDevices(db);
  bumpSessionsEpoch(db);
}

// Reset using the recovery code. On success the used code is replaced with
// a fresh one (returned once) so the admin is never left without a code.
// Returns { ok: true, newRecoveryCode } or { ok: false, reason, message }.
function resetPasswordWithRecoveryCode(db, code, newPassword) {
  const pwError = validateNewPassword(newPassword);
  if (pwError) return { ok: false, reason: 'weak_password', message: pwError };

  if (!getRecoveryCodeStatus(db).exists) {
    return {
      ok: false,
      reason: 'no_code',
      message: 'No recovery code has been set up on this device. On the box, run: node scripts/reset-admin-password.js',
    };
  }
  if (!verifyRecoveryCode(db, code)) {
    return { ok: false, reason: 'bad_code', message: 'That recovery code is not correct.' };
  }

  applyPasswordReset(db, newPassword);
  const newRecoveryCode = generateRecoveryCode(db);
  return { ok: true, newRecoveryCode };
}

// Console reset (scripts/reset-admin-password.js): no code needed, the
// caller already has shell access to the box.
function resetPasswordDirect(db, newPassword) {
  const pwError = validateNewPassword(newPassword);
  if (pwError) return { ok: false, message: pwError };
  applyPasswordReset(db, newPassword);
  return { ok: true };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  DEVICE_TTL_MS,
  MAX_TRUSTED_DEVICES,
  ensureSchema,
  getSessionsEpoch,
  bumpSessionsEpoch,
  describeUserAgent,
  createTrustedDevice,
  exchangeDeviceToken,
  listTrustedDevices,
  revokeTrustedDevice,
  revokeDeviceByToken,
  revokeAllTrustedDevices,
  generateRecoveryCode,
  getRecoveryCodeStatus,
  verifyRecoveryCode,
  validateNewPassword,
  resetPasswordWithRecoveryCode,
  resetPasswordDirect,
};
