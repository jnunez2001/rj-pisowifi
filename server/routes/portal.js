const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { getRates } = require('../services/voucherService');
const { execSync } = require('child_process');

// Detect client MAC from IP using ARP table
function getMacFromIp(ip) {
  try {
    // Read dnsmasq leases file
    const leases = require('fs').readFileSync('/var/lib/misc/dnsmasq.leases', 'utf8');
    const lines = leases.trim().split('\n');
    for (const line of lines) {
      const parts = line.split(' ');
      // Format: timestamp MAC IP hostname client-id
      if (parts[2] === ip) {
        return parts[1].toUpperCase();
      }
    }
  } catch (e) {}

  try {
    // Fallback: use ARP table
    const arp = execSync(`arp -n ${ip} 2>/dev/null`).toString();
    const match = arp.match(/([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/i);
    if (match) return match[1].toUpperCase();
  } catch (e) {}

  return null;
}

// GET /api/portal/detect — detect client MAC from IP
router.get('/detect', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || 
                   req.connection.remoteAddress ||
                   req.socket.remoteAddress;
  
  // Clean IPv6 prefix
  const ip = clientIp.replace('::ffff:', '');
  const mac = getMacFromIp(ip);

  return res.json({
    success: !!mac,
    ip,
    mac: mac || null
  });
});

router.get('/rates', (req, res) => {
  try {
    const rates = getRates();

    const getSetting = (key, def) => {
      const s = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return s ? s.value : def;
    };

    return res.json({
      success: true,
      cafe_name: getSetting('cafe_name', 'R&J PisoWifi'),
      banner_text: getSetting('banner_text', 'HIGH SPEED CONNECTION!'),
      logo_url: getSetting('logo_url', null),
      banner_url: getSetting('banner_url', null),
      welcome_message: getSetting('welcome_message', 'Welcome! Insert a coin to get started.'),
      disconnect_message: getSetting('disconnect_message', 'Your session has ended. Thank you!'),
      show_voucher: getSetting('show_voucher', '0'),
      redirect_url: getSetting('redirect_url', ''),
      allow_pause: getSetting('allow_pause', '1'),
      max_pause_minutes: getSetting('max_pause_minutes', '30'),
      grace_period_minutes: getSetting('grace_period_minutes', '0'),
      rates,
      vendo_ip: getSetting('vendo_ip', '')
    });

  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;