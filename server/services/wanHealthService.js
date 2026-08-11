// ===== WAN HEALTH MONITORING (network power) =====
// Distinct from watchdogService.js (firewall reachability, disk space,
// session repair) - this specifically measures the quality of the box's
// own internet path: latency, packet loss, and (Standalone mode only,
// where the WAN role is a real local interface) link state. Every number
// here is actually measured, never invented - matches the dev handoff's
// own explicit rule that a "Network Health: 94/100"-style score must be
// traceable to measurable conditions, not a fabricated impression of
// quality.

const { execFile } = require('child_process');
const db = require('../config/database');

function pingHost(host, count = 5) {
  return new Promise((resolve) => {
    // -c count (Linux/macOS both support this), -W/-t timeout differs by
    // platform - macOS (this dev environment) uses -t (seconds), Linux
    // uses -W (seconds too, as of iputils). Try Linux-style first since
    // that's the real deployment target; falls back gracefully to
    // 'unknown' if ping itself isn't available at all rather than crashing.
    execFile('ping', ['-c', String(count), '-W', '2', host], { timeout: 15000 }, (err, stdout) => {
      if (err && !stdout) {
        // Retry with macOS-style -t flag before giving up entirely - this
        // dev Mac needs this branch; real Linux deployments will succeed
        // on the first attempt above.
        execFile('ping', ['-c', String(count), '-t', '2', host], { timeout: 15000 }, (err2, stdout2) => {
          if (err2 && !stdout2) return resolve({ status: 'unknown', reason: err2.message });
          resolve(parsePingOutput(stdout2));
        });
        return;
      }
      resolve(parsePingOutput(stdout));
    });
  });
}

function parsePingOutput(stdout) {
  // Packet loss line: "5 packets transmitted, 5 received, 0% packet loss"
  const lossMatch = stdout.match(/(\d+(?:\.\d+)?)%\s*packet loss/);
  const packetLoss = lossMatch ? parseFloat(lossMatch[1]) : null;

  // Latency summary: "round-trip min/avg/max/stddev = 12.1/14.5/18.2/2.1 ms"
  // (macOS) or "rtt min/avg/max/mdev = ..." (Linux) - both match this.
  const rttMatch = stdout.match(/[=]\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
  const avgLatencyMs = rttMatch ? parseFloat(rttMatch[2]) : null;

  if (packetLoss === null) return { status: 'unknown', reason: 'could not parse ping output' };
  return { status: 'ok', packet_loss_pct: packetLoss, avg_latency_ms: avgLatencyMs };
}

// Health score: starts at 100, deducted for measured conditions only.
// Deliberately simple/conservative rather than an elaborate weighted
// formula that would be harder to justify - each deduction maps to one
// concrete, stated reason.
function computeScore({ packet_loss_pct, avg_latency_ms, wan_link_down }) {
  if (wan_link_down) return { score: 0, reasons: ['WAN interface is down'] };
  const reasons = [];
  let score = 100;

  if (packet_loss_pct !== null) {
    if (packet_loss_pct >= 20) { score -= 50; reasons.push(`High packet loss (${packet_loss_pct}%)`); }
    else if (packet_loss_pct >= 5) { score -= 25; reasons.push(`Elevated packet loss (${packet_loss_pct}%)`); }
    else if (packet_loss_pct > 0) { score -= 5; reasons.push(`Minor packet loss (${packet_loss_pct}%)`); }
  }

  if (avg_latency_ms !== null) {
    if (avg_latency_ms >= 300) { score -= 30; reasons.push(`High latency (${avg_latency_ms}ms)`); }
    else if (avg_latency_ms >= 100) { score -= 10; reasons.push(`Elevated latency (${avg_latency_ms}ms)`); }
  }

  return { score: Math.max(0, score), reasons };
}

// Standalone mode's WAN is a real local interface (router_ports role='wan')
// - report its link state alongside the ping-based measurement. MikroTik
// mode's WAN lives on the router itself, not locally, so this is
// Standalone-specific; router-mode WAN health is a separate not-yet-built
// item (would need RouterOS-side latency data, a genuinely different
// measurement path).
function getStandaloneWanInterface() {
  try {
    const fs = require('fs');
    const wanRow = db.prepare("SELECT port_name, vlan_id FROM router_ports WHERE role = 'wan' LIMIT 1").get();
    if (!wanRow) return null;
    const ifName = wanRow.vlan_id ? `${wanRow.port_name}.${wanRow.vlan_id}` : wanRow.port_name;
    let operstate = 'unknown';
    try { operstate = fs.readFileSync(`/sys/class/net/${ifName}/operstate`, 'utf8').trim(); } catch (e) {}
    return { interface: ifName, link_state: operstate };
  } catch (e) {
    return null;
  }
}

async function checkWanHealth(host = '1.1.1.1') {
  const pingResult = await pingHost(host);
  const iface = getStandaloneWanInterface();
  const wanLinkDown = !!(iface && iface.link_state !== 'up' && iface.link_state !== 'unknown');

  const packet_loss_pct = pingResult.status === 'ok' ? pingResult.packet_loss_pct : null;
  const avg_latency_ms = pingResult.status === 'ok' ? pingResult.avg_latency_ms : null;
  const { score, reasons } = computeScore({ packet_loss_pct, avg_latency_ms, wan_link_down: wanLinkDown });

  return {
    measured_at: new Date().toISOString(),
    ping_status: pingResult.status,
    packet_loss_pct,
    avg_latency_ms,
    interface: iface,
    score,
    reasons,
  };
}

module.exports = { checkWanHealth };
