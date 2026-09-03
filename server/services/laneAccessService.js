// ===== LANE ACCESS SERVICE =====
// Real incident that prompted this: the operator has two physical
// networks reaching this server - a gated customer WiFi (paid access,
// via the coin slot) and a separate, ungated "Home" WiFi for personal
// use. Because the portal itself was reachable from either network, a
// device on the Home WiFi could still open the portal page and tap
// Insert Coin - which armed the real vendo relay and could accept a real
// coin with no way to correctly credit it to anyone, since that device
// was never meant to be part of the gated flow at all.
//
// setup-network.sh's multi-lane engine already has exactly the concept
// needed to fix this: each configured lane (router_ports.role) is either
// 'gated' (customers, walled garden enforced) or 'open' ("a Home/staff
// lane that doesn't need to pay" - that file's own words), each on its
// own /24 subnet, recorded in the standalone_lane_map setting at
// provisioning time. This was never consulted by the coin/relay routes -
// this service is that missing check.
//
// Covers standalone mode (reads standalone_lane_map, written by
// setup-network.sh) and MikroTik mode (recomputes each primary lane's
// subnet the same way mikrotikProvisioner.js's own subnetFor() does when
// it actually configures the router - see isMikrotikOpenLaneIp() below).
// OpenWRT mode has no equivalent lane-role concept built yet, so this
// always allows there rather than guessing. Same reasoning for a legacy
// single-lane install with no lane map/lanes configured at all (nothing
// to check against, and a single-subnet install has no concept of a
// separate open lane to begin with) - allow, don't block.
//
// Deliberately fails OPEN (allows the request through) on anything
// uncertain - a parsing hiccup, a missing setting, an IP that doesn't
// match any known lane - and only ever blocks when a lane is positively
// matched AND that lane's own role is explicitly 'open'. A false
// positive here would mean blocking a real paying customer's coin;
// that's the wrong direction to guess wrong in.

const db = require('../config/database');

function getNetworkMode() {
  return db.prepare("SELECT value FROM settings WHERE key = 'network_mode'").get()?.value || 'standalone';
}

function ipInSubnet(ip, subnet) {
  const ipParts = String(ip || '').split('.');
  const subnetParts = String(subnet || '').split('.');
  // Every lane in both modes is a /24 - matching the first three octets
  // is exactly that mask.
  return ipParts.length === 4 && subnetParts.length === 4 &&
    ipParts[0] === subnetParts[0] && ipParts[1] === subnetParts[1] && ipParts[2] === subnetParts[2];
}

function isStandaloneOpenLaneIp(ip) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'standalone_lane_map'").get();
  if (!row?.value) return false;
  const lanes = JSON.parse(row.value);
  if (!Array.isArray(lanes) || lanes.length === 0) return false;
  for (const lane of lanes) {
    if (ipInSubnet(ip, lane.subnet)) return lane.role === 'open';
  }
  return false;
}

// Recomputes each primary lane's subnet the exact same way
// mikrotikProvisioner.js's own subnetFor() does at the moment it actually
// configures the router (10.50.<index>.0/24, index = that lane's 0-based
// position among primary gated/open lanes, ordered by id) - deliberately
// NOT importing that file itself, since it also carries the full
// RouterOS-provisioning machinery, not something this read-only lookup
// should drag in. If that numbering scheme in mikrotikProvisioner.js
// ever changes, this needs to change with it.
function isMikrotikOpenLaneIp(ip) {
  const primaryLanes = db.prepare(`
    SELECT role FROM router_ports
    WHERE role IN ('gated', 'open') AND bridge_with_id IS NULL
    ORDER BY id
  `).all();
  if (primaryLanes.length === 0) return false;
  for (let i = 0; i < primaryLanes.length; i++) {
    if (ipInSubnet(ip, `10.50.${i}.0`)) return primaryLanes[i].role === 'open';
  }
  return false;
}

// Returns true only when the IP positively matches a configured lane
// whose role is 'open' (untrusted for coin/relay actions). Everything
// else (gated lane match, no match, unsupported mode, bad/missing data)
// returns false, i.e. "not known to be an open lane" - allow it through.
function isOpenLaneIp(ip) {
  try {
    const mode = getNetworkMode();
    if (mode === 'standalone') return isStandaloneOpenLaneIp(ip);
    if (mode === 'mikrotik') return isMikrotikOpenLaneIp(ip);
    return false;
  } catch (e) {
    console.error('[LaneAccess] isOpenLaneIp check failed, allowing by default:', e.message);
    return false;
  }
}

module.exports = { isOpenLaneIp };
