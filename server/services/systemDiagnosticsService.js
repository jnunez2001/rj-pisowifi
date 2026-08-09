// Runs the same checks that used to require SSH-ing in and typing commands
// by hand (interface up, has an IP, default route, can reach the internet,
// can resolve DNS, nft/tc/gpiod present) and returns plain-language
// pass/fail results for the admin panel. Every check is wrapped so one
// failing check (e.g. no internet) never prevents the rest from running.
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const db = require('../config/database');

function which(bin) {
  try {
    const result = execSync(`command -v ${bin} 2>/dev/null || which ${bin} 2>/dev/null`).toString().trim();
    return result || null;
  } catch (e) {
    return null;
  }
}

function check(name, label, fn) {
  try {
    const result = fn();
    return { name, label, pass: !!result.pass, detail: result.detail };
  } catch (e) {
    return { name, label, pass: false, detail: `Check failed to run: ${e.message}` };
  }
}

function getNetworkMode() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('network_mode');
    return (row && row.value) || 'standalone';
  } catch (e) {
    return 'standalone';
  }
}

function runChecks() {
  const results = [];
  const isLinux = process.platform === 'linux';
  const mode = getNetworkMode();

  results.push(check('interface', 'Network interface is up', () => {
    if (!isLinux) return { pass: true, detail: 'Skipped (not applicable on this platform).' };
    if (!fs.existsSync('/sys/class/net')) {
      return { pass: false, detail: 'No network interfaces found on this system.' };
    }
    const ifaces = fs.readdirSync('/sys/class/net').filter((n) => n !== 'lo');
    const up = ifaces.filter((n) => {
      try {
        return fs.readFileSync(`/sys/class/net/${n}/operstate`, 'utf8').trim() === 'up';
      } catch (e) {
        return false;
      }
    });
    return {
      pass: up.length > 0,
      detail: up.length > 0
        ? `${up.length} of ${ifaces.length} network interface(s) up: ${up.join(', ')}`
        : `No network interface is currently up (found: ${ifaces.join(', ') || 'none'}). Check the cable/WiFi connection.`,
    };
  }));

  results.push(check('ip_address', 'This box has an IP address', () => {
    const addrs = [];
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) addrs.push(`${name}: ${net.address}`);
      }
    }
    return {
      pass: addrs.length > 0,
      detail: addrs.length > 0 ? addrs.join(', ') : 'No non-loopback IPv4 address found on any interface.',
    };
  }));

  results.push(check('default_route', 'Has a default route (gateway)', () => {
    if (!isLinux) return { pass: true, detail: 'Skipped (not applicable on this platform).' };
    try {
      const out = execSync('ip route show default 2>/dev/null').toString().trim();
      return {
        pass: out.length > 0,
        detail: out.length > 0 ? out : 'No default route found. This box may not have a gateway configured.',
      };
    } catch (e) {
      return { pass: false, detail: 'Could not read the routing table.' };
    }
  }));

  results.push(check('internet', 'Can reach the internet', () => {
    try {
      execSync('ping -c 1 -W 2 8.8.8.8', { stdio: 'ignore' });
      return { pass: true, detail: 'Reached 8.8.8.8 successfully.' };
    } catch (e) {
      return { pass: false, detail: 'Could not reach 8.8.8.8. Check the WAN connection.' };
    }
  }));

  results.push(check('dns', 'Can resolve domain names', () => {
    try {
      execSync('getent hosts google.com 2>/dev/null || nslookup google.com 2>/dev/null', { stdio: 'ignore' });
      return { pass: true, detail: 'Resolved google.com successfully.' };
    } catch (e) {
      return { pass: false, detail: 'Could not resolve google.com. DNS may be misconfigured.' };
    }
  }));

  results.push(check('nft', 'Network filtering tool (nft) is installed', () => {
    if (mode !== 'standalone') return { pass: true, detail: 'Skipped (only required in Standalone mode).' };
    const bin = which('nft');
    return {
      pass: !!bin,
      detail: bin ? `Found at ${bin}` : 'nft is not installed. Required for Standalone mode client access control.',
    };
  }));

  results.push(check('tc', 'Bandwidth shaping tool (tc) is installed', () => {
    if (mode !== 'standalone') return { pass: true, detail: 'Skipped (only required in Standalone mode).' };
    const bin = which('tc');
    return {
      pass: !!bin,
      detail: bin ? `Found at ${bin}` : 'tc is not installed. Required for Standalone mode bandwidth limits.',
    };
  }));

  results.push(check('gpio', 'GPIO tools are installed (Main Kiosk coin slot)', () => {
    let cfg;
    try {
      cfg = require('./coinslotGpio').currentConfig();
    } catch (e) {
      cfg = null;
    }
    if (!cfg || !cfg.enabled) {
      return { pass: true, detail: 'Skipped (Main Kiosk direct-GPIO coin slot is not enabled).' };
    }
    const gpiomon = which('gpiomon');
    const gpioset = which('gpioset');
    return {
      pass: !!(gpiomon && gpioset),
      detail: (gpiomon && gpioset)
        ? 'gpiomon and gpioset both found.'
        : `Missing: ${!gpiomon ? 'gpiomon ' : ''}${!gpioset ? 'gpioset' : ''}. Coin slot GPIO will not work without them.`,
    };
  }));

  results.push(check('disk_space', 'Enough free disk space', () => {
    const info = getDiskSpace();
    if (!info.checked) return { pass: true, detail: info.reason || 'Skipped (not applicable on this platform).' };
    return {
      pass: !info.low,
      detail: `${info.availMb} MB free (${info.usePercent}% used).${info.low ? ' Running low on disk space.' : ''}`,
    };
  }));

  const okCount = results.filter((r) => r.pass).length;
  return {
    ranAt: new Date().toISOString(),
    networkMode: mode,
    overallOk: okCount === results.length,
    passCount: okCount,
    totalCount: results.length,
    results,
  };
}

const LOW_DISK_THRESHOLD_MB = 200;

function getDiskSpace() {
  if (process.platform !== 'linux') {
    return { checked: false, reason: 'Skipped (not applicable on this platform).' };
  }
  try {
    const out = execSync("df -Pk . | tail -1").toString().trim().split(/\s+/);
    const availKb = parseInt(out[3], 10);
    const usePercent = parseInt(out[4], 10);
    const availMb = Math.round(availKb / 1024);
    return { checked: true, availMb, usePercent, low: availMb <= LOW_DISK_THRESHOLD_MB };
  } catch (e) {
    return { checked: false, reason: 'Could not determine disk usage.' };
  }
}

let lastBootReport = null;
function setLastBootReport(report) {
  lastBootReport = report;
}
function getLastBootReport() {
  return lastBootReport;
}

module.exports = { runChecks, setLastBootReport, getLastBootReport, getDiskSpace };
