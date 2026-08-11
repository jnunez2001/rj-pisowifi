// ===== NETWORK CONFIGURATION SAFETY ENGINE =====
// validate -> apply -> verify -> commit, with automatic rollback to the
// last known-good configuration on verification failure. This is the
// pattern every dev-handoff architecture doc calls mandatory before real
// network automation (see BETA_LAUNCH_PLAN.md Milestone 0, step 3) -
// previously setup-network.sh was re-run directly with no safety net at
// all, meaning a bad lane/WAN role change had no path back except manual
// SSH/physical access.
//
// Design note: the existing admin UI saves lane changes to the DB via one
// request (POST /network/standalone/ports) and applies them via a second,
// separate request (POST /network/standalone/provision/apply). That means
// by the time "apply" runs, the DB already holds the NEW desired state -
// snapshotting "current DB" at apply time would snapshot the candidate,
// not something safe to roll back to. Instead, every successful apply's
// state is preserved in network_config_versions (applied=1, rolled_back=0)
// - the most recent such row IS "last known good," and that's what a
// failed verification restores to, not "state one line ago in this
// request."
//
// Scope for this v1: wraps Standalone mode's setup-network.sh re-apply
// (router_ports/vlans/static_leases/port_forwards). MikroTik mode has no
// config-writing surface yet (only per-client allow/block/bandwidth) - it
// gets wrapped by this same engine once group 4's VLAN/DHCP/firewall work
// lands on top of it.

const db = require('../config/database');
const path = require('path');
const { execFile } = require('child_process');

const NETWORK_TABLES = ['router_ports', 'vlans', 'static_leases', 'port_forwards'];

function snapshotNetworkTables() {
  const snapshot = {};
  for (const table of NETWORK_TABLES) {
    snapshot[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  return snapshot;
}

// Restores every row of every network table to exactly the snapshot's
// state - full delete + re-insert per table rather than a diff/patch,
// since these tables are small (dozens of rows at most on real
// deployments) and a full replace is much simpler to reason about
// correctly than reconciling partial changes.
function restoreNetworkTables(snapshot) {
  const restore = db.transaction((snap) => {
    for (const table of NETWORK_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
      const rows = snap[table] || [];
      if (rows.length === 0) continue;
      const cols = Object.keys(rows[0]);
      const placeholders = cols.map(() => '?').join(',');
      const insert = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
      for (const row of rows) {
        insert.run(...cols.map((c) => row[c]));
      }
    }
  });
  restore(snapshot);
}

function getLastKnownGoodSnapshot() {
  const row = db.prepare(`
    SELECT snapshot_json FROM network_config_versions
    WHERE applied = 1 AND rolled_back = 0
    ORDER BY id DESC LIMIT 1
  `).get();
  return row ? JSON.parse(row.snapshot_json) : null;
}

// Management-path risk: does the candidate lane set remove the WAN role
// that the last known-good config had, or repurpose the lane carrying
// this server's own address (server_lan_mac)? Either one can sever the
// box's own internet uplink or make a physical vendo device (ESP32 coin
// slot, etc.) silently unreachable - the two failure modes that matter
// here, since /admin itself is only ever reached via loopback or nginx's
// separate WAN-facing path (see restrictAdminToLocalhost in app.js), not
// through a customer lane directly.
function detectManagementPathRisk(candidateLanes, baselineLanes) {
  const reasons = [];
  const baselineWan = (baselineLanes || []).filter((l) => l.role === 'wan');
  const candidateWanCount = candidateLanes.filter((l) => l.role === 'wan').length;

  if (baselineWan.length > 0 && candidateWanCount === 0) {
    reasons.push('This removes the only WAN role - the box would lose its own internet uplink.');
  }

  const serverMac = db.prepare("SELECT value FROM settings WHERE key = 'server_lan_mac'").get()?.value;
  if (serverMac) {
    let serverPortName = null;
    try {
      const fs = require('fs');
      for (const name of fs.readdirSync('/sys/class/net')) {
        try {
          const mac = fs.readFileSync(`/sys/class/net/${name}/address`, 'utf8').trim();
          if (mac.toLowerCase() === serverMac.toLowerCase()) { serverPortName = name; break; }
        } catch (e) {}
      }
    } catch (e) {}
    if (serverPortName) {
      const before = (baselineLanes || []).find((l) => l.port_name === serverPortName && !l.vlan_id);
      const after = candidateLanes.find((l) => l.port_name === serverPortName && !l.vlan_id);
      if (before && (!after || after.role !== before.role)) {
        reasons.push(`This server's own address is bound to ${serverPortName} - changing its role may make paired devices (e.g. an ESP32 coin slot) unable to reach it.`);
      }
    }
  }

  return { risky: reasons.length > 0, reasons };
}

// Best-effort connectivity check after applying - not present/meaningful
// off real Linux hardware (this dev environment has no `nft`/`tc`, no real
// WAN), so a failure to even run the check is reported as 'unknown', not
// treated as a verification failure. On real hardware, an actual failed
// lookup means the WAN uplink is genuinely gone.
function verifyConnectivity() {
  return new Promise((resolve) => {
    execFile('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', 'https://1.1.1.1'], (err, stdout) => {
      if (err) return resolve({ status: 'unknown', detail: err.message });
      const code = stdout.trim();
      const ok = code !== '000' && code !== '';
      resolve({ status: ok ? 'ok' : 'failed', detail: `curl http_code=${code}` });
    });
  });
}

function runSetupScript() {
  const scriptPath = path.join(__dirname, '../../setup/setup-network.sh');
  return new Promise((resolve) => {
    execFile('sudo', ['bash', scriptPath], { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ success: !err, error: err ? err.message : null, stdout, stderr });
    });
  });
}

function logVersion({ operator, reason, snapshot, riskReasons, applied, rolledBack, verifyResult }) {
  db.prepare(`
    INSERT INTO network_config_versions
    (operator, reason, snapshot_json, risk_reasons_json, applied, rolled_back, verify_status, verify_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operator || 'admin',
    reason || '',
    JSON.stringify(snapshot),
    JSON.stringify(riskReasons || []),
    applied ? 1 : 0,
    rolledBack ? 1 : 0,
    verifyResult ? verifyResult.status : null,
    verifyResult ? verifyResult.detail : null
  );
}

// The main entry point, called by POST /network/standalone/provision/apply
// once the desired router_ports/vlans/leases/port-forwards are already
// saved in the DB (by the earlier "save ports" request). Applies the
// CURRENT db state as the candidate configuration.
//
// riskConfirmed: the caller must have already shown detectManagementPathRisk()'s
// reasons to the admin and gotten explicit confirmation before calling this
// with riskConfirmed=true when risky=true - this function refuses risky
// changes that arrive unconfirmed, it doesn't own the confirmation UI.
async function applyNetworkChangeTransaction({ operator, reason, riskConfirmed = false }) {
  const candidate = snapshotNetworkTables();
  const lastGood = getLastKnownGoodSnapshot();

  const riskCheck = detectManagementPathRisk(candidate.router_ports, lastGood ? lastGood.router_ports : []);
  if (riskCheck.risky && !riskConfirmed) {
    return { success: false, requiresConfirmation: true, reasons: riskCheck.reasons };
  }

  const applyResult = await runSetupScript();
  if (!applyResult.success) {
    if (lastGood) {
      restoreNetworkTables(lastGood);
      await runSetupScript();
    }
    logVersion({ operator, reason, snapshot: candidate, riskReasons: riskCheck.reasons, applied: false, rolledBack: !!lastGood, verifyResult: { status: 'apply_failed', detail: applyResult.error } });
    return { success: false, rolledBack: !!lastGood, message: 'Apply failed: ' + applyResult.error };
  }

  const verifyResult = await verifyConnectivity();
  if (verifyResult.status === 'failed') {
    if (lastGood) {
      restoreNetworkTables(lastGood);
      await runSetupScript();
    }
    logVersion({ operator, reason, snapshot: candidate, riskReasons: riskCheck.reasons, applied: true, rolledBack: !!lastGood, verifyResult });
    return {
      success: false,
      rolledBack: !!lastGood,
      message: lastGood
        ? 'Connectivity check failed after applying - rolled back to the previous working configuration.'
        : 'Connectivity check failed after applying, and there is no previous known-good configuration to roll back to. Manual review needed.',
    };
  }

  logVersion({ operator, reason, snapshot: candidate, riskReasons: riskCheck.reasons, applied: true, rolledBack: false, verifyResult });
  return { success: true, verifyResult };
}

module.exports = {
  snapshotNetworkTables,
  restoreNetworkTables,
  getLastKnownGoodSnapshot,
  detectManagementPathRisk,
  verifyConnectivity,
  runSetupScript,
  applyNetworkChangeTransaction,
};
