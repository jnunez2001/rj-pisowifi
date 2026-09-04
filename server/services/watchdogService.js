// ===== WATCHDOG / SELF-HEAL SERVICE =====
// Periodic health check for the box's own network-access-control state.
// Two kinds of remediation only, deliberately:
//  - narrow, well-understood repairs that are already normal driver
//    operations (re-applying one active session's network access) run
//    automatically, capped, so a burst of repairs can't mask a real
//    hardware problem behind an endless retry loop.
//  - anything bigger (the firewall table itself missing) is never
//    auto-rebuilt from here on a hunch. The one deliberate exception is
//    the IP-recovery ladder below: a total loss of network connectivity
//    takes the box offline for every customer, so as a capped, ordered
//    escalation (bounce interface, THEN re-run setup-network.sh, THEN
//    reboot only as a last resort) it's allowed to re-apply the same
//    setup-network.sh every normal boot already runs - never triggered
//    speculatively, only after two consecutive "no IP at all" checks.
//    Anything not on that specific ladder is still surfaced as a
//    critical alert instead of touched automatically, per the "backup/
//    confirm before risky changes" reliability rule.

const cron = require('node-cron');
const os = require('os');
const path = require('path');
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
let ipRecoveryStage = 'none'; // 'none' | 'bounced' | 'script_reapplied'
let lastResult = { at: null, status: 'unknown', issues: [] };
let lastIssueCodes = new Set();
let lastOnlineVendoMacs = new Set();
let hasSweptVendoConnectivityOnce = false;
// Real brownout report: a vendo's ESP8266 can come back up with its
// outbound heartbeat (registerVendo(), a plain HTTPClient POST) working
// fine while its own inbound ESP8266WebServer listener stays wedged - a
// known failure mode where the WiFi/TCP stack comes out of a brownout in a
// half-broken state. The Devices page's "online" status is derived purely
// from that heartbeat (last_seen), so it kept showing the vendo as online
// while every real customer's Insert Coin press hit a generic "Vendo
// offline" toast with nothing pointing an operator at the actual cause.
// Tracked the same way mikrotikUnreachableSince above is (in-memory only,
// self-heals on its own recovery, no restart-survival needed) but keyed
// per-vendo mac since more than one can exist.
let vendoInboundUnreachableSince = {};
let vendoRemoteRestartAttemptAt = {};
const VENDO_INBOUND_STUCK_MS = 6 * 60 * 1000; // 3 consecutive 2-min checks
const VENDO_REMOTE_RESTART_RETRY_MS = 10 * 60 * 1000;
// Outage compensation, Controller-mode half (server/services/timerService.js
// has the server-restart half). Tracks when the MikroTik router FIRST
// became unreachable - in-memory only is fine here, unlike the restart
// case, since this condition self-heals on its own recovery within the
// same running process, nothing to survive across a restart.
let mikrotikUnreachableSince = null;
const VENDO_ONLINE_WINDOW_MS = 3 * 60 * 1000; // matches devices.js's isOnline() 3-minute window

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
// already makes on session creation, not a new code path.
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

// Real gap found live: this box's interfaces have their OS-level network
// management (NetworkManager/systemd-networkd) explicitly turned OFF by
// setup-network.sh (disable_os_network_management) - setup-network.sh
// itself is the only thing that ever calls dhclient or assigns a static
// IP on them. bounceInterface() above just toggles link state up/down;
// with nothing managing the interface, that alone does nothing to
// actually request a new lease or reapply a configured static IP, a real
// case where the bounce silently accomplished nothing and the ladder
// escalated straight to a full reboot as the only remaining option.
//
// Re-running setup-network.sh is strictly LESS disruptive than that
// reboot it used to jump to - it already knows how to bring an interface
// back up correctly (the operator's configured static IP if one exists,
// otherwise DHCP), it's what re-applies on every normal boot anyway, and
// it's idempotent (safe to run again on an already-correct box). This
// doesn't reopen the "never auto-rebuild the firewall table" rule in this
// file's own header - it's inserted as a step BEFORE reboot in the same
// capped ladder, not a new unconditional trigger, and setup-network.sh is
// the same script every reboot already runs regardless.
function reapplyNetworkSetup() {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, '../../setup/setup-network.sh');
    execFile('sudo', ['bash', scriptPath], { timeout: 20000 }, (err) => {
      if (err) console.error('🛡️ [Watchdog] setup-network.sh re-apply failed:', err.message);
      resolve(!err);
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
        : `No network IP address, and resetting interface(s) [${targets.join(', ')}] failed (this account may lack permission). Will re-apply network setup next if it's still down.`,
    });
    return issues;
  }

  // Bounced the interface on a prior check and it's still down - a bare
  // link toggle doesn't request a new DHCP lease or reapply a configured
  // static IP on its own (see reapplyNetworkSetup's own comment above),
  // so try that properly before escalating any further.
  if (ipRecoveryStage === 'bounced') {
    ipRecoveryStage = 'script_reapplied';
    const ok = await reapplyNetworkSetup();
    issues.push({
      severity: 'critical',
      code: ok ? 'ip_missing_network_reapplied' : 'ip_missing_reapply_failed',
      message: ok
        ? 'No network IP address after an interface reset. Re-applied network setup (requests a fresh DHCP lease, or your configured static IP) and rechecking.'
        : 'No network IP address, and re-applying network setup failed. Will attempt a full restart next if it\'s still down.',
    });
    return issues;
  }

  // Already reset the interface AND re-applied network setup on prior
  // checks, and it's still down.
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

  // Edge-triggered alert log: only log a NEW issue code appearing, or a
  // previously-present one clearing - never every 2-minute recurrence of
  // an already-known ongoing issue (that would spam the bell with the
  // same low-disk-space warning forever).
  try {
    const { logAlertEvent } = require('./alertEventService');
    const currentCodes = new Set(issues.map((i) => i.code));

    for (const issue of issues) {
      if (!lastIssueCodes.has(issue.code)) {
        logAlertEvent(issue.severity, issue.code, 'Self-heal check found an issue', issue.message);
      }
    }
    for (const oldCode of lastIssueCodes) {
      if (!currentCodes.has(oldCode)) {
        logAlertEvent('info', 'issue_resolved', 'Previous issue cleared', `"${oldCode}" is no longer present on the latest check.`);
      }
    }
    lastIssueCodes = currentCodes;
  } catch (e) {
    console.error('🛡️ [Watchdog] Failed to log alert event transition:', e.message);
  }
}

// Vendo online/offline is derived (last_seen recency), not a stored
// status - the Devices page already computes it this way client-side
// (public/admin/js/devices.js's isOnline(), same 3-minute window). This
// sweep runs on the same 2-minute cadence as the rest of the health check
// and only logs an actual flip from online to offline or back, not every
// tick, by comparing against the online set from the previous run.
async function checkVendoConnectivity() {
  let rows = [];
  try {
    const { logAlertEvent } = require('./alertEventService');
    rows = db.prepare("SELECT mac_address, name, last_seen, ip_address FROM vendos WHERE status = 'adopted'").all();
    const now = Date.now();
    const currentOnline = new Set();
    for (const v of rows) {
      const seenAt = v.last_seen ? new Date(v.last_seen + 'Z').getTime() : NaN;
      if (Number.isFinite(seenAt) && (now - seenAt) < VENDO_ONLINE_WINDOW_MS) {
        currentOnline.add(v.mac_address);
      }
    }

    if (hasSweptVendoConnectivityOnce) {
      for (const v of rows) {
        const wasOnline = lastOnlineVendoMacs.has(v.mac_address);
        const isOnline = currentOnline.has(v.mac_address);
        if (isOnline && !wasOnline) {
          logAlertEvent('info', 'vendo_connected', `"${v.name || v.mac_address}" connected`, `MAC ${v.mac_address}`);
        } else if (!isOnline && wasOnline) {
          logAlertEvent('warning', 'vendo_disconnected', `"${v.name || v.mac_address}" disconnected`, `MAC ${v.mac_address} has not checked in for over 3 minutes.`);
        }
      }
    }
    hasSweptVendoConnectivityOnce = true;
    lastOnlineVendoMacs = currentOnline;
  } catch (e) {
    console.error('🛡️ [Watchdog] Vendo connectivity sweep failed:', e.message);
    return;
  }

  await checkVendoInboundReachability(rows);
}

// A vendo whose heartbeat looks fine (checked above) can still have a
// wedged inbound web server after a brownout - see the comment on
// vendoInboundUnreachableSince above. Actively probes the device's own
// /status (already used on-demand by the Devices page's health modal,
// admin.js's GET /vendos/:id/health) instead of trusting the heartbeat
// alone, since that's exactly the signal a stuck listener won't give.
async function checkVendoInboundReachability(rows) {
  const { logAlertEvent } = require('./alertEventService');
  const now = Date.now();

  for (const v of rows) {
    if (!v.ip_address || !lastOnlineVendoMacs.has(v.mac_address)) {
      // No known address yet, or the heartbeat itself is already stale -
      // that's the existing vendo_disconnected case above, not this one.
      delete vendoInboundUnreachableSince[v.mac_address];
      delete vendoRemoteRestartAttemptAt[v.mac_address];
      continue;
    }

    let reachable = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(`http://${v.ip_address}/status`, { signal: controller.signal });
        reachable = res.ok;
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      reachable = false;
    }

    const label = v.name || v.mac_address;

    if (reachable) {
      if (vendoInboundUnreachableSince[v.mac_address]) {
        logAlertEvent('info', 'vendo_inbound_recovered', `"${label}" is responding to relay commands again`, `MAC ${v.mac_address} recovered on its own.`);
      }
      delete vendoInboundUnreachableSince[v.mac_address];
      delete vendoRemoteRestartAttemptAt[v.mac_address];
      continue;
    }

    if (!vendoInboundUnreachableSince[v.mac_address]) {
      vendoInboundUnreachableSince[v.mac_address] = now;
      continue; // one bad check is treated as a transient blip, same principle as the IP-recovery ladder above
    }

    const stuckForMs = now - vendoInboundUnreachableSince[v.mac_address];
    if (stuckForMs < VENDO_INBOUND_STUCK_MS) continue;

    const lastAttempt = vendoRemoteRestartAttemptAt[v.mac_address] || 0;
    if (now - lastAttempt < VENDO_REMOTE_RESTART_RETRY_MS) continue;

    const isFirstAttempt = lastAttempt === 0;
    vendoRemoteRestartAttemptAt[v.mac_address] = now;

    // Best-effort only: if the listener is genuinely wedged this may not
    // land either (same socket as /status above), but it's free to try
    // and sometimes a stuck single connection clears just enough for one
    // more request through. Its own result isn't trusted either way - the
    // NEXT cycle's /status probe is what actually confirms recovery.
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(`http://${v.ip_address}/restart`, { method: 'POST', signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {}

    if (isFirstAttempt) {
      logAlertEvent(
        'warning',
        'vendo_inbound_unreachable',
        `"${label}" is online but not responding to coin/relay commands`,
        `MAC ${v.mac_address} has been checking in normally (it looks "online") but hasn't answered a real relay/status request in over ${Math.round(VENDO_INBOUND_STUCK_MS / 60000)} minutes - a known issue after a power blip where the WiFi radio comes back in a half-working state. Attempted a remote restart; if customers still see "Vendo offline," this device needs a manual power cycle.`
      );
    }
  }
}

async function runHealthCheck() {
  const issues = [];
  const mode = getNetworkMode();

  issues.push(...(await checkNetworkReachability()));

  // MikroTik/pfSense own their own access-control state on external
  // hardware. This box isn't the source of truth for it, so the
  // firewall-reachability + per-session repair checks only apply where
  // this box itself enforces access (standalone/OpenWRT).
  if (mode === 'standalone' || mode === 'openwrt') {
    const reachable = await checkFirewallReachable();
    if (!reachable) {
      issues.push({
        severity: 'critical',
        code: 'firewall_unreachable',
        message: 'The network access-control table is missing or unreachable. WiFi access enforcement may not be working. This needs manual attention. Re-run network setup.',
      });
      console.error('🛡️ [Watchdog] Firewall/network driver unreachable. Not attempting an automatic full rebuild (too risky to do unattended). Run setup-network.sh manually.');
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
  } else if (mode === 'mikrotik') {
    // Bug this fixes: this check used to be skipped entirely for
    // Controller mode ("this box isn't the source of truth for access
    // control"), true for enforcement, but it left a real gap - if the
    // MikroTik router itself is unreachable (a brownout, a cable pulled),
    // every customer behind it loses internet exactly like a standalone
    // outage, but nothing here ever noticed or compensated their expiry
    // clocks for it. testConnection() is a lightweight single-command
    // liveness check (mikrotikApiClient.js), not a full config query.
    let routerReachable = false;
    try {
      routerReachable = await require('./mikrotikService').testConnection();
    } catch (e) {
      routerReachable = false;
    }

    if (!routerReachable) {
      if (mikrotikUnreachableSince === null) mikrotikUnreachableSince = Date.now();
      issues.push({
        severity: 'critical',
        code: 'mikrotik_router_unreachable',
        message: 'The MikroTik router could not be reached. Customer internet access and session expiry compensation cannot be verified until it recovers.',
      });
    } else if (mikrotikUnreachableSince !== null) {
      const gapMs = Date.now() - mikrotikUnreachableSince;
      mikrotikUnreachableSince = null;
      await require('./timerService').applyOutageCompensation(gapMs, 'The MikroTik router');
    }

    // Real incident: after this exact router-power-loss-then-recovery
    // scenario, the Hotspot's own walled-garden enforcement had stopped
    // working entirely - every client got free full-speed internet, no
    // portal shown. Only meaningful to check once the router itself is
    // reachable (the block above already covers total unreachability).
    if (routerReachable) {
      try {
        const hotspotCheck = await require('./mikrotikService').checkHotspotEnabled();
        if (!hotspotCheck.ok) {
          issues.push({
            severity: 'critical',
            code: 'mikrotik_hotspot_disabled',
            message: `The MikroTik Hotspot gate appears to be OFF - customers may be getting free internet with no login/coin prompt. ${hotspotCheck.reason} Check Hotspot server status on the router immediately.`,
          });
        }
      } catch (e) {
        console.error('🛡️ [Watchdog] Hotspot status check failed:', e.message);
      }

      // Real incident: blockClient() (called when a session ends) removes
      // this customer's router-side bypass, but that call is a best-effort
      // try/catch with nothing to retry it - a network blip at exactly the
      // wrong moment leaves a real customer with permanent free, ungated
      // internet, confirmed live via a leftover "rj-piso-" bypass binding
      // with no matching active session. Cleans up any of this app's OWN
      // stale bindings (never touches one an operator added by hand) every
      // 2-minute cycle, so a missed removal self-heals within minutes
      // instead of silently costing revenue indefinitely.
      try {
        // is_paused=0 OR pause_reason='idle': a MANUAL pause calls
        // blockClient() (sessionService.js's pauseSession()), so that mac
        // correctly has no binding right now - but an idle auto-pause
        // deliberately never blocks (it has to auto-resume the instant
        // real traffic returns), so that mac must stay counted as
        // "should have access" or this would wrongly strip a legitimately
        // idle-but-still-connected customer's bypass.
        const shouldHaveAccess = new Set([
          ...db.prepare("SELECT mac_address FROM sessions WHERE is_paused = 0 OR pause_reason = 'idle'").all().map((r) => r.mac_address),
          ...db.prepare('SELECT mac_address FROM trusted_devices').all().map((r) => r.mac_address),
          ...db.prepare('SELECT mac_address FROM vendos').all().map((r) => r.mac_address),
        ]);
        const { removed } = await require('./mikrotikService').reconcileBypassBindings(shouldHaveAccess);
        if (removed.length > 0) {
          issues.push({
            severity: 'warning',
            code: 'mikrotik_stale_bypass_cleaned',
            message: `Removed ${removed.length} stale bypass binding(s) that were giving free internet with no active session: ${removed.join(', ')}.`,
          });
        }
      } catch (e) {
        console.error('🛡️ [Watchdog] Bypass reconciliation failed:', e.message);
      }
    }
  }

  await checkVendoConnectivity();

  const freeMb = await checkDiskSpace();
  if (freeMb !== null && freeMb < MIN_FREE_DISK_MB) {
    issues.push({
      severity: 'critical',
      code: 'low_disk_space',
      message: `Only ${freeMb}MB of disk space left. The system may fail to save new sessions/transactions soon. Free up space or expand storage.`,
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
