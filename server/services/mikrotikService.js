// ===== MIKROTIK SERVICE =====
// Handles MikroTik router control via the native binary API (RouterOS 6 and
// 7, see mikrotikApiClient.js for why the binary API instead of REST).
// Used when network_mode = 'mikrotik'
//
// IMPORTANT: allowClient/blockClient use /ip/hotspot/ip-binding, NOT
// /ip/hotspot/active. The "active" list only contains devices that have
// already authenticated through Hotspot's own login page, you can't force
// an entry there for a device that hasn't logged in yet. ip-binding with
// type=bypassed is the correct mechanism: it tells Hotspot "let this MAC
// through without going through the login page at all," which is what a
// coin-slot-triggers-access flow actually needs.
//
// Command shape mirrors the CLI menu path ("/ip/hotspot/ip-binding/print"),
// with parameters as "=key=value" words and query filters as "?key=value".
// "remove"/"set" need the record's ".id", always look it up first, same
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
 * found. A lookup failure (network error, timeout, router error) throws,
 * client.talk() rejects on those, rather than resolving as "not found",
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
// Time enforcement stays with our own DB/cron (timerService), the router
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
        // Already bound, just refresh the comment so we can see when it was renewed
        await client.talk(['/ip/hotspot/ip-binding/set', `=.id=${existing['.id']}`, `=comment=rj-piso-${Date.now()}`]);
        console.log(`✅ MikroTik refreshed existing binding: ${mac}`);
        return true;
      }

      // No existing binding, create one
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
    // nothing to remove, masking the MAC-case mismatch bug above entirely,
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

// Global self-heal, not just per-session: found live that a customer's
// queue survived on the router pointed at a stale IP long after their
// session had ended (normal cleanup - expireSession() calling
// removeClientBandwidth() - only fires when a session ends gracefully;
// a server restart, crash, or manual DB edit mid-session skips it
// entirely, leaving an orphaned queue that permanently shadows whatever
// new IP that MAC gets later, since RouterOS just... never told anyone).
// Called every tick (timerService.js) in mikrotik mode - removes any
// rj-<mac> queue whose MAC isn't a currently active session, so a stale
// queue is gone within one tick instead of surviving indefinitely.
const PER_CLIENT_QUEUE_RE = /^rj-([0-9a-f]{12})(-udp|-other)?$/;

async function pruneOrphanedQueues(activeMacs) {
  const config = getMikrotikConfig();
  if (!config.ip) return;
  const activeSet = new Set(activeMacs.map((m) => m.toLowerCase().replace(/:/g, '')));
  try {
    await withMikrotik(config, async (client) => {
      const res = await client.talk(['/queue/simple/print']);
      // Parents first in the list, remove children before parents (RouterOS
      // rejects removing a queue that still has children) - reverse order.
      for (const q of res.re.slice().reverse()) {
        const match = PER_CLIENT_QUEUE_RE.exec(q.name || '');
        if (!match) continue; // not a per-client queue (e.g. a lane queue) - leave it alone
        if (activeSet.has(match[1])) continue; // still a real active session
        await client.talk(['/queue/simple/remove', `=.id=${q['.id']}`]);
        console.log(`[MikroTik] Pruned orphaned bandwidth queue: ${q.name} (no matching active session)`);
      }
    });
  } catch (err) {
    console.error('[MikroTik] pruneOrphanedQueues failed:', err.message);
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
// Real bug found live: setClientBandwidth() is called every 30s for every
// active session (timerService.js's tick, see its own comment - "resolve
// the client's CURRENT IP/state fresh on every call and are idempotent,
// refresh an existing binding rather than erroring"), and deleteQueue()
// runs immediately before every add here specifically to make that true.
// In practice RouterOS still occasionally rejected the add with "already
// have such name" - the remove and the very next add land close enough
// together that the router hasn't finished dropping the old queue from
// its name-uniqueness index yet, even though our API session already got
// a clean "!done" for the remove. Rather than trying to out-race that
// (a fixed delay would either be too short some of the time or waste time
// every time), add falls back to updating the existing queue by name when
// the add is rejected for exactly this reason - actually honoring
// "refresh" instead of erroring on every tick for an already-active
// session.
async function addOrUpdateQueue(client, words) {
  try {
    await client.talk(words);
  } catch (err) {
    if (!/already have such name/i.test(err.message || '')) throw err;
    const nameWord = words.find((w) => w.startsWith('=name='));
    const name = nameWord ? nameWord.slice('=name='.length) : null;
    if (!name) throw err;
    const existing = await client.talk(['/queue/simple/print', `?name=${name}`]);
    if (existing.re.length === 0) throw err;
    // target/parent/max-limit/priority/burst-* etc - same fields, just via
    // set instead of add. Confirmed live: RouterOS rejects place-before on
    // /queue/simple/set ("unknown parameter place-before") - it's an
    // add-only positional parameter, not a settable property, so it's
    // dropped here. The existing queue keeps whatever position it already
    // has; place-before only ever mattered at initial creation time to
    // rank this client's cap above its lane's own wider queue (see the
    // comment above this queue's original /add call) - a queue being
    // refreshed here was already created correctly-positioned the first
    // time, so losing place-before on a refresh doesn't reopen that bug.
    const setWords = words.filter((w) =>
      w !== '/queue/simple/add' && !w.startsWith('=name=') && !w.startsWith('=place-before=')
    );
    await client.talk(['/queue/simple/set', `=.id=${existing.re[0]['.id']}`, ...setWords]);
  }
}

// burst is optional: { mbps, seconds } - a genuine, RouterOS-native burst
// (real router-enforced QoS, not anything that fakes or hides itself from
// a speed test). RouterOS allows a client to run at burst-limit as long as
// their own average rate over the last burst-time seconds stays below
// burst-threshold; once real sustained usage pushes that average up to the
// threshold, the router drops them back to max-limit on its own. threshold
// is set to the sustained cap itself, so a client bursts freely from an
// idle/light-use starting point (a page load, a short speed test) but
// settles back to the honest cap the moment they're actually using it.
async function setClientBandwidth(mac, downloadMbps, uploadMbps = downloadMbps, burst = null, trackDataUsage = false) {
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

  // Real problems found live with a per-MAC queue for every single session
  // (the original design): (1) a device that rotates its MAC mid-session
  // (iOS/Android privacy MAC randomization) gets a fresh DHCP lease its old
  // queue was never told about, and just... isn't capped anymore until
  // something re-provisions it; (2) the queue list fills up with one rj-<mac>
  // entry per customer who's ever connected, most of them for the exact same
  // flat rate. When this call is just the plain global default cap (no real
  // per-client override - Premium, a custom voucher rate, etc.) AND the
  // router actually has mikrotikProvisioner.js's lane-wide "<bridge>-
  // regular-cap" PCQ queue provisioned, skip creating an individual queue
  // entirely and rely on that shared queue instead - RouterOS dynamically
  // sub-divides it by IP on its own, immune to MAC rotation and adding zero
  // objects per client. The regular-cap queue's existence is checked live,
  // not assumed - a router that hasn't had Configure re-run since this
  // existed falls back to the original per-client queue behavior below
  // rather than silently leaving default-rate customers uncapped.
  const defaultDownload = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_cap_download_mbps'").get()?.value || '0', 10);
  const defaultUpload = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_cap_upload_mbps'").get()?.value || '0', 10);
  // A session tracking data usage against a cap (Plans > Data type) needs
  // a real per-client queue to read bytes back from, even if its speed
  // happens to match the plain default - the shared PCQ queue below can't
  // attribute bytes to one specific client.
  const isPlainDefaultCap = !trackDataUsage && !burstMbps && download === defaultDownload && upload === defaultUpload;

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
      // Looked up before "<bridge>-queue" fairness queue for a router that
      // hasn't had Configure re-run since regular-cap was introduced -
      // either way, an override queue just needs to rank above whatever
      // wider queue would otherwise also match this client's /32 address.
      let placeBeforeId = null;
      let regularCapExists = false;
      if (lease.server) {
        const bridgeName = lease.server.replace(/-dhcp$/, '');
        const regularCapRes = await client.talk(['/queue/simple/print', `?name=${bridgeName}-regular-cap`]);
        if (regularCapRes.re.length > 0) {
          placeBeforeId = regularCapRes.re[0]['.id'];
          regularCapExists = true;
        } else {
          const laneQueueRes = await client.talk(['/queue/simple/print', `?name=${bridgeName}-queue`]);
          if (laneQueueRes.re.length > 0) placeBeforeId = laneQueueRes.re[0]['.id'];
        }
      }

      if (isPlainDefaultCap && regularCapExists) {
        await deleteQueue(client, mac);
        console.log(`📶 MikroTik: ${mac} is on the plain default cap - relying on the lane's shared PCQ queue, no individual queue created`);
        return true;
      }
      if (isPlainDefaultCap && !regularCapExists) {
        console.warn(`📶 MikroTik: ${mac} needs the default cap but this lane has no regular-cap queue yet (Configure hasn't been re-run since this feature was added) - falling back to an individual queue for now. Re-run Configure to switch this lane to the shared PCQ queue.`);
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
      await addOrUpdateQueue(client, parentWords);

      // Bug found live: burst was configured on the parent queue only. Real
      // traffic never actually flows through the parent itself in a RouterOS
      // queue tree - it flows through whichever CHILD queue matches
      // (game-priority UDP or "other"), each independently rate-limited by
      // its own max-limit. Without the same burst-limit/threshold/time here,
      // a child's flat max-limit is the real bottleneck regardless of what
      // the parent allows, silently capping every client at the base rate -
      // exactly the "still not bursting, maintained the Xmbps cap" symptom.
      const childBurstWords = burstMbps ? [
        `=burst-limit=${burstMbps}M/${burstMbps}M`,
        `=burst-threshold=${upload}M/${download}M`,
        `=burst-time=${burstSeconds}s/${burstSeconds}s`,
      ] : [];

      // Bug found live (matches place-before's own history above): a child
      // queue's =parent= alone isn't enough for RouterOS to accept it on
      // every call. The first /add succeeds fine, but the periodic re-apply
      // (this session's own bandwidth reasserted every 30s by timerService)
      // hits addOrUpdateQueue's "already have such name" -> /queue/simple/set
      // fallback every time after that, and that update call was failing
      // with "missing =target=" on every single tick - real router log
      // evidence, not a guess. Setting an explicit =target= on the child too
      // (redundant with =parent= on a fresh /add, but required for /set to
      // have an identifier RouterOS actually accepts) fixes both paths.
      await addOrUpdateQueue(client, [
        '/queue/simple/add', `=name=${baseName}-udp`, `=parent=${baseName}`, `=target=${ip}/32`,
        '=packet-marks=rj-game-priority', `=max-limit=${upload}M/${download}M`, '=priority=1/1',
        ...childBurstWords,
      ]);
      await addOrUpdateQueue(client, [
        '/queue/simple/add', `=name=${baseName}-other`, `=parent=${baseName}`, `=target=${ip}/32`,
        `=max-limit=${upload}M/${download}M`, '=priority=8/8',
        ...childBurstWords,
      ]);

      console.log(`📶 MikroTik bandwidth set: ${mac} (${ip}) → ${download}Mbps down / ${upload}Mbps up, game traffic prioritized${burstMbps ? ` (burst ${burstMbps}Mbps for ${burstSeconds}s)` : ''}${placeBeforeId ? '' : ' (WARNING: could not find lane queue to place before - lane-wide limit may take priority)'}`);
      return true;
    });
  } catch (err) {
    console.error('MikroTik bandwidth error:', err.message);
    return false;
  }
}

// Remove a client's bandwidth queue (session ended), mirrors
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

// Checks whether MikroTik mode is currently active (vs nodogsplash),
// call this from sessionService.js/timerService.js before branching logic
function isMikrotikModeEnabled() {
  const s = db.prepare('SELECT value FROM settings WHERE key = ?').get('network_mode');
  return s && s.value === 'mikrotik';
}

// ROUTER_MODE_PLAN.md Stage 3, live port discovery. Queries the router
// itself for its actual physical ethernet ports rather than assuming a
// fixed model/port-count, so the same code works on any MikroTik hardware
// (ROUTER_MODE_PLAN.md §2/§7, no hardcoded router-model list).
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

// Live status card (ROUTER_MODE_PLAN.md §4.7), read straight from the
// router, not our own database, so it reflects what's actually true right
// now rather than what we last told it to be.
async function getLiveStatus() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const resourceRes = await client.talk(['/system/resource/print']);
    const identityRes = await client.talk(['/system/identity/print']);
    // Bug: this used to count /ip/hotspot/active/print, which only ever
    // lists devices that authenticated through Hotspot's own login page -
    // per this file's own top comment, allowClient() deliberately bypasses
    // that page entirely via ip-binding type=bypassed, so a real, paying,
    // currently-online device NEVER appears there. Live Status showed 0
    // active devices no matter how many customers were actually connected.
    // Counting bypassed ip-bindings instead matches the access mechanism
    // this app actually uses.
    const activeRes = await client.talk(['/ip/hotspot/ip-binding/print', '?type=bypassed']);
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

// Dashboard's optional Network Traffic graph (comprehensive mode). RouterOS
// gives an instant rate directly via monitor-traffic's "once" mode - no
// need to sample twice and compute a delta client-side the way the
// standalone/interface-counter path has to.
async function getInterfaceTraffic(interfaceNames) {
  const config = getMikrotikConfig();
  if (!config.ip || !interfaceNames.length) return { download_mbps: 0, upload_mbps: 0 };
  return withMikrotik(config, async (client) => {
    let rxTotal = 0;
    let txTotal = 0;
    for (const name of interfaceNames) {
      const res = await client.talk(['/interface/monitor-traffic', `=interface=${name}`, '=once=']);
      const r = res.re[0] || {};
      rxTotal += parseInt(r['rx-bits-per-second'], 10) || 0;
      txTotal += parseInt(r['tx-bits-per-second'], 10) || 0;
    }
    // Measuring the customer-facing (gated LAN) interface, not WAN: traffic
    // the router TRANSMITS out that port is what customers are downloading,
    // traffic it RECEIVES on that port is what they're uploading - the
    // reverse of how rx/tx would read on the WAN side.
    return {
      download_mbps: Math.round((txTotal / 1000000) * 10) / 10,
      upload_mbps: Math.round((rxTotal / 1000000) * 10) / 10
    };
  });
}

// Settings > Portal Settings > Customer Portal Address, router mode's
// equivalent of setup-network.sh's dnsmasq address= line - the router owns
// DNS in this mode (our own dnsmasq is disabled), so this server can't
// answer that hostname itself. Adds/updates a static DNS record on the
// router resolving it to THIS server's own current DHCP lease address (via
// server_lan_mac, the same setting Ports and Roles auto-provisioning
// already relies on to know which device on the router IS this server).
// Best-effort: silently no-ops if server_lan_mac isn't set or has no
// current lease yet, same as this file's other bandwidth/queue calls that
// depend on a lease existing.
async function setPortalDnsName(hostname) {
  const config = getMikrotikConfig();
  if (!config.ip || !hostname) return false;
  const ownMac = db.prepare("SELECT value FROM settings WHERE key = 'server_lan_mac'").get()?.value;
  if (!ownMac) return false;
  try {
    return await withMikrotik(config, async (client) => {
      const leaseRes = await client.talk(['/ip/dhcp-server/lease/print', `?mac-address=${mikMac(ownMac)}`]);
      if (leaseRes.re.length === 0) return false;
      const ip = leaseRes.re[0].address;

      // Bug found live: this created the static DNS record, but a LAN
      // client's DNS query never reaches it unless the router's own DNS
      // server actually answers LAN requests - that's a separate setting
      // (allow-remote-requests) that used to only ever get enabled during
      // a full Configure run. An admin who set a Portal Hostname without
      // re-running Configure (reasonably - Configure touches the whole
      // router, not something to risk for a DNS tweak) had a record that
      // existed but was completely unreachable, with the UI's own text
      // saying as much ("Applies on your next Configure run") instead of
      // this just working the moment it's saved, same as everything else
      // POST /settings applies live. This alone doesn't touch bridges,
      // ports, NAT, or Hotspot - safe to apply standalone.
      await client.talk(['/ip/dns/set', '=allow-remote-requests=yes', '=servers=8.8.8.8,1.1.1.1']);

      const existing = await client.talk(['/ip/dns/static/print', `?name=${hostname}`]);
      for (const row of existing.re) {
        await client.talk(['/ip/dns/static/remove', `=.id=${row['.id']}`]);
      }
      await client.talk(['/ip/dns/static/add', `=name=${hostname}`, `=address=${ip}`]);
      console.log(`[MikroTik] Portal address ${hostname} -> ${ip}`);
      return true;
    });
  } catch (err) {
    console.error('[MikroTik] setPortalDnsName failed:', err.message);
    return false;
  }
}

// "Test connection" button, just needs to prove login succeeds, doesn't
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
// its IP by reading this server's own local ARP table / dnsmasq.leases,
// both of which only ever have entries for devices on the same Layer 2
// segment as this server. That's true for any lane sharing this server's
// own bridge (e.g. PC-Rental), but a gated lane on its own separate bridge
// (e.g. WiFi-Rental's VLAN) is a different broadcast domain entirely,
// reachable only by routing through the MikroTik, this server has zero L2
// visibility into it, so local ARP lookups can never find those clients'
// MACs, no matter how many times you retry. The router itself, as the
// actual gateway for every lane, always knows the true IP-to-MAC mapping,
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

// Reverse of getMacFromIp, same DHCP lease table, the other direction.
// Needed for the coin-crediting path: the ESP32 relaying a coin insert only
// knows its OWN WiFi IP, never the paying customer's, a shared coin slot
// serves many different customers over time and has no way to know who's
// currently inserting a coin from its own network layer. The real IP for
// the session being credited has to be looked up server-side by the
// customer's MAC instead of trusted from the relay device's request body.
async function getIpFromMac(mac) {
  const config = getMikrotikConfig();
  if (!config.ip) return null;
  const target = String(mac || '').toLowerCase();
  try {
    return await withMikrotik(config, async (client) => {
      const res = await client.talk(['/ip/dhcp-server/lease/print', `?mac-address=${mikMac(target)}`]);
      const lease = res.re[0];
      return lease && lease.address ? lease.address : null;
    });
  } catch (err) {
    console.error('MikroTik getIpFromMac error:', err.message);
    return null;
  }
}

// ===== VLAN MANAGER (network power parity with Standalone mode) =====
// Standalone mode already lets an operator create/list/delete VLANs
// locally (server/routes/admin.js's /network/vlans endpoints, backed by
// the `vlans` table + setup-network.sh). MikroTik mode had nothing
// equivalent - the operator had to configure VLANs by hand in WinBox
// first. This brings the same capability to Router Mode over the RouterOS
// API: a VLAN interface (/interface/vlan) plus, for a "lan" VLAN, an IP
// address on it (/ip/address) so it's actually a usable network, not just
// a bare tagged interface.
//
// Scope note: this is the VLAN interface + addressing only. DHCP server
// provisioning for the VLAN and firewall/NAT policy are separate,
// not-yet-built network-power items (see BETA_LAUNCH_PLAN.md group 4) -
// creating a VLAN here does not yet make it hand out addresses or have
// any firewall policy of its own.

// Lists VLAN interfaces along with whatever IP address (if any) RouterOS
// has assigned directly to each one.
async function listVlans() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const [vlanRes, addrRes] = await Promise.all([
      client.talk(['/interface/vlan/print']),
      client.talk(['/ip/address/print']),
    ]);
    return vlanRes.re.map((v) => {
      const addr = addrRes.re.find((a) => a.interface === v.name);
      return {
        id: v['.id'],
        name: v.name,
        vlan_id: parseInt(v['vlan-id'], 10),
        parent_interface: v.interface,
        disabled: v.disabled === 'true',
        running: v.running === 'true',
        ip_address: addr ? addr.address : null,
      };
    });
  });
}

class MikrotikVlanConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'MikrotikVlanConflictError';
  }
}

// Creates a VLAN interface on `parentInterface`, optionally with a
// directly-assigned IP (CIDR form, e.g. "192.168.13.1/24") to make it a
// real addressable LAN. Idempotency/conflict check first - RouterOS
// itself would reject a duplicate vlan-id+interface combination, but a
// pre-check gives a clear, specific error instead of a raw RouterOS
// rejection message.
async function createVlan({ parentInterface, vlanId, name, ipAddress }) {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  const vlanName = name || `vlan${vlanId}-${parentInterface}`;

  return withMikrotik(config, async (client) => {
    const existing = await client.talk(['/interface/vlan/print', `?vlan-id=${vlanId}`, `?interface=${parentInterface}`]);
    if (existing.re.length > 0) {
      throw new MikrotikVlanConflictError(`VLAN ${vlanId} already exists on ${parentInterface}`);
    }

    await client.talk([
      '/interface/vlan/add',
      `=name=${vlanName}`,
      `=vlan-id=${vlanId}`,
      `=interface=${parentInterface}`,
    ]);

    if (ipAddress) {
      try {
        await client.talk(['/ip/address/add', `=address=${ipAddress}`, `=interface=${vlanName}`]);
      } catch (err) {
        // Roll back the just-created VLAN interface rather than leaving a
        // half-configured VLAN (interface exists, no address) behind -
        // same "don't leave a dangling half-applied change" principle the
        // Standalone config-safety engine follows, scaled to what a
        // single API call here actually needs.
        try {
          const created = await client.talk(['/interface/vlan/print', `?name=${vlanName}`]);
          if (created.re[0]) await client.talk(['/interface/vlan/remove', `=.id=${created.re[0]['.id']}`]);
        } catch (cleanupErr) {
          console.error('MikroTik VLAN rollback-after-address-failure also failed:', cleanupErr.message);
        }
        throw err;
      }
    }

    // Verify: re-fetch rather than trust the add call's own response, same
    // "don't assume, confirm" discipline used elsewhere in this codebase.
    const confirm = await client.talk(['/interface/vlan/print', `?name=${vlanName}`]);
    if (confirm.re.length === 0) {
      throw new Error('VLAN creation appeared to succeed but the interface is not present on re-check');
    }
    return { name: vlanName, vlan_id: vlanId, parent_interface: parentInterface, ip_address: ipAddress || null };
  });
}

async function deleteVlan(mikrotikId) {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const vlan = await client.talk(['/interface/vlan/print', `?.id=${mikrotikId}`]);
    if (vlan.re.length === 0) return { removed: false, reason: 'not_found' };
    const vlanName = vlan.re[0].name;

    const addr = await client.talk(['/ip/address/print', `?interface=${vlanName}`]);
    for (const a of addr.re) {
      await client.talk(['/ip/address/remove', `=.id=${a['.id']}`]);
    }
    await client.talk(['/interface/vlan/remove', `=.id=${mikrotikId}`]);
    return { removed: true };
  });
}

// ===== DHCP MANAGER (network power parity with Standalone mode) =====
// A VLAN created above is just an addressed interface until it can
// actually hand out addresses - this is the other half of "make a usable
// network." Creates the three linked RouterOS objects a working DHCP
// server needs: an address pool (/ip/pool), the server itself bound to an
// interface (/ip/dhcp-server), and the network definition telling clients
// their gateway/DNS (/ip/dhcp-server/network). All three are created
// together and rolled back together on partial failure, same discipline
// as createVlan() above.

class MikrotikDhcpConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'MikrotikDhcpConflictError';
  }
}

async function listDhcpServers() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const [serversRes, poolsRes, networksRes] = await Promise.all([
      client.talk(['/ip/dhcp-server/print']),
      client.talk(['/ip/pool/print']),
      client.talk(['/ip/dhcp-server/network/print']),
    ]);
    return serversRes.re.map((s) => {
      const pool = poolsRes.re.find((p) => p.name === s['address-pool']);
      const network = networksRes.re.find((n) => pool && n.address && pool.ranges && pool.ranges.startsWith(n.address.split('/')[0].split('.').slice(0, 3).join('.')));
      return {
        id: s['.id'],
        name: s.name,
        interface: s.interface,
        disabled: s.disabled === 'true',
        pool_name: s['address-pool'] || null,
        pool_ranges: pool ? pool.ranges : null,
        network: network ? network.address : null,
        gateway: network ? network.gateway : null,
        dns_servers: network ? network['dns-server'] : null,
      };
    });
  });
}

// poolRange: "192.168.13.10-192.168.13.250". network: "192.168.13.0/24".
// gateway: "192.168.13.1". dnsServers defaults to gateway if not given -
// same "sane default, overridable" pattern the rest of this app uses for
// bandwidth/QoS settings.
async function createDhcpServer({ interfaceName, poolRange, network, gateway, dnsServers, name }) {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  const serverName = name || `dhcp-${interfaceName}`;
  const poolName = `pool-${interfaceName}`;

  return withMikrotik(config, async (client) => {
    const existing = await client.talk(['/ip/dhcp-server/print', `?interface=${interfaceName}`]);
    if (existing.re.length > 0) {
      throw new MikrotikDhcpConflictError(`A DHCP server already exists on ${interfaceName}`);
    }

    await client.talk(['/ip/pool/add', `=name=${poolName}`, `=ranges=${poolRange}`]);

    try {
      await client.talk([
        '/ip/dhcp-server/add',
        `=name=${serverName}`,
        `=interface=${interfaceName}`,
        `=address-pool=${poolName}`,
        '=disabled=no',
      ]);
    } catch (err) {
      await rollbackPool(client, poolName);
      throw err;
    }

    try {
      await client.talk([
        '/ip/dhcp-server/network/add',
        `=address=${network}`,
        `=gateway=${gateway}`,
        `=dns-server=${dnsServers || gateway}`,
      ]);
    } catch (err) {
      // Roll back both the server and the pool - same "don't leave a
      // half-configured object behind" discipline as createVlan().
      await rollbackDhcpServer(client, serverName);
      await rollbackPool(client, poolName);
      throw err;
    }

    const confirm = await client.talk(['/ip/dhcp-server/print', `?name=${serverName}`]);
    if (confirm.re.length === 0) {
      throw new Error('DHCP server creation appeared to succeed but is not present on re-check');
    }
    return { name: serverName, interface: interfaceName, pool_name: poolName, network, gateway };
  });
}

async function rollbackPool(client, poolName) {
  try {
    const pool = await client.talk(['/ip/pool/print', `?name=${poolName}`]);
    if (pool.re[0]) await client.talk(['/ip/pool/remove', `=.id=${pool.re[0]['.id']}`]);
  } catch (e) {
    console.error('MikroTik DHCP pool rollback failed:', e.message);
  }
}

async function rollbackDhcpServer(client, serverName) {
  try {
    const server = await client.talk(['/ip/dhcp-server/print', `?name=${serverName}`]);
    if (server.re[0]) await client.talk(['/ip/dhcp-server/remove', `=.id=${server.re[0]['.id']}`]);
  } catch (e) {
    console.error('MikroTik DHCP server rollback failed:', e.message);
  }
}

async function deleteDhcpServer(mikrotikId) {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const server = await client.talk(['/ip/dhcp-server/print', `?.id=${mikrotikId}`]);
    if (server.re.length === 0) return { removed: false, reason: 'not_found' };
    const { name: serverName, 'address-pool': poolName } = server.re[0];

    const networks = await client.talk(['/ip/dhcp-server/network/print']);
    // Network entries aren't linked to a server by id in RouterOS - they're
    // matched by address range against the pool's own range, same join
    // listDhcpServers() above does for display. Best-effort cleanup: only
    // remove a network entry if it's unambiguously this pool's own.
    const pool = poolName ? (await client.talk(['/ip/pool/print', `?name=${poolName}`])).re[0] : null;
    if (pool && pool.ranges) {
      const poolSubnet = pool.ranges.split('.').slice(0, 3).join('.');
      for (const n of networks.re) {
        if (n.address && n.address.split('.').slice(0, 3).join('.') === poolSubnet) {
          await client.talk(['/ip/dhcp-server/network/remove', `=.id=${n['.id']}`]);
        }
      }
    }

    await client.talk(['/ip/dhcp-server/remove', `=.id=${mikrotikId}`]);
    if (poolName) await rollbackPool(client, poolName);

    return { removed: true };
  });
}

// ===== PORT/INTERFACE ROLE ASSIGNMENT (network power parity) =====
// Uses RouterOS interface-lists (/interface/list + /interface/list/member)
// - the standard, idiomatic RouterOS mechanism for grouping interfaces
// into roles, and the same building block the firewall zone builder and
// NAT manager below reference (in-interface-list=/out-interface-list=).
// Mirrors Standalone mode's router_ports.role concept (wan/gated/open/
// unused) with role names adjusted to match how they're actually used in
// RouterOS firewall rules: wan/lan/guest/unused.

const MIKROTIK_ROLE_LISTS = { wan: 'WAN', lan: 'LAN', guest: 'GUEST' };

async function ensureInterfaceList(client, listName) {
  const existing = await client.talk(['/interface/list/print', `?name=${listName}`]);
  if (existing.re.length === 0) {
    await client.talk(['/interface/list/add', `=name=${listName}`]);
  }
}

// Lists every physical ethernet interface with its current role, derived
// from which (if any) of the three managed lists it's a member of. An
// interface in none of them is 'unused'.
async function listInterfaceRoles() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const [ifaces, members] = await Promise.all([
      client.talk(['/interface/ethernet/print']),
      client.talk(['/interface/list/member/print']),
    ]);
    return ifaces.re.map((iface) => {
      const membership = members.re.find((m) =>
        m.interface === iface.name && Object.values(MIKROTIK_ROLE_LISTS).includes(m.list)
      );
      const role = membership
        ? Object.keys(MIKROTIK_ROLE_LISTS).find((r) => MIKROTIK_ROLE_LISTS[r] === membership.list)
        : 'unused';
      return {
        name: iface.name,
        mac: iface['mac-address'] || '',
        running: iface.running === 'true',
        role,
      };
    });
  });
}

// Sets interfaceName's role - removes it from any OTHER managed role-list
// membership first (an interface should only ever be in one role at a
// time), then adds it to the requested one. role='unused' just removes
// membership from all three, no list added.
async function setInterfaceRole(interfaceName, role) {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  if (role !== 'unused' && !MIKROTIK_ROLE_LISTS[role]) {
    throw new Error(`Invalid role: ${role}`);
  }

  return withMikrotik(config, async (client) => {
    // Remove any existing membership in one of our managed lists first.
    const members = await client.talk(['/interface/list/member/print', `?interface=${interfaceName}`]);
    for (const m of members.re) {
      if (Object.values(MIKROTIK_ROLE_LISTS).includes(m.list)) {
        await client.talk(['/interface/list/member/remove', `=.id=${m['.id']}`]);
      }
    }

    if (role === 'unused') {
      return { interface: interfaceName, role: 'unused' };
    }

    const listName = MIKROTIK_ROLE_LISTS[role];
    await ensureInterfaceList(client, listName);
    await client.talk(['/interface/list/member/add', `=list=${listName}`, `=interface=${interfaceName}`]);

    // Verify - re-fetch rather than trust the add call, same discipline
    // as the VLAN/DHCP managers above.
    const confirm = await client.talk(['/interface/list/member/print', `?interface=${interfaceName}`, `?list=${listName}`]);
    if (confirm.re.length === 0) {
      throw new Error('Role assignment appeared to succeed but membership is not present on re-check');
    }
    return { interface: interfaceName, role };
  });
}

// ===== FIREWALL ZONE BUILDER (network power parity - the MikroTik half
// of the gap found while building Standalone's lane-isolation fix) =====
// Zone-to-zone policy ("Guest -> LAN: DENY") using the interface-lists
// from the role manager above, same shape the dev-handoff specs describe
// (a simple ALLOW/DENY builder, not raw RouterOS rule syntax). Every rule
// this creates is tagged with a distinct comment prefix so it's always
// identifiable as StarkFi-managed and never confused with (or silently
// overwritten alongside) rules an operator configured by hand in WinBox.

class MikrotikZonePolicyConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'MikrotikZonePolicyConflictError';
  }
}

const ZONE_POLICY_COMMENT_PREFIX = 'starkfi-zone-policy:';

function zonePolicyComment(fromZone, toZone) {
  return `${ZONE_POLICY_COMMENT_PREFIX}${fromZone}->${toZone}`;
}

async function listFirewallZonePolicies() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const res = await client.talk(['/ip/firewall/filter/print']);
    return res.re
      .filter((r) => (r.comment || '').startsWith(ZONE_POLICY_COMMENT_PREFIX))
      .map((r) => {
        const [fromZone, toZone] = (r.comment || '').slice(ZONE_POLICY_COMMENT_PREFIX.length).split('->');
        return { id: r['.id'], from_zone: fromZone, to_zone: toZone, action: r.action, disabled: r.disabled === 'true' };
      });
  });
}

// Inserted at the TOP of the forward chain (place=0 - RouterOS evaluates
// filter rules top to bottom, first match wins) so a zone policy actually
// takes precedence over any general accept rule already there, the same
// "isolation must actually take effect, not just exist" concern the
// Standalone nftables fix addressed.
async function createFirewallZonePolicy({ fromZone, toZone, action }) {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  const fromList = MIKROTIK_ROLE_LISTS[fromZone];
  const toList = MIKROTIK_ROLE_LISTS[toZone];
  if (!fromList || !toList) throw new Error(`Unknown zone: ${fromZone} or ${toZone}`);

  return withMikrotik(config, async (client) => {
    const comment = zonePolicyComment(fromZone, toZone);
    const existing = await client.talk(['/ip/firewall/filter/print', `?comment=${comment}`]);
    if (existing.re.length > 0) {
      throw new MikrotikZonePolicyConflictError(`A policy for ${fromZone} -> ${toZone} already exists`);
    }

    await client.talk([
      '/ip/firewall/filter/add',
      '=chain=forward',
      `=in-interface-list=${fromList}`,
      `=out-interface-list=${toList}`,
      `=action=${action}`,
      `=comment=${comment}`,
      '=place-before=0',
    ]);

    const confirm = await client.talk(['/ip/firewall/filter/print', `?comment=${comment}`]);
    if (confirm.re.length === 0) {
      throw new Error('Zone policy creation appeared to succeed but is not present on re-check');
    }
    return { from_zone: fromZone, to_zone: toZone, action };
  });
}

async function deleteFirewallZonePolicy(mikrotikId) {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const rule = await client.talk(['/ip/firewall/filter/print', `?.id=${mikrotikId}`]);
    if (rule.re.length === 0) return { removed: false, reason: 'not_found' };
    // Safety: only ever remove a rule this feature itself created (the
    // comment prefix check), never an arbitrary firewall rule an operator
    // might pass an id for - this endpoint must not become a generic
    // "delete any firewall rule" primitive.
    if (!(rule.re[0].comment || '').startsWith(ZONE_POLICY_COMMENT_PREFIX)) {
      return { removed: false, reason: 'not_a_zone_policy' };
    }
    await client.talk(['/ip/firewall/filter/remove', `=.id=${mikrotikId}`]);
    return { removed: true };
  });
}

// ===== NAT/PORT-FORWARD MANAGER (network power parity) =====
// Mirrors Standalone mode's port_forwards table/UI. RouterOS dst-nat
// rules in the /ip/firewall/nat dstnat chain, scoped to the WAN interface
// list so a forward never accidentally matches traffic arriving from the
// LAN/GUEST side (same "never on the wrong side" principle Standalone's
// existing port-forward rules already follow, scoped to WAN_VIF there).
// Same tag-and-only-delete-your-own-rules discipline as the firewall
// zone manager above.

class MikrotikPortForwardConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'MikrotikPortForwardConflictError';
  }
}

const PORT_FORWARD_COMMENT_PREFIX = 'starkfi-port-forward:';

async function listPortForwards() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const res = await client.talk(['/ip/firewall/nat/print']);
    return res.re
      .filter((r) => (r.comment || '').startsWith(PORT_FORWARD_COMMENT_PREFIX))
      .map((r) => ({
        id: r['.id'],
        protocol: r.protocol,
        external_port: parseInt(r['dst-port'], 10),
        internal_ip: r['to-addresses'],
        internal_port: parseInt(r['to-ports'], 10),
        disabled: r.disabled === 'true',
      }));
  });
}

async function createPortForward({ protocol, externalPort, internalIp, internalPort }) {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  const comment = `${PORT_FORWARD_COMMENT_PREFIX}${protocol}:${externalPort}`;

  return withMikrotik(config, async (client) => {
    const existing = await client.talk(['/ip/firewall/nat/print', `?comment=${comment}`]);
    if (existing.re.length > 0) {
      throw new MikrotikPortForwardConflictError(`A forward for ${protocol}/${externalPort} already exists`);
    }

    await client.talk([
      '/ip/firewall/nat/add',
      '=chain=dstnat',
      `=in-interface-list=${MIKROTIK_ROLE_LISTS.wan}`,
      `=protocol=${protocol}`,
      `=dst-port=${externalPort}`,
      '=action=dst-nat',
      `=to-addresses=${internalIp}`,
      `=to-ports=${internalPort}`,
      `=comment=${comment}`,
    ]);

    const confirm = await client.talk(['/ip/firewall/nat/print', `?comment=${comment}`]);
    if (confirm.re.length === 0) {
      throw new Error('Port forward creation appeared to succeed but is not present on re-check');
    }
    return { protocol, external_port: externalPort, internal_ip: internalIp, internal_port: internalPort };
  });
}

async function deletePortForward(mikrotikId) {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const rule = await client.talk(['/ip/firewall/nat/print', `?.id=${mikrotikId}`]);
    if (rule.re.length === 0) return { removed: false, reason: 'not_found' };
    if (!(rule.re[0].comment || '').startsWith(PORT_FORWARD_COMMENT_PREFIX)) {
      return { removed: false, reason: 'not_a_port_forward' };
    }
    await client.talk(['/ip/firewall/nat/remove', `=.id=${mikrotikId}`]);
    return { removed: true };
  });
}

// ===== DNS MANAGER (network power parity) - MikroTik side. RouterOS DNS
// is a single global setting (/ip/dns set), simpler than Standalone's
// per-lane dnsmasq config - one function each way rather than a whole
// CRUD surface. =====

async function getDnsServers() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    const res = await client.talk(['/ip/dns/print']);
    const servers = (res.re[0] && res.re[0].servers) || '';
    return { servers: servers.split(',').filter(Boolean) };
  });
}

async function setDnsServers(servers) {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');
  return withMikrotik(config, async (client) => {
    await client.talk(['/ip/dns/set', `=servers=${servers.join(',')}`]);
    const confirm = await client.talk(['/ip/dns/print']);
    const actual = (confirm.re[0] && confirm.re[0].servers) || '';
    if (actual.split(',').filter(Boolean).join(',') !== servers.join(',')) {
      throw new Error('DNS servers appeared to be set but do not match on re-check');
    }
    return { servers };
  });
}

// Real cross-VLAN device discovery for Access Points, used when
// network_mode = 'mikrotik' (Controller Mode). This box's own local ARP
// table (networkDiscoveryService.js) only sees devices on whatever single
// VLAN its management connection happens to sit on - it has no interface
// presence on the other VLANs the MikroTik owns. The router itself,
// however, already knows every device on every VLAN it routes, so this
// asks it directly via /ip/arp/print (live L2 table) and
// /ip/dhcp-server/lease/print (hostnames), same read-only "ask the
// device that actually knows" approach getMacFromIp already uses. VLAN
// evidence comes from matching the ARP entry's interface name against
// listVlans() (real RouterOS interface -> vlan_id mapping, not a guess).
// Real per-client traffic for the Network Devices page - reads this
// client's own simple queue (the same rj-<mac> parent queue
// setClientBandwidth() already creates for shaping), rather than inventing
// a number. RouterOS reports "bytes" as "upload/download" on the parent
// queue. Returns null (not zero) for a client with no active queue - e.g.
// no session right now - so the UI can honestly show "not available"
// instead of a fake 0.
async function getClientTraffic(mac) {
  const config = getMikrotikConfig();
  if (!config.ip) return null;
  try {
    return await withMikrotik(config, async (client) => {
      const res = await client.talk(['/queue/simple/print', `?name=${queueNameFor(mac)}`]);
      const q = res.re[0];
      if (!q || !q.bytes) return null;
      const [up, down] = String(q.bytes).split('/').map((n) => parseInt(n, 10) || 0);
      return { uploadBytes: up, downloadBytes: down, totalBytes: up + down };
    });
  } catch (err) {
    return null;
  }
}

async function scanForDevices() {
  const config = getMikrotikConfig();
  if (!config.ip) return [];
  return withMikrotik(config, async (client) => {
    const [arpRes, leaseRes, vlanRes] = await Promise.all([
      client.talk(['/ip/arp/print']),
      client.talk(['/ip/dhcp-server/lease/print']),
      client.talk(['/interface/vlan/print']),
    ]);

    const vlanByInterface = new Map(vlanRes.re.map((v) => [v.name, parseInt(v['vlan-id'], 10)]));
    const leaseByMac = new Map();
    for (const lease of leaseRes.re) {
      const mac = (lease['mac-address'] || '').toLowerCase();
      if (!mac) continue;
      // RouterOS's WebFig "Active Host Name" column comes from
      // active-host-name, not host-name (host-name is the static field,
      // which stays blank on ordinary dynamic leases) - checking both
      // covers static-bound leases too.
      // A MAC can have more than one lease record (e.g. a static binding
      // alongside a dynamic one) - merge rather than overwrite, so a
      // blank field on whichever record RouterOS returns second doesn't
      // wipe out a hostname/class-id a different record already had.
      const existing = leaseByMac.get(mac) || {};
      leaseByMac.set(mac, {
        hostname: existing.hostname || lease['active-host-name'] || lease['host-name'] || null,
        // DHCP vendor class (option 60) - RouterOS's "Active Class ID"
        // column. Often more identifying than hostname for spotting an AP
        // specifically, e.g. "Omada Wireless EAP225-Outdoor" versus a
        // generic phone hostname.
        vendor_class: existing.vendor_class || lease['active-class-id'] || lease['class-id'] || null,
      });
    }

    const byMac = new Map();
    for (const entry of arpRes.re) {
      const mac = (entry['mac-address'] || '').toLowerCase();
      const ip = entry.address;
      if (!mac || !ip || entry.invalid === 'true') continue;
      const vlanId = vlanByInterface.get(entry.interface) || null;
      byMac.set(mac, {
        ip,
        mac,
        hostname: leaseByMac.get(mac)?.hostname || null,
        vendor_class: leaseByMac.get(mac)?.vendor_class || null,
        vlan_id: vlanId,
        vlan_evidence: vlanId ? `Reported by MikroTik as connected via VLAN ${vlanId} interface (${entry.interface})` : null,
        discovered_via: leaseByMac.has(mac) ? 'mikrotik_arp+dhcp' : 'mikrotik_arp',
      });
    }
    return Array.from(byMac.values());
  });
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
  getInterfaceTraffic,
  pruneOrphanedQueues,
  setPortalDnsName,
  testConnection,
  getMacFromIp,
  getIpFromMac,
  listVlans,
  createVlan,
  deleteVlan,
  MikrotikVlanConflictError,
  listDhcpServers,
  createDhcpServer,
  deleteDhcpServer,
  MikrotikDhcpConflictError,
  listInterfaceRoles,
  setInterfaceRole,
  listFirewallZonePolicies,
  createFirewallZonePolicy,
  deleteFirewallZonePolicy,
  MikrotikZonePolicyConflictError,
  listPortForwards,
  createPortForward,
  deletePortForward,
  MikrotikPortForwardConflictError,
  getDnsServers,
  setDnsServers,
  scanForDevices,
  getClientTraffic,
};
