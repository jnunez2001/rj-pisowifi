const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { getRates } = require('../services/voucherService');
const { execSync } = require('child_process');
const mikrotikService = require('../services/mikrotikService');
const { parseSqliteDate } = require('../utils/sqliteDate');

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
          // Free capture: this device's own DHCP hostname (e.g.
          // "Joshs-iPhone") is sitting right here every time a portal
          // MAC-detect happens - persist it so Top Spenders/Live
          // Sessions/Users can show a real name instead of a bare MAC.
          // See networkDevicesService.recordObservedHostname().
          if (parts[3] && parts[3] !== '*') {
            require('../services/networkDevicesService').recordObservedHostname(mac, parts[3]);
          }
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
      allow_premium_to_regular_convert: getSetting('allow_premium_to_regular_convert', '0'),
      movies_open_in_chrome: getSetting('movies_open_in_chrome', '0'),
      promo_banner_images: db.prepare('SELECT image_path FROM promo_banner_images ORDER BY sort_order ASC').all().map((r) => r.image_path)
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

    // Bug this fixes: the ESP32's own response body was discarded
    // entirely, so a coin-health-check failure (firmware's activateRelay()
    // refusing to open the gate after repeated credit failures, see
    // coin.cpp/relay.cpp) looked identical to any other unreachable-device
    // error to the portal - no way to show the customer a distinct "report
    // issue" affordance instead of a generic "vendo offline" toast.
    if (relayRes.status === 503) {
      const data = await relayRes.json().catch(() => ({}));
      return res.status(503).json({
        success: false,
        message: data.message || 'Coin health check failed',
        coin_health: false,
      });
    }

    if (!relayRes.ok) {
      return res.status(502).json({ success: false, message: 'ESP32 relay request failed' });
    }

    return res.json({ success: true });
  } catch (e) {
    console.error(`[Vendo] Relay ${action} failed:`, e.message);
    return res.status(502).json({ success: false, message: 'ESP32 unreachable' });
  }
});

// POST /report-issue - a deliberately distinct, one-click "something's
// wrong with the coin machine" signal from the text-based "Report a
// Problem" chat form above. No typing needed: the portal shows this when
// /relay/on comes back with coin_health:false (the coin acceptor has
// already refused several credits in a row, see the firmware's own
// activateRelay() guard). Proxies to the vendo's own /report-issue route
// (esp32/esp8266 firmware), which attempts a safe self-heal restart when
// idle - always logs the report itself first, even if the vendo can't be
// reached, since the report is useful operator signal on its own.
const reportIssueRateLimit = new Map();
const REPORT_ISSUE_RATE_LIMIT_MS = 30000; // longer cooldown than the chat report - this triggers an actual device restart attempt, not just a message

router.post('/report-issue', async (req, res) => {
  const ip = getRealClientIp(req);
  const last = reportIssueRateLimit.get(ip);
  if (last && Date.now() - last < REPORT_ISSUE_RATE_LIMIT_MS) {
    return res.status(429).json({ success: false, message: 'Please wait a moment before trying again.' });
  }
  reportIssueRateLimit.set(ip, Date.now());

  const mac = req.body?.mac ? String(req.body.mac).trim().toLowerCase() : null;
  try {
    require('../services/alertEventService').logAlertEvent(
      'warning',
      'customer_reported_coin_issue',
      'Customer reported the coin machine isn\'t working',
      mac ? `Reported from device ${mac}. A self-heal restart was attempted.` : 'A self-heal restart was attempted.'
    );
  } catch (e) {}

  const vendoIp = db.prepare("SELECT value FROM settings WHERE key = 'vendo_ip'").get()?.value;
  if (!vendoIp) {
    // Report is still logged above even with no vendo configured (e.g.
    // direct-GPIO/Main Kiosk mode) - an operator should still see it.
    return res.json({ success: true, message: 'Thanks, your report has been sent.' });
  }

  try {
    const issueRes = await fetch(`http://${vendoIp}/report-issue`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    const data = await issueRes.json().catch(() => ({}));
    if (issueRes.status === 409) {
      return res.status(409).json({ success: false, message: data.message || 'The coin machine is busy, please try again in a moment.' });
    }
    if (!issueRes.ok) {
      return res.json({ success: true, message: 'Thanks, your report has been sent (the machine could not be restarted automatically).' });
    }
    return res.json({ success: true, message: 'Thanks - the coin machine is restarting now.' });
  } catch (e) {
    return res.json({ success: true, message: 'Thanks, your report has been sent (the machine could not be restarted automatically).' });
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

// GET /reports?mac=xx - "My Reports": a customer's own submitted reports
// plus a preview of the latest thread message, so the portal can show a
// two-way conversation instead of a fire-and-forget form. Scoped to the
// requesting MAC only (mac_address column, never trusted from anywhere
// else) - no login exists here to check ownership against otherwise.
router.get('/reports', (req, res) => {
  const mac = String(req.query.mac || '').trim().toLowerCase();
  if (!mac || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
    return res.status(400).json({ success: false, message: 'Valid mac required' });
  }
  const reports = db.prepare(
    'SELECT * FROM customer_reports WHERE mac_address = ? ORDER BY created_at DESC'
  ).all(mac);
  return res.json({ success: true, reports });
});

// GET /reports/:id/messages?mac=xx - the thread for one of THIS mac's own
// reports. mac is required and cross-checked against the report's owner
// so one customer can never read another's thread.
router.get('/reports/:id/messages', (req, res) => {
  const mac = String(req.query.mac || '').trim().toLowerCase();
  const report = db.prepare('SELECT mac_address FROM customer_reports WHERE id = ?').get(req.params.id);
  if (!report || report.mac_address !== mac) {
    return res.status(403).json({ success: false, message: 'Not found' });
  }
  const messages = db.prepare(
    'SELECT sender, message, created_at FROM report_messages WHERE report_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);
  return res.json({ success: true, messages });
});

// POST /reports/:id/reply - a customer follow-up message on their own
// existing report thread (two-way, not just the initial report). Same
// mac ownership check as the messages route above; same blocked-MAC
// check as the original POST /report so a blocked prankster can't just
// use reply as a side door back into the thread.
router.post('/reports/:id/reply', (req, res) => {
  const mac = String(req.body?.mac || '').trim().toLowerCase();
  const message = String(req.body?.message || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ success: false, message: 'Message required' });

  const report = db.prepare('SELECT mac_address FROM customer_reports WHERE id = ?').get(req.params.id);
  if (!report || report.mac_address !== mac) {
    return res.status(403).json({ success: false, message: 'Not found' });
  }
  const blocked = db.prepare('SELECT 1 FROM report_blocked_macs WHERE mac_address = ?').get(mac);
  if (blocked) return res.json({ success: true });

  db.prepare(
    "INSERT INTO report_messages (report_id, sender, message) VALUES (?, 'customer', ?)"
  ).run(req.params.id, message);
  return res.json({ success: true });
});

// ── Local Movie Server (server/services/movieService.js) ───────────────
const movieService = require('../services/movieService');

function hasActiveSession(mac) {
  const session = db.prepare(
    "SELECT * FROM sessions WHERE mac_address = ? ORDER BY id DESC LIMIT 1"
  ).get(mac);
  return !!(session && session.minutes_remaining > 0 && parseSqliteDate(session.hard_expires_at) > new Date());
}

function hasActiveRental(movieId, mac) {
  return !!db.prepare(`
    SELECT 1 FROM movie_rentals WHERE movie_id = ? AND mac_address = ? AND expires_at > datetime('now')
  `).get(movieId, mac);
}

// GET /movies?mac=xx - the Netflix-style browse grid. Free movies show
// unlocked whenever the device has an active WiFi session (same gate as
// internet); premium movies ALWAYS need their own paid rental
// (movie_rentals), regardless of how much WiFi time the device has.
router.get('/movies', (req, res) => {
  const mac = String(req.query.mac || '').trim().toLowerCase();
  const sessionActive = mac ? hasActiveSession(mac) : false;
  const movies = movieService.getMovies().map((m) => {
    const unlocked = m.tier === 'free' ? sessionActive : (mac ? hasActiveRental(m.id, mac) : false);
    return {
      id: m.id, title: m.title, tier: m.tier, price_pesos: m.price_pesos,
      duration_seconds: m.duration_seconds, thumbnail_path: m.thumbnail_path,
      status: m.status, unlocked
    };
  });
  res.json({ success: true, movies, session_active: sessionActive });
});

// GET /movies/:id/play?mac=xx - gate check, then either return the HLS
// URL (already transcoded) or kick off transcoding and tell the client
// to keep polling this same route until status flips to 'ready'.
router.get('/movies/:id/play', (req, res) => {
  const mac = String(req.query.mac || '').trim().toLowerCase();
  const movie = movieService.getMovie(req.params.id);
  if (!movie) return res.status(404).json({ success: false, message: 'Movie not found' });

  const unlocked = movie.tier === 'free' ? hasActiveSession(mac) : hasActiveRental(movie.id, mac);
  if (!unlocked) {
    return res.status(403).json({ success: false, message: 'Not unlocked for this device' });
  }

  if (movie.status !== 'ready') {
    movieService.ensureTranscoded(movie.id);
    return res.json({ success: true, status: movie.status === 'failed' ? 'transcoding' : movie.status });
  }
  return res.json({ success: true, status: 'ready', hls_url: `/movies_cache/${movie.id}/master.m3u8` });
});

// ── Online Movies (vidrock.ru embed catalog) ────────────────────────────
// Fully separate from the local movie routes above: separate catalog
// (server/services/onlineMovieCatalog.js), separate ledger
// (online_movie_rentals), separate coin mode ('online_movie' in
// server/routes/coin.js). Free tier reuses the exact same hasActiveSession
// gate as a local free movie; paid tiers need their own online_movie_rentals
// row, same "separate real coin payment" rule as a local premium rental.
const onlineMovieCatalog = require('../services/onlineMovieCatalog');

function hasActiveOnlineRental(movieId, mac) {
  return !!db.prepare(`
    SELECT 1 FROM online_movie_rentals WHERE movie_id = ? AND mac_address = ? AND expires_at > datetime('now')
  `).get(movieId, mac);
}

// GET /online-movies?mac=xx - catalog with per-device unlock state, same
// shape/spirit as GET /movies above.
//
// Free titles are always open, no session check at all - the real access
// control for a device with no paid WiFi time at all is the network-level
// firewall (nftables' allowed_macs set), which already blocks it from
// reaching any streaming source in the first place; an app-level WiFi-
// session gate on top of that was a real source of live "movies won't
// open" bugs (Countdown Speed compressing a session's real duration to
// near-zero). Paid titles (set by an admin in Movies > Online) are gated
// on their own dedicated online_movie_rentals row instead - a simple,
// self-contained expiry check with no dependency on WiFi session state.
router.get('/online-movies', (req, res) => {
  const mac = String(req.query.mac || '').trim().toLowerCase();
  const tmdbService = require('../services/tmdbService');
  const viewRows = db.prepare('SELECT movie_id, views FROM online_movie_views').all();
  const viewsById = new Map(viewRows.map((r) => [r.movie_id, r.views]));
  const movies = onlineMovieCatalog.getAll().map((m) => {
    const unlocked = m.tier === 'free' ? true : (mac ? hasActiveOnlineRental(m.id, mac) : false);
    // Synchronous cache read, no network call in this request's path - see
    // tmdbService.js's warmCache() (kicked off in the background by
    // server/app.js at startup) for what actually populates this.
    return {
      id: m.id, title: m.title, tier: m.tier, price_pesos: m.price_pesos, release_date: m.release_date || null,
      poster: tmdbService.getCachedPosterUrl(m.id), genres: tmdbService.getCachedGenres(m.id), unlocked,
      views: viewsById.get(m.id) || 0, priority: m.priority || 0,
    };
  });
  res.json({ success: true, movies, session_active: true });
});

// Shared by GET /online-movies/top10 and GET /tv-shows/top10 - the "front
// row" ranking is admin-controlled per media type (settings key
// movie_top10_mode / series_top10_mode), one of:
//   'most_viewed'   - real play counts on this box (online_movie_views /
//                      tv_series_views), highest first
//   'tmdb_trending'  - TMDb's own live trending order (getTrendingIds()),
//                      filtered down to titles actually in this catalog
//   'custom'         - an admin-curated, manually-ordered pick list
//                      (custom_top_picks), ignoring views/TMDb entirely
// `items` is the full mapped catalog (each entry already has .id/.views),
// `trendingIds` is already resolved (the caller awaits it, since only the
// tmdb_trending branch needs a network call) so this helper itself stays
// synchronous and reusable for both media types.
function computeTop10(mode, items, trendingIds, mediaType) {
  const byId = new Map(items.map((it) => [it.id, it]));
  if (mode === 'custom') {
    const picks = db.prepare('SELECT tmdb_id FROM custom_top_picks WHERE media_type = ? ORDER BY sort_order, id').all(mediaType);
    return picks.map((p) => byId.get(p.tmdb_id)).filter(Boolean).slice(0, 10);
  }
  if (mode === 'tmdb_trending') {
    const ranked = trendingIds.map((id) => byId.get(id)).filter(Boolean);
    if (ranked.length > 0) return ranked.slice(0, 10);
    // Fall through to most_viewed if trending gave us nothing usable yet
    // (no TMDb key set, first run before the cache warms, network hiccup)
    // rather than showing an empty front row.
  }
  return [...items].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 10);
}

// GET /online-movies/top10 - the numbered "Top 10 Movies" row on the
// customer home screen. Separate endpoint (not folded into GET
// /online-movies above) because tmdb_trending mode needs an occasional
// live TMDb call (see computeTop10/getTrendingIds' hourly cache) and the
// main catalog route above is deliberately kept fully synchronous.
router.get('/online-movies/top10', async (req, res) => {
  const mac = String(req.query.mac || '').trim().toLowerCase();
  const tmdbService = require('../services/tmdbService');
  const viewRows = db.prepare('SELECT movie_id, views FROM online_movie_views').all();
  const viewsById = new Map(viewRows.map((r) => [r.movie_id, r.views]));
  const items = onlineMovieCatalog.getAll().map((m) => ({
    id: m.id, title: m.title, tier: m.tier, price_pesos: m.price_pesos, release_date: m.release_date || null,
    poster: tmdbService.getCachedPosterUrl(m.id), genres: tmdbService.getCachedGenres(m.id),
    unlocked: m.tier === 'free' ? true : (mac ? hasActiveOnlineRental(m.id, mac) : false),
    views: viewsById.get(m.id) || 0, priority: m.priority || 0,
  }));
  const mode = db.prepare("SELECT value FROM settings WHERE key = 'movie_top10_mode'").get()?.value || 'most_viewed';
  const trendingIds = mode === 'tmdb_trending' ? await tmdbService.getTrendingIds() : [];
  const top10 = computeTop10(mode, items, trendingIds, 'movie');
  res.json({ success: true, mode, top10 });
});

// GET /online-movies/sources - the server-switcher tabs in the player
// overlay (public/portal/assets/js/movies-online.js). Just names + ids,
// never the actual URL template (no reason for that to reach the client
// until a specific movie's embed is requested).
router.get('/online-movies/sources', (req, res) => {
  const sources = db.prepare(`
    SELECT id, name, is_default FROM streaming_sources
    WHERE movie_url_template IS NOT NULL AND movie_url_template != ''
    ORDER BY sort_order, id
  `).all();
  res.json({ success: true, sources });
});

// POST /online-movies/search-hit {query, movie_id} - logs a search only
// when it led somewhere real (the client only calls this the moment a
// customer opens a movie while the search box has text in it - see
// movies-online.js), not on every keystroke. Powers the admin's Top
// Searches panel (real demand signal) without drowning it in abandoned/
// typo searches. Fire-and-forget from the client, so this fails soft and
// never blocks or affects opening the movie itself.
router.post('/online-movies/search-hit', (req, res) => {
  const query = String(req.body?.query || '').trim().slice(0, 200);
  const movieId = parseInt(req.body?.movie_id, 10);
  if (!query || !movieId) return res.status(400).json({ success: false });
  db.prepare('INSERT INTO online_movie_searches (query, movie_id) VALUES (?, ?)').run(query, movieId);
  res.json({ success: true });
});

// POST /movie-requests {mac, requester_name, title, year} - the Movies
// tab's "Request a Movie" form. A device can submit many requests over
// time, just not more than one in a rolling 24h - checked here rather than
// by calendar day so it can't be gamed by submitting at 11:59pm and again
// at 12:01am. Reviewed in the admin panel's Movies > Online > Movie
// Requests panel (server/routes/admin.js).
router.post('/movie-requests', (req, res) => {
  const mac = String(req.body?.mac || '').trim().toLowerCase();
  const requesterName = String(req.body?.requester_name || '').trim().slice(0, 60);
  const title = String(req.body?.title || '').trim().slice(0, 150);
  const year = String(req.body?.year || '').trim().slice(0, 10);
  if (!mac || !requesterName || !title) {
    return res.status(400).json({ success: false, message: 'Your name and the movie title are required.' });
  }
  const recent = db.prepare(`SELECT 1 FROM movie_requests WHERE mac_address = ? AND created_at > datetime('now', '-1 day')`).get(mac);
  if (recent) {
    return res.status(429).json({ success: false, message: 'You can only request one movie per day - try again tomorrow.' });
  }
  db.prepare('INSERT INTO movie_requests (mac_address, requester_name, title, year) VALUES (?, ?, ?, ?)').run(mac, requesterName, title, year);
  res.json({ success: true });
});

// GET /online-movies/:id/embed?mac=xx - hands back an embed URL built from
// settings.movie_embed_url_template, a provider-agnostic template
// containing a literal "{tmdb_id}" placeholder (e.g.
// "https://someprovider.com/embed/movie/{tmdb_id}"), from
// movie_streaming_sources (admin panel's Movies > Online > Streaming
// Sources - can be more than one, named "Server 1"/"Server 2"/etc., a
// customer can switch between them from the player overlay). Optional
// ?source_id= picks a specific one; with none given, the admin's chosen
// default is used, or the first configured source if none is marked
// default. No sources configured at all = movies stay disabled. Gate
// check: free is always open, paid needs a live online_movie_rentals row
// for this device (see the comment on GET /online-movies above for why
// this doesn't touch WiFi session state at all).
router.get('/online-movies/:id/embed', (req, res) => {
  const mac = String(req.query.mac || '').trim().toLowerCase();
  const movie = onlineMovieCatalog.getById(req.params.id);
  if (!movie) return res.status(404).json({ success: false, message: 'Movie not found' });

  if (movie.tier !== 'free' && !hasActiveOnlineRental(movie.id, mac)) {
    return res.status(403).json({ success: false, message: 'Not unlocked for this device' });
  }

  const sourceId = parseInt(req.query.source_id, 10);
  const source = sourceId
    ? db.prepare(`SELECT * FROM streaming_sources WHERE id = ? AND movie_url_template IS NOT NULL AND movie_url_template != ''`).get(sourceId)
    : db.prepare(`
        SELECT * FROM streaming_sources
        WHERE movie_url_template IS NOT NULL AND movie_url_template != ''
        ORDER BY is_default DESC, sort_order, id LIMIT 1
      `).get();
  if (!source) {
    return res.status(503).json({ success: false, message: 'No movie source configured yet - set one in Settings > Movies.' });
  }

  // Real play count, feeds the client's "Top 10 Most Watched" row - counted
  // here (not on page view) so browsing the grid doesn't inflate it, only
  // an actual, unlocked play does. Counted once per movie regardless of
  // which server the customer picks, not once per source.
  db.prepare(`
    INSERT INTO online_movie_views (movie_id, views) VALUES (?, 1)
    ON CONFLICT(movie_id) DO UPDATE SET views = views + 1
  `).run(movie.id);

  return res.json({ success: true, source_id: source.id, embed_url: source.movie_url_template.replace('{tmdb_id}', movie.id) });
});

// POST /online-movies/:id/unlock-with-credit {mac} - the no-coins-needed
// path for when a device's existing Movie Credit balance already covers
// the whole price (owner request: credit should be usable for movies, not
// just WiFi time). Skips the coin-slot/relay hardware flow entirely rather
// than routing a ₱0 "insertion" through it - this is a straight balance
// deduction, re-validated server-side against the CURRENT balance (never
// trusted from the client) so it can't be spoofed or double-spent.
router.post('/online-movies/:id/unlock-with-credit', (req, res) => {
  const mac = String(req.body?.mac || '').trim().toLowerCase();
  if (!mac) return res.status(400).json({ success: false, message: 'Valid MAC address required' });
  const movie = onlineMovieCatalog.getById(req.params.id);
  if (!movie) return res.status(404).json({ success: false, message: 'Movie not found' });
  if (movie.tier === 'free') return res.status(400).json({ success: false, message: 'This movie is already free.' });

  const creditRow = db.prepare('SELECT balance_pesos FROM movie_credits WHERE mac_address = ?').get(mac);
  const balance = creditRow?.balance_pesos || 0;
  if (balance < movie.price_pesos) {
    return res.status(400).json({ success: false, message: `Your ₱${balance} credit isn't enough - this movie is ₱${movie.price_pesos}.` });
  }

  db.prepare('UPDATE movie_credits SET balance_pesos = balance_pesos - ?, updated_at = CURRENT_TIMESTAMP WHERE mac_address = ?').run(movie.price_pesos, mac);

  const rentalHours = movie.rental_hours > 0
    ? movie.rental_hours
    : parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'movie_rental_hours'").get()?.value || '48');
  const expiresAt = new Date(Date.now() + rentalHours * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO online_movie_rentals (movie_id, mac_address, expires_at) VALUES (?, ?, ?)').run(movie.id, mac, expiresAt);
  db.prepare(`
    INSERT INTO transactions (voucher_code, coin_value, minutes_added, type, mac_address)
    VALUES (?, ?, 0, 'online_movie_rental_credit', ?)
  `).run(`ONLINE-MOVIE-${movie.id}`, movie.price_pesos, mac);
  console.log(`✅ Online movie rental unlocked for ${mac} using ₱${movie.price_pesos} credit: "${movie.title}"`);

  res.json({ success: true, expires_at: expiresAt });
});

// ── TV Shows (series/anime/K-drama, seasons & episodes) ─────────────────
// Parallel to Online Movies above but against tvCatalogService/
// tv_series_* tables - see database.js's header comment on those tables
// for why this isn't just "movies with an extra field". Whole-SERIES
// pricing: one tv_series_rentals row unlocks every season/episode for the
// rental window, not per-episode. Shares movie_credits with Online Movies
// on purpose (one balance, spendable on either) rather than a second,
// parallel credit pool that would just fragment the same money.
const tvCatalogService = require('../services/tvCatalogService');
const tmdbTvService = require('../services/tmdbTvService');

function hasActiveTvRental(seriesId, mac) {
  return !!db.prepare(`
    SELECT 1 FROM tv_series_rentals WHERE series_id = ? AND mac_address = ? AND expires_at > datetime('now')
  `).get(seriesId, mac);
}

// GET /tv-shows?mac=xx - same shape/spirit as GET /online-movies. Also
// returns origin_country (alongside genres) so the client can build the
// Anime/K-Drama auto-rows (Animation genre + Japan origin / Korea origin)
// without a second round trip.
router.get('/tv-shows', (req, res) => {
  const mac = String(req.query.mac || '').trim().toLowerCase();
  const viewRows = db.prepare('SELECT series_id, views FROM tv_series_views').all();
  const viewsById = new Map(viewRows.map((r) => [r.series_id, r.views]));
  const series = tvCatalogService.getAll().map((s) => {
    const unlocked = s.tier === 'free' ? true : (mac ? hasActiveTvRental(s.id, mac) : false);
    return {
      id: s.id, title: s.title, tier: s.tier, price_pesos: s.price_pesos, first_air_date: s.first_air_date || null,
      poster: tmdbTvService.getCachedPosterUrl(s.id), genres: tmdbTvService.getCachedGenres(s.id),
      origin_country: tmdbTvService.getCachedOriginCountry(s.id), unlocked,
      views: viewsById.get(s.id) || 0, priority: s.priority || 0,
    };
  });
  res.json({ success: true, series });
});

// GET /tv-shows/top10 - mirrors GET /online-movies/top10 above for the
// "Top 10 Series" row.
router.get('/tv-shows/top10', async (req, res) => {
  const mac = String(req.query.mac || '').trim().toLowerCase();
  const viewRows = db.prepare('SELECT series_id, views FROM tv_series_views').all();
  const viewsById = new Map(viewRows.map((r) => [r.series_id, r.views]));
  const items = tvCatalogService.getAll().map((s) => ({
    id: s.id, title: s.title, tier: s.tier, price_pesos: s.price_pesos, first_air_date: s.first_air_date || null,
    poster: tmdbTvService.getCachedPosterUrl(s.id), genres: tmdbTvService.getCachedGenres(s.id),
    origin_country: tmdbTvService.getCachedOriginCountry(s.id),
    unlocked: s.tier === 'free' ? true : (mac ? hasActiveTvRental(s.id, mac) : false),
    views: viewsById.get(s.id) || 0, priority: s.priority || 0,
  }));
  const mode = db.prepare("SELECT value FROM settings WHERE key = 'series_top10_mode'").get()?.value || 'most_viewed';
  const trendingIds = mode === 'tmdb_trending' ? await tmdbTvService.getTrendingIds() : [];
  const top10 = computeTop10(mode, items, trendingIds, 'tv');
  res.json({ success: true, mode, top10 });
});

router.get('/tv-shows/sources', (req, res) => {
  const sources = db.prepare(`
    SELECT id, name, is_default FROM streaming_sources
    WHERE tv_url_template IS NOT NULL AND tv_url_template != ''
    ORDER BY sort_order, id
  `).all();
  res.json({ success: true, sources });
});

// GET /tv-shows/:id/seasons - live TMDb lookup (not pre-synced into the
// feed table, unlike the catalog list itself) since this is only ever
// called when a customer actually opens one series' detail view, not on
// every catalog page load - request volume stays comparable to opening a
// movie's embed, not a per-row cost on the browse grid.
router.get('/tv-shows/:id/seasons', async (req, res) => {
  try {
    const series = await tmdbTvService.getSeriesById(req.params.id);
    res.json({ success: true, seasons: series.seasons, overview: series.overview });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Could not load seasons.' });
  }
});

router.get('/tv-shows/:id/season/:num/episodes', async (req, res) => {
  try {
    const episodes = await tmdbTvService.getEpisodes(req.params.id, parseInt(req.params.num, 10));
    res.json({ success: true, episodes });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Could not load episodes.' });
  }
});

router.post('/tv-shows/search-hit', (req, res) => {
  const query = String(req.body?.query || '').trim().slice(0, 200);
  const seriesId = parseInt(req.body?.series_id, 10);
  if (!query || !seriesId) return res.status(400).json({ success: false });
  db.prepare("INSERT INTO online_movie_searches (query, movie_id, media_type) VALUES (?, ?, 'tv')").run(query, seriesId);
  res.json({ success: true });
});

// GET /tv-shows/:id/embed?season=&episode=&mac=&source_id= - same gate/
// source-resolution logic as GET /online-movies/:id/embed, plus the
// season/episode numbers a movie embed has no concept of. Views are
// counted per-series (not per-episode) - see tv_series_views' comment.
router.get('/tv-shows/:id/embed', (req, res) => {
  const mac = String(req.query.mac || '').trim().toLowerCase();
  const season = parseInt(req.query.season, 10);
  const episode = parseInt(req.query.episode, 10);
  if (!season || !episode) return res.status(400).json({ success: false, message: 'A season and episode are required.' });

  const series = tvCatalogService.getById(req.params.id);
  if (!series) return res.status(404).json({ success: false, message: 'Series not found' });

  if (series.tier !== 'free' && !hasActiveTvRental(series.id, mac)) {
    return res.status(403).json({ success: false, message: 'Not unlocked for this device' });
  }

  const sourceId = parseInt(req.query.source_id, 10);
  const source = sourceId
    ? db.prepare(`SELECT * FROM streaming_sources WHERE id = ? AND tv_url_template IS NOT NULL AND tv_url_template != ''`).get(sourceId)
    : db.prepare(`
        SELECT * FROM streaming_sources
        WHERE tv_url_template IS NOT NULL AND tv_url_template != ''
        ORDER BY is_default DESC, sort_order, id LIMIT 1
      `).get();
  if (!source) {
    return res.status(503).json({ success: false, message: 'No TV source configured yet - set one in Movies > Streaming Sources.' });
  }

  db.prepare(`
    INSERT INTO tv_series_views (series_id, views) VALUES (?, 1)
    ON CONFLICT(series_id) DO UPDATE SET views = views + 1
  `).run(series.id);

  // Providers disagree on placeholder naming ({season} vs {season_number},
  // {episode} vs {episode_number} - e.g. vidsrc.sbs uses the _number form)
  // so replace whichever alias is actually present rather than requiring
  // one exact spelling.
  const embedUrl = source.tv_url_template
    .replace(/\{tmdb_id\}/g, series.id)
    .replace(/\{season(_number)?\}/g, season)
    .replace(/\{episode(_number)?\}/g, episode);
  return res.json({ success: true, source_id: source.id, embed_url: embedUrl });
});

// POST /tv-shows/:id/unlock-with-credit {mac} - same no-coins-needed
// credit path as movies' equivalent route, unlocking the whole series.
router.post('/tv-shows/:id/unlock-with-credit', (req, res) => {
  const mac = String(req.body?.mac || '').trim().toLowerCase();
  if (!mac) return res.status(400).json({ success: false, message: 'Valid MAC address required' });
  const series = tvCatalogService.getById(req.params.id);
  if (!series) return res.status(404).json({ success: false, message: 'Series not found' });
  if (series.tier === 'free') return res.status(400).json({ success: false, message: 'This series is already free.' });

  const creditRow = db.prepare('SELECT balance_pesos FROM movie_credits WHERE mac_address = ?').get(mac);
  const balance = creditRow?.balance_pesos || 0;
  if (balance < series.price_pesos) {
    return res.status(400).json({ success: false, message: `Your ₱${balance} credit isn't enough - this series is ₱${series.price_pesos}.` });
  }

  db.prepare('UPDATE movie_credits SET balance_pesos = balance_pesos - ?, updated_at = CURRENT_TIMESTAMP WHERE mac_address = ?').run(series.price_pesos, mac);

  const rentalHours = series.rental_hours > 0
    ? series.rental_hours
    : parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'movie_rental_hours'").get()?.value || '48');
  const expiresAt = new Date(Date.now() + rentalHours * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO tv_series_rentals (series_id, mac_address, expires_at) VALUES (?, ?, ?)').run(series.id, mac, expiresAt);
  db.prepare(`
    INSERT INTO transactions (voucher_code, coin_value, minutes_added, type, mac_address)
    VALUES (?, ?, 0, 'tv_series_rental_credit', ?)
  `).run(`TV-SERIES-${series.id}`, series.price_pesos, mac);
  console.log(`✅ TV series unlocked for ${mac} using ₱${series.price_pesos} credit: "${series.title}"`);

  res.json({ success: true, expires_at: expiresAt });
});

// POST /tv-requests {mac, requester_name, title, year} - same form/rate
// limit as POST /movie-requests, reusing movie_requests with media_type
// 'tv' instead of a second table (see database.js's column comment). The
// once-per-day limit is shared across both - one request a day total,
// whether it's for a movie or a series.
router.post('/tv-requests', (req, res) => {
  const mac = String(req.body?.mac || '').trim().toLowerCase();
  const requesterName = String(req.body?.requester_name || '').trim().slice(0, 60);
  const title = String(req.body?.title || '').trim().slice(0, 150);
  const year = String(req.body?.year || '').trim().slice(0, 10);
  if (!mac || !requesterName || !title) {
    return res.status(400).json({ success: false, message: 'Your name and the series title are required.' });
  }
  const recent = db.prepare(`SELECT 1 FROM movie_requests WHERE mac_address = ? AND created_at > datetime('now', '-1 day')`).get(mac);
  if (recent) {
    return res.status(429).json({ success: false, message: 'You can only request one title per day - try again tomorrow.' });
  }
  db.prepare("INSERT INTO movie_requests (mac_address, requester_name, title, year, media_type) VALUES (?, ?, ?, ?, 'tv')").run(mac, requesterName, title, year);
  res.json({ success: true });
});

// ── Movie Credit balance (database.js's movie_credits table) ───────────
// Fed by server/routes/coin.js's 'online_movie' finalize branch whenever a
// coin window over/undershoots a movie's price - see that file's
// addMovieCredit(). This is where the customer actually gets it back.

// GET /credit/:mac - the portal polls/reads this to show "You have ₱X
// credit" if there's anything to show.
router.get('/credit/:mac', (req, res) => {
  const mac = String(req.params.mac || '').trim().toLowerCase();
  const row = db.prepare('SELECT balance_pesos FROM movie_credits WHERE mac_address = ?').get(mac);
  res.json({ success: true, balance_pesos: row?.balance_pesos || 0 });
});

// POST /credit/use { mac } - spends the ENTIRE current balance as regular
// WiFi coin credit, through the exact same rate-matching creditCoinValue()
// already uses for a normal coin insert. If the balance doesn't match any
// configured rate yet (e.g. still just ₱2 and the cheapest rate is ₱5), it's
// left alone rather than lost - same "can't make change" reality as the
// rest of this coin system, just never destructive.
router.post('/credit/use', async (req, res) => {
  const mac = String(req.body.mac || '').trim().toLowerCase();
  if (!mac) return res.status(400).json({ success: false, message: 'Valid MAC address required' });

  const row = db.prepare('SELECT balance_pesos FROM movie_credits WHERE mac_address = ?').get(mac);
  const balance = row?.balance_pesos || 0;
  if (balance <= 0) {
    return res.json({ success: false, message: 'No credit to use yet.' });
  }

  const { creditCoinValue, NoMatchingRateError } = require('../services/coinCreditService');
  try {
    const ip = (await require('../services/networkService').getIpFromMac(mac)) || '';
    const result = await creditCoinValue(mac, balance, ip, null, false);
    db.prepare('UPDATE movie_credits SET balance_pesos = 0, updated_at = CURRENT_TIMESTAMP WHERE mac_address = ?').run(mac);
    console.log(`✅ Movie credit spent for ${mac}: ₱${balance} -> ${result.minutes_added} WiFi minutes`);
    return res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof NoMatchingRateError) {
      return res.json({ success: false, message: `Your ₱${balance} credit doesn't match a WiFi rate yet - it's saved, keep adding to it.` });
    }
    console.error('Credit use error:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong, please try again.' });
  }
});

// Premium movie unlocking is now a real, separate coin payment (see
// server/routes/coin.js's 'movie' pendingMode branch in
// finalizePendingCoins()) - deliberately NOT deducted from WiFi minutes,
// even if the customer has plenty of time left. The old version of this
// route did that minutes-deduction; removed in favor of the real coin
// flow, which the movies portal page now drives via POST /api/coin/pending
// (mode: 'movie', movie_id), POST /api/portal/relay/on to arm the coin
// slot, and polling GET /api/coin/pending/:mac the same way the WiFi
// Insert Coin modal already does.

module.exports = router;
