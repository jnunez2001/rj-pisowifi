const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Encrypts secrets (currently: mikrotik_pass) at rest with a key that lives
// OUTSIDE the SQLite database file, in the same separate data directory as
// the DB itself (see server/config/database.js's DB_PATH). This matters
// specifically because a MikroTik router's credentials have real resale
// value here — if someone copies just the .db file (the easiest thing to
// walk off with), the encrypted value in it is useless without also having
// this key file from the original machine.
const DATA_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, '../database');
const KEY_PATH = process.env.SECRET_KEY_PATH || path.join(DATA_DIR, '.secret.key');

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {}
  try {
    cachedKey = fs.readFileSync(KEY_PATH);
  } catch (e) {
    cachedKey = crypto.randomBytes(32);
    fs.writeFileSync(KEY_PATH, cachedKey, { mode: 0o600 });
  }
  return cachedKey;
}

function encryptSecret(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc$${iv.toString('hex')}$${authTag.toString('hex')}$${ciphertext.toString('hex')}`;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc$');
}

// Accepts legacy plaintext values too (pre-migration installs), same
// pattern as passwordHash.js's verifyPassword — returns the value unchanged
// if it was never encrypted, so nothing breaks before the migration runs.
function decryptSecret(stored) {
  if (!stored) return '';
  if (!isEncrypted(stored)) return stored;
  try {
    const [, ivHex, tagHex, dataHex] = stored.split('$');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return plain.toString('utf8');
  } catch (e) {
    console.error('[SecretCrypto] Failed to decrypt stored secret:', e.message);
    return '';
  }
}

module.exports = { encryptSecret, decryptSecret, isEncrypted };
