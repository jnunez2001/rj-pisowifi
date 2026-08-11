// ===== DATA RETENTION / DELETION POLICY (privacy) =====
// Real gap from the Phase 8 privacy audit: nothing ever aged out old
// MAC/session history - session_history and free_claims (both carry
// mac_address + timestamps, exactly the "presence/behavior trail"
// concern the audit raised) grew forever.
//
// Deliberately scoped to operational/diagnostic tables only -
// session_history (duration records) and free_claims (free-minutes
// claim history). The financial ledger (`transactions`) is explicitly
// NOT touched here: those are real revenue/audit records with business
// and potential legal retention value that has nothing to do with the
// MAC-privacy concern this addresses, and deleting them for privacy
// reasons alone would be the wrong tradeoff. watchdog_events and
// network_config_versions are diagnostic, not customer data, and can
// grow unbounded too - included for the same "don't let a table grow
// forever" reason, not a privacy concern per se.

const db = require('../config/database');
const cron = require('node-cron');

const DEFAULT_RETENTION_DAYS = {
  session_history: 30, // matches the 30-day figure already floated for "client sessions" in planning notes
  free_claims: 30,
  watchdog_events: 90,
  network_config_versions: 180, // config-change audit trail - kept longer than routine session data on purpose
};

function getRetentionDays(table) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`retention_days_${table}`);
  const parsed = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS[table];
}

const TABLE_TIMESTAMP_COLUMN = {
  session_history: 'ended_at',
  free_claims: 'claimed_at',
  watchdog_events: 'checked_at',
  network_config_versions: 'created_at',
};

function runCleanup() {
  const results = {};
  for (const table of Object.keys(DEFAULT_RETENTION_DAYS)) {
    try {
      const days = getRetentionDays(table);
      const col = TABLE_TIMESTAMP_COLUMN[table];
      const result = db.prepare(
        `DELETE FROM ${table} WHERE ${col} < datetime('now', '-' || ? || ' days')`
      ).run(days);
      results[table] = { deleted: result.changes, retention_days: days };
      if (result.changes > 0) {
        console.log(`🗑️  [DataRetention] ${table}: removed ${result.changes} row(s) older than ${days} days`);
      }
    } catch (e) {
      console.error(`[DataRetention] Cleanup failed for ${table}:`, e.message);
      results[table] = { error: e.message };
    }
  }
  return results;
}

function getPolicy() {
  const policy = {};
  for (const table of Object.keys(DEFAULT_RETENTION_DAYS)) {
    policy[table] = getRetentionDays(table);
  }
  return policy;
}

function setRetentionDays(table, days) {
  if (!DEFAULT_RETENTION_DAYS.hasOwnProperty(table)) {
    throw new Error(`Unknown retention table: ${table}`);
  }
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(`retention_days_${table}`, String(days));
}

function start() {
  // Once a day at 03:00 - low-traffic hour, matches the timing convention
  // the nightly scheduled DB backup already uses.
  cron.schedule('0 3 * * *', () => {
    runCleanup();
  });
  console.log('🗑️  Data retention cleanup scheduled (daily)');
}

module.exports = { runCleanup, getPolicy, setRetentionDays, start, DEFAULT_RETENTION_DAYS };
