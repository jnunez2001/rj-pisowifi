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
// Standalone mode only for now (this is where standalone_lane_map
// actually exists) - MikroTik/OpenWRT mode has no equivalent lane-role
// map built yet, so this always allows there rather than guessing.
// Same reasoning for a legacy single-lane install with no lane map at
// all (nothing to check against, and a single-subnet install has no
// concept of a separate open lane to begin with) - allow, don't block.
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

// Returns true only when the IP positively matches a configured lane
// whose role is 'open' (untrusted for coin/relay actions). Everything
// else (gated lane match, no match, wrong mode, bad/missing data)
// returns false, i.e. "not known to be an open lane" - allow it through.
function isOpenLaneIp(ip) {
  try {
    if (getNetworkMode() !== 'standalone') return false;

    const row = db.prepare("SELECT value FROM settings WHERE key = 'standalone_lane_map'").get();
    if (!row?.value) return false;

    const lanes = JSON.parse(row.value);
    if (!Array.isArray(lanes) || lanes.length === 0) return false;

    const ipParts = String(ip || '').split('.');
    if (ipParts.length !== 4) return false;

    for (const lane of lanes) {
      const subnetParts = String(lane.subnet || '').split('.');
      // Every lane is a /24 on 10.<octet>.0.0 (setup-network.sh's own
      // scheme) - matching the first three octets is exactly that mask.
      if (subnetParts.length === 4 &&
          ipParts[0] === subnetParts[0] &&
          ipParts[1] === subnetParts[1] &&
          ipParts[2] === subnetParts[2]) {
        return lane.role === 'open';
      }
    }
    return false;
  } catch (e) {
    console.error('[LaneAccess] isOpenLaneIp check failed, allowing by default:', e.message);
    return false;
  }
}

module.exports = { isOpenLaneIp };
