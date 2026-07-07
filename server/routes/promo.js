const express = require('express');
const router = express.Router();
const db = require('../config/database');
const {
  getSessionByMac,
  createSession
} = require('../services/sessionService');

// No reverse proxy sits in front of this server (setup/nginx.conf is an
// unused empty placeholder), so the real client IP is the raw socket
// address — the portal always sent '' as req.body.ip, which made every
// promo-redeemed session's stored ip_address useless.
function getRealClientIp(req) {
  const raw = req.connection.remoteAddress || req.socket.remoteAddress || '';
  return raw.replace('::ffff:', '').trim();
}

// POST /api/promo/redeem
router.post('/redeem', async (req, res) => {
  try {
    const ip = getRealClientIp(req);

    if (!req.body.mac || !req.body.code) {
      return res.status(400).json({
        success: false,
        message: 'MAC address and code required'
      });
    }

    // Bug: promo_vouchers.mac_address is looked up/stored with whatever
    // case the client sent — coin.js lowercases MACs before touching the
    // sessions table, but this route didn't, so the same device could look
    // "new" here just from a casing difference against its own coin-created
    // history. Normalize to match the rest of the system.
    const mac = String(req.body.mac).trim().toLowerCase();
    const code = req.body.code;

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

    // Check if promo has expired
    if (promo.expires_at) {
      const expiresAt = new Date(promo.expires_at);
      if (new Date() >= expiresAt) {
        return res.status(404).json({
          success: false,
          message: 'This promo code has expired'
        });
      }
    }

    // Check if MAC already has active session
    const existing = getSessionByMac(mac);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'You already have an active session'
      });
    }

    // Check if MAC has already redeemed ANY promo (prevent duplicate redemption)
    const previousPromo = db.prepare(`
      SELECT id FROM promo_vouchers
      WHERE mac_address = ? AND status IN ('active', 'used')
    `).get(mac);

    if (previousPromo) {
      return res.status(400).json({
        success: false,
        message: 'You have already redeemed a promo code. Please wait for your session to expire.'
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