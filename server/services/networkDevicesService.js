// ===== NETWORK DEVICES (unified inventory) =====
// Per the Vendo Protocol spec, section 25: "Vendo devices must appear in
// the shared Network Devices inventory. There must be one device identity,
// not separate records for Network Devices and Vendo." This is that shared
// inventory - it merges real passive network discovery (ARP/DHCP, or the
// MikroTik's own tables in Controller Mode - see networkDiscoveryService.js)
// with adopted Vendo devices (the real vendos table real ESP32 firmware
// self-registers into - see POST /api/vendo/register in admin.js) and
// active sessions, keyed by MAC so a Vendo appears once, not as two
// disconnected records.
//
// Traffic is real where it can be, honestly absent where it can't: a
// standalone client only has tc HTB counters while it has an active shaped
// session; a MikroTik client only has queue counters the same way. A device
// that's merely present on the network with no active paid session (a
// printer, an idle laptop, an unpaired candidate) has no traffic source at
// all - shown as unavailable, never a fabricated 0.

const { execFile, execSync } = require('child_process');
const db = require('../config/database');
const { vendorFromMac } = require('./networkDiscoveryService');
const { peekClassId } = require('./drivers/classIdAllocator');

// Real, authoritative "what MAC is actually at this IP right now" lookup -
// moved here from portal.js (which only used it for GET /detect) so
// server/routes/coin.js, promo.js, and session.js can all reuse it too,
// for cross-checking a caller-submitted MAC against the caller's own
// real network identity on the value-transferring routes (coin credit,
// voucher redeem, free-minutes claim, movie-credit use) - previously
// none of those verified the submitted MAC belonged to whoever was
// actually connecting, they just format-validated it and trusted it
// outright. Logic and caching behavior kept identical to the original.
const macResolutionCache = new Map();
const MAC_CACHE_TTL_MS = 10000; // 10 seconds

async function resolveMacFromIp(ip) {
  const cached = macResolutionCache.get(ip);
  if (cached && Date.now() - cached.time < MAC_CACHE_TTL_MS) {
    return cached.mac;
  }

  let mac = null;
  const mikrotikService = require('./mikrotikService');

  if (mikrotikService.isMikrotikModeEnabled()) {
    mac = await mikrotikService.getMacFromIp(ip);
  } else {
    try {
      // Read dnsmasq leases file
      const leases = require('fs').readFileSync('/var/lib/misc/dnsmasq.leases', 'utf8');
      const lines = leases.trim().split('\n');
      for (const line of lines) {
        const parts = line.split(' ');
        // Format: timestamp MAC IP hostname client-id
        if (parts[2] === ip) {
          mac = parts[1].toLowerCase();
          if (parts[3] && parts[3] !== '*') {
            recordObservedHostname(mac, parts[3]);
          }
          break;
        }
      }
    } catch (e) {}

    if (!mac) {
      try {
        // Fallback: use ARP table
        const arp = execSync(`arp -n ${ip} 2>/dev/null`).toString();
        const match = arp.match(/([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/i);
        if (match) mac = match[1].toLowerCase();
      } catch (e) {}
    }
  }

  macResolutionCache.set(ip, { mac, time: Date.now() });
  return mac;
}

// Cross-checks a caller-submitted MAC against what's actually at their
// own IP right now, for every real value-transferring portal route (coin
// credit, voucher redeem, free-minutes claim, movie-credit use). None of
// those previously verified this at all - they format-validated the
// submitted MAC and trusted it outright, meaning anyone who knew (or
// guessed, or sniffed) another customer's MAC could call these routes
// directly - skipping the portal page/JS entirely - and have real value
// credited to that other customer's MAC instead of their own.
//
// Deliberately fails OPEN (allows through) when resolution itself is
// uncertain (returns null - an ARP-cache miss, a DHCP lease not visible
// yet) - same "only block on a confident, positive mismatch" principle
// laneAccessService.js already established elsewhere in this codebase.
// A false positive here would mean refusing a real paying customer's own
// legitimate coin/voucher/claim; that's the wrong direction to guess
// wrong in. Only refuses when the real MAC is confidently known AND
// definitively different from what was claimed.
async function verifyMacBelongsToCaller(claimedMac, ip) {
  try {
    const realMac = await resolveMacFromIp(ip);
    if (!realMac) return true; // couldn't confirm either way - allow
    return realMac.toLowerCase() === String(claimedMac || '').toLowerCase();
  } catch (e) {
    console.error('[MAC ownership check] failed, allowing by default:', e.message);
    return true;
  }
}

function getNetworkMode() {
  return db.prepare("SELECT value FROM settings WHERE key = 'network_mode'").get()?.value || 'standalone';
}

function getLanInterface() {
  return db.prepare("SELECT value FROM settings WHERE key = 'lan_interface'").get()?.value || process.env.LAN_IF || 'enp0s8';
}

// Shared "what should we call this customer's device" helper, used by Top
// Spenders, Live Sessions, and the Users tab so they show a real device
// name (e.g. "Joshs-iPhone") instead of a bare MAC address - the exact
// same client_labels-then-hostname fallback this file already applies for
// Network Devices (see listDevices() below), just made reusable for
// callers that only have a mac, not a full live network scan. An
// operator's manual rename (client_labels) always wins over whatever a
// phone happens to call itself.
function recordObservedHostname(mac, hostname) {
  const macClean = String(mac || '').trim().toLowerCase();
  const nameClean = String(hostname || '').trim();
  // dnsmasq writes a literal "*" for a lease with no hostname - never
  // persist that as if it were a real name.
  if (!macClean || !nameClean || nameClean === '*') return;
  try {
    db.prepare(`
      INSERT INTO device_hostnames (mac_address, hostname, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mac_address) DO UPDATE SET hostname = excluded.hostname, updated_at = excluded.updated_at
    `).run(macClean, nameClean);
  } catch (e) {
    console.error('Failed to record observed hostname:', e.message);
  }
}

// Batch lookup for a list of macs (Top Spenders/Live Sessions/Users tab
// all render a whole table at once) - one query each for the manual-label
// and auto-hostname tables rather than N+1 per row.
function getDisplayNames(macs) {
  const cleanMacs = [...new Set((macs || []).map((m) => String(m || '').trim().toLowerCase()).filter(Boolean))];
  if (cleanMacs.length === 0) return new Map();

  const placeholders = cleanMacs.map(() => '?').join(',');
  const labels = db.prepare(`SELECT mac_address, label FROM client_labels WHERE mac_address IN (${placeholders}) AND label != ''`).all(...cleanMacs);
  const hostnames = db.prepare(`SELECT mac_address, hostname FROM device_hostnames WHERE mac_address IN (${placeholders})`).all(...cleanMacs);

  const result = new Map();
  for (const h of hostnames) result.set(h.mac_address, h.hostname);
  for (const l of labels) result.set(l.mac_address, l.label); // manual label wins
  return result;
}

// Single-mac convenience wrapper over the batch lookup above.
function getDisplayName(mac) {
  const macClean = String(mac || '').trim().toLowerCase();
  return getDisplayNames([macClean]).get(macClean) || null;
}

// Real tc HTB byte counter for a standalone client's own shaping class -
// only exists while that client has an active shaped session.
function getTcTraffic(classId) {
  return new Promise((resolve) => {
    if (!classId) return resolve(null);
    execFile('tc', ['-s', 'class', 'show', 'dev', getLanInterface(), 'classid', `1:${classId}`], (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const m = String(stdout).match(/Sent (\d+) bytes/);
      resolve(m ? { totalBytes: parseInt(m[1], 10) } : null);
    });
  });
}

// Best-effort device "type" from real signals only - never a guessed
// category the data can't actually support. vendorClass comes from the
// MikroTik's own DHCP vendor-class-identifier (see mikrotikService.js's
// scanForDevices) when available.
function inferDeviceType({ isVendo, isAccessPoint, vendorClass }) {
  if (isVendo) return 'Vendo';
  if (isAccessPoint) return 'Access Point';
  const vc = (vendorClass || '').toLowerCase();
  if (vc.includes('android') || vc.includes('iphone') || vc.includes('ios')) return 'Mobile';
  if (vc.includes('msft') || vc.includes('windows') || vc.includes('dhcpcd') || vc.includes('udhcp')) return 'Computer';
  return 'Unknown';
}

async function listDevices() {
  const { scanNetwork } = require('./networkDiscoveryService');
  const mode = getNetworkMode();

  const [discovered, vendos, accessPoints, activeSessions] = await Promise.all([
    scanNetwork().catch(() => []),
    Promise.resolve(db.prepare("SELECT id, name, mac_address, status FROM vendos WHERE status = 'adopted'").all()),
    Promise.resolve(db.prepare('SELECT mac_address FROM access_points').all()),
    Promise.resolve(db.prepare("SELECT mac_address, hard_expires_at FROM sessions WHERE hard_expires_at > datetime('now') AND is_paused = 0").all()),
  ]);

  // Reuses the existing "Name Your Devices" client_labels table (Network >
  // Devices) as the rename mechanism here too, instead of a second,
  // duplicate naming table - an admin-set label wins over anything
  // auto-detected (hostname, Vendo's own registered name).
  const labels = db.prepare('SELECT mac_address, label FROM client_labels').all();
  const labelByMac = new Map(labels.map((l) => [String(l.mac_address || '').toLowerCase(), l.label]));

  const groupRows = db.prepare(`
    SELECT m.mac_address, g.id as group_id, g.name as group_name
    FROM device_group_members m JOIN device_groups g ON g.id = m.group_id
  `).all();
  const groupByMac = new Map(groupRows.map((g) => [String(g.mac_address || '').toLowerCase(), g]));

  const vendoByMac = new Map(vendos.map((v) => [String(v.mac_address || '').toLowerCase(), v]));
  const apMacs = new Set(accessPoints.map((a) => String(a.mac_address || '').toLowerCase()));
  const sessionMacs = new Set(activeSessions.map((s) => String(s.mac_address || '').toLowerCase()));
  const blockedMacs = new Set(db.prepare('SELECT mac_address FROM device_blocks').all().map((b) => b.mac_address));

  const byMac = new Map();
  for (const d of discovered) {
    const mac = String(d.mac || '').toLowerCase();
    if (!mac) continue;
    byMac.set(mac, {
      mac,
      ip: d.ip,
      hostname: d.hostname,
      vendor: d.vendor,
      vendor_class: d.vendor_class,
      vlan_id: d.vlan_id,
      discovered_via: d.discovered_via,
    });
  }
  // A Vendo might be adopted but not currently answering ARP/DHCP (e.g.
  // powered off) - still list it, just as offline with no live IP/VLAN.
  for (const v of vendos) {
    const mac = String(v.mac_address || '').toLowerCase();
    if (!mac) continue;
    if (!byMac.has(mac)) byMac.set(mac, { mac });
  }

  const devices = [];
  for (const entry of byMac.values()) {
    const vendo = vendoByMac.get(entry.mac);
    const isVendo = !!vendo;
    const isAccessPoint = apMacs.has(entry.mac);
    const hasActiveSession = sessionMacs.has(entry.mac);
    // Bug found live: a device that disconnected from WiFi entirely could
    // sit in the DHCP lease file for hours (dnsmasq doesn't drop a lease
    // just because the client stopped responding), so "has an IP" alone
    // kept marking it online long after it actually left, a customer
    // with paid time remaining but no longer connected still showed as a
    // live client until the lease itself expired. discovered_via
    // distinguishes genuine current ARP presence ('arp'/'arp+dhcp',
    // MikroTik mode's 'mikrotik_arp'/'mikrotik_arp+dhcp', the router's
    // own live ARP table, always) from a lease-only sighting ('dhcp') that
    // just means this device was on the network at some point before its
    // lease expires, not that it's here right now.
    const online = !!entry.ip && entry.discovered_via !== 'dhcp';

    let traffic = null;
    if (hasActiveSession) {
      if (mode === 'mikrotik') {
        try {
          const mikrotikService = require('./mikrotikService');
          traffic = await mikrotikService.getClientTraffic(entry.mac);
        } catch (e) { traffic = null; }
      } else {
        traffic = await getTcTraffic(peekClassId(entry.mac));
      }
    }

    // Feeds the same write-through cache Top Spenders/Live Sessions/Users
    // read from (see recordObservedHostname above) - a page load here is a
    // free opportunity to capture a real device name for later, even for
    // a device that never triggers a portal MAC detection (e.g. one that
    // never opens the portal, just sits on the network).
    if (entry.hostname && !isVendo) recordObservedHostname(entry.mac, entry.hostname);

    devices.push({
      mac: entry.mac,
      name: labelByMac.get(entry.mac) || (isVendo ? vendo.name : (entry.hostname || entry.mac)),
      type: inferDeviceType({ isVendo, isAccessPoint, vendorClass: entry.vendor_class }),
      status: online ? 'online' : 'offline',
      ip: entry.ip || null,
      vlan_id: entry.vlan_id || null,
      vendor: entry.vendor || null,
      traffic_bytes: traffic ? traffic.totalBytes : null,
      vendo_id: isVendo ? vendo.id : null,
      group_id: groupByMac.get(entry.mac)?.group_id || null,
      group_name: groupByMac.get(entry.mac)?.group_name || null,
      is_blocked: blockedMacs.has(entry.mac),
    });
  }

  return devices;
}

function summarize(devices) {
  return {
    total: devices.length,
    online: devices.filter((d) => d.status === 'online').length,
    offline: devices.filter((d) => d.status === 'offline').length,
  };
}

function listGroups() {
  return db.prepare('SELECT * FROM device_groups ORDER BY name').all();
}

function createGroup(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Group name is required');
  const result = db.prepare('INSERT INTO device_groups (name) VALUES (?)').run(trimmed);
  return { id: result.lastInsertRowid, name: trimmed };
}

function deleteGroup(id) {
  const result = db.prepare('DELETE FROM device_groups WHERE id = ?').run(id);
  if (result.changes === 0) throw new Error('Group not found');
}

function assignDeviceGroup(mac, groupId) {
  const normalizedMac = String(mac || '').toLowerCase().trim();
  if (groupId) {
    db.prepare(`
      INSERT INTO device_group_members (mac_address, group_id) VALUES (?, ?)
      ON CONFLICT(mac_address) DO UPDATE SET group_id = excluded.group_id
    `).run(normalizedMac, groupId);
    const group = db.prepare('SELECT name FROM device_groups WHERE id = ?').get(groupId);
    db.prepare('INSERT INTO device_events (mac_address, event_type, details) VALUES (?, ?, ?)')
      .run(normalizedMac, 'group_changed', `Added to group "${group ? group.name : groupId}"`);
  } else {
    db.prepare('DELETE FROM device_group_members WHERE mac_address = ?').run(normalizedMac);
    db.prepare('INSERT INTO device_events (mac_address, event_type, details) VALUES (?, ?, ?)')
      .run(normalizedMac, 'group_changed', 'Removed from group');
  }
}

// Shared logging helper - used by this file's own group-assignment
// endpoint and by admin.js's Vendo adopt/remove/rename routes, so there's
// one history table instead of a separate one per feature.
function logDeviceEvent(mac, eventType, details) {
  db.prepare('INSERT INTO device_events (mac_address, event_type, details) VALUES (?, ?, ?)')
    .run(String(mac || '').toLowerCase().trim(), eventType, details || null);
}

function getDeviceHistory(mac) {
  return db.prepare('SELECT event_type, details, created_at FROM device_events WHERE mac_address = ? ORDER BY created_at DESC LIMIT 100')
    .all(String(mac || '').toLowerCase().trim());
}

// Real enforcement via networkService.blockClient/allowClient (the same
// mode-aware mechanism session management already uses) - device_blocks is
// just persistence/audit visibility on top, not a separate access-control
// system of its own.
async function blockDevice(mac) {
  const normalizedMac = String(mac || '').toLowerCase().trim();
  const networkService = require('./networkService');
  await networkService.blockClient(normalizedMac);
  db.prepare('INSERT OR REPLACE INTO device_blocks (mac_address, blocked_at) VALUES (?, CURRENT_TIMESTAMP)').run(normalizedMac);
  logDeviceEvent(normalizedMac, 'blocked', 'Network access blocked');
}

async function unblockDevice(mac) {
  const normalizedMac = String(mac || '').toLowerCase().trim();
  const networkService = require('./networkService');
  await networkService.allowClient(normalizedMac);
  db.prepare('DELETE FROM device_blocks WHERE mac_address = ?').run(normalizedMac);
  logDeviceEvent(normalizedMac, 'unblocked', 'Network access restored');
}

module.exports = { listDevices, summarize, listGroups, createGroup, deleteGroup, assignDeviceGroup, logDeviceEvent, getDeviceHistory, blockDevice, unblockDevice, getTcTraffic, recordObservedHostname, getDisplayName, getDisplayNames, resolveMacFromIp, verifyMacBelongsToCaller };
