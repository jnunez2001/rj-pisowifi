// ===== TP-LINK ARCHER AX12 ADAPTER (Phase 1, read-only) =====
// Implements server/services/apAdapters/adapterInterface.js against the
// endpoints AP_INTEGRATION_ARCHITECTURE.md section 9-12 documents as
// confirmed-observed on a real AX12 unit:
//   device_config?form=config (operation=read) - capability document
//   status?form=all - live LAN/wireless/health/client state
//   a separate client-telemetry request - rxrate/txrate/signal/onlineTime
//
// IMPORTANT, read before trusting this in production: the doc confirms
// those READ endpoints, but does not document the actual login handshake
// used to obtain the `stok` session token those endpoints require - only
// that authenticated POST requests were observed. TP-Link's local web UI
// across different Archer firmware versions has used both a plain
// form-encoded login and an RSA-encrypted-password login; which one this
// specific AX12/firmware combination needs is NOT verified here. The
// authenticate() implementation below is the simpler, plain-form baseline
// (per section 31: "Do not build... Vendor API assumptions without
// testing" - this is flagged, not silently assumed correct). It fails
// with a clearly distinguishable AuthenticationFailed error rather than
// pretending to succeed, per section 19's required failure-mode
// distinction. Verify and adjust against a real unit before relying on
// this for anything beyond development.

const { defineApAdapter } = require('./adapterInterface');

const BASE_LOGIN_PATH = '/cgi-bin/luci/;stok=/login?form=login';
function apiPath(stok, form) {
  return `/cgi-bin/luci/;stok=${stok}/${form}`;
}

async function postForm(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const err = new Error(`TP-Link AX12: HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }
  return res.json();
}

// Section 6: identify() must not require credentials - a plain unauthenticated
// GET of the login page is enough to fingerprint a TP-Link Archer web UI
// (its login page has a distinctive title/script signature across the
// Archer line) without ever sending a password.
async function identify(ip) {
  try {
    const res = await fetch(`http://${ip}/`, { signal: AbortSignal.timeout(3000) });
    const html = await res.text();
    if (/TP-Link|tplinkwifi/i.test(html)) {
      return { vendor: 'TP-Link', model: 'Archer (unconfirmed model)', confidence: 'medium' };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Baseline plain-form login - see the module header's authentication
// caveat. Throws a clearly-typed error on failure rather than returning a
// falsy session, per section 19 (AuthenticationFailed must be
// distinguishable from Offline/Timeout).
async function authenticate(ip, credentials) {
  const baseUrl = `http://${ip}`;
  let data;
  try {
    data = await postForm(baseUrl, BASE_LOGIN_PATH, {
      operation: 'login',
      password: credentials.password,
    });
  } catch (err) {
    const authErr = new Error('TP-Link AX12: authentication request failed (device offline, unreachable, or this firmware needs a different login handshake than the one implemented here)');
    authErr.name = 'AuthenticationFailed';
    authErr.cause = err;
    throw authErr;
  }
  if (!data || !data.stok) {
    const authErr = new Error('TP-Link AX12: login rejected (wrong password, or this firmware expects RSA-encrypted login rather than the plain form used here)');
    authErr.name = 'AuthenticationFailed';
    throw authErr;
  }
  return { session: { baseUrl, stok: data.stok, ip } };
}

async function readConfig(session) {
  return postForm(session.baseUrl, apiPath(session.stok, 'device_config?form=config'), { operation: 'read' });
}

async function readStatus(session) {
  return postForm(session.baseUrl, apiPath(session.stok, 'status?form=all'), { operation: 'read' });
}

async function getCapabilities(session) {
  const config = await readConfig(session);
  const { emptyCapabilities } = require('./capabilityModel');
  const caps = emptyCapabilities();
  // Section 5: only claim what's actually confirmed present in the
  // response, never inferred from the feature merely existing by name.
  caps.monitoring.device_status = true;
  caps.monitoring.wireless = !!(config?.wireless_2g || config?.wireless_5g || config?.supportOperationMode);
  caps.monitoring.clients = true; // status?form=all always includes client arrays per section 11
  caps.monitoring.health = true;
  caps.monitoring.traffic = false; // section 12: not confirmed valid in every mode, don't claim it
  // Management (Phase 2, not yet validated per section 15) intentionally
  // left false here even if the config document reports support - section
  // 15 explicitly requires validating each write endpoint against a real
  // device before an adapter may claim it.
  return caps;
}

async function getDeviceInfo(session) {
  const status = await readStatus(session);
  return {
    vendor: 'TP-Link',
    model: 'Archer AX12',
    firmware: status.fw_ver || status.firmware_version || null,
    mac: status.lan_macaddr || null,
  };
}

async function getStatus(session) {
  const status = await readStatus(session);
  return {
    online: true, // reaching this point means the device answered
    cpuPercent: status.cpu_usage != null ? Number(status.cpu_usage) : null,
    memPercent: status.mem_usage != null ? Number(status.mem_usage) : null,
  };
}

async function getOperationMode(session) {
  const config = await readConfig(session);
  const mode = config?.operation_mode || config?.opMode;
  if (mode === 'router' || mode === 'ap') return mode;
  return 'unknown';
}

async function getNetwork(session) {
  const status = await readStatus(session);
  return {
    lanIp: status.lan_ipv4_ipaddr || null,
    lanMac: status.lan_macaddr || null,
    lanNetmask: status.lan_ipv4_netmask || null,
  };
}

async function getWireless(session) {
  const status = await readStatus(session);
  const band = (prefix) => {
    if (status[`wireless_${prefix}_enable`] == null) return null;
    return {
      enabled: status[`wireless_${prefix}_enable`] === '1' || status[`wireless_${prefix}_enable`] === true,
      ssid: status[`wireless_${prefix}_ssid`] || null,
      channel: status[`wireless_${prefix}_current_channel`] || status[`wireless_${prefix}_channel`] || null,
      channelWidth: status[`wireless_${prefix}_htmode`] || null,
      txPower: status[`wireless_${prefix}_txpower`] || null,
    };
  };
  return { band2g: band('2g'), band5g: band('5g') };
}

// Section 13: normalize vendor units into StarkFi units - rxrate/txrate
// arrive as the vendor's own scaled integer (720600 -> 720.6 Mbps per the
// doc's own example), never exposed raw to the frontend.
function normalizeClient(raw) {
  return {
    mac: (raw.mac || raw.macaddr || '').toLowerCase(),
    ip: raw.ip || raw.ipaddr || null,
    hostname: raw.deviceName || raw.hostname || null,
    connectionType: raw.wire_type === 'wired' ? 'wired' : 'wireless',
    band: raw.band || null,
    signalDbm: raw.signal != null ? Number(raw.signal) : null,
    rxRateMbps: raw.rxrate != null ? Number(raw.rxrate) / 1000 : null,
    txRateMbps: raw.txrate != null ? Number(raw.txrate) / 1000 : null,
    onlineSeconds: raw.onlineTime != null ? Number(raw.onlineTime) : null,
    deviceType: raw.deviceType || 'other',
  };
}

async function getClients(session) {
  const status = await readStatus(session);
  const wireless = (status.access_devices_wireless_host || []).map(normalizeClient);
  const wired = (status.access_devices_wired || []).map((c) => ({ ...normalizeClient(c), connectionType: 'wired' }));
  return [...wireless, ...wired];
}

async function getHealth(session) {
  const status = await readStatus(session);
  return {
    cpuPercent: status.cpu_usage != null ? Number(status.cpu_usage) : null,
    memPercent: status.mem_usage != null ? Number(status.mem_usage) : null,
  };
}

module.exports = defineApAdapter('tplink-ax12', {
  identify,
  authenticate,
  getCapabilities,
  getDeviceInfo,
  getStatus,
  getOperationMode,
  getNetwork,
  getWireless,
  getClients,
  getHealth,
});
