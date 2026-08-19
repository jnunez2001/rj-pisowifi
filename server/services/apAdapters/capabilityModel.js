// ===== AP CAPABILITY MODEL =====
// Per section 5/17: a capability response from the device is not proof a
// feature is usable right now - effective capability = hardware capability
// AND operation-mode-appropriate AND actually implemented by this adapter.
// e.g. an AX12 can support "router mode VPN server" in its firmware, but
// that's meaningless (and must show as unavailable) while it's running in
// AP mode as a StarkFi-managed access point.

const MONITORING_KEYS = ['device_status', 'clients', 'wireless', 'health', 'traffic'];
const MANAGEMENT_KEYS = ['ssid', 'password', 'channel', 'channel_width', 'tx_power', 'restart'];

function emptyCapabilities() {
  const monitoring = {};
  const management = {};
  for (const k of MONITORING_KEYS) monitoring[k] = false;
  for (const k of MANAGEMENT_KEYS) management[k] = false;
  return { monitoring, management };
}

// hardwareCaps: what the device's own capability endpoint reported.
// modeAvailability: which of those are actually meaningful in the
// device's CURRENT operation mode (e.g. router-only features go false in
// AP mode) - adapter-supplied, since only the adapter knows per-vendor
// mode rules.
// adapterSupport: which of those this specific adapter has actually
// implemented and tested (section 5: "Do not assume a capability simply
// because the firmware contains a similarly named feature").
function computeEffectiveCapabilities(hardwareCaps, modeAvailability, adapterSupport) {
  const effective = emptyCapabilities();
  for (const key of MONITORING_KEYS) {
    effective.monitoring[key] = !!(hardwareCaps?.monitoring?.[key] && modeAvailability?.monitoring?.[key] !== false && adapterSupport?.monitoring?.[key]);
  }
  for (const key of MANAGEMENT_KEYS) {
    effective.management[key] = !!(hardwareCaps?.management?.[key] && modeAvailability?.management?.[key] !== false && adapterSupport?.management?.[key]);
  }
  return effective;
}

// Section 6: three integration levels, derived from effective capabilities
// rather than stored separately - avoids the level and the capabilities
// ever disagreeing with each other.
function integrationLevel(effectiveCapabilities) {
  const hasAnyManagement = Object.values(effectiveCapabilities.management).some(Boolean);
  const hasAnyMonitoring = Object.values(effectiveCapabilities.monitoring).some(Boolean);
  if (hasAnyManagement) return 3; // Managed
  if (hasAnyMonitoring) return 2; // Monitored
  return 1; // Discovered
}

module.exports = { MONITORING_KEYS, MANAGEMENT_KEYS, emptyCapabilities, computeEffectiveCapabilities, integrationLevel };
