const { exec } = require('child_process');
const fs = require('fs');

// Bug found via a comparable project's own production stabilization notes
// (not yet hit here, fixed proactively): tc flower's MAC-based matching
// (dst_mac/src_mac) has been observed to be inconsistently supported
// across different tc/kernel builds, while IP-based matching (dst_ip/
// src_ip) is natively supported and reliable everywhere. Standalone mode's
// own DHCP server (dnsmasq) already writes exactly this MAC-to-IP mapping
// to leases file for every connected client - same source app.js/
// portal.js already read for the reverse (IP-to-MAC) direction.
function getIpFromMac(mac) {
  try {
    const leases = fs.readFileSync('/var/lib/misc/dnsmasq.leases', 'utf8');
    // Format: timestamp MAC IP hostname client-id
    for (const line of leases.trim().split('\n')) {
      const parts = line.split(' ');
      if (parts[1] && parts[1].toLowerCase() === mac) return parts[2] || null;
    }
  } catch (e) {}
  return null;
}

// Remembers which IP a client's tc filters were actually created against,
// so removeClientBandwidth() can target that exact IP even if the DHCP
// lease has since renewed to something else - a fresh getIpFromMac() at
// removal time could otherwise miss the original filter (or worse, later
// match some other device that inherits the now-recycled old IP).
const lastShapedIp = new Map();

// Network backend is selectable per-deployment (Settings > Network Mode).
// Default ('nodogsplash') drives nftables/tc directly on this box, below.
// 'mikrotik' delegates every call to mikrotikService, which drives an
// external router over its REST API instead. sessionService/timerService
// only ever import from this module, so they stay backend-agnostic.
function isMikrotikMode() {
  return require('./mikrotikService').isMikrotikModeEnabled();
}

function normalizeMac(mac) {
  const normalizedMac = String(mac || '').trim().toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalizedMac)) {
    throw new Error(`Invalid MAC address: ${mac}`);
  }
  return normalizedMac;
}

function allowClient(mac) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    return Promise.reject(error);
  }

  if (isMikrotikMode()) {
    return require('./mikrotikService').allowClient(normalizedMac);
  }

  return new Promise((resolve, reject) => {
    exec(`sudo nft add element ip rj_piso allowed_macs { ${normalizedMac} }`,
      (error, stdout, stderr) => {
        if (error) {
          if (stderr && stderr.includes('already exists')) {
            console.log(`[Network] Already allowed: ${normalizedMac}`);
            resolve();
          } else if (stderr && stderr.includes('Error')) {
            console.error(`[Network] ❌ Failed to allow ${normalizedMac}. Error: ${stderr.trim()}`);
            console.error(`[Network] ❌ This usually means: nftables set 'allowed_macs' doesn't exist. Run setup-network.sh`);
            reject(error);
          } else {
            console.error(`[Network] Failed to allow ${normalizedMac}:`, error.message);
            console.error(`[Network] stderr:`, stderr);
            reject(error);
          }
        } else {
          console.log(`[Network] ✅ Allowed: ${normalizedMac}`);
          resolve();
        }
      }
    );
  });
}

function blockClient(mac) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    console.error('[Network] Invalid MAC during block:', error.message);
    return Promise.resolve();
  }

  if (isMikrotikMode()) {
    return require('./mikrotikService').blockClient(normalizedMac);
  }

  return new Promise((resolve) => {
    exec(`sudo nft delete element ip rj_piso allowed_macs { ${normalizedMac} }`,
      (error, stdout, stderr) => {
        if (error) {
          console.log(`[Network] Already blocked or not found: ${normalizedMac}`);
        } else {
          console.log(`[Network] Blocked: ${normalizedMac}`);
        }
        resolve();
      }
    );
  });
}

function isClientAllowed(mac) {
  return new Promise((resolve) => {
    let normalizedMac;
    try {
      normalizedMac = normalizeMac(mac);
    } catch (error) {
      resolve(false);
      return;
    }

    exec(`sudo nft list set ip rj_piso allowed_macs`,
      (error, stdout) => {
        if (error) resolve(false);
        else resolve(stdout.toLowerCase().includes(normalizedMac));
      }
    );
  });
}

function macToClassId(mac) {
  let hash = 0;
  for (const c of mac) hash = (hash * 31 + c.charCodeAt(0)) % 900;
  return 100 + hash;
}

// Bug: setup-network.sh binds the tc root qdisc (and everything else) to a
// VLAN sub-interface like "enp0s8.13" when a LAN-mode VLAN is configured
// (Network > VLAN Management - some setups share one switch between the
// ISP modem and the AP, tagging customer traffic with a VLAN ID to
// separate it) - per-client tc commands issued from here must target that
// same sub-interface, not the raw physical one, or they'd fail since the
// qdisc they're attaching to doesn't exist on the physical interface at all.
// clientIp lets this resolve the RIGHT lane when the multi-lane Standalone
// engine is active (STANDALONE_ARCHITECTURE_PLAN.md) - setup-network.sh is
// the only place that actually computes VLAN/bridge interface names and
// subnet assignments, so it writes that mapping to the 'standalone_lane_map'
// setting as JSON and this just reads it back, rather than re-deriving the
// same logic a second time here and risking the two falling out of sync.
// Falls back to the single legacy interface whenever multi-lane mode isn't
// active, or the client's IP doesn't match any known lane (e.g. still on
// the legacy 10.0.0.0/24 range) - existing single-lane installs are
// unaffected either way.
function getLanInterface(clientIp) {
  try {
    const db = require('../config/database');
    if (clientIp) {
      const mapSetting = db.prepare("SELECT value FROM settings WHERE key = 'standalone_lane_map'").get();
      if (mapSetting) {
        try {
          const lanes = JSON.parse(mapSetting.value);
          const octet = clientIp.split('.')[1];
          const match = lanes.find((l) => l.subnet === `10.${octet}.0.0`);
          if (match) return match.interface;
        } catch (e) {}
      }
    }

    const base = db.prepare("SELECT value FROM settings WHERE key = 'lan_interface'").get()?.value ||
      process.env.LAN_IF ||
      'enp0s8';
    const lanVlan = db.prepare("SELECT base_interface, vlan_id FROM vlans WHERE mode = 'lan' ORDER BY id DESC LIMIT 1").get();
    if (lanVlan && lanVlan.base_interface === base) {
      return `${base}.${lanVlan.vlan_id}`;
    }
    return base;
  } catch (e) {
    return process.env.LAN_IF || 'enp0s8';
  }
}

// Bug (ROUTER_MODE_PLAN.md §12): this only ever shaped one direction -
// the root htb qdisc + dst_mac filter below caps traffic going TO the
// client (download), but nothing capped traffic FROM the client (upload).
// bandwidth_cap_upload_mbps existed as a setting with its own admin UI
// field, but nothing ever read it or enforced it - a customer's real
// upload speed was silently whatever the download cap said.
//
// Fix: upload is capped separately via an ingress qdisc + police filter on
// the same LAN interface (setup-network.sh creates the ingress qdisc once;
// per-client, this file adds/replaces a police filter matched by src_mac -
// preserved because this is still the LAN segment, before any routing
// rewrites it). "police... drop" simply drops packets over the rate rather
// than queueing them (ingress traffic can't be queued the way htb queues
// egress), which is the standard way to rate-limit inbound traffic with tc.
// burst is optional: { mbps, seconds }. Correction: this used to be treated
// as router-mode-only, on the assumption HTB had no equivalent to RouterOS's
// burst-limit/burst-threshold/burst-time - wrong. HTB's own rate/ceil/burst
// parameters do exactly this natively: ceil is the allowed peak (burst)
// rate, and burst/cburst is a token-bucket sized in bytes so the class can
// actually sustain ceil for burst.seconds before falling back to the
// steady-state rate. sizeOfBurstBucket() below computes that byte size from
// the admin's configured mbps/seconds instead of the previous fixed 32k
// smoothing bucket (which was never meant to represent a real burst window).
function burstBucketBytes(burst, fallbackMbps) {
  if (!burst || !burst.mbps || !burst.seconds) return { ceilMbps: fallbackMbps, bytes: 32 * 1024 };
  const bytes = Math.round((burst.mbps * 1000000 / 8) * burst.seconds);
  return { ceilMbps: burst.mbps, bytes };
}

function setClientBandwidth(mac, downloadMbps, uploadMbps = downloadMbps, burst = null) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    console.error('[TC] Invalid MAC during shaping:', error.message);
    return Promise.resolve();
  }

  const download = parseInt(downloadMbps, 10);
  const upload = parseInt(uploadMbps, 10);
  if (!Number.isFinite(download) || download <= 0 || !Number.isFinite(upload) || upload <= 0) {
    console.error(`[TC] Invalid bandwidth for ${normalizedMac}: down=${downloadMbps} up=${uploadMbps}`);
    return Promise.resolve();
  }

  if (isMikrotikMode()) {
    return require('./mikrotikService').setClientBandwidth(normalizedMac, download, upload, burst);
  }

  const clientIp = getIpFromMac(normalizedMac);
  if (!clientIp) {
    console.log(`[TC] No DHCP lease found yet for ${normalizedMac}, skipping bandwidth`);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const classId = macToClassId(normalizedMac);
    const lanIf = getLanInterface(clientIp);
    const { ceilMbps, bytes } = burstBucketBytes(burst, download);
    // CAKE runs as a leaf qdisc under this client's own HTB class (not on
    // the interface root) so each customer gets its own flow-fairness/AQM
    // scoped to their own rate cap, instead of one shared queue where a
    // heavy downloader could still starve other customers' flows. Handle
    // reuses classId (100-999) so it's already guaranteed unique per client
    // and matches across shape/cleanup calls.
    const cmds = [
      `sudo tc class replace dev ${lanIf} parent 1: classid 1:${classId} htb rate ${download}mbit ceil ${ceilMbps}mbit burst ${bytes} cburst ${bytes} quantum 15000`,
      `sudo tc qdisc replace dev ${lanIf} parent 1:${classId} handle ${classId}: cake bandwidth ${ceilMbps}mbit`,
      `sudo tc filter replace dev ${lanIf} protocol ip parent 1:0 prio 1 flower dst_ip ${clientIp} classid 1:${classId}`,
      `sudo tc filter replace dev ${lanIf} parent ffff: protocol ip prio 1 flower src_ip ${clientIp} action police rate ${upload}mbit burst 32k drop`
    ];

    exec(cmds.join(' && '), (error) => {
      if (error) {
        console.error(`[TC] Failed to shape ${normalizedMac} (${clientIp}):`, error.message);
      } else {
        console.log(`[TC] Shaped ${normalizedMac} (${clientIp}) to ${download}mbit down (burst ${ceilMbps}mbit) / ${upload}mbit up, CAKE enabled (class 1:${classId})`);
        lastShapedIp.set(normalizedMac, clientIp);
      }
      resolve();
    });
  });
}

function removeClientBandwidth(mac) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    console.error('[TC] Invalid MAC during cleanup:', error.message);
    return Promise.resolve();
  }

  if (isMikrotikMode()) {
    return require('./mikrotikService').removeClientBandwidth(normalizedMac);
  }

  // Prefer the exact IP the filters were created against - the DHCP lease
  // may have since renewed to something else, and a fresh lookup at
  // removal time could miss the original filter entirely (or worse, later
  // match a different device that inherits the now-recycled old IP).
  const clientIp = lastShapedIp.get(normalizedMac) || getIpFromMac(normalizedMac);
  lastShapedIp.delete(normalizedMac);
  if (!clientIp) {
    console.log(`[TC] No known IP for ${normalizedMac}, nothing to clean up`);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const classId = macToClassId(normalizedMac);
    const lanIf = getLanInterface(clientIp);
    exec(
      `sudo tc filter del dev ${lanIf} protocol ip parent 1:0 prio 1 flower dst_ip ${clientIp} classid 1:${classId}; ` +
      `sudo tc qdisc del dev ${lanIf} parent 1:${classId} handle ${classId}:; ` +
      `sudo tc class del dev ${lanIf} classid 1:${classId}; ` +
      `sudo tc filter del dev ${lanIf} parent ffff: protocol ip prio 1 flower src_ip ${clientIp}`,
      (error, stdout, stderr) => {
        // Log errors instead of suppressing (Bug #38)
        if (error) {
          console.warn(`[TC] Warning during cleanup for ${normalizedMac}: ${error.message}`);
          if (stderr && !stderr.includes('No such file')) {
            console.warn(`[TC] stderr: ${stderr.trim()}`);
          }
        } else {
          console.log(`[TC] Cleaned up bandwidth shaping for ${normalizedMac}`);
        }
        resolve();
      }
    );
  });
}

module.exports = {
  allowClient,
  blockClient,
  isClientAllowed,
  setClientBandwidth,
  removeClientBandwidth
};