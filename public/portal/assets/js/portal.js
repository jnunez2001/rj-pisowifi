const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { getRates } = require('../services/voucherService');
const { execSync } = require('child_process');
const fs = require('fs');

// Detect client MAC from IP
function getMacFromIp(ip) {
  // Try ARP table first (most reliable)
  try {
    const arp = execSync(`ip neigh show ${ip} 2>/dev/null`).toString().trim();
    const match = arp.match(/lladdr\s+([0-9a-f:]{17})/i);
    if (match) return match[1].toUpperCase();
  } catch(e) {}

  // Fallback: dnsmasq leases file
  try {
    const leases = fs.readFileSync('/var/lib/misc/dnsmasq.leases', 'utf8');
    const lines = leases.trim().split('\n');
    for (const line of lines) {
      const parts = line.split(' ');
      if (parts[2] === ip) return parts[1].toUpperCase();
    }
  } catch(e) {}

  return null;
}

// GET /api/portal/detect
router.get('/detect', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] ||
                   req.connection.remoteAddress ||
                   req.socket.remoteAddress || '';
  const ip = clientIp.replace('::ffff:', '').trim();
  const mac = getMacFromIp(ip);

  return res.json({
    success: !!mac,
    ip,
    mac: mac || null
  });
});

// GET /api/portal/rates
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