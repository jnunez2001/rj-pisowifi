const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

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

// ── Captive Portal Detection ──────────────────────────────────
// Redirect root to portal
app.get('/', (req, res) => {
  res.redirect('/portal/');
});

// Android captive portal detection
app.get('/generate_204', (req, res) => {
  res.redirect('http://10.0.0.1:3000/portal/');
});
app.get('/gen_204', (req, res) => {
  res.redirect('http://10.0.0.1:3000/portal/');
});

// iOS/macOS captive portal detection
app.get('/hotspot-detect.html', (req, res) => {
  res.redirect('http://10.0.0.1:3000/portal/');
});
app.get('/library/test/success.html', (req, res) => {
  res.redirect('http://10.0.0.1:3000/portal/');
});

// Windows captive portal detection
app.get('/ncsi.txt', (req, res) => {
  res.redirect('http://10.0.0.1:3000/portal/');
});
app.get('/connecttest.txt', (req, res) => {
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