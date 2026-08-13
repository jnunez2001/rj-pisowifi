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
  const today = new Date().toISOString().split('T')[0];
  // Excludes 'candidate' rows (see registerCandidate/listCandidates below) -
  // an un-adopted candidate has no real device_key yet and shouldn't appear
  // as a registered kiosk until an admin actually adopts it.
  const kiosks = db.prepare("SELECT * FROM satellite_kiosks WHERE status = 'adopted' ORDER BY created_at DESC").all();

  const revenueStmt = db.prepare(`
    SELECT COALESCE(SUM(coin_value), 0) as total, COUNT(*) as count
    FROM transactions WHERE kiosk_id = ? AND date(created_at) = ?
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

// ===== VENDO DISCOVERY / ADOPTION (see server/services/vendoDiscoveryService.js) =====
// A candidate row has no real device_key yet - device_key's UNIQUE NOT NULL
// constraint still needs a value, so a placeholder ('candidate:<mac>')
// fills it until adoption issues the real key. A placeholder never matches
// a real key format (real keys are 40 hex chars from generateDeviceKey()),
// so resolveDeviceKey() can never accidentally attribute a coin credit to
// an unadopted candidate.
function candidatePlaceholderKey(mac) {
  return `candidate:${mac}`;
}

// Called from POST /api/vendo/announce (public, unauthenticated by design -
// discovery must not require trust to even be seen, see the module's own
// "Discovery must NOT establish trust by itself" principle). Upserts by MAC
// so a device that re-announces (reboot, still un-adopted) doesn't create a
// duplicate candidate row each time.
function registerCandidate({ mac, firmwareVersion, hardware }) {
  const normalizedMac = String(mac || '').toLowerCase().trim();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalizedMac)) {
    throw new Error('Valid MAC address required');
  }
  const existing = db.prepare('SELECT id, status FROM satellite_kiosks WHERE mac_address = ?').get(normalizedMac);
  if (existing) {
    // Already adopted - re-announcing shouldn't demote it back to a
    // candidate or touch its real device_key.
    if (existing.status === 'adopted') {
      db.prepare('UPDATE satellite_kiosks SET last_seen = CURRENT_TIMESTAMP, firmware_version = ? WHERE id = ?')
        .run(firmwareVersion || null, existing.id);
      return { id: existing.id, status: 'adopted' };
    }
    db.prepare('UPDATE satellite_kiosks SET last_seen = CURRENT_TIMESTAMP, firmware_version = ? WHERE id = ?')
      .run(firmwareVersion || null, existing.id);
    return { id: existing.id, status: 'candidate' };
  }

  const result = db.prepare(`
    INSERT INTO satellite_kiosks (name, device_key, mac_address, firmware_version, hardware, status, discovered_via, last_seen)
    VALUES (?, ?, ?, ?, ?, 'candidate', 'zenfi-vendo-discovery', CURRENT_TIMESTAMP)
  `).run(`New Vendo (${normalizedMac})`, candidatePlaceholderKey(normalizedMac), normalizedMac, firmwareVersion || null, hardware || null);

  return { id: result.lastInsertRowid, status: 'candidate' };
}

function listCandidates() {
  return db.prepare("SELECT id, name, mac_address, firmware_version, hardware, last_seen FROM satellite_kiosks WHERE status = 'candidate' ORDER BY last_seen DESC").all();
}

// Same "shown once" discipline as createKiosk() - issues the real
// device_key and flips the row from candidate to adopted. The admin still
// has to get this key onto the physical device (e.g. its own config page,
// same manual step createKiosk() already required) - adoption here only
// approves the device and generates the credential, it doesn't push it to
// the device automatically (no such transport exists yet).
function adoptCandidate(id, name) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) {
    throw new Error('Name is required');
  }
  const candidate = db.prepare("SELECT id FROM satellite_kiosks WHERE id = ? AND status = 'candidate'").get(id);
  if (!candidate) {
    throw new Error('Candidate not found');
  }
  const deviceKey = generateDeviceKey();
  db.prepare("UPDATE satellite_kiosks SET name = ?, device_key = ?, status = 'adopted' WHERE id = ?")
    .run(trimmedName, deviceKey, id);
  return { id, name: trimmedName, device_key: deviceKey };
}

module.exports = { listKiosks, createKiosk, renameKiosk, deleteKiosk, resolveDeviceKey, registerCandidate, listCandidates, adoptCandidate };
