// ===== ROUTER DRIVER INTERFACE =====
// Ported from Tarakifi's drivers/base.py RouterDriver ABC (structure only,
// not code, that file is Python/asyncio, this is a plain JS contract).
// Each driver translates "allow this MAC" / "kick this MAC" / "shape this
// MAC's bandwidth" into whatever the target backend actually understands
// (local nftables/tc, MikroTik's binary API, SSH+nft/tc on OpenWRT, etc).
// sessionService.js/timerService.js only ever call through networkService.js
// (the dispatcher), never a driver directly, so they stay backend-agnostic.
//
// Drivers are plain objects, not classes with `new`, matches this app's
// existing module.exports-of-functions convention (mikrotikService.js,
// the pre-refactor networkService.js) instead of introducing OOP where
// nothing else in the codebase uses it.
//
// Required methods (a driver MUST implement these):
//   ping()                                          -> Promise<boolean>
//   allowClient(mac)                                -> Promise<void>
//   blockClient(mac)                                -> Promise<void>
//   isClientAllowed(mac)                             -> Promise<boolean>
//   setClientBandwidth(mac, downMbps, upMbps, burst) -> Promise<void>
//   removeClientBandwidth(mac)                       -> Promise<void>
//
// Optional methods (a driver MAY implement these; sensible no-op defaults
// below are used when it doesn't, mirrors Tarakifi's own set_bandwidth/
// clear_bandwidth default-no-op pattern for drivers without QoS support):
//   listActiveClients()  -> Promise<Array<{mac, ip, hostname}>>
//   getMacFromIp(ip)     -> Promise<string|null>
//   getIpFromMac(mac)    -> Promise<string|null>
//   checkRoam(mac)       -> Promise<{changed: boolean, oldIp, newIp}>
//     Only meaningful for drivers whose bandwidth shaping is bound to a
//     specific interface/IP at apply-time (standalone's tc/HTB) rather than
//     applied network-wide (MikroTik's Simple Queues follow the MAC
//     regardless of which lane/AP it's on), those drivers default to
//     "never changed" since there's nothing to repair.

const REQUIRED_METHODS = [
  'ping',
  'allowClient',
  'blockClient',
  'isClientAllowed',
  'setClientBandwidth',
  'removeClientBandwidth',
];

const OPTIONAL_DEFAULTS = {
  async listActiveClients() {
    return [];
  },
  async getMacFromIp() {
    return null;
  },
  async getIpFromMac() {
    return null;
  },
  async checkRoam() {
    return { changed: false };
  },
};

// Wraps a driver implementation, filling in optional-method defaults and
// failing loudly at load time (not at first call) if a required method is
// missing, catches a broken driver module during Workstream 1 development
// rather than surfacing as a mystery "X is not a function" mid-session.
function defineDriver(name, impl) {
  for (const method of REQUIRED_METHODS) {
    if (typeof impl[method] !== 'function') {
      throw new Error(`[Driver:${name}] Missing required method: ${method}`);
    }
  }
  return { name, ...OPTIONAL_DEFAULTS, ...impl };
}

module.exports = { defineDriver, REQUIRED_METHODS };
