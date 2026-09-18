// Alerts are never auto-deleted; only the manual delete-all removes them.
// Run: node --test --test-force-exit test/alerts.test.js
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starkfi-alerts-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const db = require('../server/config/database');
const alerts = require('../server/services/alertEventService');

const count = () => db.prepare('SELECT COUNT(*) n FROM alert_events').get().n;

test('alerts are never trimmed automatically (used to cap at 500)', () => {
  db.exec('DELETE FROM alert_events');
  for (let i = 0; i < 620; i++) alerts.logAlertEvent('info', 'coin_inserted', `Coin ${i}`, null);
  assert.strictEqual(count(), 620);
  assert.strictEqual(alerts.getRecentAlertEvents().length, 200);
  assert.strictEqual(alerts.getRecentAlertEvents(1000).length, 620);
});

test('clearAllAlertEvents deletes everything and records when', () => {
  assert.strictEqual(alerts.getAlertsClearedAt(), null);
  assert.strictEqual(alerts.clearAllAlertEvents(), 620);
  assert.strictEqual(count(), 0);
  assert.ok(alerts.getAlertsClearedAt());
  alerts.logAlertEvent('warning', 'x', 'After clear', null);
  assert.strictEqual(count(), 1);
});

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
