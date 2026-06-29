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

const app = express();
const PORT = 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, '../public')));

// ── Helper: check if IP is authenticated ─────────────────────
function isAuthenticated(ip) {
  try {
    const leases = fs.readFileSync('/var/lib/misc/dnsmasq.leases', 'utf8');
    const line = leases.split('\n').find(l => l.includes(ip));
    if (!line) return false;
    const mac = line.split(' ')[1].toLowerCase();
    const result = execSync('sudo nft list set ip rj_piso allowed_macs 2>/dev/null').toString();
    return result.includes(mac);
  } catch(e) {
    return false;
  }
}

function getClientIp(req) {
  const raw = req.headers['x-forwarded-for'] ||
              req.connection.remoteAddress ||
              req.socket.remoteAddress || '';
  return raw.replace('::ffff:', '').trim();
}

// ── Captive Portal Detection ──────────────────────────────────

// Redirect root to portal
app.get('/', (req, res) => {
  res.redirect('/portal/');
});

// Android captive portal detection
app.get('/generate_204', (req, res) => {
  const ip = getClientIp(req);
  if (isAuthenticated(ip)) {
    return res.status(204).send();  // No content = authenticated
  }
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/gen_204', (req, res) => {
  const ip = getClientIp(req);
  if (isAuthenticated(ip)) {
    return res.status(204).send();
  }
  res.redirect('http://10.0.0.1:3000/portal/');
});

// iOS/macOS captive portal detection
app.get('/hotspot-detect.html', (req, res) => {
  const ip = getClientIp(req);
  if (isAuthenticated(ip)) {
    // Tell iOS the network is open — stops captive portal popup
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

// Windows captive portal detection
app.get('/ncsi.txt', (req, res) => {
  const ip = getClientIp(req);
  if (isAuthenticated(ip)) {
    return res.send('Microsoft NCSI');
  }
  res.redirect('http://10.0.0.1:3000/portal/');
});

app.get('/connecttest.txt', (req, res) => {
  const ip = getClientIp(req);
  if (isAuthenticated(ip)) {
    return res.send('Microsoft Connect Test');
  }
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

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🚀 R&J PisoWifi Server Started!');
  console.log(`📡 Running on port ${PORT}`);
  console.log(`🌐 Admin: http://localhost:${PORT}/admin`);
  console.log(`📱 Portal: http://localhost:${PORT}/portal`);
  console.log('');
});

module.exports = app;