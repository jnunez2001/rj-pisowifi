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

// Cache package.json on startup (Bug #47)
const packageJson = require('../package.json');
const APP_VERSION = packageJson.version;

const app = express();
const PORT = 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, '../public')));

// ── Caching ──────────────────────────────────────────────────────
const authCache = new Map();
const macCache = new Map();
const CACHE_TTL = 30000; // 30 seconds (re-enabled, was 0)
const MAC_CACHE_TTL = 10000; // 10 seconds for IP→MAC mapping (Bug #45)

// ── Helper: get MAC from IP (cached) ──────────────────────────
function getMacFromIp(ip) {
  // Check MAC cache first (Bug #45)
  const cachedMac = macCache.get(ip);
  if (cachedMac && Date.now() - cachedMac.time < MAC_CACHE_TTL) {
    return cachedMac.mac;
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
function isAuthenticated(ip) {
  try {
    // Check cache first
    const cached = authCache.get(ip);
    if (cached && Date.now() - cached.time < CACHE_TTL) {
      return cached.result;
    }

    const mac = getMacFromIp(ip);
    if (!mac) {
      authCache.set(ip, { result: false, time: Date.now() });
      return false;
    }

    const result = execSync(
      'sudo nft list set ip rj_piso allowed_macs 2>/dev/null'
    ).toString();
    const isAuth = result.includes(mac);

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

app.get('/generate_204', (req, res) => {
  const ip = getClientIp(req);
  if (isAuthenticated(ip)) return res.status(204).send();
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/gen_204', (req, res) => {
  const ip = getClientIp(req);
  if (isAuthenticated(ip)) return res.status(204).send();
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/hotspot-detect.html', (req, res) => {
  const ip = getClientIp(req);
  if (isAuthenticated(ip)) {
    return res.send('<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>');
  }
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/library/test/success.html', (req, res) => {
  const ip = getClientIp(req);
  if (isAuthenticated(ip)) {
    return res.send('<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>');
  }
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/ncsi.txt', (req, res) => {
  const ip = getClientIp(req);
  if (isAuthenticated(ip)) return res.send('Microsoft NCSI');
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/connecttest.txt', (req, res) => {
  const ip = getClientIp(req);
  if (isAuthenticated(ip)) return res.send('Microsoft Connect Test');
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