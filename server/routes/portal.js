const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { getRates } = require('../services/voucherService');
const { execSync } = require('child_process');
const mikrotikService = require('../services/mikrotikService');

// Rate limiting for /detect endpoint (Bug #32)
const detectRateLimit = new Map();
const DETECT_RATE_LIMIT_MS = 5000; // Allow 1 request per 5 seconds per IP

// MAC resolution cache (Bug #33)
const macResolutionCache = new Map();
const MAC_CACHE_TTL_MS = 10000; // 10 seconds

// Detect client MAC from IP (with caching).
//
// Bug found on real hardware: this used to always read this server's own
// local dnsmasq.leases file / ARP table, which only ever has entries for
// devices on the same Layer 2 segment as this server. Router mode disables
// dnsmasq entirely, and a gated lane on its own separate bridge (e.g.
// WiFi-Rental's VLAN) is a different broadcast domain this server has no L2
// visibility into at all — local lookups could never find those clients,
// no matter how many times a customer retried. In router mode, ask the
// MikroTik itself instead: as the actual gateway for every lane, its own
// DHCP lease table always has the true IP-to-MAC mapping.
async function getMacFromIp(ip) {
  // Check cache first (Bug #33 — cache MAC resolution)
  const cached = macResolutionCache.get(ip);
  if (cached && Date.now() - cached.time < MAC_CACHE_TTL_MS) {
    return cached.mac;
  }

  let mac = null;

  if (mikrotikService.isMikrotikModeEnabled()) {
    mac = await mikrotikService.getMacFromIp(ip);
  } else {
    try {
      // Read dnsmasq leases file
      const leases = require('fs').readFileSync('/var/lib/misc/dnsmasq.leases', 'utf8');
      const lines = leases.trim().split('\n');
      for (const line of lines) {
        const parts = line.split(' ');
        // Format: timestamp MAC IP hostname client-id
        if (parts[2] === ip) {
          mac = parts[1].toLowerCase();
          break;
        }
      }
    } catch (e) {}

    if (!mac) {
      try {
        // Fallback: use ARP table
        const arp = execSync(`arp -n ${ip} 2>/dev/null`).toString();
        const match = arp.match(/([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/i);
        if (match) mac = match[1].toLowerCase();
      } catch (e) {}
    }
  }

  // Cache the result (even null, to avoid repeated lookups)
  macResolutionCache.set(ip, { mac, time: Date.now() });
  return mac;
}

// GET /api/portal/detect — detect client MAC from IP
router.get('/detect', async (req, res) => {
  // No reverse proxy sits in front of this server (setup/nginx.conf is an
  // unused empty placeholder) — x-forwarded-for is fully client-suppliable
  // here, so trusting it let one device resolve (and act as) another
  // device's MAC address just by sending a spoofed header. The raw socket
  // address can't be set by the client.
  const clientIp = req.connection.remoteAddress ||
                   req.socket.remoteAddress;

  // Clean IPv6 prefix
  const ip = (clientIp || '').replace('::ffff:', '');

  // Rate limiting (Bug #32)
  const lastRequest = detectRateLimit.get(ip);
  if (lastRequest && Date.now() - lastRequest < DETECT_RATE_LIMIT_MS) {
    return res.status(429).json({
      success: false,
      message: 'Rate limit exceeded. Try again later.'
    });
  }
  detectRateLimit.set(ip, Date.now());

  const mac = await getMacFromIp(ip);

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
      payment_methods: getSetting('payment_methods', 'both'),
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

router.post('/relay/:action', async (req, res) => {
  const { action } = req.params;
  if (!['on', 'off'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Invalid action' });
  }

  const vendoIp = db.prepare("SELECT value FROM settings WHERE key = 'vendo_ip'").get()?.value;
  if (!vendoIp) {
    return res.status(400).json({ success: false, message: 'No vendo configured' });
  }

  try {
    const relayRes = await fetch(`http://${vendoIp}/relay/${action}`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000)
    });

    if (!relayRes.ok) {
      return res.status(502).json({ success: false, message: 'ESP32 relay request failed' });
    }

    return res.json({ success: true });
  } catch (e) {
    console.error(`[Vendo] Relay ${action} failed:`, e.message);
    return res.status(502).json({ success: false, message: 'ESP32 unreachable' });
  }
});

module.exports = router;
