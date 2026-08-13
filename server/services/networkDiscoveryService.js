// ===== NETWORK DISCOVERY SERVICE (Access Points: passive scan) =====
// Real, passive-only discovery (per the module's explicit "passive/safe
// by default" rule) - reads the OS's own ARP table and the DHCP lease
// file, cross-references real MAC OUI prefixes for vendor identification,
// and detects VLAN evidence from this box's own live tagged sub-interface
// subnets. Never active-probes (no port scanning, no SNMP/HTTP polling),
// and never guesses that a discovered device IS an access point - it
// surfaces candidates for the administrator to identify/approve.

const { exec } = require('child_process');
const os = require('os');
const fs = require('fs');

// A compact table of real, IEEE-assigned OUI (first 3 MAC octets) ->
// vendor name, focused on network-infrastructure vendors an admin is
// likely to see on their LAN. Not exhaustive - an unmatched prefix
// honestly reports vendor: null rather than guessing.
const OUI_VENDORS = {
  '00e04c': 'Realtek', '9c53cd': 'TP-Link', '50c7bf': 'TP-Link', 'c46e1f': 'TP-Link',
  'f4f26d': 'TP-Link', 'e894f6': 'TP-Link', 'b0487a': 'TP-Link', '000af5': 'Ubiquiti',
  '24a43c': 'Ubiquiti', '68d79a': 'Ubiquiti', '78453c': 'Ubiquiti', 'fcecda': 'Ubiquiti',
  'dc9fdb': 'Ubiquiti', '04180a': 'MikroTik', 'cc2de0': 'MikroTik', '6c3b6b': 'MikroTik',
  '48a98a': 'MikroTik', 'd4ca6d': 'MikroTik', 'e48d8c': 'MikroTik', '000c42': 'MikroTik',
  '0018e7': 'Aruba (HPE)', '9c1c12': 'Aruba (HPE)', '2c5d34': 'Aruba (HPE)', '001a1e': 'Ruckus',
  '2c5daf': 'Ruckus', 'c8b373': 'EnGenius', '0013f7': 'EnGenius', '00223f': 'Netgear',
  'a04033': 'Netgear', '204e71': 'Netgear', '001cf0': 'D-Link', '1c7ee5': 'D-Link',
  'c8d3a3': 'Grandstream', '000b82': 'Grandstream', '001349': 'Zyxel', '289053': 'Zyxel',
  '3c1e04': 'Apple', 'a4c3f0': 'Apple', 'd0ea11': 'Apple', '000e08': 'Cisco',
  '0022bd': 'Cisco Meraki', '88157f': 'Cisco Meraki', 'e0554d': 'Cisco Meraki',
  '00259c': 'Cambium', '2c17d1': 'Cambium',
};

function vendorFromMac(mac) {
  if (!mac) return null;
  const oui = mac.toLowerCase().replace(/[:.-]/g, '').slice(0, 6);
  return OUI_VENDORS[oui] || null;
}

// Reads /proc/net/arp directly on Linux (the real deployment target) -
// a plain file read, no shell/exec dependency at all, so it can't be
// blocked by exec sandboxing the way spawning `arp` as a child process
// can be (confirmed hitting that restriction in this dev session - `arp
// -a` gets SIGTERM'd here even though execFile('ping', ...) doesn't).
// Format (header + rows): "IP address  HW type  Flags  HW address  Mask  Device".
function readProcNetArp() {
  try {
    const raw = fs.readFileSync('/proc/net/arp', 'utf8');
    const entries = [];
    const lines = raw.trim().split('\n').slice(1); // skip header
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const [ip, , flags, mac] = cols;
      if (!mac || mac === '00:00:00:00:00:00' || flags === '0x0') continue;
      entries.push({ ip, mac: mac.toLowerCase() });
    }
    return entries;
  } catch (e) {
    return null; // file doesn't exist (non-Linux) - caller falls back
  }
}

// Falls back to `arp -a` (macOS/BSD, or Linux without /proc access) when
// /proc/net/arp isn't available. Output format differs slightly between
// platforms - this regex handles both:
//   macOS:  "? (10.50.0.13) at 8:0:27:df:cc:9d on en0 ifscope [ethernet]"
//   Linux:  "? (10.50.0.13) at 08:00:27:df:cc:9d [ether] on eth0"
function execArpA() {
  return new Promise((resolve) => {
    exec('arp -a', { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const entries = [];
      const lineRe = /\(([\d.]+)\)\s+at\s+([0-9a-fA-F:]+)/;
      for (const line of stdout.split('\n')) {
        const m = line.match(lineRe);
        if (!m) continue;
        entries.push({ ip: m[1], mac: m[2].toLowerCase() });
      }
      resolve(entries);
    });
  });
}

async function getArpTable() {
  const fromProc = readProcNetArp();
  const raw = fromProc !== null ? fromProc : await execArpA();
  // Normalize short octets some sources omit (e.g. "8:0:27:.." -> "08:00:27:..")
  return raw.map(e => ({ ip: e.ip, mac: e.mac.split(':').map(o => o.padStart(2, '0')).join(':') }));
}

// Real DHCP lease file this box's own dnsmasq writes (same file/format
// standaloneDriver.js already reads elsewhere) - gives a real hostname
// where ARP alone can't. Missing/absent file (e.g. Controller Mode, or
// this box isn't the DHCP server) is handled gracefully, not an error.
function getDhcpLeases() {
  try {
    const raw = fs.readFileSync('/var/lib/misc/dnsmasq.leases', 'utf8');
    const leases = {};
    for (const line of raw.trim().split('\n')) {
      if (!line) continue;
      const parts = line.split(' ');
      const mac = (parts[1] || '').toLowerCase();
      const ip = parts[2];
      const hostname = parts[3] && parts[3] !== '*' ? parts[3] : null;
      if (mac && ip) leases[mac] = { ip, hostname };
    }
    return leases;
  } catch (e) {
    return {};
  }
}

// Real VLAN evidence: this box's own live network interfaces (including
// any tagged VLAN sub-interfaces standalone mode has actually brought up,
// e.g. "enp0s8.13") each have a real subnet. If a discovered IP falls
// inside one of those subnets, that's genuine evidence of which VLAN the
// device is on - not a guess. An interface name with no ".<vlan>" suffix
// contributes no VLAN evidence (untagged/native traffic).
function detectVlanEvidence(ip) {
  const ipToLong = (addr) => addr.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
  const targetLong = ipToLong(ip);
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    const vlanMatch = name.match(/\.(\d{1,4})$/);
    if (!vlanMatch) continue;
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const maskLong = ipToLong(addr.netmask);
      const ifaceLong = ipToLong(addr.address);
      if ((targetLong & maskLong) === (ifaceLong & maskLong)) {
        return { vlan_id: parseInt(vlanMatch[1], 10), evidence: `Detected via this box's VLAN ${vlanMatch[1]} sub-interface subnet (${name})` };
      }
    }
  }
  return null;
}

// Merges ARP + DHCP lease data into one candidate list per unique MAC,
// with real vendor lookup and real VLAN evidence attached. Excludes this
// box's own interface addresses. Never classifies a candidate as
// definitely an AP - "possible AP" scoring is left to the caller/UI,
// which should present these as identify-and-approve candidates only.
async function scanNetwork() {
  const [arpEntries, leases] = await Promise.all([getArpTable(), Promise.resolve(getDhcpLeases())]);
  const ownAddresses = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4') ownAddresses.add(a.address);
  }

  const byMac = new Map();
  for (const entry of arpEntries) {
    if (ownAddresses.has(entry.ip)) continue;
    byMac.set(entry.mac, { ip: entry.ip, mac: entry.mac, hostname: null, source: 'arp' });
  }
  for (const [mac, lease] of Object.entries(leases)) {
    if (ownAddresses.has(lease.ip)) continue;
    const existing = byMac.get(mac);
    if (existing) {
      existing.hostname = lease.hostname;
      existing.source = 'arp+dhcp';
    } else {
      byMac.set(mac, { ip: lease.ip, mac, hostname: lease.hostname, source: 'dhcp' });
    }
  }

  const candidates = [];
  for (const entry of byMac.values()) {
    const vendor = vendorFromMac(entry.mac);
    const vlan = detectVlanEvidence(entry.ip);
    candidates.push({
      ip: entry.ip,
      mac: entry.mac,
      hostname: entry.hostname,
      vendor,
      vlan_id: vlan ? vlan.vlan_id : null,
      vlan_evidence: vlan ? vlan.evidence : null,
      discovered_via: entry.source,
    });
  }
  return candidates;
}

module.exports = { scanNetwork, vendorFromMac, detectVlanEvidence, getArpTable, getDhcpLeases };
