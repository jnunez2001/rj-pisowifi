// ===== MULTI-WAN FAILOVER (network power, Standalone mode) =====
// Primary/backup failover only (matches the scoped plan - no weighted
// load balancing or policy routing yet). Deliberately split into a pure
// decision function (fully unit-testable, no side effects) and a thin
// side-effecting route-switch wrapper, the same discipline used for the
// MikroTik RouterOS work tonight - this is the LEAST hardware-verifiable
// piece of that whole batch (real failover behavior needs two actual ISP
// uplinks to confirm, which this dev environment has no way to provide).
//
// A second router_ports row with role='wan' is treated as the backup -
// lowest id among 'wan' rows is primary (same "head lanes in id order"
// convention setup-network.sh's own lane numbering already uses).

const db = require('../config/database');
const { execFile } = require('child_process');
const cron = require('node-cron');

const CONSECUTIVE_FAILURES_TO_FAILOVER = 3; // ~3 checks (matches watchdog-style debounce) before acting - one bad ping shouldn't flap the route
const CONSECUTIVE_SUCCESSES_TO_FAILBACK = 3;

let consecutiveFailures = 0;
let consecutiveSuccesses = 0;
let currentActive = 'primary'; // 'primary' | 'backup' - in-memory, reset on restart (recomputed fresh next check either way)

function getWanLanes() {
  const rows = db.prepare("SELECT * FROM router_ports WHERE role = 'wan' ORDER BY id ASC").all();
  return { primary: rows[0] || null, backup: rows[1] || null };
}

// Pure decision function - no I/O, fully testable with synthetic inputs.
// Returns one of: 'stay_primary' | 'failover_to_backup' | 'stay_backup' |
// 'failback_to_primary' | 'no_backup_configured'.
function decideFailoverAction({ hasBackup, primaryHealthy, currentActiveLane, failureStreak, successStreak }) {
  if (!hasBackup) return 'no_backup_configured';

  if (currentActiveLane === 'primary') {
    if (primaryHealthy) return 'stay_primary';
    if (failureStreak >= CONSECUTIVE_FAILURES_TO_FAILOVER) return 'failover_to_backup';
    return 'stay_primary'; // degraded, but not for long enough yet
  }

  // currently on backup
  if (!primaryHealthy) return 'stay_backup';
  if (successStreak >= CONSECUTIVE_SUCCESSES_TO_FAILBACK) return 'failback_to_primary';
  return 'stay_backup'; // primary looks OK again, but not for long enough yet to trust it
}

function laneInterfaceName(lane) {
  return lane.vlan_id ? `${lane.port_name}.${lane.vlan_id}` : lane.port_name;
}

// Discovers the gateway dhclient already installed for `iface` (multi-WAN
// commonly uses DHCP per uplink, so the gateway usually isn't known ahead
// of time the way a static WAN's is), then re-installs the default route
// via that interface at the given metric. Best-effort, mirrors the
// execFile-wrapped pattern already used throughout admin.js/configSafety.js.
function switchActiveRoute(lane, metric) {
  const iface = laneInterfaceName(lane);
  return new Promise((resolve) => {
    execFile('ip', ['route', 'show', 'dev', iface], (err, stdout) => {
      if (err) return resolve({ success: false, error: err.message });
      const match = stdout.match(/default via (\S+)/) || stdout.match(/via (\S+)/);
      const gateway = match ? match[1] : null;
      const args = gateway
        ? ['route', 'replace', 'default', 'via', gateway, 'dev', iface, 'metric', String(metric)]
        : ['route', 'replace', 'default', 'dev', iface, 'metric', String(metric)];
      execFile('ip', args, (err2) => {
        resolve({ success: !err2, error: err2 ? err2.message : null, interface: iface, gateway });
      });
    });
  });
}

async function checkAndFailover() {
  const { primary, backup } = getWanLanes();
  if (!primary) return { action: 'no_primary_configured' };

  const hasBackup = !!backup;
  let primaryHealthy = true;
  if (hasBackup) {
    const { checkWanHealth } = require('./wanHealthService');
    const health = await checkWanHealth();
    primaryHealthy = health.score >= 50; // matches wanHealthService's own "elevated" threshold
    if (primaryHealthy) {
      consecutiveFailures = 0;
      consecutiveSuccesses++;
    } else {
      consecutiveSuccesses = 0;
      consecutiveFailures++;
    }
  }

  const action = decideFailoverAction({
    hasBackup,
    primaryHealthy,
    currentActiveLane: currentActive,
    failureStreak: consecutiveFailures,
    successStreak: consecutiveSuccesses,
  });

  if (action === 'failover_to_backup') {
    const result = await switchActiveRoute(backup, 1);
    if (result.success) {
      currentActive = 'backup';
      console.log(`🔀 Multi-WAN: failed over to backup (${laneInterfaceName(backup)}) after ${consecutiveFailures} failed health checks`);
    } else {
      console.error('Multi-WAN failover route switch failed:', result.error);
    }
  } else if (action === 'failback_to_primary') {
    const result = await switchActiveRoute(primary, 1);
    if (result.success) {
      currentActive = 'primary';
      console.log(`🔀 Multi-WAN: failed back to primary (${laneInterfaceName(primary)}) after ${consecutiveSuccesses} healthy checks`);
    } else {
      console.error('Multi-WAN failback route switch failed:', result.error);
    }
  }

  return { action, currentActive };
}

function getStatus() {
  const { primary, backup } = getWanLanes();
  return {
    primary: primary ? { interface: laneInterfaceName(primary), lane_name: primary.lane_name } : null,
    backup: backup ? { interface: laneInterfaceName(backup), lane_name: backup.lane_name } : null,
    currently_active: currentActive,
    consecutive_failures: consecutiveFailures,
    consecutive_successes: consecutiveSuccesses,
  };
}

function start() {
  // Every 2 minutes - frequent enough to catch a real outage reasonably
  // fast, infrequent enough not to flap on transient blips (combined with
  // the consecutive-check thresholds above).
  cron.schedule('*/2 * * * *', () => {
    checkAndFailover().catch((e) => console.error('Multi-WAN check crashed:', e.message));
  });
  console.log('🔀 Multi-WAN failover monitor started');
}

module.exports = {
  getWanLanes,
  decideFailoverAction,
  switchActiveRoute,
  checkAndFailover,
  getStatus,
  start,
};
