const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { checkSpam, recordAttempt, clearAttempts } = require('../services/spamService');

// In-memory store of which MAC is currently "pending" a coin insertion.
// Single-vendo setup: only one pending slot needed at a time.
let pendingCoinMac = null;
let pendingSetAt = 0;
const PENDING_TIMEOUT_MS = 40000; // must match/slightly exceed portal's 30s coin timer

// POST /api/coin/pending — portal calls this right when INSERT COIN modal opens
router.post('/pending', (req, res) => {
  const { mac } = req.body;
  if (!mac) {
    return res.status(400).json({ success: false, message: 'MAC required' });
  }
  pendingCoinMac = mac;
  pendingSetAt = Date.now();
  console.log(`⏳ Pending coin registered for ${mac}`);
  return res.json({ success: true });
});

// POST /api/coin — ESP32 calls this when a coin is detected
router.post('/', async (req, res) => {
  try {
    const { mac: deviceMac, coin_value, ip } = req.body;

    if (!coin_value) {
      return res.status(400).json({
        success: false,
        message: 'Coin value required'
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

    if (!mac) {
      return res.status(400).json({
        success: false,
        message: 'No pending customer MAC and no MAC provided'
      });
    }

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

    const { getRates } = require('../services/voucherService');
    const { getSessionByMac, createSession, addTimeToSession } = require('../services/sessionService');

    // ===== SMART COIN MATCHING =====
    const allRates = getRates().sort((a, b) => b.coin_value - a.coin_value);

    let remaining = coin_value;
    const matchedRates = [];

    for (const rate of allRates) {
      if (remaining <= 0) break;
      if (rate.coin_value <= remaining) {
        const times = Math.floor(remaining / rate.coin_value);
        matchedRates.push({ rate, times });
        remaining -= rate.coin_value * times;
      }
    }

    if (matchedRates.length === 0 || remaining === coin_value) {
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

    clearAttempts(mac);

    let totalMinutes = 0;
    let totalExpirationMinutes = 0;

    for (const { rate, times } of matchedRates) {
      totalMinutes += rate.minutes * times;
      totalExpirationMinutes += rate.expiration_minutes * times;
    }

    const matchLog = matchedRates
      .map(({ rate, times }) => `₱${rate.coin_value}x${times}`)
      .join(' + ');
    console.log(`💡 ₱${coin_value} matched as: ${matchLog} = ${totalMinutes} mins (mac: ${mac})`);

    const existingSession = getSessionByMac(mac);

    let result;

    if (existingSession) {
      const updated = await addTimeToSession(mac, totalMinutes, totalExpirationMinutes);

      db.prepare(`
        INSERT INTO transactions 
        (voucher_code, coin_value, minutes_added, type)
        VALUES (?, ?, ?, 'coin')
      `).run(existingSession.voucher_code, coin_value, totalMinutes);

      console.log(`💰 Added ${totalMinutes} mins to ${existingSession.voucher_code}`);

      result = {
        success: true,
        action: 'time_added',
        voucher_code: updated.voucher_code,
        minutes_added: totalMinutes,
        minutes_remaining: updated.minutes_remaining,
        expires_at: updated.expires_at,
        hard_expires_at: updated.hard_expires_at,
        matched_as: matchLog
      };

    } else {
      const session = await createSession(mac, ip || '', totalMinutes, totalExpirationMinutes);

      db.prepare(`
        INSERT INTO transactions 
        (voucher_code, coin_value, minutes_added, type)
        VALUES (?, ?, ?, 'coin')
      `).run(session.voucher_code, coin_value, totalMinutes);

      console.log(`🆕 New session: ${session.voucher_code} for ${mac}`);

      result = {
        success: true,
        action: 'session_created',
        voucher_code: session.voucher_code,
        minutes_added: totalMinutes,
        minutes_remaining: session.minutes_remaining,
        expires_at: session.expires_at,
        hard_expires_at: session.hard_expires_at,
        matched_as: matchLog
      };
    }

    // Coin successfully credited — clear the pending slot
    pendingCoinMac = null;

    return res.json(result);

  } catch (err) {
    console.error('Coin error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

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