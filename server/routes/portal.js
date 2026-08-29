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

// Named sounds only, never an arbitrary client-supplied name - the vendo
// builds a fetch URL straight from whatever this sends it
// (esp8266/firmware's /play route), so accepting anything from the
// portal (unauthenticated, customer-facing) would let anyone make the
// vendo device request whatever path they want. Add new prompts here as
// real audio files land in public/audio/vendo/.
const VENDO_SOUNDS = new Set(['welcome', 'insert-coin', 'connected']);

// POST /play-sound - tells the vendo to stream and play one of the named
// WAV files above, e.g. a voice prompt when the customer taps "Insert
// Coin" on the portal (see portal.js's handleInsertCoin()). Actual
// device call lives in vendoAudioService.js, shared with coin.js's
// amount-announcement trigger (which fires from a background timer, not
// a web request, so it can't reuse this route directly).
router.post('/play-sound', async (req, res) => {
  const { sound } = req.body || {};
  if (!VENDO_SOUNDS.has(sound)) {
    return res.status(400).json({ success: false, message: 'Unknown sound' });
  }
  const { playVendoSound } = require('../services/vendoAudioService');
  const ok = await playVendoSound(sound);
  if (!ok) {
    return res.status(502).json({ success: false, message: 'Vendo unreachable or not configured' });
  }
  return res.json({ success: true });
});

// POST /report - customer-facing "Report a Problem" button. No login
// needed (same unauthenticated-by-design reasoning as every other portal
// route here). Three layers keep this from being a spam/prank vector:
//   1. A short per-IP cooldown (below) stops rapid-fire double-taps.
//   2. A per-MAC daily cap (settings.max_reports_per_mac, operator-
//      adjustable) stops one customer from flooding the Reports page.
//   3. report_blocked_macs - an operator can permanently silence one
//      specific MAC's report channel (POST /admin/reports/block-mac)
//      after seeing it's just pranking, without touching their WiFi
//      access at all.
const REPORT_CATEGORIES = new Set(['slow_internet', 'credit_missed', 'other']);
const reportRateLimit = new Map();
const REPORT_RATE_LIMIT_MS = 15000; // 1 report per 15s per IP

router.post('/report', (req, res) => {
  const ip = getRealClientIp(req);
  const lastRequest = reportRateLimit.get(ip);
  if (lastRequest && Date.now() - lastRequest < REPORT_RATE_LIMIT_MS) {
    return res.status(429).json({ success: false, message: 'Please wait a moment before sending another report.' });
  }

  const { mac, voucher_code, name, category, message } = req.body || {};
  const macClean = mac ? String(mac).trim().toLowerCase() : null;
  const trimmedName = String(name || '').trim().slice(0, 60);
  const trimmedMessage = String(message || '').trim().slice(0, 1000);
  const cat = REPORT_CATEGORIES.has(category) ? category : 'other';

  if (!trimmedName) {
    return res.status(400).json({ success: false, message: 'Please enter your name.' });
  }
  if (!trimmedMessage) {
    return res.status(400).json({ success: false, message: 'Please describe the issue.' });
  }

  if (macClean) {
    const blocked = db.prepare('SELECT 1 FROM report_blocked_macs WHERE mac_address = ?').get(macClean);
    if (blocked) {
      // Deliberately vague, not a hard error - a blocked prankster
      // shouldn't get useful feedback that the button is specifically
      // disabled for them.
      return res.json({ success: true });
    }

    const maxPerDay = parseInt(
      db.prepare("SELECT value FROM settings WHERE key = 'max_reports_per_mac'").get()?.value || '5',
      10
    );
    const countToday = db.prepare(`
      SELECT COUNT(*) AS n FROM customer_reports
      WHERE mac_address = ? AND created_at >= datetime('now', '-1 day')
    `).get(macClean).n;
    if (countToday >= maxPerDay) {
      return res.status(429).json({ success: false, message: 'You have reached the report limit for today.' });
    }
  }

  reportRateLimit.set(ip, Date.now());
  db.prepare(`
    INSERT INTO customer_reports (mac_address, voucher_code, name, category, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(macClean, voucher_code || null, trimmedName, cat, trimmedMessage);

  const { logAlertEvent } = require('../services/alertEventService');
  const categoryLabel = { slow_internet: 'Slow internet', credit_missed: 'Credit issue', other: 'Report' }[cat];
  logAlertEvent('info', 'customer_report', `${categoryLabel} from ${trimmedName}`, trimmedMessage);

  return res.json({ success: true });
});

module.exports = router;
