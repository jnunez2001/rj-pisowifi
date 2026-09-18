// ===== ALERT EVENT LOG =====
// Persisted event/alert history backing the admin panel's notification
// bell. Every row here is a real, one-off occurrence or a genuine state
// transition - never a synthetic/placeholder entry. See CREATE TABLE
// alert_events in server/config/database.js for the shape.
//
// Event codes currently wired in:
//   vendo_connected / vendo_disconnected  - watchdogService.js (last_seen edge)
//   vendo_candidate_detected              - admin.js POST /vendo/register
//   coin_inserted                         - coinCreditService.js
//   suspicious_coin_activity              - coinCreditService.js (burst detector)
//   <watchdog issue code> / issue_resolved - watchdogService.js (edge-triggered)
//
// Reserved but not yet wired (no real trigger exists for these today - do
// not fabricate one just to fill the category):
//   update_available - would hook into an update-check mechanism; none
//     exists yet in updateRollbackService.js as of this writing.
//   team_message      - a future "message from the StarkFi team" channel.
//     Never populate this with placeholder/sample content.

const db = require('../config/database');

function logAlertEvent(severity, code, title, detail = null) {
  try {
    db.prepare(
      'INSERT INTO alert_events (severity, code, title, detail) VALUES (?, ?, ?, ?)'
    ).run(severity, code, title, detail);
    // Alerts are never removed automatically (used to be trimmed to the
    // newest 500 here); they stay until the admin deletes them with the
    // trash button on the bell (clearAllAlertEvents below).
  } catch (e) {
    console.error('🔔 [AlertEvents] Failed to log alert event:', e.message);
  }
}

function getRecentAlertEvents(limit = 200) {
  return db.prepare(
    'SELECT id, severity, code, title, detail, created_at FROM alert_events ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

// Manual "delete all" from the notification bell. Also records when it
// happened so watchdog-derived alerts (which live in watchdog_events, a log
// other pages still read) are hidden from the bell without deleting that log.
function clearAllAlertEvents() {
  const deleted = db.prepare('DELETE FROM alert_events').run().changes;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('alerts_cleared_at', datetime('now'))").run();
  return deleted;
}

function getAlertsClearedAt() {
  return db.prepare("SELECT value FROM settings WHERE key = 'alerts_cleared_at'").get()?.value || null;
}

module.exports = { logAlertEvent, getRecentAlertEvents, clearAllAlertEvents, getAlertsClearedAt };
