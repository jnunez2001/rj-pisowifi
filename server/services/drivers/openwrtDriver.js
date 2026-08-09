// ===== OPENWRT DRIVER (SSH + nftables/tc) =====
// Literal port of the APPROACH in Tarakifi's drivers/openwrt.py — SSH to
// the router, drive an nftables set for allow/block and HTB+ifb qdiscs for
// bidirectional shaping — reimplemented in JS since Tarakifi's version uses
// Python's asyncssh. rj-pisowifi had no OpenWRT-as-external-router option
// before this; the standalone driver's own nft/tc command shapes (same
// commands, same CAKE-under-HTB structure) are reused here almost verbatim,
// just executed over SSH instead of local exec, and against an ifb device
// for ingress shaping the way genuine OpenWRT tc setups require (OpenWRT's
// own tc doesn't support the "police...drop" ingress trick the standalone
// driver uses locally in the same clean way, since we don't control kernel
// module loading remotely the same way setup-network.sh does locally).
//
// Connection credentials come from settings (host/user + password OR key),
// same shape as Tarakifi's RouterCredentials dataclass and this app's own
// mikrotikConfigHelper.js pattern.

const { NodeSSH } = require('node-ssh');
const { defineDriver } = require('./driverInterface');
const { getClassId, peekClassId, releaseClassId } = require('./classIdAllocator');

function getOpenwrtConfig() {
  const db = require('../../config/database');
  const { decryptSecret } = require('../../utils/secretCrypto');
  const get = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
  const encryptedPass = get('openwrt_pass');
  return {
    host: get('openwrt_host'),
    port: parseInt(get('openwrt_port') || '22', 10),
    username: get('openwrt_user') || 'root',
    password: encryptedPass ? decryptSecret(encryptedPass) : undefined,
    privateKeyPath: get('openwrt_key_path') || undefined,
    lanInterface: get('openwrt_lan_interface') || 'br-lan',
  };
}

function normalizeMac(mac) {
  const normalizedMac = String(mac || '').trim().toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalizedMac)) {
    throw new Error(`Invalid MAC address: ${mac}`);
  }
  return normalizedMac;
}

async function withSsh(config, fn) {
  if (!config.host) throw new Error('OpenWRT host not configured');
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      privateKeyPath: config.privateKeyPath,
      readyTimeout: 8000,
    });
    return await fn(ssh);
  } finally {
    ssh.dispose();
  }
}

async function exec(ssh, cmd) {
  const result = await ssh.execCommand(cmd);
  if (result.code !== 0 && result.stderr) {
    console.warn(`[OpenWRT] "${cmd}" exited ${result.code}: ${result.stderr.trim()}`);
  }
  return result;
}

async function ping() {
  const config = getOpenwrtConfig();
  try {
    return await withSsh(config, async (ssh) => {
      const r = await exec(ssh, 'echo ok');
      return r.stdout.trim() === 'ok';
    });
  } catch (err) {
    console.error('[OpenWRT] ping error:', err.message);
    return false;
  }
}

// Uses one nftables set (rj_piso_allowed) on the router, same shape as the
// standalone driver's own allowed_macs set — operator must create the base
// table/set/chain once via router-setup.md-style one-time config (mirrors
// the prerequisite Tarakifi documents for OpenWRT in its own router-setup
// doc), same pattern MikroTik's setup wizard automates for RouterOS.
async function allowClient(mac) {
  const normalizedMac = normalizeMac(mac);
  const config = getOpenwrtConfig();
  await withSsh(config, async (ssh) => {
    await exec(ssh, `nft add element inet rj_piso rj_piso_allowed { ${normalizedMac} }`);
  });
  console.log(`[OpenWRT] Allowed: ${normalizedMac}`);
}

async function blockClient(mac) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    console.error('[OpenWRT] Invalid MAC during block:', error.message);
    return;
  }
  const config = getOpenwrtConfig();
  // Bug: this let an SSH connection failure (host unreachable, auth
  // failure) reject the promise - every other driver's blockClient (and
  // this file's own removeClientBandwidth/setClientBandwidth) treats a
  // failure as "log it and move on", per networkService.js's own
  // documented contract ("blockClient/setClientBandwidth/
  // removeClientBandwidth just log and resolve"). A caller that assumes
  // that contract (most call sites do wrap in try/catch defensively, but
  // shouldn't have to) would otherwise see an inconsistent failure mode
  // only on this one driver.
  try {
    await withSsh(config, async (ssh) => {
      await exec(ssh, `nft delete element inet rj_piso rj_piso_allowed { ${normalizedMac} }`);
      // Also flush the per-client HTB class/ifb filters so a blocked client
      // doesn't keep an inherited bandwidth cap if later re-added with a
      // different rate.
      await exec(ssh, `tc filter del dev ${config.lanInterface} parent 1:0 protocol ip prio 1 flower dst_mac ${normalizedMac} 2>/dev/null; true`);
    });
  } catch (error) {
    console.error(`[OpenWRT] blockClient error for ${normalizedMac}:`, error.message);
    return;
  }
  console.log(`[OpenWRT] Blocked: ${normalizedMac}`);
}

async function isClientAllowed(mac) {
  const normalizedMac = normalizeMac(mac);
  const config = getOpenwrtConfig();
  try {
    return await withSsh(config, async (ssh) => {
      const r = await exec(ssh, 'nft list set inet rj_piso rj_piso_allowed');
      return r.stdout.toLowerCase().includes(normalizedMac);
    });
  } catch (err) {
    console.error('[OpenWRT] isClientAllowed error:', err.message);
    return false;
  }
}

// OpenWRT tc matches by dst_mac/src_mac directly (no DHCP-lease-to-IP
// lookup needed like the standalone driver requires) — flower's MAC
// matching is what the standalone driver's own comment warns is
// inconsistently supported across kernel builds, but OpenWRT's own tc
// build is known-consistent for this since it's the platform's default
// shaping mechanism (luci-app-sqm builds on exactly this).
async function setClientBandwidth(mac, downloadMbps, uploadMbps = downloadMbps, burst = null) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    console.error('[OpenWRT] Invalid MAC during shaping:', error.message);
    return;
  }
  const download = parseInt(downloadMbps, 10);
  const upload = parseInt(uploadMbps, 10);
  if (!Number.isFinite(download) || download <= 0 || !Number.isFinite(upload) || upload <= 0) {
    console.error(`[OpenWRT] Invalid bandwidth for ${normalizedMac}: down=${downloadMbps} up=${uploadMbps}`);
    return;
  }
  const config = getOpenwrtConfig();
  const classId = getClassId(normalizedMac);
  // ceil must be >= rate for HTB, same clamp as the standalone driver's
  // burstBucketBytes() - an operator-set burst rate below the base cap
  // would otherwise make `tc class replace` fail outright.
  const ceilMbps = Math.max(burst && burst.mbps ? burst.mbps : download, download);

  try {
    await withSsh(config, async (ssh) => {
      await exec(ssh, `tc class replace dev ${config.lanInterface} parent 1: classid 1:${classId} htb rate ${download}mbit ceil ${ceilMbps}mbit`);
      await exec(ssh, `tc filter replace dev ${config.lanInterface} protocol ip parent 1:0 prio 1 flower dst_mac ${normalizedMac} classid 1:${classId}`);
      // Ingress (upload) shaping requires an ifb device mirrored from the LAN
      // interface — assumed already set up as a one-time prerequisite
      // (documented alongside the base nftables table/set setup), same as
      // Tarakifi's own OpenWRT driver assumes the operator pre-configures
      // ifb0 rather than provisioning it live over SSH on every call.
      await exec(ssh, `tc filter replace dev ifb0 protocol ip parent 1:0 prio 1 flower src_mac ${normalizedMac} action police rate ${upload}mbit burst 32k drop`);
    });
    console.log(`[OpenWRT] Shaped ${normalizedMac} to ${download}mbit down / ${upload}mbit up`);
  } catch (error) {
    // Matches networkService.js's documented contract - setClientBandwidth
    // just logs and resolves, same as the standalone driver's own exec
    // callback never rejecting this call.
    console.error(`[OpenWRT] Failed to shape ${normalizedMac}:`, error.message);
  }
}

async function removeClientBandwidth(mac) {
  let normalizedMac;
  try {
    normalizedMac = normalizeMac(mac);
  } catch (error) {
    console.error('[OpenWRT] Invalid MAC during cleanup:', error.message);
    return;
  }

  // peekClassId (not getClassId) - never allocate a fresh ID just to
  // immediately try deleting a tc class that was never created (e.g.
  // cleanup called on a MAC whose bandwidth cap was never applied), which
  // would otherwise leak an allocation forever.
  const classId = peekClassId(normalizedMac);
  if (classId === undefined) {
    console.log(`[OpenWRT] No known shaping for ${normalizedMac}, nothing to clean up`);
    return;
  }

  const config = getOpenwrtConfig();
  try {
    await withSsh(config, async (ssh) => {
      await exec(ssh, `tc filter del dev ${config.lanInterface} protocol ip parent 1:0 prio 1 flower dst_mac ${normalizedMac} classid 1:${classId} 2>/dev/null; true`);
      await exec(ssh, `tc class del dev ${config.lanInterface} classid 1:${classId} 2>/dev/null; true`);
      await exec(ssh, `tc filter del dev ifb0 protocol ip parent 1:0 prio 1 flower src_mac ${normalizedMac} 2>/dev/null; true`);
    });
    console.log(`[OpenWRT] Cleaned up bandwidth shaping for ${normalizedMac}`);
  } catch (error) {
    // Matches networkService.js's documented contract - removeClientBandwidth
    // just logs and resolves.
    console.error(`[OpenWRT] Failed to clean up ${normalizedMac}:`, error.message);
  } finally {
    // Release only after the cleanup attempt (same as standaloneDriver.js),
    // so a retry before this attempt's callback fires still has the class
    // ID to work with.
    releaseClassId(normalizedMac);
  }
}

async function getMacFromIp(ip) {
  const config = getOpenwrtConfig();
  try {
    return await withSsh(config, async (ssh) => {
      // dnsmasq's own lease file on OpenWRT, same format assumption the
      // standalone driver already relies on locally.
      const r = await exec(ssh, `awk -v ip="${ip}" '$3==ip{print $2}' /tmp/dhcp.leases`);
      const mac = r.stdout.trim().toLowerCase();
      return mac || null;
    });
  } catch (err) {
    console.error('[OpenWRT] getMacFromIp error:', err.message);
    return null;
  }
}

module.exports = defineDriver('openwrt', {
  ping,
  allowClient,
  blockClient,
  isClientAllowed,
  setClientBandwidth,
  removeClientBandwidth,
  getMacFromIp,
});
