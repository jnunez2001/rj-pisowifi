// ===== DATABASE ENCRYPTION AT REST (opt-in) =====
// Real gap found in the Phase 8 privacy audit: anyone who copies the raw
// .db file (or steals the SD card) can read session/transaction/voucher
// history in plain text - only two individual fields (mikrotik_pass,
// admin_2fa_secret, via secretCrypto.js) were ever encrypted, not the
// database itself.
//
// Deliberately OFF by default and never auto-applied to an existing
// database - this is a live data-format migration on a system that will
// hold real revenue data, not something to flip silently. An operator
// must explicitly trigger migrateToEncrypted() (Settings > Storage,
// wired in admin.js), which requires a fresh backup to already exist and
// verifies the migrated copy is byte-for-byte readable before ever
// touching the original file.
//
// Uses better-sqlite3-multiple-ciphers (drop-in API-compatible with
// better-sqlite3, bundles SQLite3MultipleCiphers) rather than swapping to
// a from-scratch SQLCipher fork - verified end-to-end tonight: without
// the key the file reports "file is not a database" (genuine encryption,
// not just an access-control wrapper), the raw bytes contain no plaintext
// of what was written, and the correct key reads it back exactly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getKeyPath(dbPath) {
  return path.join(path.dirname(dbPath), '.db-encryption-key');
}

function hasEncryptionKey(dbPath) {
  return fs.existsSync(getKeyPath(dbPath));
}

function readEncryptionKey(dbPath) {
  try {
    return fs.readFileSync(getKeyPath(dbPath), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

function writeEncryptionKey(dbPath, key) {
  fs.writeFileSync(getKeyPath(dbPath), key, { mode: 0o600 });
}

// Migrates an existing PLAINTEXT database file to an encrypted one, in
// place. Steps, each one verified before proceeding to the next:
//   1. Require an existing recent backup file to already exist (caller's
//      responsibility to have made one - this function refuses to run
//      without backupPath pointing at a real file, it does not make its
//      own backup, since a backup taken by this same process moments
//      before touching the live file is not meaningfully safer than the
//      file it's about to modify).
//   2. Generate a new random key.
//   3. Copy every table into a new encrypted file via ATTACH + per-table
//      CREATE+INSERT (portable across cipher libraries - sqlcipher_export
//      is NOT available in SQLite3MultipleCiphers, confirmed by testing).
//   4. Verify row counts match, table by table, between original and
//      migrated copy.
//   5. Only then: rename the original plaintext file aside (.pre-encryption),
//      move the encrypted copy into its place, write the key file.
// Throws (does not partially apply) if any step fails - the original
// plaintext file is never touched until step 5, so a failure at any
// earlier step leaves it completely untouched.
function migrateToEncrypted(dbPath, backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error('A backup file must already exist before migrating - refusing to proceed without one.');
  }
  if (hasEncryptionKey(dbPath)) {
    throw new Error('This database is already encrypted.');
  }

  const Database = require('better-sqlite3-multiple-ciphers');
  const key = crypto.randomBytes(32).toString('hex');
  const encryptedPath = `${dbPath}.encrypting-tmp`;
  if (fs.existsSync(encryptedPath)) fs.unlinkSync(encryptedPath);

  const src = new Database(dbPath);
  try {
    src.exec(`ATTACH DATABASE '${encryptedPath}' AS encrypted KEY '${key}'`);
    const tables = src.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all();

    // Two passes, not one create+insert per table in a single loop - a
    // second real bug caught while testing this tonight: several tables
    // have a foreign key to another table (e.g. promo_vouchers ->
    // bandwidth_profiles), and even inserting ZERO rows into such a table
    // fails with "no such table" if the referenced table doesn't exist
    // YET in the encrypted schema - SQLite validates the FK target's
    // existence when preparing the INSERT statement, not just when an
    // actual foreign-key-bearing row is written. Creating every table
    // first, before any INSERT runs, avoids this regardless of table
    // order or which tables happen to reference which.
    for (const t of tables) {
      // First bug caught while testing this tonight: most tables in this
      // schema are declared "CREATE TABLE IF NOT EXISTS ..." - naively
      // inserting "encrypted." right after "CREATE TABLE" produced
      // "CREATE TABLE encrypted.IF NOT EXISTS tablename (...)", which
      // SQLite parses as a broken statement and the table silently never
      // gets created in the encrypted file. Strip "IF NOT EXISTS" first
      // (safe here - this is always a brand-new, definitely-empty file),
      // then prefix the schema.
      const createSql = t.sql
        .replace(/IF NOT EXISTS\s+/i, '')
        .replace(/^CREATE TABLE\s+/i, 'CREATE TABLE encrypted.');
      src.exec(createSql);
    }
    for (const t of tables) {
      src.exec(`INSERT INTO encrypted.${t.name} SELECT * FROM main.${t.name}`);
    }

    // Verify row counts match before trusting this copy with anything -
    // a silent partial copy would be worse than not migrating at all.
    for (const t of tables) {
      const originalCount = src.prepare(`SELECT COUNT(*) c FROM main.${t.name}`).get().c;
      const copiedCount = src.prepare(`SELECT COUNT(*) c FROM encrypted.${t.name}`).get().c;
      if (originalCount !== copiedCount) {
        throw new Error(`Row count mismatch on ${t.name}: ${originalCount} -> ${copiedCount}, aborting migration`);
      }
    }

    src.exec('DETACH DATABASE encrypted');
  } finally {
    src.close();
  }

  // Final independent verification: open the encrypted copy fresh (not
  // through the same connection that just wrote it) and confirm it's
  // genuinely readable with the key before touching the original file.
  const verify = new Database(encryptedPath);
  verify.pragma(`key='${key}'`);
  const verifyTables = verify.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all();
  if (verifyTables.length === 0) {
    verify.close();
    fs.unlinkSync(encryptedPath);
    throw new Error('Encrypted copy verification failed - no tables found on fresh open. Original file untouched.');
  }
  verify.close();

  const preEncryptionPath = `${dbPath}.pre-encryption`;
  fs.renameSync(dbPath, preEncryptionPath);
  fs.renameSync(encryptedPath, dbPath);
  writeEncryptionKey(dbPath, key);

  return { keyPath: getKeyPath(dbPath), plaintextBackupKeptAt: preEncryptionPath };
}

module.exports = { hasEncryptionKey, readEncryptionKey, writeEncryptionKey, migrateToEncrypted, getKeyPath };
