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
  // No reverse proxy sits in front of this server (setup/nginx.conf is an
  // unused empty placeholder) — clients hit Express directly, so
  // x-forwarded-for is a client-suppliable header, not a trustworthy one.
  // Any device could spoof it to another device's IP and have this resolve
  // to that device's MAC via getMacFromIp() below. Use the raw socket
  // address, which the client cannot set.
  const raw = req.connection.remoteAddress ||
              req.socket.remoteAddress || '';
  return raw.replace('::ffff:', '').trim();
}

// ── Captive Portal Detection ──────────────────────────────────

app.get('/', (req, res) => {
  res.redirect('/portal/');
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

const server = app.listen(PORT, '0.0.0.0', () => {
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