// ===== WATCHDOG / SELF-HEAL SERVICE =====
// Periodic health check for the box's own network-access-control state.
// Two kinds of remediation only, deliberately:
//  - narrow, well-understood repairs that are already normal driver
//    operations (re-applying one active session's network access) run
//    automatically, capped, so a burst of repairs can't mask a real
//    hardware problem behind an endless retry loop.
//  - anything bigger (the firewall table itself missing) is never
//    auto-rebuilt from here — that ruleset lives in setup-network.sh and
//    depends on interface/lane detection this service has no business
//    replicating unattended. It's surfaced as a critical alert instead,
//    per the "backup/confirm before risky changes" reliability rule.

const cron = require('node-cron');
const os = require('os');
const { execFile } = require('child_process');
const db = require('../config/database');
const networkService = require('./networkService');

const CHECK_INTERVAL_CRON = '*/2 * * * *'; // every 2 minutes
const MAX_AUTO_FIXES_PER_WINDOW = 3;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MIN_FREE_DISK_MB = 200;
const MAX_EVENTS_KEPT = 500;

// A full IP/NIC loss (e.g. a flaky USB-Ethernet adapter dropping its link)
// takes this box offline for every customer, not just one session - it gets
// its own, more cautious escalation ladder instead of the general
// per-session auto-fix cap above: one bad check is treated as a transient
// blip and ignored, two in a row triggers a lightweight interface reset,
// and only if that doesn't bring the IP back does it escalate to a full
// restart - capped hard, so a genuinely dead adapter gets flagged instead
// of reboot-looping forever.
const MAX_REBOOTS_PER_WINDOW = 1;
const REBOOT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

let fixTimestamps = [];
let rebootTimestamps = [];
let lastKnownGoodInterfaces = new Set();
let consecutiveIpMissing = 0;
let ipRecoveryStage = 'none'; // 'none' | 'bounced'
let lastResult = { at: null, status: 'unknown', issues: [] };

function pruneFixTimestamps() {
  const cutoff = Date.now() - WINDOW_MS;
  fixTimestamps = fixTimestamps.filter((t) => t > cutoff);
}

function canAutoFix() {
  pruneFixTimestamps();
  return fixTimestamps.length < MAX_AUTO_FIXES_PER_WINDOW;
}

function recordAutoFix() {
  fixTimestamps.push(Date.now());
}

function getNetworkMode() {
  return db.prepare("SELECT value FROM settings WHERE key = 'network_mode'").get()?.value || 'standalone';
}

async function checkFirewallReachable() {
  try {
    return await networkService.ping();
  } catch (e) {
    return false;
  }
}

// Every active (not paused, not hard-expired) session's MAC should
// currently be allowed on the network. If one has silently dropped out of
// the allow set (e.g. ephemeral nftables state lost across a reboot), this
// re-applies it via the exact same allowClient() call sessionService
// already makes on session creation — not a new code path.
async function repairActiveSessionAccess() {
  const now = new Date().toISOString();
  const activeSessions = db.prepare(`
    SELECT mac_address FROM sessions
    WHERE hard_expires_at > ? AND is_paused = 0
  `).all(now);

  const repaired = [];
  for (const session of activeSessions) {
    if (!canAutoFix()) break;
    try {
      const allowed = await networkService.isClientAllowed(session.mac_address);
      if (!allowed) {
        await networkService.allowClient(session.mac_address);
        recordAutoFix();
        repaired.push(session.mac_address);
        console.warn(`🛡️ [Watchdog] Re-applied network access for ${session.mac_address} (was unexpectedly blocked)`);
      }
    } catch (e) {
      console.error(`🛡️ [Watchdog] Failed to check/repair access for ${session.mac_address}:`, e.message);
    }
  }
  return repaired;
}

function getNonInternalIPv4Interfaces() {
  const nets = os.networkInterfaces();
  const found = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        found.push(name);
        break;
      }
    }
  }
  return found;
}

function canReboot() {
  const cutoff = Date.now() - REBOOT_WINDOW_MS;
  rebootTimestamps = rebootTimestamps.filter((t) => t > cutoff);
  return rebootTimestamps.length < MAX_REBOOTS_PER_WINDOW;
}

function bounceInterface(name) {
  return new Promise((resolve) => {
    execFile('ip', ['link', 'set', name, 'down'], () => {
      setTimeout(() => {
        execFile('ip', ['link', 'set', name, 'up'], (err) => resolve(!err));
      }, 1000);
    });
  });
}

async function checkNetworkReachability() {
  const issues = [];
  const live = getNonInternalIPv4Interfaces();

  if (live.length > 0) {
    lastKnownGoodInterfaces = new Set(live);
    consecutiveIpMissing = 0;
    ipRecoveryStage = 'none';
    return issues;
  }

  consecutiveIpMissing += 1;

  if (consecutiveIpMissing < 2) {
    issues.push({
      severity: 'warning',
      code: 'ip_missing_transient',
      message: 'No network IP address detected on this check. Waiting for a second consecutive miss before acting.',
    });
    return issues;
  }

  if (os.platform() !== 'linux') {
    issues.push({
      severity: 'critical',
      code: 'ip_missing_no_auto_recovery',
      message: 'No network IP address detected for multiple checks. Automatic recovery is only available on the deployed Linux platform, not this environment.',
    });
    return issues;
  }

  if (ipRecoveryStage === 'none') {
    const targets = [...lastKnownGoodInterfaces];
    if (targets.length === 0) {
      ipRecoveryStage = 'bounced';
      issues.push({
        severity: 'critical',
        code: 'ip_missing_no_known_interface',
        message: 'No network IP address on any interface, and no previously-seen interface to reset. This likely needs a manual restart.',
      });
      return issues;
    }

    let anyBounced = false;
    for (const name of targets) {
      const ok = await bounceInterface(name);
      if (ok) anyBounced = true;
    }
    ipRecoveryStage = 'bounced';
    issues.push({
      severity: 'critical',
      code: anyBounced ? 'ip_missing_interface_bounced' : 'ip_missing_bounce_failed',
      message: anyBounced
        ? `No network IP address for multiple checks. Reset network interface(s) [${targets.join(', ')}] and rechecking.`
        : `No network IP address, and resetting interface(s) [${targets.join(', ')}] failed (this account may lack permission). Will attempt a full restart next if it's still down.`,
    });
    return issues;
  }

  // Already reset the interface on a prior check and it's still down.
  if (!canReboot()) {
    issues.push({
      severity: 'critical',
      code: 'ip_missing_reboot_rate_limited',
      message: 'Network is still down after an interface reset, and an automatic restart has already been used recently. Auto-recovery is paused - this needs a manual check, likely a failing network adapter.',
    });
    return issues;
  }

  issues.push({
    severity: 'critical',
    code: 'ip_missing_rebooting',
    message: 'Network is still down after an interface reset. Restarting the system automatically to restore connectivity.',
  });
  rebootTimestamps.push(Date.now());
  setTimeout(() => {
    execFile('reboot', [], (err) => {
      if (err) console.error('🛡️ [Watchdog] Reboot command failed (this account likely lacks permission to reboot):', err.message);
    });
  }, 2000);
  return issues;
}

function checkDiskSpace() {
  return new Promise((resolve) => {
    execFile('df', ['-Pm', '.'], (err, stdout) => {
      if (err) { resolve(null); return; }
      const lines = String(stdout).trim().split('\n');
      const parts = lines[lines.length - 1].trim().split(/\s+/);
      const availableMb = parseInt(parts[3], 10);
      resolve(Number.isFinite(availableMb) ? availableMb : null);
    });
  });
}

function persistResult(status, issues) {
  lastResult = { at: new Date().toISOString(), status, issues };
  try {
    db.prepare('INSERT INTO watchdog_events (status, issues_json) VALUES (?, ?)')
      .run(status, JSON.stringify(issues));
    // Keep the table from growing unbounded on a long-running box.
    db.prepare(`
      DELETE FROM watchdog_events WHERE id NOT IN (
        SELECT id FROM watchdog_events ORDER BY id DESC LIMIT ?
      )
    `).run(MAX_EVENTS_KEPT);
  } catch (e) {
    console.error('🛡️ [Watchdog] Failed to persist health check result:', e.message);
  }
}

async function runHealthCheck() {
  const issues = [];
  const mode = getNetworkMode();

  issues.push(...(await checkNetworkReachability()));

  // MikroTik/pfSense own their own access-control state on external
  // hardware — this box isn't the source of truth for it, so the
  // firewall-reachability + per-session repair checks only apply where
  // this box itself enforces access (standalone/OpenWRT).
  if (mode === 'standalone' || mode === 'openwrt') {
    const reachable = await checkFirewallReachable();
    if (!reachable) {
      issues.push({
        severity: 'critical',
        code: 'firewall_unreachable',
        message: 'The network access-control table is missing or unreachable. WiFi access enforcement may not be working. This needs manual attention — re-run network setup.',
      });
      console.error('🛡️ [Watchdog] Firewall/network driver unreachable — not attempting an automatic full rebuild (too risky to do unattended). Run setup-network.sh manually.');
    } else {
      const repaired = await repairActiveSessionAccess();
      if (repaired.length) {
        issues.push({
          severity: 'warning',
          code: 'sessions_repaired',
          message: `Re-applied network access for ${repaired.length} active session(s) whose firewall entry had unexpectedly dropped.`,
        });
      }

      // A customer's internet access already follows them across every
      // AP/lane by design (shared allow-list) - this repairs their speed
      // cap doing the same, since tc/HTB shaping is bound to whichever
      // interface their IP was on when it was applied.
      const reshaped = await require('./sessionService').repairRoamedSessions();
      if (reshaped.length) {
        issues.push({
          severity: 'warning',
          code: 'bandwidth_reshaped_after_roam',
          message: `Re-applied speed limits for ${reshaped.length} session(s) that moved to a different access point.`,
        });
      }
    }
  }

  const freeMb = await checkDiskSpace();
  if (freeMb !== null && freeMb < MIN_FREE_DISK_MB) {
    issues.push({
      severity: 'critical',
      code: 'low_disk_space',
      message: `Only ${freeMb}MB of disk space left. The system may fail to save new sessions/transactions soon — free up space or expand storage.`,
    });
  }

  if (!canAutoFix()) {
    issues.push({
      severity: 'warning',
      code: 'auto_fix_rate_limited',
      message: 'Multiple automatic repairs were needed in a short window and further auto-repair has been paused to avoid masking a real hardware problem. Manual check recommended.',
    });
  }

  const status = issues.some((i) => i.severity === 'critical')
    ? 'critical'
    : issues.length > 0
      ? 'warning'
      : 'ok';

  persistResult(status, issues);
  return lastResult;
}

function start() {
  cron.schedule(CHECK_INTERVAL_CRON, () => {
    runHealthCheck().catch((e) => console.error('🛡️ [Watchdog] Health check crashed:', e.message));
  });
  // Run once immediately at boot too, not just on the first cron tick.
  runHealthCheck().catch((e) => console.error('🛡️ [Watchdog] Initial health check failed:', e.message));
  console.log('🛡️ [Watchdog] Self-heal service started');
}

function getLastResult() {
  return lastResult;
}

module.exports = { start, getLastResult, runHealthCheck };
