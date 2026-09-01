// ===== SATELLITE KIOSK SERVICE =====
// Registry for secondary coin-accepting stations (ESP32/ESP8266 boards)
// relaying credits back to this box over WiFi - see docs/tabs/satellite-
// kiosks.md. Deliberately opt-in: unregistered relay traffic (no
// device_key, or one that doesn't match) keeps working exactly as it
// always has, credited with no kiosk attribution, so pairing a kiosk here
// never breaks an ESP32 already deployed in the field.

const crypto = require('crypto');
const db = require('../config/database');

const ONLINE_WINDOW_MS = 5 * 60 * 1000; // last_seen within this = "online"

function generateDeviceKey() {
  return crypto.randomBytes(20).toString('hex'); // 40 hex chars
}

function maskKey(key) {
  return `••••••••${key.slice(-4)}`;
}

function isOnline(lastSeen) {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen + 'Z').getTime() < ONLINE_WINDOW_MS;
}

// List every registered kiosk with today's revenue attributed to it and a
// live online/offline read (not a stored, driftable status field).
function listKiosks() {
  // Bug found live: new Date().toISOString() is always UTC regardless of
  // the server's own OS timezone, while operators are commonly
  // Asia/Manila (UTC+8) - same "Today's Revenue" bug fixed on the main
  // Dashboard, here attributing a satellite kiosk's revenue to the wrong
  // calendar day for ~8 hours every local day. 'localtime' matches the
  // server's own OS timezone, same convention used elsewhere (timerService.js).
  const today = db.prepare("SELECT date('now', 'localtime') as d").get().d;
  const kiosks = db.prepare('SELECT * FROM satellite_kiosks ORDER BY created_at DESC').all();

  const revenueStmt = db.prepare(`
    SELECT COALESCE(SUM(coin_value), 0) as total, COUNT(*) as count
    FROM transactions WHERE kiosk_id = ? AND date(created_at, 'localtime') = ?
  `);

  return kiosks.map(k => {
    const revenue = revenueStmt.get(k.id, today);
    return {
      id: k.id,
      name: k.name,
      device_key_masked: maskKey(k.device_key),
      online: isOnline(k.last_seen),
      last_seen: k.last_seen,
      created_at: k.created_at,
      today_revenue: revenue.total,
      today_transactions: revenue.count,
    };
  });
}

// Returns the full (unmasked) device_key - only ever called right after
// creation, so the operator has exactly one chance to copy it into the
// ESP32's own config, same "shown once" discipline as an API key.
function createKiosk(name) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) {
    throw new Error('Kiosk name is required');
  }
  const deviceKey = generateDeviceKey();
  const result = db.prepare(
    'INSERT INTO satellite_kiosks (name, device_key) VALUES (?, ?)'
  ).run(trimmedName, deviceKey);

  return { id: result.lastInsertRowid, name: trimmedName, device_key: deviceKey };
}

function renameKiosk(id, name) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) {
    throw new Error('Kiosk name is required');
  }
  const result = db.prepare('UPDATE satellite_kiosks SET name = ? WHERE id = ?').run(trimmedName, id);
  if (result.changes === 0) {
    throw new Error('Kiosk not found');
  }
}

// Preserves transaction history (never deletes revenue records) - just
// detaches them from the kiosk being removed, same soft-delete discipline
// used everywhere else money-adjacent in this app.
function deleteKiosk(id) {
  db.prepare('UPDATE transactions SET kiosk_id = NULL WHERE kiosk_id = ?').run(id);
  const result = db.prepare('DELETE FROM satellite_kiosks WHERE id = ?').run(id);
  if (result.changes === 0) {
    throw new Error('Kiosk not found');
  }
}

// Called from the coin relay path on every request that carries a
// device_key. Returns the kiosk id to tag the transaction with, or null if
// the key is missing/unrecognized - callers treat null exactly like a
// legacy request with no key at all, never rejecting the credit itself.
function resolveDeviceKey(deviceKey) {
  if (!deviceKey) return null;
  const kiosk = db.prepare('SELECT id FROM satellite_kiosks WHERE device_key = ?').get(deviceKey);
  if (!kiosk) return null;
  db.prepare('UPDATE satellite_kiosks SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(kiosk.id);
  return kiosk.id;
}

module.exports = { listKiosks, createKiosk, renameKiosk, deleteKiosk, resolveDeviceKey };
