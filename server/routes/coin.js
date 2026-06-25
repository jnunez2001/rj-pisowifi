const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { checkSpam, recordAttempt, clearAttempts } = require('../services/spamService');

router.post('/', (req, res) => {
  try {
    const { mac, coin_value, ip } = req.body;

    if (!mac || !coin_value) {
      return res.status(400).json({
        success: false,
        message: 'MAC address and coin value required'
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
    // Get all rates sorted descending by coin_value
    const allRates = getRates().sort((a, b) => b.coin_value - a.coin_value);

    // Break coin_value into matching rates greedily
    // e.g. ₱3 → ₱1 x3, ₱7 → ₱5 x1 + ₱1 x2
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

    // Nothing matched at all — truly invalid coin
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

    // Valid coin — clear spam counter
    clearAttempts(mac);

   // Calculate total minutes and sum all expiration windows
    let totalMinutes = 0;
    let totalExpirationMinutes = 0;

    for (const { rate, times } of matchedRates) {
      totalMinutes += rate.minutes * times;
      totalExpirationMinutes += rate.expiration_minutes * times;
    }

    // Log what we matched
    const matchLog = matchedRates
      .map(({ rate, times }) => `₱${rate.coin_value}x${times}`)
      .join(' + ');
    console.log(`💡 ₱${coin_value} matched as: ${matchLog} = ${totalMinutes} mins`);

    // Process session
    const existingSession = getSessionByMac(mac);

    if (existingSession) {
      const updated = addTimeToSession(mac, totalMinutes, totalExpirationMinutes);

      db.prepare(`
        INSERT INTO transactions 
        (voucher_code, coin_value, minutes_added, type)
        VALUES (?, ?, ?, 'coin')
      `).run(existingSession.voucher_code, coin_value, totalMinutes);

      console.log(`💰 Added ${totalMinutes} mins to ${existingSession.voucher_code}`);

      return res.json({
        success: true,
        action: 'time_added',
        voucher_code: updated.voucher_code,
        minutes_added: totalMinutes,
        minutes_remaining: updated.minutes_remaining,
        expires_at: updated.expires_at,
        hard_expires_at: updated.hard_expires_at,
        matched_as: matchLog
      });

    } else {
      const session = createSession(mac, ip || '', totalMinutes, totalExpirationMinutes);

      db.prepare(`
        INSERT INTO transactions 
        (voucher_code, coin_value, minutes_added, type)
        VALUES (?, ?, ?, 'coin')
      `).run(session.voucher_code, coin_value, totalMinutes);

      console.log(`🆕 New session: ${session.voucher_code} for ${mac}`);

      return res.json({
        success: true,
        action: 'session_created',
        voucher_code: session.voucher_code,
        minutes_added: totalMinutes,
        minutes_remaining: session.minutes_remaining,
        expires_at: session.expires_at,
        hard_expires_at: session.hard_expires_at,
        matched_as: matchLog
      });
    }

  } catch (err) {
    console.error('Coin error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/coin/status/:mac
router.get('/status/:mac', (req, res) => {
  const { mac } = req.params;
  const spamCheck = checkSpam(mac);
  const { getSessionByMac } = require('../services/sessionService');

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