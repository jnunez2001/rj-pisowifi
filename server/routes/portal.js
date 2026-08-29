const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { getRates } = require('../services/voucherService');
const { execSync } = require('child_process');
const mikrotikService = require('../services/mikrotikService');

// Bug found live: this route used to read only the raw socket address,
// which is correct when this server is reached directly - but a portal
// TLS setup (setup/nginx.conf) proxies HTTPS through nginx on this same
// box first, and nginx always connects to this app from loopback. Every
// real customer's request looked identical to the server itself talking
// to itself (127.0.0.1), so /detect could never resolve a real MAC for
// anyone once the box was set up with a TLS-enabled portal - the portal
// page looked permanently blank/"0 time" even for an active, paid
// session, with no error anywhere pointing at why. Same helper already
// used correctly in admin.js/session.js/promo.js: only trust
// X-Forwarded-For when the TCP connection itself is from loopback (nginx
// sets this correctly; a remote client can't fake their own raw socket
// address to BE loopback, so this can't be spoofed by anyone but nginx
// itself). LAN clients never proxied through nginx fall through to the
// raw socket address unchanged.
function getRealClientIp(req) {
  const raw = (req.connection.remoteAddress || req.socket.remoteAddress || '')
    .replace('::ffff:', '').trim();
  if (raw === '127.0.0.1' || raw === '::1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return raw;
}

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
// visibility into at all, local lookups could never find those clients,
// no matter how many times a customer retried. In router mode, ask the
// MikroTik itself instead: as the actual gateway for every lane, its own
// DHCP lease table always has the true IP-to-MAC mapping.
async function getMacFromIp(ip) {
  // Check cache first (Bug #33, cache MAC resolution)
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

// GET /api/portal/detect, detect client MAC from IP
router.get('/detect', async (req, res) => {
  const ip = getRealClientIp(req);

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
      cafe_name: getSetting('cafe_name', 'StarkFi'),
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
      vendo_ip: getSetting('vendo_ip', ''),
      vapid_public_key: getSetting('vapid_public_key', ''),
      portal_hostname: getSetting('portal_hostname', ''),
      allow_premium_to_regular_convert: getSetting('allow_premium_to_regular_convert', '0')
    });

  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/portal/push-subscribe - only reachable in practice over the
// LAN-facing HTTPS port (setup/nginx.conf's 8443 block), since the browser
// itself refuses to even attempt subscribing from a plain-HTTP page
// (service workers require a secure context) - no need to re-check the
// protocol here, an insecure-context caller physically can't produce a
// valid subscription object to send in the first place.
router.post('/push-subscribe', (req, res) => {
  try {
    const { mac, subscription } = req.body;
    if (!mac || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ success: false, message: 'Invalid subscription' });
    }
    db.prepare(`
      INSERT INTO push_subscriptions (mac_address, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET mac_address = excluded.mac_address
    `).run(String(mac).trim().toLowerCase(), subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
    return res.json({ success: true });
  } catch (err) {
    console.error('Push subscribe error:', err);
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

// Named sounds only, never an arbitrary client-supplied URL - the vendo
// fetches whatever URL this tells it to, so accepting a raw URL from the
// portal (unauthenticated, customer-facing) would let anyone make the
// vendo device fetch/stream from anywhere. Add new prompts here as real
// audio files land in public/audio/vendo/.
const VENDO_SOUNDS = {
  'welcome': 'welcome.wav',
  'insert-coin': 'insert-coin.wav',
  'connected': 'connected.wav',
};

// POST /play-sound - tells the vendo to stream and play one of the named
// WAV files above, e.g. a voice prompt when the customer taps "Insert
// Coin" on the portal (see portal.js's handleInsertCoin()). The file
// itself is served straight out of public/ (app.js's express.static) and
// streamed/decoded by the device a chunk at a time - never saved to the
// vendo's own flash (esp8266/firmware's audio.cpp).
router.post('/play-sound', async (req, res) => {
  const { sound } = req.body || {};
  const filename = VENDO_SOUNDS[sound];
  if (!filename) {
    return res.status(400).json({ success: false, message: 'Unknown sound' });
  }

  const vendoIp = db.prepare("SELECT value FROM settings WHERE key = 'vendo_ip'").get()?.value;
  if (!vendoIp) {
    return res.status(400).json({ success: false, message: 'No vendo configured' });
  }

  // Same host the requesting browser used to reach this server - the
  // vendo is on the same LAN and reaches this server the same way a
  // customer's phone does, so this is a reasonable, no-extra-config way
  // to build a URL the device can actually fetch back.
  const audioUrl = `${req.protocol}://${req.get('host')}/audio/vendo/${filename}`;

  try {
    const playRes = await fetch(`http://${vendoIp}/play?url=${encodeURIComponent(audioUrl)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000)
    });
    if (!playRes.ok) {
      return res.status(502).json({ success: false, message: 'Vendo play request failed' });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('[Vendo] play-sound failed:', e.message);
    return res.status(502).json({ success: false, message: 'Vendo unreachable' });
  }
});

module.exports = router;
