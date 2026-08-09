// Builds a single downloadable text bundle - recent logs, basic network
// state, service status, and sanitized settings (no passwords/secrets) - so
// an operator asking for help can send one file instead of pasting a dozen
// terminal screenshots. Plain text, not a real .zip, deliberately: no new
// dependency needed, and it stays readable cross-platform (Linux SBC, mini
// PC, or a Windows dev box) with nothing more than a text editor.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const db = require('../config/database');

const SECRET_KEYS = ['admin_password', 'mikrotik_password', 'router_password', 'openwrt_password'];

function section(title, content) {
  return `\n===== ${title} =====\n${content}\n`;
}

function safeRun(cmd) {
  try {
    return execSync(cmd, { timeout: 5000 }).toString().trim();
  } catch (e) {
    return `(unavailable: ${e.message})`;
  }
}

function getRecentLogs(maxLines) {
  const logDir = process.env.FINANCIAL_LOG_DIR || path.join(__dirname, '../logs');
  try {
    const files = fs.readdirSync(logDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);
    return files.map((f) => {
      const lines = fs.readFileSync(path.join(logDir, f.name), 'utf8').trim().split('\n');
      return `--- ${f.name} (last ${maxLines} lines) ---\n${lines.slice(-maxLines).join('\n')}`;
    }).join('\n\n') || '(no log files found)';
  } catch (e) {
    return `(could not read logs: ${e.message})`;
  }
}

function getSanitizedSettings() {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return rows
      .filter((r) => !SECRET_KEYS.includes(r.key))
      .map((r) => `${r.key} = ${r.value}`)
      .join('\n');
  } catch (e) {
    return `(could not read settings: ${e.message})`;
  }
}

function buildBundle() {
  const isLinux = process.platform === 'linux';
  let report = `ZenFi Support Bundle\nGenerated: ${new Date().toISOString()}\nPlatform: ${process.platform}\n`;

  try {
    const diagnostics = require('./systemDiagnosticsService').runChecks();
    const diagText = diagnostics.results.map((r) => `[${r.pass ? 'OK' : 'FAIL'}] ${r.label}: ${r.detail}`).join('\n');
    report += section('SYSTEM HEALTH CHECK', diagText);
  } catch (e) {
    report += section('SYSTEM HEALTH CHECK', `(failed to run: ${e.message})`);
  }

  if (isLinux) {
    report += section('IP ADDRESSES', safeRun('ip addr show'));
    report += section('APP SERVICE STATUS', safeRun('systemctl status rj-pisowifi --no-pager -l'));
    report += section('WATCHDOG SERVICE STATUS', safeRun('systemctl status rj-pisowifi-watchdog.timer --no-pager -l'));
  } else {
    report += section('IP ADDRESSES', '(skipped - not applicable on this platform)');
    report += section('APP SERVICE STATUS', '(skipped - systemd not applicable on this platform)');
  }

  report += section('RECENT LOGS (financial audit trail, last 3 files)', getRecentLogs(50));
  report += section('SETTINGS (sanitized - passwords/secrets removed)', getSanitizedSettings());

  return report;
}

module.exports = { buildBundle };
