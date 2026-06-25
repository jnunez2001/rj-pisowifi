const express = require('express');
const router = express.Router();
const db = require('../config/database');
const {
  getSessionByMac,
  createSession
} = require('../services/sessionService');

// POST /api/promo/redeem
// Customer redeems a promo code
router.post('/redeem', (req, res) => {
  try {
    const { mac, code, ip } = req.body;

    if (!mac || !code) {
      return res.status(400).json({
        success: false,
        message: 'MAC address and code required'
      });
    }

    // Find promo voucher
    const promo = db.prepare(`
      SELECT * FROM promo_vouchers 
      WHERE code = ? AND status = 'unused'
    `).get(code.toUpperCase());

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

    // Calculate minutes from days
    const minutes = promo.duration_days * 24 * 60;

    // Create session
    const session = createSession(mac, ip || '', minutes);

    // Mark promo as active
    const expiresAt = new Date(
      Date.now() + minutes * 60 * 1000
    ).toISOString();

    db.prepare(`
      UPDATE promo_vouchers 
      SET status = 'active', mac_address = ?, expires_at = ?
      WHERE code = ?
    `).run(mac, expiresAt, code.toUpperCase());

    // Log transaction
    db.prepare(`
      INSERT INTO transactions 
      (voucher_code, coin_value, minutes_added, type)
      VALUES (?, ?, ?, 'promo')
    `).run(session.voucher_code, promo.price, minutes);

    console.log(
      `🎫 Promo redeemed: ${code} for ${mac}`
    );

    return res.json({
      success: true,
      action: 'promo_redeemed',
      voucher_code: session.voucher_code,
      duration_days: promo.duration_days,
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