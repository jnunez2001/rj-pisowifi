const express = require('express');
const router = express.Router();
const {
  getSessionByMac,
  getSessionByVoucher,
  pauseSession,
  resumeSession,
  expireSession
} = require('../services/sessionService');
const { checkSpam, recordAttempt, clearAttempts } = require('../services/spamService');
const { logFinancialEvent } = require('../services/financialLogService');
const sseService = require('../services/sseService');

// This server has no reverse proxy in front of it (confirmed: setup/nginx.conf
// is an unused empty placeholder, nothing sets up nginx) — clients hit Express
// directly, so the real client IP is the raw socket address, never a
// client-suppliable header or request-body field.
function getRealClientIp(req) {
  const raw = req.connection.remoteAddress || req.socket.remoteAddress || '';
  return raw.replace('::ffff:', '').trim();
}

// pause/resume/cancel only require knowing a voucher_code — no login exists
// to check "is this actually your session". MAC addresses (the only other
// piece of identity in this system) are trivially visible to anyone on the
// LAN via ARP, so without this, a device could mass-guess voucher codes and
// pause/cancel other customers' paid sessions. Reuses the same
// checkSpam/recordAttempt mechanism already used for coin-insertion abuse
// (and its existing spam_max_attempts/spam_block_minutes settings), under a
// separate identifier namespace so it doesn't share counters with that.
function sessionActionRateLimit(req, res, next) {
  const ip = getRealClientIp(req);
  const check = checkSpam(`session-action:${ip}`);
  if (check.blocked) {
    return res.status(429).json({ success: false, message: check.message });
  }
  req._rateLimitId = `session-action:${ip}`;
  next();
}

// GET /api/session/events/:mac — Server-Sent Events stream. The portal
// keeps this connection open and gets pushed an instant wake-up the
// moment a coin/promo/free-claim credits this MAC, instead of waiting on
// its next poll (previously the fastest path was still up to ~1.5s).
router.get('/events/:mac', (req, res) => {
  const mac = String(req.params.mac || '').trim().toLowerCase();
  if (!mac) return res.status(400).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write('\n');

  sseService.subscribe(mac, res);

  // Keep the connection alive through any idle-timeout proxies/browsers
  // that might otherwise close a long-lived HTTP connection.
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseService.unsubscribe(mac, res);
  });
});

// GET /api/session/mac/:mac
router.get('/mac/:mac', async (req, res) => {
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

    if (now >= hardExpires && session.is_paused === 0) {
      await expireSession(session.voucher_code);
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
      : Math.max(0, (new Date(session.expires_at) - new Date()) / 60000);

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
router.post('/pause', sessionActionRateLimit, async (req, res) => {
  try {
    const { voucher_code } = req.body;
    if (!voucher_code) {
      return res.status(400).json({
        success: false,
        message: 'Voucher code required'
      });
    }

    const session = await pauseSession(voucher_code);
    if (!session) {
      recordAttempt(req._rateLimitId);
      return res.status(404).json({
        success: false,
        message: 'Session not found or already paused'
      });
    }
    clearAttempts(req._rateLimitId);

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
router.post('/resume', sessionActionRateLimit, async (req, res) => {
  try {
    const { voucher_code } = req.body;
    if (!voucher_code) {
      return res.status(400).json({
        success: false,
        message: 'Voucher code required'
      });
    }

    const session = await resumeSession(voucher_code);
    if (!session) {
      recordAttempt(req._rateLimitId);
      return res.status(404).json({
        success: false,
        message: 'Session not found, not paused, or hard expiration passed'
      });
    }
    clearAttempts(req._rateLimitId);

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
router.post('/cancel', sessionActionRateLimit, async (req, res) => {
  try {
    const { voucher_code } = req.body;
    if (!voucher_code) {
      return res.status(400).json({
        success: false,
        message: 'Voucher code required'
      });
    }

    // Keep the response identical either way (always a generic success) —
    // this already didn't leak whether a voucher_code was real before the
    // rate-limit fix, and it shouldn't start now just to decide which
    // rate-limit bucket to increment.
    const existing = getSessionByVoucher(voucher_code);
    if (existing) clearAttempts(req._rateLimitId);
    else recordAttempt(req._rateLimitId);

    await expireSession(voucher_code);
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
router.get('/free-claim/status/:mac', (req, res) => {
  try {
    // Normalize casing to match how /free-claim stores free_claims.mac_address
    const mac = String(req.params.mac || '').trim().toLowerCase();
    const db = require('../config/database');

    const enabled = db.prepare(
      "SELECT value FROM settings WHERE key = 'free_minutes_enabled'"
    ).get()?.value || '1';

    if (enabled !== '1') {
      return res.json({ success: true, eligible: false, reason: 'disabled' });
    }

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
router.post('/free-claim', async (req, res) => {
  try {
    // Bug: this used to trust req.body.ip, which the portal always sent as
    // '' — the IP-based anti-MAC-spoofing check below never actually ran.
    // Derive it from the connection itself instead, so it can't be spoofed.
    const ip = getRealClientIp(req);
    const db = require('../config/database');

    if (!req.body.mac) {
      return res.status(400).json({ success: false, message: 'MAC address required' });
    }

    // Bug: free_claims.mac_address was looked up/stored with whatever case
    // the client sent, but coin.js lowercases MACs before touching the
    // sessions table — a device could dodge the once-per-day free-minutes
    // limit just by hitting this endpoint with different MAC casing.
    const mac = String(req.body.mac).trim().toLowerCase();

    const enabled = db.prepare(
      "SELECT value FROM settings WHERE key = 'free_minutes_enabled'"
    ).get()?.value || '1';

    if (enabled !== '1') {
      return res.status(403).json({ success: false, message: 'Free minutes not available' });
    }

    const today = new Date().toISOString().split('T')[0];

    // Check MAC-based claim (Bug #7 — primary check)
    const existingMac = db.prepare(`
      SELECT id FROM free_claims
      WHERE mac_address = ?
      AND date(claimed_at) = ?
    `).get(mac, today);

    if (existingMac) {
      return res.status(403).json({
        success: false,
        message: 'You have already claimed your free minutes today.'
      });
    }

    // Bug #74: this used to hard-block a second claim from the same IP,
    // meant as a secondary defense against MAC spoofing. But many customer
    // devices legitimately share one IP as the server sees it (a router
    // doing hotspot NAT in front of it, e.g. the MikroTik in external-router
    // mode), which blocked every customer after the first each day. The MAC
    // check above is the real defense; this is now just a visibility log.
    if (ip) {
      const existingIp = db.prepare(`
        SELECT id FROM free_claims
        WHERE ip_address = ?
        AND date(claimed_at) = ?
      `).get(ip, today);

      if (existingIp) {
        console.warn(`[Free claim] Multiple claims from IP ${ip} today (expected behind a NATting router)`);
      }
    }

    const { getSessionByMac, createSession } = require('../services/sessionService');
    const existingSession = getSessionByMac(mac);

    if (existingSession) {
      return res.status(403).json({
        success: false,
        message: 'Free minutes are only for new connections.'
      });
    }

    const freeMinutes = parseInt(
      db.prepare("SELECT value FROM settings WHERE key = 'free_minutes_amount'").get()?.value || '5'
    );

    const session = await createSession(mac, ip || '', freeMinutes, freeMinutes);

    // Verify session was created successfully
    if (!session || !session.voucher_code) {
      return res.status(500).json({
        success: false,
        message: 'Failed to create session. Please try again.'
      });
    }

    // Record claim with both MAC and IP for anti-spoofing (Bug #7)
    db.prepare(`INSERT INTO free_claims (mac_address, ip_address) VALUES (?, ?)`).run(mac, ip || null);

    db.prepare(`
      INSERT INTO transactions (voucher_code, coin_value, minutes_added, type)
      VALUES (?, 0, ?, 'free')
    `).run(session.voucher_code, freeMinutes);
    logFinancialEvent({ voucher_code: session.voucher_code, coin_value: 0, minutes_added: freeMinutes, type: 'free', mac });

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