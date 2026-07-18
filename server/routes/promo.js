const express = require('express');
const router = express.Router();
const db = require('../config/database');
const {
  getSessionByMac,
  createSession,
  getBurstConfig
} = require('../services/sessionService');
const { setClientBandwidth } = require('../services/networkService');
const { logFinancialEvent } = require('../services/financialLogService');

// Promo redemption is a LAN-only flow — nftables DNATs it straight to this
// app, bypassing nginx (setup/nginx.conf, WAN admin access only) entirely —
// so the real client IP is the raw socket address. The portal always sent
// '' as req.body.ip, which made every promo-redeemed session's stored
// ip_address useless.
function getRealClientIp(req) {
  const raw = req.connection.remoteAddress || req.socket.remoteAddress || '';
  return raw.replace('::ffff:', '').trim();
}

// POST /api/promo/redeem
router.post('/redeem', async (req, res) => {
  try {
    const ip = getRealClientIp(req);

    // Settings > Portal Settings > Payment Methods. Safe to enforce here
    // (unlike coin credits in coin.js) because no real money has changed
    // hands yet at this point — a voucher code being rejected just tells
    // the customer to use the other method, nothing is lost.
    const paymentMethods = db.prepare("SELECT value FROM settings WHERE key = 'payment_methods'").get()?.value || 'both';
    if (paymentMethods === 'coin') {
      return res.status(403).json({
        success: false,
        message: 'Voucher redemption is currently disabled. Please use the coin slot instead.'
      });
    }

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

    // Bug: this included 'used' (a promo whose session already fully ended -
    // sessionService.js's expireSession() marks it 'used' the moment that
    // happens) alongside 'active' (a promo whose session is currently
    // live). Meant to block redeeming a second code while one is still
    // running - matches the error message's own "wait for your session to
    // expire" wording - but including 'used' blocked every device from
    // ever redeeming a second promo code again, forever, even long after
    // its first session had completely ended. Only 'active' should block.
    const previousPromo = db.prepare(`
      SELECT id FROM promo_vouchers
      WHERE mac_address = ? AND status = 'active'
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

    // Session gets its own internal RJ-XXXXXX id (voucher_code) regardless
    // of how it was paid for - record the actual code the customer typed
    // separately so an admin looking a customer up by the code they were
    // handed can actually find the session it created.
    db.prepare('UPDATE sessions SET redeemed_code = ? WHERE voucher_code = ?').run(normalized, session.voucher_code);

    // Per-voucher bandwidth override (Create Voucher's optional Mbps
    // fields). createSession() above already applied the GLOBAL cap if one
    // is enabled - this replaces it with the voucher's own numbers, and
    // saves them on the session itself so timerService.js's 30s
    // self-healing re-assertion keeps using THIS voucher's speed instead of
    // silently reverting to the global cap on its next tick.
    if (promo.download_mbps) {
      const overrideDown = promo.download_mbps;
      const overrideUp = promo.upload_mbps || promo.download_mbps;
      db.prepare('UPDATE sessions SET download_mbps = ?, upload_mbps = ? WHERE voucher_code = ?')
        .run(overrideDown, overrideUp, session.voucher_code);
      try {
        await setClientBandwidth(mac, overrideDown, overrideUp, getBurstConfig());
      } catch (e) {
        console.error(`Failed to apply voucher bandwidth override for ${mac}:`, e.message);
      }
    }

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
    logFinancialEvent({ voucher_code: session.voucher_code, coin_value: promo.price || 0, minutes_added: minutes, type: 'promo', mac, promo_code: normalized });

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