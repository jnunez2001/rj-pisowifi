// ===== AP ADAPTER INTERFACE =====
// Per AP_INTEGRATION_ARCHITECTURE.md section 4/32: ZenFi Core must never
// contain vendor-specific API calls directly - every AP integration goes
// through this normalized contract, the same discipline server/services/
// drivers/driverInterface.js already uses for router drivers (allow/block/
// shape a client the same way regardless of standalone/MikroTik/OpenWRT
// underneath). A future AP vendor only needs to implement this contract,
// not touch anything in the Access Points page or AP Integration Service.

const REQUIRED_METHODS = [
  'identify',       // (ip) -> Promise<{vendor, model, confidence} | null> - no credentials
  'authenticate',   // (ip, credentials) -> Promise<{session}> - throws on failure
  'getCapabilities', // (session) -> Promise<CapabilityModel> - see capabilityModel.js
  'getDeviceInfo',  // (session) -> Promise<{vendor, model, firmware, mac}>
  'getStatus',      // (session) -> Promise<{online, cpuPercent, memPercent}>
  'getOperationMode', // (session) -> Promise<'router'|'ap'|'unknown'>
  'getNetwork',     // (session) -> Promise<{lanIp, lanMac, lanNetmask}>
  'getWireless',    // (session) -> Promise<{band2g: {...}|null, band5g: {...}|null}>
  'getClients',      // (session) -> Promise<Array<NormalizedClient>> - see section 13
  'getHealth',      // (session) -> Promise<{cpuPercent, memPercent}>
];

// Management methods are optional and capability-gated (section 4: "Do not
// expose a management function in the UI unless the adapter reports that
// the device supports it") - a Phase-1 read-only adapter implements none
// of these, and defineApAdapter() fills in a clear "not supported" default
// for each so callers never hit "X is not a function".
const OPTIONAL_MANAGEMENT_METHODS = [
  'setSSID', 'setPassword', 'setChannel', 'setChannelWidth',
  'setTxPower', 'enableRadio', 'disableRadio', 'restart',
];

class UnsupportedOperationError extends Error {
  constructor(adapterName, method) {
    super(`${adapterName} adapter does not support ${method} (Phase 1 is read-only, or this device's capabilities don't include it)`);
    this.name = 'UnsupportedOperationError';
  }
}

function defineApAdapter(name, impl) {
  for (const method of REQUIRED_METHODS) {
    if (typeof impl[method] !== 'function') {
      throw new Error(`[APAdapter:${name}] Missing required method: ${method}`);
    }
  }
  const managementDefaults = {};
  for (const method of OPTIONAL_MANAGEMENT_METHODS) {
    managementDefaults[method] = async () => {
      throw new UnsupportedOperationError(name, method);
    };
  }
  return { name, ...managementDefaults, ...impl };
}

module.exports = { defineApAdapter, REQUIRED_METHODS, OPTIONAL_MANAGEMENT_METHODS, UnsupportedOperationError };
