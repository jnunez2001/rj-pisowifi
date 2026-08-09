// ===== TOTP (Time-based One-Time Password) SERVICE =====
// RFC 6238 implementation using only Node's built-in crypto - no new npm
// dependency, same reasoning as passwordHash.js's own choice of scrypt
// over bcrypt. Generates the same 6-digit rotating codes any standard
// authenticator app (Google Authenticator, Authy, 1Password, etc.)
// produces from a shared secret - nothing proprietary, this is the same
// algorithm every one of those apps already implements.
const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30; // Standard TOTP time-step, matches every authenticator app's default.
const DIGITS = 6;

function generateSecret() {
  // 20 random bytes (160 bits) is the standard TOTP secret size (matches
  // Google Authenticator's own default) - encoded as base32 since that's
  // what every authenticator app's manual-entry field expects.
  const bytes = crypto.randomBytes(20);
  return base32Encode(bytes);
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input) {
  const clean = input.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue; // Skip spacer characters a user might paste in.
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  // TOTP counter is a 64-bit big-endian integer - Node's bitwise ops are
  // 32-bit, so split across two 32-bit writes instead of one 64-bit one.
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter % 0x100000000, 4);

  const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binCode % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Checks the token against the current time-step and one step on either
// side (± 30s) - accounts for clock drift between the box and the user's
// phone without meaningfully widening the real guessing window (still
// only 3 valid codes at any moment, each replaced every 30s).
function verifyToken(base32Secret, token) {
  if (!base32Secret || !token) return false;
  const clean = String(token).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;

  const secretBuffer = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let errorWindow = -1; errorWindow <= 1; errorWindow++) {
    if (hotp(secretBuffer, counter + errorWindow) === clean) return true;
  }
  return false;
}

// otpauth:// URL an authenticator app's QR scanner or manual-entry screen
// understands - standard format, not anything custom.
function buildOtpAuthUrl(base32Secret, accountLabel, issuer) {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedLabel = encodeURIComponent(accountLabel);
  return `otpauth://totp/${encodedIssuer}:${encodedLabel}?secret=${base32Secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = { generateSecret, verifyToken, buildOtpAuthUrl };
