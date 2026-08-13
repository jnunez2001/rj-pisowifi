// ===== AP INTEGRATION SERVICE =====
// The one place that connects the vendor-neutral adapter contract
// (adapterInterface.js) to the real access_points table. Routes in
// server/routes/admin.js call this instead of touching an adapter or
// secretCrypto directly, matching the driver-registry pattern already used
// for router modes (see server/services/drivers/).

const db = require('../../config/database');
const { encryptSecret, decryptSecret } = require('../../utils/secretCrypto');
const { computeEffectiveCapabilities, integrationLevel } = require('./capabilityModel');

const ADAPTERS = {
  'tplink-ax12': require('./tplinkAx12Adapter'),
};

function getAdapter(adapterType) {
  const adapter = ADAPTERS[adapterType];
  if (!adapter) throw new Error(`No AP adapter registered for type "${adapterType}"`);
  return adapter;
}

// Unauthenticated fingerprint pass - tries every registered adapter's
// identify() against the given IP and returns the first match. Used before
// asking the administrator for a password, per section 6's "no credentials
// required to identify" rule.
async function identifyDevice(ip) {
  for (const [type, adapter] of Object.entries(ADAPTERS)) {
    const result = await adapter.identify(ip);
    if (result) return { adapterType: type, ...result };
  }
  return null;
}

// Authenticates once to prove the credentials work, stores them encrypted,
// and marks the AP row 'monitored' (never 'managed' - see the schema
// comment in database.js). Does not keep the session alive between calls;
// each poll re-authenticates, since the adapter's stok is short-lived and
// this service has no long-running process to cache it in.
async function adoptDevice(apId, adapterType, credentials) {
  const row = db.prepare('SELECT * FROM access_points WHERE id = ?').get(apId);
  if (!row) throw new Error('Access point not found');
  if (!row.ip_address) throw new Error('This AP has no IP address to connect to.');

  const adapter = getAdapter(adapterType);
  const { session } = await adapter.authenticate(row.ip_address, credentials);
  const capabilities = await adapter.getCapabilities(session);

  db.prepare(`
    UPDATE access_points
    SET adapter_type = ?, credentials_encrypted = ?, management_state = 'monitored',
        adapter_last_error = NULL, adapter_last_polled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(adapterType, encryptSecret(credentials.password), apId);

  return { capabilities, integrationLevel: integrationLevel(computeEffectiveCapabilities(capabilities, {}, adapterSupportFor(capabilities))) };
}

// Effective capabilities (section 5) need an "adapter support" mask too -
// for a Phase 1 read-only adapter this is just "whatever it reported it
// monitors", since none of these adapters implement management methods yet.
function adapterSupportFor(capabilities) {
  return { monitoring: capabilities.monitoring, management: {} };
}

function unadoptDevice(apId) {
  const row = db.prepare('SELECT * FROM access_points WHERE id = ?').get(apId);
  if (!row) throw new Error('Access point not found');
  db.prepare(`
    UPDATE access_points
    SET adapter_type = NULL, credentials_encrypted = NULL, management_state = 'unmanaged',
        adapter_last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(apId);
}

// Live read - re-authenticates, pulls device info/status/wireless/clients,
// and persists status/last_seen_at the same way the plain ICMP ping does so
// the rest of the Access Points UI doesn't need to know an adapter poll
// happened versus a ping. On failure, records adapter_last_error and leaves
// management_state as 'monitored' (a failed poll is not the same as never
// having been adopted - section 19's Offline vs AuthenticationFailed
// distinction matters here too).
async function pollDevice(apId) {
  const row = db.prepare('SELECT * FROM access_points WHERE id = ?').get(apId);
  if (!row) throw new Error('Access point not found');
  if (!row.adapter_type || !row.credentials_encrypted) {
    throw new Error('This AP has not been adopted by an adapter yet.');
  }
  const adapter = getAdapter(row.adapter_type);
  const password = decryptSecret(row.credentials_encrypted);

  try {
    const { session } = await adapter.authenticate(row.ip_address, { password });
    const [deviceInfo, status, operationMode, network, wireless, clients, health] = await Promise.all([
      adapter.getDeviceInfo(session),
      adapter.getStatus(session),
      adapter.getOperationMode(session),
      adapter.getNetwork(session),
      adapter.getWireless(session),
      adapter.getClients(session),
      adapter.getHealth(session),
    ]);

    db.prepare(`
      UPDATE access_points
      SET status = 'online', last_seen_at = CURRENT_TIMESTAMP, adapter_last_error = NULL,
          adapter_last_polled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
          vendor = COALESCE(vendor, ?), model = COALESCE(model, ?)
      WHERE id = ?
    `).run(deviceInfo.vendor || null, deviceInfo.model || null, apId);

    return { deviceInfo, status, operationMode, network, wireless, clients, health };
  } catch (err) {
    db.prepare(`
      UPDATE access_points
      SET status = 'offline', adapter_last_error = ?, adapter_last_polled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(err.message || String(err), apId);
    throw err;
  }
}

module.exports = { identifyDevice, adoptDevice, unadoptDevice, pollDevice, ADAPTERS };
