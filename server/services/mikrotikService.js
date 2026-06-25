// ===== MIKROTIK SERVICE =====
// Handles MikroTik RouterOS API calls
// Used when network_mode = 'mikrotik'

const db = require('../config/database');

function getMikrotikConfig() {
  const getSetting = (key, def) => {
    const s = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return s ? s.value : def;
  };
  return {
    ip: getSetting('mikrotik_ip', ''),
    user: getSetting('mikrotik_user', 'admin'),
    pass: getSetting('mikrotik_pass', ''),
    interface: getSetting('mikrotik_interface', 'ether1')
  };
}

// Allow a client MAC address (create hotspot binding)
async function allowClient(mac, minutes) {
  const config = getMikrotikConfig();
  if (!config.ip) {
    console.log('MikroTik IP not configured');
    return false;
  }
  try {
    // MikroTik REST API (RouterOS 7+)
    const url = `http://${config.ip}/rest/ip/hotspot/active`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64')
      },
      body: JSON.stringify({
        'mac-address': mac,
        'minutes': minutes
      })
    });
    console.log(`✅ MikroTik allowed: ${mac}`);
    return res.ok;
  } catch(err) {
    console.error('MikroTik allowClient error:', err.message);
    return false;
  }
}

// Block a client MAC address (remove hotspot binding)
async function blockClient(mac) {
  const config = getMikrotikConfig();
  if (!config.ip) return false;
  try {
    const url = `http://${config.ip}/rest/ip/hotspot/active`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64')
      },
      body: JSON.stringify({ 'mac-address': mac })
    });
    console.log(`🚫 MikroTik blocked: ${mac}`);
    return res.ok;
  } catch(err) {
    console.error('MikroTik blockClient error:', err.message);
    return false;
  }
}

// Set bandwidth limit for a client
async function setClientBandwidth(mac, mbps) {
  const config = getMikrotikConfig();
  if (!config.ip) return false;
  try {
    const url = `http://${config.ip}/rest/queue/simple`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64')
      },
      body: JSON.stringify({
        'name': `rj-${mac}`,
        'target': mac,
        'max-limit': `${mbps}M/${mbps}M`
      })
    });
    console.log(`📶 MikroTik bandwidth set: ${mac} → ${mbps}Mbps`);
    return res.ok;
  } catch(err) {
    console.error('MikroTik bandwidth error:', err.message);
    return false;
  }
}

module.exports = { allowClient, blockClient, setClientBandwidth };