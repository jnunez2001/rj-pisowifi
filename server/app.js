/*
 * Zenfi WiFi Rental Server
 * Copyright (c) 2026 Joshua Nunez. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 * See LICENSE.
 */
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

require('./config/database');

const coinRoute = require('./routes/coin');
const sessionRoute = require('./routes/session');
const promoRoute = require('./routes/promo');
const adminRoute = require('./routes/admin');
const portalRoute = require('./routes/portal');

const { startTimer } = require('./services/timerService');
const mikrotikService = require('./services/mikrotikService');

// Cache package.json on startup (Bug #47)
const packageJson = require('../package.json');
const APP_VERSION = packageJson.version;

const app = express();
const PORT = 3000;

// CSP was previously disabled outright. A real policy is now enforced,
// but script-src still needs 'unsafe-inline': the admin UI has 50+
// existing onclick="..." handlers across every page's JS, and CSP's
// script-src-attr directive (which could isolate just those handlers
// without allowing inline <script> blocks) isn't supported in Safari -
// unreliable for operators administering from a Mac/iPhone/iPad. Removing
// the inline handlers in favor of addEventListener is real, separate
// follow-up work, not something to half-do here. What this DOES still
// block that `false` did not: any injected <script src="https://attacker...">
// pointing off this small known allowlist, framing this page in another
// site (clickjacking), and form submissions to a foreign origin.
const CSP_SCRIPT_SOURCES = ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'];
const CSP_STYLE_SOURCES = ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'];
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: CSP_SCRIPT_SOURCES,
      scriptSrcElem: CSP_SCRIPT_SOURCES,
      // Helmet defaults script-src-attr/style-src-attr to 'none'
      // independently of script-src/style-src - Chrome and Firefox
      // enforce that strict default even when script-src itself allows
      // 'unsafe-inline' (only Safari falls back to script-src for this).
      // Must be set explicitly or the 50+ onclick="..." handlers break in
      // Chrome/Firefox while silently working in Safari.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: CSP_STYLE_SOURCES,
      styleSrcElem: CSP_STYLE_SOURCES,
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      // Helmet bakes upgrade-insecure-requests into its own CSP defaults
      // and merges it back in even when this key is simply omitted here -
      // it must be explicitly nulled to actually suppress it.
      upgradeInsecureRequests: null,
    },
  },
}));

// upgrade-insecure-requests belongs only on the admin panel, which is
// reached exclusively over HTTPS via nginx's WAN front door (setup/nginx.conf).
// Setting it globally broke the portal: portal.html loads over plain HTTP for
// LAN captive-portal clients (no TLS listener on this port), so the directive
// was forcing every CSS/JS/media request on that page to upgrade to
// https://<box-ip>:3000/..., which nothing answers - the page itself would
// load (fetched before any CSP applied) but every asset silently failed,
// exactly the "raw unstyled HTML, buttons don't work" symptom reported live.
app.use(['/admin', '/api/admin'], (req, res, next) => {
  const csp = res.getHeader('Content-Security-Policy');
  if (csp) res.setHeader('Content-Security-Policy', `${csp}; upgrade-insecure-requests`);
  next();
});

// cors() with no options reflects and allows ANY origin. Nothing in this
// app actually needs cross-origin browser access - the admin/portal HTML
// and JS are served by this same Express server, so legitimate requests
// are always same-origin (no CORS headers required at all for those).
// The only thing wide-open CORS was doing was letting a page on any OTHER
// site make credentialed requests against this API from a victim's
// browser. STARKFI_ALLOWED_ORIGINS is available as an escape hatch for a
// genuine future cross-origin integration (e.g. zentry-hub calling a
// box's API directly), comma-separated, empty/unset by default.
const allowedOrigins = (process.env.STARKFI_ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : false,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust only the loopback interface as a proxy source - nginx (WAN admin
// front door, see setup/nginx.conf) always connects from 127.0.0.1 and
// correctly sets X-Forwarded-For to the real remote address ($remote_addr,
// not blindly relayed from the client). An external attacker can't spoof a
// loopback TCP source, so this is safe and makes req.ip accurate for both
// WAN-via-nginx admin traffic and direct LAN/portal traffic - required for
// per-client rate limiting below to actually bucket by real client, not by
// nginx's own address for every WAN request.
app.set('trust proxy', 'loopback');

// General flood/DoS safety net across the whole API - separate from
// spamService.js, which targets repeated failed attempts on specific
// sensitive actions (login, coin, voucher redemption) and is unaffected by
// this. This just caps raw request volume per client. Sized generously
// above the portal's own fastest legitimate polling (coin-pending checks
// every 1.5s = ~40/min) so real customers never get caught by it.
const { rateLimit } = require('express-rate-limit');
app.use('/api', rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down.' },
}));

// Bug: /admin (the login page and every admin UI assets) and /api/admin/*
// were reachable by anyone on any lane who guessed the URL - nginx.conf's
// own comment states admin access is meant to go exclusively through its
// WAN-facing TLS front door, but nothing on this side ever actually
// enforced that. A customer on PC-Rental or WiFi-Rental typing this
// server's own LAN IP followed by "/admin" would see the real admin login
// page, with only the password (not network access at all) standing
// between them and it - reduced security-in-depth, and no reason a
// customer should even know an admin panel exists at a guessable URL.
// nginx always proxies to 127.0.0.1:3000 specifically, regardless of who
// the original external client was, so checking the raw socket's own
// remote address (not any client-suppliable header) reliably tells apart
// "arrived via nginx" from "hit this port directly". A few specific paths
// are still LAN-reachable on purpose - the ESP32 vendo hardware calls
// these directly and has no admin password to send.
const ADMIN_LAN_ALLOWED_PATHS = new Set([
  '/api/admin/vendo/register',
  '/api/admin/vendo/firmware/version',
  '/api/admin/vendo/firmware/download',
]);
function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
function restrictAdminToLocalhost(req, res, next) {
  // Bug found on real hardware: this used to check req.path, which Express
  // strips the mount prefix from inside a middleware registered via
  // app.use('/api/admin', ...) - so a request to /api/admin/vendo/register
  // saw req.path as just "/vendo/register", which never matched this set's
  // full-path entries. Every real LAN device (the ESP32 vendo, on every
  // register call and every heartbeat) got silently 404'd here no matter
  // what, while a curl from localhost "worked" only because it short-
  // circuits on isLocalRequest() before this check is ever reached.
  // req.originalUrl always holds the full path regardless of mount depth.
  const path = req.originalUrl.split('?')[0];
  if (isLocalRequest(req) || ADMIN_LAN_ALLOWED_PATHS.has(path)) return next();
  // 404, not 403 - a direct LAN probe shouldn't even get confirmation
  // that an admin panel exists here at all.
  return res.status(404).end();
}
app.use('/admin', restrictAdminToLocalhost);
app.use('/api/admin', restrictAdminToLocalhost);

// Bug found live: the Firmware Flasher page (public/admin/js/firmware-flasher.js)
// fetches manifest.json and the bundled .bin files with plain relative
// fetch() calls, no cache-busting. Express's static middleware sends
// Last-Modified/ETag but no Cache-Control, so with no explicit directive a
// browser is free to apply HTTP heuristic caching and serve a stale
// firmware binary from a previous page load without ever revalidating -
// an operator reflashing after a firmware push could silently re-flash
// the OLD build and see no error, just a version number that never moves.
// Firmware bytes are correctness-critical, never a caching win worth
// taking - force revalidation on every request for this one directory,
// ahead of the general static mount below so it takes precedence.
app.use('/admin/assets/firmware', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, express.static(path.join(__dirname, '../public/admin/assets/firmware')));

app.use(express.static(path.join(__dirname, '../public')));

// ── Caching ──────────────────────────────────────────────────────
const authCache = new Map();
const macCache = new Map();
const CACHE_TTL = 30000; // 30 seconds (re-enabled, was 0)
const MAC_CACHE_TTL = 10000; // 10 seconds for IP→MAC mapping (Bug #45)

// ── Helper: get MAC from IP (cached) ──────────────────────────
// Bug found on real hardware: this used to only ever check this server's
// own local `ip neigh`/dnsmasq.leases, which only has entries for devices
// on the same Layer 2 segment as this server. That covers a lane sharing
// this server's own bridge (e.g. PC-Rental) but not a gated lane on its own
// separate bridge (e.g. WiFi-Rental's VLAN) — a different broadcast domain
// this server has no L2 visibility into, reachable only by routing through
// the MikroTik. In router mode, ask the router itself instead: as the
// actual gateway for every lane, its own DHCP lease table always has the
// true IP-to-MAC mapping.
async function getMacFromIp(ip) {
  // Check MAC cache first (Bug #45)
  const cachedMac = macCache.get(ip);
  if (cachedMac && Date.now() - cachedMac.time < MAC_CACHE_TTL) {
    return cachedMac.mac;
  }

  if (mikrotikService.isMikrotikModeEnabled()) {
    const mac = await mikrotikService.getMacFromIp(ip);
    macCache.set(ip, { mac, time: Date.now() });
    return mac;
  }

  try {
    const arp = execSync(`ip neigh show ${ip} 2>/dev/null`).toString().trim();
    const match = arp.match(/lladdr\s+([0-9a-f:]{17})/i);
    if (match) {
      const mac = match[1].toLowerCase();
      macCache.set(ip, { mac, time: Date.now() });
      return mac;
    }
  } catch(e) {}

  try {
    const leases = fs.readFileSync('/var/lib/misc/dnsmasq.leases', 'utf8');
    const line = leases.split('\n').find(l => l.includes(ip));
    if (line) {
      const mac = line.split(' ')[1].toLowerCase();
      macCache.set(ip, { mac, time: Date.now() });
      return mac;
    }
  } catch(e) {}

  macCache.set(ip, { mac: null, time: Date.now() });
  return null;
}

// ── Helper: check if IP is authenticated (cached) ────────────
// Bug found on real hardware: the nftables set this checked
// (`rj_piso allowed_macs`) is a standalone-mode-only concept — router mode
// never creates it, so this always threw, was swallowed by the catch, and
// silently reported every router-mode client as unauthenticated regardless
// of real status. Router mode tracks authentication via MikroTik's own
// ip-binding/hotspot active list (mikrotikService.allowClient/blockClient),
// not a local nftables set, so it needs its own check here.
async function isAuthenticated(ip) {
  try {
    // Check cache first
    const cached = authCache.get(ip);
    if (cached && Date.now() - cached.time < CACHE_TTL) {
      return cached.result;
    }

    const mac = await getMacFromIp(ip);
    if (!mac) {
      authCache.set(ip, { result: false, time: Date.now() });
      return false;
    }

    let isAuth;
    if (mikrotikService.isMikrotikModeEnabled()) {
      isAuth = await mikrotikService.isClientAllowed(mac);
    } else {
      const result = execSync(
        'sudo nft list set ip rj_piso allowed_macs 2>/dev/null'
      ).toString();
      isAuth = result.includes(mac);
    }

    authCache.set(ip, { result: isAuth, time: Date.now() });
    return isAuth;
  } catch(e) {
    return false;
  }
}

function getClientIp(req) {
  // LAN captive-portal traffic (what this function is for) never passes
  // through nginx — nftables DNATs it straight to this app (setup-network.sh)
  // before any other process on the box sees it. Only WAN admin access goes
  // through nginx now (setup/nginx.conf). So for these LAN-only routes,
  // x-forwarded-for is still a client-suppliable header, not a trustworthy
  // one — any device could spoof it to another device's IP and have this
  // resolve to that device's MAC via getMacFromIp() below. Use the raw
  // socket address, which the client cannot set.
  const raw = req.connection.remoteAddress ||
              req.socket.remoteAddress || '';
  return raw.replace('::ffff:', '').trim();
}

// ── Captive Portal Detection ──────────────────────────────────

app.get('/', (req, res) => {
  res.redirect('/portal/');
});

// Router mode's "Configure" step (mikrotikProvisioner.js) makes the
// MikroTik fetch this page and use it as the Hotspot's own login.html,
// replacing MikroTik's default built-in login screen. Bug this fixes:
// without it, a newly-connected customer would see MikroTik's generic
// login page first, not this app's portal — contradicting the explicit
// design (customers should never see MikroTik's own login screen).
//
// Bug found on real hardware: this used to redirect to a relative
// "/portal/" path, on the assumption the browser always loads this page
// live from this app. That's wrong for how MikroTik's Hotspot actually
// serves it — Configure's /tool fetch step downloads this page ONCE and
// saves it as a static login.html on the router itself. A customer's phone
// then loads that static copy directly from the router's own hotspot
// address (e.g. 10.50.1.1), not from this app, so a relative "/portal/"
// resolved to a page that doesn't exist on the router (endless spinner, no
// error). Baking in an absolute URL fixes it. Building that URL from the
// request's own Host header (rather than a hardcoded IP) keeps it correct
// automatically: the Host header on THIS request — made by the router's
// own /tool fetch — is exactly the address/port that fetch was told to
// use, which is the one address the router already knows how to reach
// this app at.
app.get('/hotspot-login', (req, res) => {
  const portalUrl = `${req.protocol}://${req.get('host')}/portal/`;
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${portalUrl}">
<title>Redirecting...</title>
<script>window.location.href = "${portalUrl}";</script>
</head>
<body>
<p>Redirecting to the portal... <a href="${portalUrl}">Click here if nothing happens</a>.</p>
</body>
</html>`);
});

app.get('/generate_204', async (req, res) => {
  const ip = getClientIp(req);
  if (await isAuthenticated(ip)) return res.status(204).send();
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/gen_204', async (req, res) => {
  const ip = getClientIp(req);
  if (await isAuthenticated(ip)) return res.status(204).send();
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/hotspot-detect.html', async (req, res) => {
  const ip = getClientIp(req);
  if (await isAuthenticated(ip)) {
    return res.send('<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>');
  }
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/library/test/success.html', async (req, res) => {
  const ip = getClientIp(req);
  if (await isAuthenticated(ip)) {
    return res.send('<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>');
  }
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/ncsi.txt', async (req, res) => {
  const ip = getClientIp(req);
  if (await isAuthenticated(ip)) return res.send('Microsoft NCSI');
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/connecttest.txt', async (req, res) => {
  const ip = getClientIp(req);
  if (await isAuthenticated(ip)) return res.send('Microsoft Connect Test');
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/redirect', (req, res) => {
  res.redirect('http://10.0.0.1:3000/portal/');
});

// ── API Routes ────────────────────────────────────────────────
app.use('/api/coin', coinRoute);
app.use('/api/session', sessionRoute);
app.use('/api/promo', promoRoute);
app.use('/api/admin', adminRoute);
app.use('/api/portal', portalRoute);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    name: 'StarkFi Server',
    time: new Date().toISOString()
  });
});

startTimer();

// Bug (same root cause as the nginx IPv6 fix, one level deeper): binding
// explicitly to '0.0.0.0' only accepts IPv4 connections. A browser
// resolving "localhost" to the IPv6 loopback (::1) gets an instant refusal
// instead of reaching the app at all, even though curl (defaulting to
// IPv4) or a direct http://127.0.0.1:PORT request work fine - exactly
// masking this the same way it masked the nginx version of the bug.
// Omitting the host argument lets Node listen on both address families
// (dual-stack '::', which also accepts IPv4 on virtually every real
// deployment target for this project) instead of IPv4 only.
const server = app.listen(PORT, () => {
  console.log('');
  console.log('🚀 StarkFi Server Started!');
  console.log(`📡 Running on port ${PORT}`);
  console.log(`🌐 Admin: http://localhost:${PORT}/admin`);
  console.log(`📱 Portal: http://localhost:${PORT}/portal`);
  try {
    const { getDeviceIdentity } = require('./services/deviceIdentity');
    console.log(`🔑 Device ID: ${getDeviceIdentity().id}`);
  } catch (e) {
    console.error('[DeviceIdentity] Failed to read/generate device ID:', e.message);
  }
  console.log('');

  // Re-apply the saved static IP (if any) on every boot - closes the gap
  // where the setting only ever took effect the moment someone clicked
  // "Apply Network Settings," so a reboot silently drifted back to
  // whatever cloud-init/DHCP handed the box.
  const hostNetworkService = require('./services/hostNetworkService');
  const db = require('./config/database');
  hostNetworkService.reapplyStaticNetworkOnBoot(db);

  // Falls back to DHCP automatically if a static gateway goes unreachable
  // for too long - covers a client forgetting to switch back to DHCP
  // before moving the box to a different router or ISP.
  hostNetworkService.startConnectivityWatchdog(db);

  // Direct-GPIO coin acceptor listener (Workstream 4) — no-ops cleanly when
  // not configured/enabled (currentConfig().enabled false) or when gpiomon
  // isn't installed, so this never blocks boot on boxes using the ESP32
  // relay path instead. Matches the "boot always succeeds, subsystem
  // failures degrade gracefully" pattern already used by the network
  // watchdog above.
  try {
    require('./services/coinslotGpio').startListener();
  } catch (e) {
    console.warn('[CoinslotGPIO] Listener failed to start (non-fatal):', e.message);
  }

  // Vendo zero-config discovery - same "never blocks boot" degrade-
  // gracefully pattern as everything else here.
  try {
    require('./services/vendoDiscoveryService').startVendoDiscovery();
  } catch (e) {
    console.warn('[VendoDiscovery] Failed to start (non-fatal):', e.message);
  }

  // Self-heal watchdog — periodic health check + narrow auto-repair for the
  // box's own network-access-control state (standalone/OpenWRT modes).
  // Never blocks boot; a failure here just means health checks aren't
  // running, not that vending stops working.
  try {
    require('./services/watchdogService').start();
  } catch (e) {
    console.warn('[Watchdog] Failed to start (non-fatal):', e.message);
  }

  // Multi-WAN failover monitor (Standalone mode, network power) - only
  // does anything once a second router_ports row with role='wan' exists;
  // otherwise its periodic check is a cheap no-op. Never blocks boot.
  try {
    require('./services/multiWanService').start();
  } catch (e) {
    console.warn('[Multi-WAN] Failed to start (non-fatal):', e.message);
  }

  // Data retention cleanup (privacy) - ages out old session_history/
  // free_claims/watchdog_events/network_config_versions rows on a daily
  // schedule. Never touches the financial transactions ledger.
  try {
    require('./services/dataRetentionService').start();
  } catch (e) {
    console.warn('[DataRetention] Failed to start (non-fatal):', e.message);
  }

  // Telemetry Tier 1 (outbox + crash reporting) - off by default
  // (telemetry_enabled setting), mechanism-only until a real Privacy
  // Policy exists. Scheduling this unconditionally is safe: both its
  // cron jobs no-op instantly while disabled.
  try {
    require('./services/telemetryService').start();
  } catch (e) {
    console.warn('[Telemetry] Failed to start (non-fatal):', e.message);
  }

  // Preflight dependency check — verifies nft/tc/gpio tools and basic
  // network readiness exist before the app is trusted to vend. Deliberately
  // non-blocking (matches this app's "boot always succeeds, subsystems
  // degrade gracefully" pattern) but fails LOUDLY in the console/log
  // instead of the previous behavior of silently misbehaving on
  // unsupported hardware. Result is cached for the admin panel's Health
  // Check card and About page to surface without re-running it.
  try {
    const diagnostics = require('./services/systemDiagnosticsService');
    const report = diagnostics.runChecks();
    diagnostics.setLastBootReport(report);
    if (!report.overallOk) {
      console.warn('');
      console.warn('⚠️  PREFLIGHT CHECK FAILED — this box is missing something it needs:');
      report.results.filter((r) => !r.pass).forEach((r) => {
        console.warn(`   ✗ ${r.label}: ${r.detail}`);
      });
      console.warn('   The app will still start, but vending may not work correctly until this is fixed.');
      console.warn('   See Network > System Health Check in the admin panel for details.');
      console.warn('');
    } else {
      console.log(`✅ Preflight check passed (${report.passCount}/${report.totalCount})`);
    }
  } catch (e) {
    console.warn('[Preflight] Check failed to run (non-fatal):', e.message);
  }

  // Post-update health check + auto-rollback — only does anything if
  // /install-update recorded a pending update on the previous boot (see
  // updateRollbackService.js). Closes the "new code boots but runs
  // incorrectly, not an outright crash" gap that systemd's Restart=always
  // and the watchdog's hang-detection don't cover.
  try {
    require('./services/updateRollbackService').checkAndVerify(process.cwd(), PORT);
  } catch (e) {
    console.warn('[UpdateRollback] Post-update check failed to run (non-fatal):', e.message);
  }

  // Scheduled nightly database backup (rotated, keeps last 7) — see
  // scheduledBackupService.js. Separate from the on-demand JSON export and
  // the pre-update snapshot, so an operator never has to remember to click
  // "Backup" themselves to avoid losing data to a corrupted DB or SD card.
  try {
    require('./services/scheduledBackupService').start();
  } catch (e) {
    console.warn('[ScheduledBackup] Failed to start (non-fatal):', e.message);
  }

  // Daily log rotation (financial logs, kept 1 year, see
  // financialLogService.js) - same "prevent unbounded disk growth" goal as
  // the scheduled backup above, on the same daily cadence.
  try {
    const financialLogService = require('./services/financialLogService');
    financialLogService.rotateOldLogs();
    setInterval(() => financialLogService.rotateOldLogs(), 24 * 60 * 60 * 1000);
  } catch (e) {
    console.warn('[FinancialLog] Rotation failed to start (non-fatal):', e.message);
  }

  // License check-in (see licenseService.js) — genuinely inert today, no
  // LICENSE_SERVER_URL is configured anywhere yet, so this never makes a
  // network call. Every 6 hours once a real server exists, comfortably
  // inside the 72h grace period even if one attempt is missed.
  try {
    const licenseService = require('./services/licenseService');
    licenseService.checkIn();
    setInterval(() => licenseService.checkIn(), 6 * 60 * 60 * 1000);
  } catch (e) {
    console.warn('[License] Check-in failed to start (non-fatal):', e.message);
  }
});

// Graceful shutdown on SIGTERM (Bug #46)
process.on('SIGTERM', () => {
  console.log('\n⏹️ SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    try {
      const db = require('./config/database');
      db.close();
      console.log('✅ Database connection closed');
    } catch(e) {}
    process.exit(0);
  });
  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('❌ Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
});

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  console.log('\n⏹️ SIGINT received, shutting down gracefully...');
  process.emit('SIGTERM');
});

module.exports = app;