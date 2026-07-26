// ===== MIKROTIK DRIVER (interface adapter) =====
// Thin adapter over the existing mikrotikService.js — NOT a rewrite.
// mikrotikService.js is already more battle-tested than Tarakifi's own
// MikroTik driver (documented real-hardware bug fixes: MAC case-sensitivity,
// queue priority ordering, burst placement) — this file only makes its
// existing exports conform to the shared driver interface shape.

const mikrotikService = require('../mikrotikService');
const { defineDriver } = require('./driverInterface');

async function ping() {
  try {
    await mikrotikService.testConnection();
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = defineDriver('mikrotik', {
  ping,
  allowClient: mikrotikService.allowClient,
  blockClient: mikrotikService.blockClient,
  isClientAllowed: mikrotikService.isClientAllowed,
  setClientBandwidth: mikrotikService.setClientBandwidth,
  removeClientBandwidth: mikrotikService.removeClientBandwidth,
  getMacFromIp: mikrotikService.getMacFromIp,
});
