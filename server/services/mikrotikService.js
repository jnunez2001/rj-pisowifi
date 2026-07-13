// ===== MIKROTIK SERVICE =====
// Handles MikroTik router control via the native binary API (RouterOS 6 and
// 7 — see mikrotikApiClient.js for why the binary API instead of REST).
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
// Command shape mirrors the CLI menu path ("/ip/hotspot/ip-binding/print"),
// with parameters as "=key=value" words and query filters as "?key=value".
// "remove"/"set" need the record's ".id" — always look it up first, same
// pattern as the old REST GET-before-DELETE/PATCH.

const db = require('../config/database');
const { withMikrotik } = require('./mikrotikApiClient');
const { getMikrotikConfig } = require('./mikrotikConfigHelper');

// Bug found on real hardware: every MAC-based print filter in this file
// (?mac-address=...) is an exact string match against whatever RouterOS
// actually has stored - and RouterOS always stores/displays MACs uppercase,
// regardless of the case used when the record was created. This app
// normalizes MACs to lowercase everywhere else (networkService.js's
// normalizeMac), so every one of these filters was silently matching
// nothing: findIpBinding() never found the binding it just created,
// blockClient() logged "blocked" and returned success having removed
// nothing (the binding stayed on the router), and the DHCP-lease-based
// bandwidth lookup in setClientBandwidth() had the same silent-miss bug.
// Uppercase right at the boundary to RouterOS's own API calls, without
// touching this app's own lowercase convention anywhere else.
const mikMac = (mac) => String(mac).toUpperCase();

/**
 * Looks up the existing ip-binding record for a MAC, if any.
 * Returns the full record (including its .id), or null if genuinely not
 * found. A lookup failure (network error, timeout, router error) throws —
 * client.talk() rejects on those — rather than resolving as "not found",
 * so callers can't mistake a transient failure for "nothing exists yet"
 * (that mistake used to create duplicate ip-bindings under the old REST
 * client; the binary client's reject-on-failure behavior preserves the fix
 * automatically).
 */
async function findIpBinding(client, mac) {
  const res = await client.talk(['/ip/hotspot/ip-binding/print', `?mac-address=${mikMac(mac)}`]);
  return res.re.length > 0 ? res.re[0] : null;
}

// Whether a MAC is currently allowed through (bypassed ip-binding exists).
// Used by app.js's captive-portal-detection routes (generate_204,
// hotspot-detect.html, etc.) in router mode, since those used to check a
// local nftables set that only ever exists in standalone mode.
async function isClientAllowed(mac) {
  const config = getMikrotikConfig();
  if (!config.ip) return false;
  try {
    return await withMikrotik(config, async (client) => {
      const existing = await findIpBinding(client, mac);
      return !!existing;
    });
  } catch (err) {
    console.error('MikroTik isClientAllowed error:', err.message);
    return false;
  }
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
    return await withMikrotik(config, async (client) => {
      const existing = await findIpBinding(client, mac);

      if (existing) {
        // Already bound — just refresh the comment so we can see when it was renewed
        await client.talk(['/ip/hotspot/ip-binding/set', `=.id=${existing['.id']}`, `=comment=rj-piso-${Date.now()}`]);
        console.log(`✅ MikroTik refreshed existing binding: ${mac}`);
        return true;
      }

      // No existing binding — create one
      await client.talk(['/ip/hotspot/ip-binding/add', `=mac-address=${mikMac(mac)}`, '=type=bypassed', `=comment=rj-piso-${Date.now()}`]);
      console.log(`✅ MikroTik allowed: ${mac}`);
      return true;
    });
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
    const removedBinding = await withMikrotik(config, async (client) => {
      // Remove the ip-binding that was granting bypass access
      const binding = await findIpBinding(client, mac);
      if (binding) {
        await client.talk(['/ip/hotspot/ip-binding/remove', `=.id=${binding['.id']}`]);
      }

      // Also kick any currently-active hotspot session for this MAC, so access
      // is cut immediately instead of waiting for the connection to naturally drop
      const activeRes = await client.talk(['/ip/hotspot/active/print', `?mac-address=${mikMac(mac)}`]);
      for (const session of activeRes.re) {
        await client.talk(['/ip/hotspot/active/remove', `=.id=${session['.id']}`]);
      }

      return !!binding;
    });
    // Bug found on real hardware: this used to log success unconditionally,
    // even when findIpBinding() found nothing and there was genuinely
    // nothing to remove — masking the MAC-case mismatch bug above entirely,
    // since every call "succeeded" whether or not it actually did anything.
    if (removedBinding) {
      console.log(`🚫 MikroTik blocked: ${mac}`);
    } else {
      console.warn(`⚠️ MikroTik blockClient: no ip-binding found for ${mac} - nothing to remove`);
    }
    return true;
  } catch (err) {
    console.error('MikroTik blockClient error:', err.message);
    return false;
  }
}

function queueNameFor(mac) {
  return `rj-${mac.replace(/:/g, '')}`;
}

// Deletes any existing simple queue(s) for this client. A client's
// bandwidth is now a parent queue (rj-<mac>, the overall cap) plus two
// priority children (rj-<mac>-udp, rj-<mac>-other) for game-traffic
// prioritization (see setClientBandwidth) - "~" is a substring match on
// name, so this catches all three (and the old flat single-queue shape
// from before this existed, for a clean upgrade on existing sessions) in
// one query instead of needing to know the exact child names up front.
// Children must be removed before their parent (RouterOS won't remove a
// queue that still has children referencing it) - reversing the print
// order (children were added after the parent, so this list is
// parent-first) guarantees that.
async function deleteQueue(client, mac) {
  const queueName = queueNameFor(mac);
  const res = await client.talk(['/queue/simple/print', `?name~${queueName}`]);
  for (const q of res.re.slice().reverse()) {
    await client.talk(['/queue/simple/remove', `=.id=${q['.id']}`]);
  }
}

// Set bandwidth limit for a client.
// NOTE: RouterOS simple queues target an IP address or address range, not a
// MAC directly. We need the DHCP lease for this MAC to know its current IP.
//
// Bug (ROUTER_MODE_PLAN.md §12): this used to take a single mbps value and
// apply it to both directions - bandwidth_cap_upload_mbps existed as a
// setting and was editable from the admin UI, but nothing ever actually
// read it. RouterOS's own max-limit parameter is upload/download order, so
// that ordering is preserved here to match what an admin reading a
// RouterOS export would expect. uploadMbps defaults to downloadMbps when
// omitted, so any caller still passing one argument keeps its old behavior
// instead of silently breaking.
// burst is optional: { mbps, seconds } - a genuine, RouterOS-native burst
// (real router-enforced QoS, not anything that fakes or hides itself from
// a speed test). RouterOS allows a client to run at burst-limit as long as
// their own average rate over the last burst-time seconds stays below
// burst-threshold; once real sustained usage pushes that average up to the
// threshold, the router drops them back to max-limit on its own. threshold
// is set to the sustained cap itself, so a client bursts freely from an
// idle/light-use starting point (a page load, a short speed test) but
// settles back to the honest cap the moment they're actually using it.
async function setClientBandwidth(mac, downloadMbps, uploadMbps = downloadMbps, burst = null) {
  const config = getMikrotikConfig();
  if (!config.ip) return false;

  const download = parseInt(downloadMbps, 10);
  const upload = parseInt(uploadMbps, 10);
  if (!Number.isFinite(download) || download <= 0 || !Number.isFinite(upload) || upload <= 0) {
    console.error(`[MikroTik] Invalid bandwidth for ${mac}: down=${downloadMbps} up=${uploadMbps}`);
    return false;
  }

  let burstMbps = null;
  let burstSeconds = null;
  if (burst && Number.isFinite(parseInt(burst.mbps, 10)) && Number.isFinite(parseInt(burst.seconds, 10))) {
    burstMbps = parseInt(burst.mbps, 10);
    burstSeconds = parseInt(burst.seconds, 10);
    if (burstMbps <= Math.max(download, upload)) {
      console.warn(`[MikroTik] Burst speed (${burstMbps}Mbps) must exceed the cap - ignoring burst for ${mac}`);
      burstMbps = null;
      burstSeconds = null;
    }
  }

  try {
    return await withMikrotik(config, async (client) => {
      // Find the client's current IP via its DHCP lease
      const leaseRes = await client.talk(['/ip/dhcp-server/lease/print', `?mac-address=${mikMac(mac)}`]);
      if (leaseRes.re.length === 0) {
        console.log(`MikroTik: no DHCP lease found yet for ${mac}, skipping bandwidth`);
        return false;
      }
      const lease = leaseRes.re[0];
      const ip = lease.address;

      // Bug found on real hardware: this per-client queue was always added
      // with no explicit ordering relative to its lane's own smart queue
      // (mikrotikProvisioner.js's "<bridge>-queue", covering the whole
      // subnet). RouterOS Simple Queues apply only the FIRST matching
      // queue in list order when two queues' targets overlap and aren't
      // explicitly parent/child-linked - since the lane queue already
      // exists (created during Configure, so it's earlier in the list) and
      // its /24 target already covers this client's /32 address, it always
      // won, and the per-client cap silently never took effect for anyone,
      // in any session, ever. Insert the per-client queue directly above
      // its own lane's queue (via place-before) so the narrower per-client
      // limit is what actually gets evaluated first. Lane name is derived
      // from the DHCP server name on this lease ("<bridge>-dhcp"), matching
      // mikrotikProvisioner.js's own naming convention exactly.
      let placeBeforeId = null;
      if (lease.server) {
        const laneQueueName = lease.server.replace(/-dhcp$/, '-queue');
        const laneQueueRes = await client.talk(['/queue/simple/print', `?name=${laneQueueName}`]);
        if (laneQueueRes.re.length > 0) {
          placeBeforeId = laneQueueRes.re[0]['.id'];
        }
      }

      // Remove any existing queue for this client first (avoid duplicates)
      await deleteQueue(client, mac);

      const baseName = queueNameFor(mac);

      // New: game-traffic prioritization. A flat single queue treats a
      // customer's own game packets and their own/other customers' bulk
      // traffic (downloads, video) identically - on a shared, capped
      // connection, that's the real source of gaming lag, not just the raw
      // Mbps number. Splitting into a parent (the overall cap, unchanged
      // from before) plus two priority children fixes this: UDP traffic
      // (what most real-time games use) is marked by a one-time mangle
      // rule during Configure (mikrotikProvisioner.js's
      // "Mark UDP traffic for game-priority queueing" step) and always
      // gets served first via priority=1 when this client's own traffic is
      // contending for their own capped bandwidth, while everything else
      // shares what's left at priority=8. Total throughput still never
      // exceeds the parent's max-limit - this changes ordering under
      // contention, not the cap itself.
      const parentWords = ['/queue/simple/add', `=name=${baseName}`, `=target=${ip}/32`, `=max-limit=${upload}M/${download}M`];
      if (placeBeforeId) parentWords.push(`=place-before=${placeBeforeId}`);
      if (burstMbps) {
        // burst-threshold = the sustained cap itself: bursting is allowed
        // only while this client's own average stays at/below what they're
        // already paying for, not above it.
        parentWords.push(`=burst-limit=${burstMbps}M/${burstMbps}M`);
        parentWords.push(`=burst-threshold=${upload}M/${download}M`);
        parentWords.push(`=burst-time=${burstSeconds}s/${burstSeconds}s`);
      }
      await client.talk(parentWords);

      await client.talk([
        '/queue/simple/add', `=name=${baseName}-udp`, `=parent=${baseName}`,
        '=packet-marks=rj-game-priority', `=max-limit=${upload}M/${download}M`, '=priority=1/1',
      ]);
      await client.talk([
        '/queue/simple/add', `=name=${baseName}-other`, `=parent=${baseName}`,
        `=max-limit=${upload}M/${download}M`, '=priority=8/8',
      ]);

      console.log(`📶 MikroTik bandwidth set: ${mac} (${ip}) → ${download}Mbps down / ${upload}Mbps up, game traffic prioritized${burstMbps ? ` (burst ${burstMbps}Mbps for ${burstSeconds}s)` : ''}${placeBeforeId ? '' : ' (WARNING: could not find lane queue to place before - lane-wide limit may take priority)'}`);
      return true;
    });
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
    await withMikrotik(config, (client) => deleteQueue(client, mac));
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

// ROUTER_MODE_PLAN.md Stage 3 — live port discovery. Queries the router
// itself for its actual physical ethernet ports rather than assuming a
// fixed model/port-count, so the same code works on any MikroTik hardware
// (ROUTER_MODE_PLAN.md §2/§7 — no hardcoded router-model list).
async function getRouterPorts() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const res = await client.talk(['/interface/ethernet/print']);
    return res.re.map((r) => ({
      name: r.name,
      mac: r['mac-address'] || '',
      running: r.running === 'true',
      disabled: r.disabled === 'true',
    }));
  });
}

// Live status card (ROUTER_MODE_PLAN.md §4.7) — read straight from the
// router, not our own database, so it reflects what's actually true right
// now rather than what we last told it to be.
async function getLiveStatus() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const resourceRes = await client.talk(['/system/resource/print']);
    const identityRes = await client.talk(['/system/identity/print']);
    const activeRes = await client.talk(['/ip/hotspot/active/print']);
    const r = resourceRes.re[0] || {};
    return {
      model: r['board-name'] || 'Unknown',
      routerosVersion: r['version'] || 'Unknown',
      uptime: r['uptime'] || 'Unknown',
      cpuLoad: r['cpu-load'] || '0',
      identity: (identityRes.re[0] || {}).name || '',
      activeDevices: activeRes.re.length,
    };
  });
}

// "Test connection" button — just needs to prove login succeeds, doesn't
// need the full status payload.
async function testConnection() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  await withMikrotik(config, async (client) => {
    await client.talk(['/system/identity/print']);
  });
  return true;
}

// Bug found on real hardware: app.js/portal.js resolved a client's MAC from
// its IP by reading this server's own local ARP table / dnsmasq.leases —
// both of which only ever have entries for devices on the same Layer 2
// segment as this server. That's true for any lane sharing this server's
// own bridge (e.g. PC-Rental), but a gated lane on its own separate bridge
// (e.g. WiFi-Rental's VLAN) is a different broadcast domain entirely,
// reachable only by routing through the MikroTik — this server has zero L2
// visibility into it, so local ARP lookups can never find those clients'
// MACs, no matter how many times you retry. The router itself, as the
// actual gateway for every lane, always knows the true IP-to-MAC mapping —
// its own DHCP lease table is the reliable source of truth in router mode.
async function getMacFromIp(ip) {
  const config = getMikrotikConfig();
  if (!config.ip) return null;
  try {
    return await withMikrotik(config, async (client) => {
      const res = await client.talk(['/ip/dhcp-server/lease/print', `?address=${ip}`]);
      const lease = res.re[0];
      return lease && lease['mac-address'] ? lease['mac-address'].toLowerCase() : null;
    });
  } catch (err) {
    console.error('MikroTik getMacFromIp error:', err.message);
    return null;
  }
}

module.exports = {
  allowClient,
  blockClient,
  isClientAllowed,
  setClientBandwidth,
  removeClientBandwidth,
  isMikrotikModeEnabled,
  getRouterPorts,
  getLiveStatus,
  testConnection,
  getMacFromIp,
};
