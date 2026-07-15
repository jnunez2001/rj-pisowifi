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

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Bug: /admin (the login page and every admin UI asset) and /api/admin/*
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
  if (isLocalRequest(req) || ADMIN_LAN_ALLOWED_PATHS.has(req.path)) return next();
  // 404, not 403 - a direct LAN probe shouldn't even get confirmation
  // that an admin panel exists here at all.
  return res.status(404).end();
}
app.use('/admin', restrictAdminToLocalhost);
app.use('/api/admin', restrictAdminToLocalhost);

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
    name: 'R&J PisoWifi Server',
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
  console.log('🚀 R&J PisoWifi Server Started!');
  console.log(`📡 Running on port ${PORT}`);
  console.log(`🌐 Admin: http://localhost:${PORT}/admin`);
  console.log(`📱 Portal: http://localhost:${PORT}/portal`);
  console.log('');

  // Re-apply the saved static IP (if any) on every boot - closes the gap
  // where the setting only ever took effect the moment someone clicked
  // "Apply Network Settings," so a reboot silently drifted back to
  // whatever cloud-init/DHCP handed the box.
  require('./services/hostNetworkService').reapplyStaticNetworkOnBoot(require('./config/database'));
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