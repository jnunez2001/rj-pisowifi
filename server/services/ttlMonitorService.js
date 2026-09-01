// ===== ANTI-TETHERING DETECTION (BETA) =====
// Standalone mode ONLY - this box has to sit inline on the LAN as the
// actual gateway to capture raw packets at all. In Controller mode
// (MikroTik/OpenWRT), this box is a separate management server that
// never sees customer packets directly, so there's nothing for this
// service to inspect there - it simply never starts in that mode.
//
// Log/alert only, per the owner's explicit choice this round: this
// never blocks, throttles, or otherwise touches a session. It exists to
// answer "does this actually happen, and is detection reliable on real
// hardware" before anything acts on it automatically.
//
// Technique: a brief passive capture of a few packets from each active
// session's IP, reading the reported IP TTL. Devices decrement TTL by
// exactly 1 per router hop; a value one below a common OS default
// (64 Linux/Android/iOS, 128 Windows, 255 some routers/IoT) suggests the
// packet passed through an extra hop - i.e., forwarded by a tethering
// device rather than sent directly. This is a heuristic, not proof -
// asymmetric routing or an already-nonstandard TTL can false-positive,
// which is exactly why this stays log-only for now.
const { execFile } = require('child_process');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // much coarser than the 30s billing tick - this is a lightweight spot-check, not a control loop
const COMMON_DEFAULT_TTLS = [64, 128, 255];
let intervalHandle = null;

function isEnabled() {
  const db = require('../config/database');
  return db.prepare("SELECT value FROM settings WHERE key = 'enable_tethering_detection'").get()?.value === '1';
}

function isStandaloneMode() {
  const db = require('../config/database');
  return (db.prepare("SELECT value FROM settings WHERE key = 'network_mode'").get()?.value || 'standalone') === 'standalone';
}

function getLanInterface() {
  const db = require('../config/database');
  return db.prepare("SELECT value FROM settings WHERE key = 'lan_interface'").get()?.value ||
    process.env.LAN_IF || 'enp0s8';
}

// Runs `tcpdump -c 3 -n src host <ip>` and parses the first reported
// `ttl <N>` value, or null if nothing came back in time (device idle,
// no packets to sample this round - not an error, just try again next
// interval).
function sampleTtl(ip, lanIf) {
  return new Promise((resolve) => {
    execFile('tcpdump', ['-i', lanIf, '-n', '-c', '3', '-v', 'src', 'host', ip], { timeout: 8000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const match = stdout.match(/ttl\s+(\d+)/i);
      resolve(match ? parseInt(match[1], 10) : null);
    });
  });
}

function nearestDefaultTtl(observed) {
  return COMMON_DEFAULT_TTLS.reduce((closest, def) =>
    Math.abs(def - observed) < Math.abs(closest - observed) ? def : closest
  , COMMON_DEFAULT_TTLS[0]);
}

async function checkOnce() {
  if (!isEnabled() || !isStandaloneMode()) return;

  const db = require('../config/database');
  const lanIf = getLanInterface();
  const sessions = db.prepare("SELECT voucher_code, mac_address, ip_address FROM sessions WHERE is_paused = 0 AND ip_address IS NOT NULL AND ip_address != ''").all();

  for (const session of sessions) {
    try {
      const observed = await sampleTtl(session.ip_address, lanIf);
      if (observed == null) continue;

      const nearest = nearestDefaultTtl(observed);
      if (observed === nearest - 1) {
        const { logAlertEvent } = require('./alertEventService');
        logAlertEvent(
          'info',
          'possible_tethering_detected',
          `Possible tethering: ${session.mac_address}`,
          `Observed TTL ${observed} (one below the common default of ${nearest}) suggests this device's traffic passed through an extra router hop - it may be sharing its connection with other devices. This is a heuristic, not certain - no action has been taken on this session.`
        );
      }
    } catch (e) {
      console.error(`TTL check failed for ${session.mac_address}:`, e.message);
    }
  }
}

function start() {
  if (intervalHandle) return; // already running
  intervalHandle = setInterval(() => {
    checkOnce().catch((e) => console.error('Anti-tethering check error:', e.message));
  }, CHECK_INTERVAL_MS);
  console.log('🔍 Anti-tethering detection service started (log-only, standalone mode)');
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { start, stop, checkOnce };
