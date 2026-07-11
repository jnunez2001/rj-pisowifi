const crypto = require('crypto');

// scrypt over bcrypt/bcryptjs: no new npm dependency (this box's npm install
// has a history of being fragile — see bugslog.md), and Node's crypto module
// already ships a memory-hard KDF that's fine for a single-admin panel.
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

// Accepts legacy plaintext values too (pre-migration installs) so existing
// deployments don't get locked out before database.js's migration runs.
function verifyPassword(plain, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length === 3 && parts[0] === 'scrypt') {
    const [, salt, hashHex] = parts;
    const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(hashHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  return String(plain) === String(stored);
}

function isHashed(value) {
  return typeof value === 'string' && value.startsWith('scrypt$');
}

module.exports = { hashPassword, verifyPassword, isHashed };
