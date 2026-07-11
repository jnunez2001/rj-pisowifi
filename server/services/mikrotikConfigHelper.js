// Shared by mikrotikService.js and mikrotikProvisioner.js - split out on its
// own so provisioning code doesn't have to require the whole service module
// (and to avoid a circular require between the two).
const db = require('../config/database');
const { decryptSecret } = require('../utils/secretCrypto');

function getMikrotikConfig() {
  const getSetting = (key, def) => {
    const s = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return s ? s.value : def;
  };
  const ssl = getSetting('mikrotik_ssl', '0') === '1';
  const portSetting = parseInt(getSetting('mikrotik_port', ''), 10);
  return {
    ip: getSetting('mikrotik_ip', ''),
    user: getSetting('mikrotik_user', 'admin'),
    pass: decryptSecret(getSetting('mikrotik_pass', '')),
    interface: getSetting('mikrotik_interface', 'ether1'),
    ssl,
    port: Number.isFinite(portSetting) && portSetting > 0 ? portSetting : null,
  };
}

module.exports = { getMikrotikConfig };
