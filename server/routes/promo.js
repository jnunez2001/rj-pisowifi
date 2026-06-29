const express = require('express');
const router = express.Router();
const db = require('../config/database');
const {
  getSessionByMac,
  createSession
} = require('../services/sessionService');

// POST /api/promo/redeem
router.post('/redeem', async (req, res) => {
  try {
    const { mac, code, ip } = req.body;

    if (!mac || !code) {
      return res.status(400).json({
        success: false,
        message: 'MAC address and code required'
      });
    }

    // Normalize code — accept with or without dash
    const raw = code.trim().toUpperCase();
    const normalized = raw.includes('-') ? raw : raw.replace(/^(PROMO|RJ)/, '$1-');

    // Find promo voucher
    const promo = db.prepare(`
      SELECT * FROM promo_vouchers 
      WHERE code = ? AND status = 'unused'
    `).get(normalized);

    if (!promo) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or already used code'
      });
    }

    // Check if MAC already has active session
    const existing = getSessionByMac(mac);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'You already have an active session'
      });
    }

    // duration_days stores fractional days (minutes / 1440)
    const minutes = Math.round(promo.duration_days * 1440);
    const expirationMinutes = minutes;

    // Create session
    const session = await createSession(mac, ip || '', minutes, expirationMinutes);

    // Mark promo as used
    const expiresAt = new Date(
      Date.now() + minutes * 60 * 1000
    ).toISOString();

    db.prepare(`
      UPDATE promo_vouchers 
      SET status = 'active', mac_address = ?, expires_at = ?
      WHERE code = ?
    `).run(mac, expiresAt, normalized);

    // Log transaction
    db.prepare(`
      INSERT INTO transactions 
      (voucher_code, coin_value, minutes_added, type)
      VALUES (?, ?, ?, 'promo')
    `).run(session.voucher_code, promo.price || 0, minutes);

    console.log(`🎫 Promo redeemed: ${normalized} for ${mac}`);

    return res.json({
      success: true,
      action: 'promo_redeemed',
      voucher_code: session.voucher_code,
      minutes_added: minutes,
      expires_at: expiresAt
    });

  } catch (err) {
    console.error('Promo error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;