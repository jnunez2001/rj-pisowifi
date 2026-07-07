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

function getLanInterface() {
  try {
    const db = require('../config/database');
    return db.prepare("SELECT value FROM settings WHERE key = 'lan_interface'").get()?.value ||
      process.env.LAN_IF ||
      'enp0s8';
  } catch (e) {
    return process.env.LAN_IF || 'enp0s8';
  }
}

function setClientBandwidth(mac, mbps) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    console.error('[TC] Invalid MAC during shaping:', error.message);
    return Promise.resolve();
  }

  const speed = parseInt(mbps, 10);
  if (!Number.isFinite(speed) || speed <= 0) {
    console.error(`[TC] Invalid bandwidth for ${normalizedMac}: ${mbps}`);
    return Promise.resolve();
  }

  if (isMikrotikMode()) {
    return require('./mikrotikService').setClientBandwidth(normalizedMac, speed);
  }

  return new Promise((resolve) => {
    const classId = macToClassId(normalizedMac);
    const lanIf = getLanInterface();
    const cmds = [
      `sudo tc class replace dev ${lanIf} parent 1: classid 1:${classId} htb rate ${speed}mbit ceil ${speed}mbit burst 32k cburst 32k quantum 15000`,
      `sudo tc filter replace dev ${lanIf} protocol ip parent 1:0 prio 1 flower dst_mac ${normalizedMac} classid 1:${classId}`
    ];

    exec(cmds.join(' && '), (error) => {
      if (error) console.error(`[TC] Failed to shape ${normalizedMac}:`, error.message);
      else console.log(`[TC] Shaped ${normalizedMac} to ${speed}mbit (class 1:${classId})`);
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
      `sudo tc class del dev ${lanIf} classid 1:${classId}`,
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