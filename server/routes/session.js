const express = require('express');
const router = express.Router();
const {
  getSessionByMac,
  getSessionByVoucher,
  pauseSession,
  resumeSession,
  expireSession
} = require('../services/sessionService');

// GET /api/session/mac/:mac
router.get('/mac/:mac', (req, res) => {
  try {
    const { mac } = req.params;
    const session = getSessionByMac(mac);

    if (!session) {
      return res.json({
        success: false,
        active: false,
        message: 'No active session'
      });
    }

    const now = new Date();
    const hardExpires = new Date(session.hard_expires_at);

    // Check hard expiration
    if (now >= hardExpires && session.is_paused === 0) {
      expireSession(session.voucher_code);
      return res.json({
        success: false,
        active: false,
        message: 'Session expired'
      });
    }

    const remaining = session.is_paused === 1
      ? session.minutes_remaining
      : Math.max(0, (new Date(session.expires_at) - now) / 60000);

    return res.json({
      success: true,
      active: true,
      voucher_code: session.voucher_code,
      minutes_remaining: remaining,
      is_paused: session.is_paused === 1,
      expires_at: session.expires_at,
      hard_expires_at: session.hard_expires_at,
      created_at: session.created_at
    });

  } catch (err) {
    console.error('Session error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/session/voucher/:code
router.get('/voucher/:code', (req, res) => {
  try {
    const { code } = req.params;
    const session = getSessionByVoucher(code);

    if (!session) {
      return res.json({
        success: false,
        active: false,
        message: 'Voucher not found'
      });
    }

    const remaining = session.is_paused === 1
      ? session.minutes_remaining
      : Math.max(
          0,
          (new Date(session.expires_at) - new Date()) / 60000
        );

    return res.json({
      success: true,
      active: true,
      voucher_code: session.voucher_code,
      minutes_remaining: remaining,
      is_paused: session.is_paused === 1,
      expires_at: session.expires_at,
      hard_expires_at: session.hard_expires_at
    });

  } catch (err) {
    console.error('Session error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/session/pause
router.post('/pause', (req, res) => {
  try {
    const { voucher_code } = req.body;
    if (!voucher_code) {
      return res.status(400).json({
        success: false,
        message: 'Voucher code required'
      });
    }

    const session = pauseSession(voucher_code);
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found or already paused'
      });
    }

    console.log(`⏸️ Paused: ${voucher_code}`);

    return res.json({
      success: true,
      message: 'Session paused',
      minutes_remaining: session.minutes_remaining,
      hard_expires_at: session.hard_expires_at
    });

  } catch (err) {
    console.error('Pause error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/session/resume
router.post('/resume', (req, res) => {
  try {
    const { voucher_code } = req.body;
    if (!voucher_code) {
      return res.status(400).json({
        success: false,
        message: 'Voucher code required'
      });
    }

    const session = resumeSession(voucher_code);
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found, not paused, or hard expiration passed'
      });
    }

    console.log(`▶️ Resumed: ${voucher_code}`);

    return res.json({
      success: true,
      message: 'Session resumed',
      minutes_remaining: session.minutes_remaining,
      expires_at: session.expires_at,
      hard_expires_at: session.hard_expires_at
    });

  } catch (err) {
    console.error('Resume error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/session/cancel
router.post('/cancel', (req, res) => {
  try {
    const { voucher_code } = req.body;
    if (!voucher_code) {
      return res.status(400).json({
        success: false,
        message: 'Voucher code required'
      });
    }

    expireSession(voucher_code);
    console.log(`❌ Cancelled: ${voucher_code}`);

    return res.json({
      success: true,
      message: 'Session cancelled'
    });

  } catch (err) {
    console.error('Cancel error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// GET /api/session/free-claim/status/:mac
// Check if MAC already claimed free minutes today
router.get('/free-claim/status/:mac', (req, res) => {
  try {
    const { mac } = req.params;
    const db = require('../config/database');

    // Check if feature is enabled
    const enabled = db.prepare(
      "SELECT value FROM settings WHERE key = 'free_minutes_enabled'"
    ).get()?.value || '1';

    if (enabled !== '1') {
      return res.json({ success: true, eligible: false, reason: 'disabled' });
    }

    // Check if already claimed today
    const today = new Date().toISOString().split('T')[0];
    const existing = db.prepare(`
      SELECT id FROM free_claims
      WHERE mac_address = ?
      AND date(claimed_at) = ?
    `).get(mac, today);

    return res.json({
      success: true,
      eligible: !existing,
      reason: existing ? 'already_claimed' : null
    });

  } catch (err) {
    console.error('Free claim status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/session/free-claim
// Claim free minutes — only for disconnected customers
router.post('/free-claim', (req, res) => {
  try {
    const { mac, ip } = req.body;
    const db = require('../config/database');

    if (!mac) {
      return res.status(400).json({ success: false, message: 'MAC address required' });
    }

    // Check if feature is enabled
    const enabled = db.prepare(
      "SELECT value FROM settings WHERE key = 'free_minutes_enabled'"
    ).get()?.value || '1';

    if (enabled !== '1') {
      return res.status(403).json({ success: false, message: 'Free minutes not available' });
    }

    // Check if already claimed today
    const today = new Date().toISOString().split('T')[0];
    const existing = db.prepare(`
      SELECT id FROM free_claims
      WHERE mac_address = ?
      AND date(claimed_at) = ?
    `).get(mac, today);

    if (existing) {
      return res.status(403).json({
        success: false,
        message: 'You have already claimed your free minutes today.'
      });
    }

    // Check if already has active session — only for disconnected
    const { getSessionByMac, createSession } = require('../services/sessionService');
    const existingSession = getSessionByMac(mac);

    if (existingSession) {
      return res.status(403).json({
        success: false,
        message: 'Free minutes are only for new connections.'
      });
    }

    // Get free minutes amount from settings
    const freeMinutes = parseInt(
      db.prepare("SELECT value FROM settings WHERE key = 'free_minutes_amount'").get()?.value || '5'
    );

    // Create session with free minutes
    // Expiration = free minutes (no buffer needed, it's free)
    const session = createSession(mac, ip || '', freeMinutes, freeMinutes);

    // Record the claim
    db.prepare(`
      INSERT INTO free_claims (mac_address) VALUES (?)
    `).run(mac);

    // Record as transaction
    db.prepare(`
      INSERT INTO transactions (voucher_code, coin_value, minutes_added, type)
      VALUES (?, 0, ?, 'free')
    `).run(session.voucher_code, freeMinutes);

    console.log(`🎁 Free ${freeMinutes} mins claimed by ${mac} → ${session.voucher_code}`);

    return res.json({
      success: true,
      voucher_code: session.voucher_code,
      minutes_added: freeMinutes,
      minutes_remaining: session.minutes_remaining,
      expires_at: session.expires_at,
      hard_expires_at: session.hard_expires_at
    });

  } catch (err) {
    console.error('Free claim error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;