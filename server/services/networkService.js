// ===== NETWORK SERVICE (driver dispatcher) =====
// Network backend is selectable per-deployment (Settings > Network Mode).
// This file used to branch `if (isMikrotikMode())` inline inside every
// function — Workstream 1 replaces that with a driver registry
// (server/services/drivers/*.js) so adding a new backend (pfSense, etc.)
// means adding one driver file, not editing every function here again.
// sessionService.js/timerService.js only ever import from this module, so
// they stay backend-agnostic exactly as before this refactor.

const { getDriver } = require('./drivers');

function getActiveDriver() {
  const db = require('../config/database');
  const mode = db.prepare("SELECT value FROM settings WHERE key = 'network_mode'").get()?.value || 'standalone';
  return getDriver(mode);
}

function normalizeMac(mac) {
  const normalizedMac = String(mac || '').trim().toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalizedMac)) {
    throw new Error(`Invalid MAC address: ${mac}`);
  }
  return normalizedMac;
}

// Preserves the exact reject/resolve behavior each caller already relies
// on from before this refactor (allowClient rejects on a bad MAC,
// blockClient/setClientBandwidth/removeClientBandwidth just log and
// resolve) — the drivers themselves also validate, this is only about not
// changing what callers observe.

function allowClient(mac) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    return Promise.reject(error);
  }
  return getActiveDriver().allowClient(normalizedMac);
}

function blockClient(mac) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    console.error('[Network] Invalid MAC during block:', error.message);
    return Promise.resolve();
  }
  return getActiveDriver().blockClient(normalizedMac);
}

function isClientAllowed(mac) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    return Promise.resolve(false);
  }
  return getActiveDriver().isClientAllowed(normalizedMac);
}

// trackDataUsage forces an individual per-client queue even when the rate
// matches the plain default (mikrotikService.js's shared-PCQ shortcut
// otherwise skips creating one) - needed so a Data-plan session's usage
// can actually be read back per client. Standalone/OpenWRT drivers ignore
// the extra argument (their tc class is already always per-client).
function setClientBandwidth(mac, downloadMbps, uploadMbps = downloadMbps, burst = null, trackDataUsage = false) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    console.error('[Network] Invalid MAC during shaping:', error.message);
    return Promise.resolve();
  }
  return getActiveDriver().setClientBandwidth(normalizedMac, downloadMbps, uploadMbps, burst, trackDataUsage);
}

function removeClientBandwidth(mac) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    console.error('[Network] Invalid MAC during cleanup:', error.message);
    return Promise.resolve();
  }
  return getActiveDriver().removeClientBandwidth(normalizedMac);
}

function getMacFromIp(ip) {
  return getActiveDriver().getMacFromIp(ip);
}

function listActiveClients() {
  return getActiveDriver().listActiveClients();
}

function ping() {
  return getActiveDriver().ping();
}

function checkRoam(mac) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    return Promise.resolve({ changed: false });
  }
  return getActiveDriver().checkRoam(normalizedMac);
}

module.exports = {
  allowClient,
  blockClient,
  isClientAllowed,
  setClientBandwidth,
  removeClientBandwidth,
  getMacFromIp,
  listActiveClients,
  ping,
  checkRoam,
};
