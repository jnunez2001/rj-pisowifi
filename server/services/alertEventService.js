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

const MAX_EVENTS_KEPT = 500;

function logAlertEvent(severity, code, title, detail = null) {
  try {
    db.prepare(
      'INSERT INTO alert_events (severity, code, title, detail) VALUES (?, ?, ?, ?)'
    ).run(severity, code, title, detail);

    db.prepare(`
      DELETE FROM alert_events WHERE id NOT IN (
        SELECT id FROM alert_events ORDER BY id DESC LIMIT ?
      )
    `).run(MAX_EVENTS_KEPT);
  } catch (e) {
    console.error('🔔 [AlertEvents] Failed to log alert event:', e.message);
  }
}

function getRecentAlertEvents(limit = 30) {
  return db.prepare(
    'SELECT id, severity, code, title, detail, created_at FROM alert_events ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

module.exports = { logAlertEvent, getRecentAlertEvents };
