// ===== TELEMETRY TIER 1 (local-first outbox + crash/error reporting) =====
// Backend mechanism only - there is deliberately no user-facing toggle in
// the admin UI yet. `telemetry_enabled` (server/config/database.js)
// defaults to '0' and stays '0' until a real Privacy Policy exists to
// disclose what recordEvent()/recordError() below actually capture. Every
// function in this file checks that setting FIRST and does nothing at all
// if it's off - not "collect but don't send," genuinely no-op.
//
// Same "a box must never depend on cloud connectivity" principle as
// licenseService.js: events/errors are written to the local outbox tables
// (telemetry_outbox, error_reports) immediately and unconditionally
// (once enabled), then synced out in a background batch on a timer.
// TELEMETRY_SYNC_URL is unset until starkfi-platform exists (same pattern
// as LICENSE_SERVER_URL) - sync() no-ops until it's configured, and rows
// just accumulate locally with zero functional impact in the meantime.

const os = require('os');
const fs = require('fs');
const cron = require('node-cron');
const db = require('../config/database');
const { getDeviceIdentity } = require('./deviceIdentity');

// Unset by design until starkfi-platform's ingest endpoint exists.
const TELEMETRY_SYNC_URL = process.env.TELEMETRY_SYNC_URL || null;

const SYNC_BATCH_SIZE = 50;

function isEnabled() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'telemetry_enabled'").get();
  return !!row && row.value === '1';
}

function recordEvent(eventType, payload = {}) {
  if (!isEnabled()) return { recorded: false };
  try {
    db.prepare('INSERT INTO telemetry_outbox (event_type, payload_json) VALUES (?, ?)')
      .run(String(eventType), JSON.stringify(payload || {}));
    return { recorded: true };
  } catch (e) {
    console.error('[Telemetry] recordEvent failed:', e.message);
    return { recorded: false, error: e.message };
  }
}

// Accepts a raw Error object or a plain {message, stack} shape so callers
// can use it directly from a try/catch without constructing anything.
function recordError(errorType, err, context = {}) {
  if (!isEnabled()) return { recorded: false };
  try {
    const message = (err && err.message) || String(err);
    const stack = (err && err.stack) || null;
    db.prepare('INSERT INTO error_reports (error_type, message, stack, context_json) VALUES (?, ?, ?, ?)')
      .run(String(errorType), message, stack, JSON.stringify(context || {}));
    return { recorded: true };
  } catch (e) {
    console.error('[Telemetry] recordError failed:', e.message);
    return { recorded: false, error: e.message };
  }
}

// Real hardware metrics via Node's own os module - no shelling out, no
// extra dependency, works the same on any Linux box this app targets.
// Disk usage is the one exception (Node has no built-in disk-space API);
// falls back to null rather than shelling out to `df`, since a missing
// disk-usage figure is a fine degradation and this file avoids adding a
// new child_process surface for a Tier 1 metric.
function collectHardwareMetrics() {
  const load = os.loadavg();
  return {
    cpu_load_1m: load[0],
    cpu_load_5m: load[1],
    cpu_load_15m: load[2],
    cpu_count: os.cpus().length,
    mem_total_bytes: os.totalmem(),
    mem_free_bytes: os.freemem(),
    uptime_seconds: Math.floor(os.uptime()),
    disk_usage: readDiskUsage(),
  };
}

// Reads /proc/meminfo-adjacent free-space info the cheap, dependency-free
// way on Linux (statfs isn't exposed by Node's fs module) - best-effort,
// returns null anywhere this doesn't apply (e.g. local dev on macOS),
// which is an accepted degradation per this file's header, not a bug.
function readDiskUsage() {
  try {
    const stat = fs.statfsSync('/');
    return {
      total_bytes: stat.blocks * stat.bsize,
      free_bytes: stat.bfree * stat.bsize,
    };
  } catch (e) {
    return null;
  }
}

function recordHardwareSnapshot() {
  return recordEvent('hardware_metrics', collectHardwareMetrics());
}

// Pushes up to SYNC_BATCH_SIZE unsynced rows from each outbox table.
// Never throws - a failed sync just leaves rows marked unsynced for the
// next tick, exactly the "log it, don't break vending" discipline
// licenseService.js's checkIn() already uses.
async function sync() {
  if (!TELEMETRY_SYNC_URL) return { attempted: false };
  if (!isEnabled()) return { attempted: false, reason: 'telemetry disabled' };

  const events = db.prepare('SELECT * FROM telemetry_outbox WHERE synced = 0 ORDER BY id LIMIT ?').all(SYNC_BATCH_SIZE);
  const errors = db.prepare('SELECT * FROM error_reports WHERE synced = 0 ORDER BY id LIMIT ?').all(SYNC_BATCH_SIZE);
  if (events.length === 0 && errors.length === 0) return { attempted: true, synced: 0 };

  try {
    const device = getDeviceIdentity();
    const res = await fetch(TELEMETRY_SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: device.id,
        events: events.map((e) => ({ id: e.id, event_type: e.event_type, payload: JSON.parse(e.payload_json), created_at: e.created_at })),
        errors: errors.map((e) => ({ id: e.id, error_type: e.error_type, message: e.message, stack: e.stack, context: JSON.parse(e.context_json), created_at: e.created_at })),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);

    const markSynced = db.transaction((table, rows) => {
      const stmt = db.prepare(`UPDATE ${table} SET synced = 1, synced_at = CURRENT_TIMESTAMP WHERE id = ?`);
      for (const row of rows) stmt.run(row.id);
    });
    markSynced('telemetry_outbox', events);
    markSynced('error_reports', errors);

    return { attempted: true, synced: events.length + errors.length };
  } catch (e) {
    console.error('[Telemetry] Sync failed (non-fatal, rows stay queued):', e.message);
    const bumpAttempts = db.transaction((table, rows) => {
      const stmt = db.prepare(`UPDATE ${table} SET attempts = attempts + 1 WHERE id = ?`);
      for (const row of rows) stmt.run(row.id);
    });
    bumpAttempts('telemetry_outbox', events);
    bumpAttempts('error_reports', errors);
    return { attempted: true, synced: 0, error: e.message };
  }
}

function getOutboxStatus() {
  const pendingEvents = db.prepare('SELECT COUNT(*) as c FROM telemetry_outbox WHERE synced = 0').get().c;
  const pendingErrors = db.prepare('SELECT COUNT(*) as c FROM error_reports WHERE synced = 0').get().c;
  return { enabled: isEnabled(), sync_configured: !!TELEMETRY_SYNC_URL, pending_events: pendingEvents, pending_errors: pendingErrors };
}

function start() {
  // Hardware snapshot every 15 minutes, sync attempt every 5 - both no-op
  // instantly if telemetry is disabled (the common case today), so this
  // is safe to always schedule rather than conditionally wiring it up.
  cron.schedule('*/15 * * * *', () => {
    recordHardwareSnapshot();
  });
  cron.schedule('*/5 * * * *', () => {
    sync();
  });
  console.log('📈 Telemetry service scheduled (currently ' + (isEnabled() ? 'enabled' : 'disabled, opt-in only') + ')');
}

module.exports = { recordEvent, recordError, collectHardwareMetrics, recordHardwareSnapshot, sync, getOutboxStatus, isEnabled, start };
