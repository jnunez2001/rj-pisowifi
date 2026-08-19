// ===== VENDO ZERO-CONFIG DISCOVERY =====
// Lets an ESP32/ESP8266 Vendo find this box's address without anyone typing
// it in manually (spec: "Do not require manual StarkFi IP entry for normal
// adoption"). Implemented as a plain UDP broadcast/reply instead of real
// mDNS - the spec explicitly allows "Local UDP discovery fallback" as an
// alternative, and this avoids adding an mDNS dependency (with its own
// native-binding/platform risk) for a first version. A real _starkfi-
// vendo._tcp.local mDNS responder can be added later without changing this
// protocol's request/response shape.
//
// Protocol: a Vendo broadcasts the single-line request "STARKFI_DISCOVER_V1"
// to this port; this box replies (unicast, straight back to the sender) with
// a JSON payload containing only non-sensitive information, matching the
// spec's "Discovery must NOT establish trust by itself" - no keys, no
// credentials, nothing an eavesdropper could use to impersonate this box.
//
// After discovery, a Vendo registers itself with the address+port it just
// learned by calling the existing POST /api/vendo/register (admin.js) -
// real ESP32 firmware already calls that endpoint on boot and every 60s
// heartbeat, it just currently needs the address hand-configured first.
// This service exists to remove that manual step, not to introduce a
// second registration mechanism alongside it.

const dgram = require('dgram');
const DISCOVERY_PORT = 6970;
const REQUEST_MESSAGE = 'STARKFI_DISCOVER_V1';
const PROTOCOL_VERSION = '1.0';

let socket = null;

function startVendoDiscovery() {
  if (socket) return; // already running

  socket = dgram.createSocket('udp4');

  socket.on('error', (err) => {
    console.error('🔌 [Vendo Discovery] Socket error:', err.message);
  });

  socket.on('message', (msg, rinfo) => {
    if (msg.toString().trim() !== REQUEST_MESSAGE) return; // ignore anything else on this port

    try {
      const { getDeviceIdentity } = require('./deviceIdentity');
      const identity = getDeviceIdentity();
      const os = require('os');
      // Best-effort primary LAN address, same "first non-internal IPv4"
      // convention used elsewhere in this codebase (e.g. the console
      // banner in setup/setup-network.sh) - good enough for a Vendo to
      // reach this box on the network it just broadcast on.
      let address = null;
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family === 'IPv4' && !a.internal) { address = a.address; break; }
        }
        if (address) break;
      }

      const reply = JSON.stringify({
        server_id: identity.id,
        name: 'StarkFi',
        protocol_version: PROTOCOL_VERSION,
        address,
        port: process.env.PORT || 3000,
      });
      socket.send(reply, rinfo.port, rinfo.address);
    } catch (err) {
      console.error('🔌 [Vendo Discovery] Failed to build reply:', err.message);
    }
  });

  socket.on('listening', () => {
    console.log(`🔌 Vendo discovery listening on UDP ${DISCOVERY_PORT}`);
  });

  socket.bind(DISCOVERY_PORT);
}

function stopVendoDiscovery() {
  if (socket) {
    socket.close();
    socket = null;
  }
}

module.exports = { startVendoDiscovery, stopVendoDiscovery, DISCOVERY_PORT, REQUEST_MESSAGE };
