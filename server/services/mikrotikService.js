// ===== MIKROTIK SERVICE =====
// Handles MikroTik RouterOS API calls (REST API, RouterOS 7+)
// Used when network_mode = 'mikrotik'
//
// IMPORTANT: allowClient/blockClient use /ip/hotspot/ip-binding, NOT
// /ip/hotspot/active. The "active" list only contains devices that have
// already authenticated through Hotspot's own login page — you can't force
// an entry there for a device that hasn't logged in yet. ip-binding with
// type=bypassed is the correct mechanism: it tells Hotspot "let this MAC
// through without going through the login page at all," which is what a
// coin-slot-triggers-access flow actually needs.
//
// RouterOS REST API method mapping (official):
//   GET    = print   (list/filter records)
//   PUT    = add     (create new record)
//   PATCH  = set     (update existing record by .id)
//   DELETE = remove  (delete existing record by .id)
// DELETE requires the record's .id — you can't delete by matching fields
// in the body, so allowClient/blockClient always GET first to find the .id.

const db = require('../config/database');

function getMikrotikConfig() {
  const getSetting = (key, def) => {
    const s = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return s ? s.value : def;
  };
  return {
    ip: getSetting('mikrotik_ip', ''),
    user: getSetting('mikrotik_user', 'admin'),
    pass: getSetting('mikrotik_pass', ''),
    interface: getSetting('mikrotik_interface', 'ether1'),
  };
}

function authHeader(config) {
  return 'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64');
}

/**
 * Looks up the existing ip-binding record for a MAC, if any.
 * Returns the full record (including its .id) or null if not found.
 */
async function findIpBinding(config, mac) {
  const url = `http://${config.ip}/rest/ip/hotspot/ip-binding?mac-address=${encodeURIComponent(mac)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': authHeader(config) },
  });
  if (!res.ok) return null;
  const records = await res.json();
  return records.length > 0 ? records[0] : null;
}

// Allow a client MAC address (bypass Hotspot login entirely via ip-binding).
// Time enforcement stays with our own DB/cron (timerService) — the router
// never tracks minutes itself, so this only needs the MAC, not a duration.
async function allowClient(mac) {
  const config = getMikrotikConfig();
  if (!config.ip) {
    console.log('MikroTik IP not configured');
    return false;
  }
  try {
    const existing = await findIpBinding(config, mac);

    if (existing) {
      // Already bound — just refresh the comment so we can see when it was renewed
      const url = `http://${config.ip}/rest/ip/hotspot/ip-binding/${existing['.id']}`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader(config),
        },
        body: JSON.stringify({
          comment: `rj-piso-${Date.now()}`,
        }),
      });
      console.log(`✅ MikroTik refreshed existing binding: ${mac}`);
      return res.ok;
    }

    // No existing binding — create one
    const url = `http://${config.ip}/rest/ip/hotspot/ip-binding`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader(config),
      },
      body: JSON.stringify({
        'mac-address': mac,
        'type': 'bypassed',
        'comment': `rj-piso-${Date.now()}`,
      }),
    });
    console.log(`✅ MikroTik allowed: ${mac}`);
    return res.ok;
  } catch (err) {
    console.error('MikroTik allowClient error:', err.message);
    return false;
  }
}

// Block a client MAC address (remove ip-binding, forcing them back to
// walled-garden/login-only state) and kick any active hotspot session too
async function blockClient(mac) {
  const config = getMikrotikConfig();
  if (!config.ip) return false;
  try {
    // Remove the ip-binding that was granting bypass access
    const binding = await findIpBinding(config, mac);
    if (binding) {
      const url = `http://${config.ip}/rest/ip/hotspot/ip-binding/${binding['.id']}`;
      await fetch(url, {
        method: 'DELETE',
        headers: { 'Authorization': authHeader(config) },
      });
    }

    // Also kick any currently-active hotspot session for this MAC, so access
    // is cut immediately instead of waiting for the connection to naturally drop
    const activeUrl = `http://${config.ip}/rest/ip/hotspot/active?mac-address=${encodeURIComponent(mac)}`;
    const activeRes = await fetch(activeUrl, {
      method: 'GET',
      headers: { 'Authorization': authHeader(config) },
    });
    if (activeRes.ok) {
      const activeSessions = await activeRes.json();
      for (const session of activeSessions) {
        await fetch(`http://${config.ip}/rest/ip/hotspot/active/${session['.id']}`, {
          method: 'DELETE',
          headers: { 'Authorization': authHeader(config) },
        });
      }
    }

    console.log(`🚫 MikroTik blocked: ${mac}`);
    return true;
  } catch (err) {
    console.error('MikroTik blockClient error:', err.message);
    return false;
  }
}

function queueNameFor(mac) {
  return `rj-${mac.replace(/:/g, '')}`;
}

// Deletes any existing simple queue(s) for this client's queue name.
// Shared by setClientBandwidth (avoid duplicates before re-adding) and
// removeClientBandwidth (session end — no queue should linger).
async function deleteQueue(config, mac) {
  const queueName = queueNameFor(mac);
  const url = `http://${config.ip}/rest/queue/simple?name=${encodeURIComponent(queueName)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': authHeader(config) },
  });
  if (!res.ok) return;
  const queues = await res.json();
  for (const q of queues) {
    await fetch(`http://${config.ip}/rest/queue/simple/${q['.id']}`, {
      method: 'DELETE',
      headers: { 'Authorization': authHeader(config) },
    });
  }
}

// Set bandwidth limit for a client
// NOTE: RouterOS simple queues target an IP address or address range, not a
// MAC directly. We need the DHCP lease for this MAC to know its current IP.
async function setClientBandwidth(mac, mbps) {
  const config = getMikrotikConfig();
  if (!config.ip) return false;
  try {
    // Find the client's current IP via its DHCP lease
    const leaseUrl = `http://${config.ip}/rest/ip/dhcp-server/lease?mac-address=${encodeURIComponent(mac)}`;
    const leaseRes = await fetch(leaseUrl, {
      method: 'GET',
      headers: { 'Authorization': authHeader(config) },
    });
    if (!leaseRes.ok) return false;
    const leases = await leaseRes.json();
    if (leases.length === 0) {
      console.log(`MikroTik: no DHCP lease found yet for ${mac}, skipping bandwidth`);
      return false;
    }
    const ip = leases[0].address;

    // Remove any existing queue for this client first (avoid duplicates)
    await deleteQueue(config, mac);

    const url = `http://${config.ip}/rest/queue/simple`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader(config),
      },
      body: JSON.stringify({
        'name': queueNameFor(mac),
        'target': `${ip}/32`,
        'max-limit': `${mbps}M/${mbps}M`,
      }),
    });
    console.log(`📶 MikroTik bandwidth set: ${mac} (${ip}) → ${mbps}Mbps`);
    return res.ok;
  } catch (err) {
    console.error('MikroTik bandwidth error:', err.message);
    return false;
  }
}

// Remove a client's bandwidth queue (session ended) — mirrors
// networkService's removeClientBandwidth so both backends behave the same
// way on session expiry.
async function removeClientBandwidth(mac) {
  const config = getMikrotikConfig();
  if (!config.ip) return false;
  try {
    await deleteQueue(config, mac);
    console.log(`MikroTik: removed bandwidth queue for ${mac}`);
    return true;
  } catch (err) {
    console.error('MikroTik removeClientBandwidth error:', err.message);
    return false;
  }
}

// Checks whether MikroTik mode is currently active (vs nodogsplash) —
// call this from sessionService.js/timerService.js before branching logic
function isMikrotikModeEnabled() {
  const s = db.prepare('SELECT value FROM settings WHERE key = ?').get('network_mode');
  return s && s.value === 'mikrotik';
}

module.exports = { allowClient, blockClient, setClientBandwidth, removeClientBandwidth, isMikrotikModeEnabled };