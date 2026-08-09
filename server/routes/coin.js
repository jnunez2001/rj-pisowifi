const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { checkSpam, recordAttempt, clearAttempts } = require('../services/spamService');
const { creditCoinValue, NoMatchingRateError } = require('../services/coinCreditService');
const { resolveDeviceKey } = require('../services/satelliteKioskService');

// MAC address validation helper (Bug #27)
function isValidMac(mac) {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(String(mac || '').trim());
}

// In-memory store of which MAC is currently "pending" a coin insertion.
// Single-vendo setup: only one pending slot needed at a time.
let pendingCoinMac = null;
let pendingSetAt = 0;
// Running total (pesos) credited since this pending window opened — lets the
// portal show "how much have I inserted so far" without having to reverse-
// engineer pesos from minutes (not reliably invertible: different coin
// denominations buy minutes at different rates).
let pendingTotal = 0;
const PENDING_TIMEOUT_MS = 40000; // must match/slightly exceed portal's 30s coin timer

// POST /api/coin/pending — portal calls this right when INSERT COIN modal opens
router.post('/pending', (req, res) => {
  const { mac } = req.body;
  if (!mac || !isValidMac(mac)) {
    return res.status(400).json({ success: false, message: 'Valid MAC address required' });
  }
  pendingCoinMac = mac.toLowerCase();
  pendingSetAt = Date.now();
  pendingTotal = 0;
  console.log(`⏳ Pending coin registered for ${pendingCoinMac}`);
  return res.json({ success: true });
});

// GET /api/coin/pending/:mac — portal polls this while the INSERT COIN modal
// is open, to show a running total and detect new coins to reset its timer.
router.get('/pending/:mac', (req, res) => {
  const mac = String(req.params.mac || '').trim().toLowerCase();
  const stillValid = pendingCoinMac === mac && (Date.now() - pendingSetAt < PENDING_TIMEOUT_MS);
  return res.json({ success: true, pending: stillValid, total: stillValid ? pendingTotal : 0 });
});

// POST /api/coin — ESP32 calls this when a coin is detected
router.post('/', async (req, res) => {
  try {
    const { mac: deviceMac, coin_value, ip, device_key } = req.body;

    // Optional - absent on every existing ESP32 deployment in the field,
    // which must keep working exactly as before. Only a request that
    // actually carries a key matching a paired Satellite Kiosk gets
    // attributed to it; anything else (no key, unrecognized key) resolves
    // to null and is credited as generic Coins, same as today.
    const kioskId = resolveDeviceKey(device_key);

    if (!coin_value || typeof coin_value !== 'number' || coin_value <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid coin value required'
      });
    }

    // Determine the customer MAC: use pending MAC if still valid,
    // otherwise fall back to whatever MAC was sent (legacy/manual testing).
    let mac = deviceMac;
    const pendingValid = pendingCoinMac && (Date.now() - pendingSetAt < PENDING_TIMEOUT_MS);

    if (pendingValid) {
      mac = pendingCoinMac;
    } else if (pendingCoinMac) {
      // expired pending slot — clear it
      pendingCoinMac = null;
    }

    // Validate MAC format early (Bug #27)
    if (!mac || !isValidMac(mac)) {
      return res.status(400).json({
        success: false,
        message: 'Valid MAC address required'
      });
    }
    mac = mac.toLowerCase();

    // Check spam
    const spamCheck = checkSpam(mac);
    if (spamCheck.blocked) {
      return res.status(429).json({
        success: false,
        blocked: true,
        remaining: spamCheck.remaining,
        message: spamCheck.message
      });
    }

    // ===== SMART COIN MATCHING + CREDIT =====
    // (shared with the direct-GPIO coin path — server/services/coinCreditService.js)
    let result;
    try {
      result = await creditCoinValue(mac, coin_value, ip, kioskId);
    } catch (err) {
      if (err instanceof NoMatchingRateError) {
        const attempt = recordAttempt(mac);
        return res.status(400).json({
          success: false,
          blocked: attempt.blocked,
          remaining: attempt.remaining,
          remaining_attempts: attempt.remaining_attempts,
          message: attempt.blocked
            ? attempt.message
            : `Invalid coin. ${attempt.remaining_attempts} attempts left.`
        });
      }
      throw err;
    }

    clearAttempts(mac);

    // Bug: previously the pending window only got a fixed 40s from when the
    // modal opened, and the portal's own 30s coin-modal timer never reset
    // as coins came in — someone dropping several coins with a few seconds
    // between each could run out of time to finish, even mid-insertion.
    // Renew both the window and the running total on every valid coin
    // attributed to the pending MAC, not just when the modal was opened.
    if (pendingValid && mac === pendingCoinMac) {
      pendingSetAt = Date.now();
      pendingTotal += coin_value;
    }

    // Bug: this used to clear pendingCoinMac immediately after any single
    // credit, so a second coin dropped moments later (before the customer
    // was done inserting) fell back to whatever bare MAC the vendo sent, or
    // got rejected outright — the portal's countdown could never actually
    // see it to reset. This is a single physical coin slot serving one
    // customer at a time ("Single-vendo setup" above), so there's no real
    // risk of a second, unrelated customer's coin landing in this window —
    // leave the pending slot alone here and let it expire on its own via
    // PENDING_TIMEOUT_MS (renewed per coin above), same as before this coin.
    return res.json(result);

  } catch (err) {
    console.error('Coin error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== DIRECT GPIO COINSLOT (Workstream 4) =====
// Separate from the pendingCoinMac mechanism above, which is specific to
// the ESP32 HTTP-relay flow — this is the busy-lock/rate-limited waiting-
// client registration for a coin acceptor wired directly into the box's
// own GPIO header. See server/services/coinslotGpio.js.

// POST /api/coin/gpio/register — portal calls this when Insert Coin opens
// in direct-GPIO mode.
router.post('/gpio/register', (req, res) => {
  const { mac } = req.body;
  if (!mac || !isValidMac(mac)) {
    return res.status(400).json({ success: false, message: 'Valid MAC address required' });
  }
  const coinslotGpio = require('../services/coinslotGpio');
  const { status, windowSeconds } = coinslotGpio.registerWaitingClient(mac);
  if (status === coinslotGpio.REGISTER_BUSY) {
    return res.status(409).json({ success: false, status, message: 'Coin slot is busy with another customer.' });
  }
  if (status === coinslotGpio.REGISTER_RATE_LIMITED) {
    return res.status(429).json({ success: false, status, message: 'Too many attempts — please wait before trying again.' });
  }
  return res.json({ success: true, status, window_seconds: windowSeconds });
});

// POST /api/coin/gpio/cancel — portal calls this when the Insert Coin
// modal is closed without paying.
router.post('/gpio/cancel', (req, res) => {
  const { mac } = req.body;
  if (!mac || !isValidMac(mac)) {
    return res.status(400).json({ success: false, message: 'Valid MAC address required' });
  }
  const coinslotGpio = require('../services/coinslotGpio');
  const cancelled = coinslotGpio.cancelWaitingClient(mac);
  return res.json({ success: true, cancelled });
});

// GET /api/coin/gpio/status/:mac — portal polls this to know whose coin
// window is currently active.
router.get('/gpio/status/:mac', (req, res) => {
  const mac = normalizeMacParam(req.params.mac);
  const coinslotGpio = require('../services/coinslotGpio');
  const waitingMac = coinslotGpio.currentWaitingMac();
  return res.json({ success: true, is_waiting: !!mac && waitingMac === mac });
});

function normalizeMacParam(mac) {
  return String(mac || '').trim().toLowerCase();
}

// GET /api/coin/status/:mac
router.get('/status/:mac', (req, res) => {
  const { mac } = req.params;
  const spamCheck = checkSpam(mac);

  const maxAttempts = db.prepare(
    "SELECT value FROM settings WHERE key = 'spam_max_attempts'"
  ).get()?.value || '3';

  const blockMinutes = db.prepare(
    "SELECT value FROM settings WHERE key = 'spam_block_minutes'"
  ).get()?.value || '1';

  res.json({
    blocked: spamCheck.blocked,
    remaining: spamCheck.remaining || 0,
    max_attempts: parseInt(maxAttempts),
    block_minutes: parseInt(blockMinutes)
  });
});

module.exports = router;