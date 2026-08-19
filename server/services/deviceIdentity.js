// ===== DEVICE IDENTITY =====
// Local half of device binding (Workstream 11's spec). Generates a stable
// ID for THIS physical box once, on first boot, and persists it - so an
// entire SD card / disk image copied onto different hardware can be
// detected as running somewhere it wasn't licensed for, instead of just
// silently working.
//
// This file only creates and stores the ID. It does not enforce anything
// by itself - enforcement (refusing to fully function on a mismatched
// device, or requiring a signed license tied to this ID) needs a central
// authority the local box doesn't control, which is why it's deliberately
// left out here rather than faked with a client-side-only check. A local
// check can always be patched by whoever has root on the box, obfuscated
// or not - real enforcement is a server-side concern for later
// (starkfi-platform, Workstream 5/11), not something this file pretends to
// solve alone.
//
// Kept deliberately lightweight: a hash, not Tarakifi's own heavier
// phone-home/license-file/grace-period machinery (explicitly out of scope
// per this app's own ground rules - freemium/take-rate, not SaaS-license
// enforcement).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const DATA_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, '../database');
const IDENTITY_PATH = process.env.DEVICE_IDENTITY_PATH || path.join(DATA_DIR, '.device-identity');

let cached = null;

// Prefers a real hardware serial (survives a MAC change from a swapped NIC
// or a new network config) over a MAC address, falls back to MAC only if
// no hardware serial is readable (common on generic PCs/VMs), and falls
// back to a random ID as a last resort (still stable once generated and
// persisted, just not tied to anything physical - matches this file's own
// "detect, don't fake" principle: better an honest random ID than a fake
// hardware-derived one on hardware that doesn't expose one).
function readHardwareSerial() {
  if (process.platform !== 'linux') return null;
  const candidates = [
    '/sys/firmware/devicetree/base/serial-number', // Raspberry Pi / most ARM SBCs
    '/etc/machine-id', // systemd machine ID, stable per-install
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8').replace(/\0/g, '').trim();
      if (raw) return raw;
    } catch (e) {}
  }
  try {
    // DMI product UUID - present on most x86 boards, not ARM SBCs.
    const raw = execSync('cat /sys/class/dmi/id/product_uuid 2>/dev/null').toString().trim();
    if (raw) return raw;
  } catch (e) {}
  return null;
}

function readPrimaryMac() {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      if (name === 'lo' || name.startsWith('docker') || name.startsWith('veth')) continue;
      for (const iface of nets[name]) {
        if (iface.mac && iface.mac !== '00:00:00:00:00:00') return iface.mac;
      }
    }
  } catch (e) {}
  return null;
}

function generateDeviceId() {
  const source = readHardwareSerial() || readPrimaryMac();
  const material = source || crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(material).digest('hex').slice(0, 16).toUpperCase();
  return {
    id: `STARKFI-${hash}`,
    // Recorded honestly - a random-fallback ID means this box's identity
    // isn't tied to anything physical (e.g. a VM with no readable serial
    // and no real NIC), worth knowing later if this ID ever needs
    // trusting for something license-related.
    source: source ? (readHardwareSerial() ? 'hardware_serial' : 'mac_address') : 'random_fallback',
  };
}

// Returns the persisted device identity, generating and saving it once on
// first call if it doesn't exist yet. Deliberately never regenerates once
// created - identity must stay stable across reboots/restarts for binding
// to mean anything.
function getDeviceIdentity() {
  if (cached) return cached;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {}
  try {
    const raw = fs.readFileSync(IDENTITY_PATH, 'utf8');
    cached = JSON.parse(raw);
    return cached;
  } catch (e) {
    const generated = generateDeviceId();
    cached = { ...generated, created_at: new Date().toISOString() };
    try {
      fs.writeFileSync(IDENTITY_PATH, JSON.stringify(cached, null, 2), { mode: 0o600 });
    } catch (writeErr) {
      console.error('[DeviceIdentity] Failed to persist device identity:', writeErr.message);
    }
    return cached;
  }
}

module.exports = { getDeviceIdentity };
