const { exec } = require('child_process');

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
function getLanInterface() {
  try {
    const db = require('../config/database');
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
function setClientBandwidth(mac, downloadMbps, uploadMbps = downloadMbps) {
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
    return require('./mikrotikService').setClientBandwidth(normalizedMac, download, upload);
  }

  return new Promise((resolve) => {
    const classId = macToClassId(normalizedMac);
    const lanIf = getLanInterface();
    const cmds = [
      `sudo tc class replace dev ${lanIf} parent 1: classid 1:${classId} htb rate ${download}mbit ceil ${download}mbit burst 32k cburst 32k quantum 15000`,
      `sudo tc filter replace dev ${lanIf} protocol ip parent 1:0 prio 1 flower dst_mac ${normalizedMac} classid 1:${classId}`,
      `sudo tc filter replace dev ${lanIf} parent ffff: protocol ip prio 1 flower src_mac ${normalizedMac} action police rate ${upload}mbit burst 32k drop`
    ];

    exec(cmds.join(' && '), (error) => {
      if (error) console.error(`[TC] Failed to shape ${normalizedMac}:`, error.message);
      else console.log(`[TC] Shaped ${normalizedMac} to ${download}mbit down / ${upload}mbit up (class 1:${classId})`);
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

  return new Promise((resolve) => {
    const classId = macToClassId(normalizedMac);
    const lanIf = getLanInterface();
    exec(
      `sudo tc filter del dev ${lanIf} protocol ip parent 1:0 prio 1 flower dst_mac ${normalizedMac} classid 1:${classId}; ` +
      `sudo tc class del dev ${lanIf} classid 1:${classId}; ` +
      `sudo tc filter del dev ${lanIf} parent ffff: protocol ip prio 1 flower src_mac ${normalizedMac}`,
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