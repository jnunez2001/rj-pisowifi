const express = require('express');
const router = express.Router();
const db = require('../config/database');
const crypto = require('crypto');

function isValidMac(mac) {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(String(mac || '').trim());
}

// POST /api/rental/register - the Windows client's first-contact and
// every-heartbeat call. Mirrors server/routes/admin.js's POST
// /vendo/register exactly: an unknown MAC registers as an unapproved
// 'candidate' and is issued a device_secret it must echo on every future
// call; adoption is a separate, deliberate admin action (POST /api/admin/
// rental/pcs/:id/adopt), never automatic just because a device checked in.
router.post('/register', (req, res) => {
  try {
    const { mac, name, ip, device_secret } = req.body || {};
    if (!mac || !isValidMac(mac) || !name) {
      return res.status(400).json({ success: false, message: 'Valid mac and name required' });
    }
    const macClean = String(mac).trim().toLowerCase();

    const existing = db.prepare('SELECT id, device_secret FROM rental_pcs WHERE mac_address = ?').get(macClean);
    if (existing && existing.device_secret && device_secret !== existing.device_secret) {
      console.warn(`⚠️ Rental PC register rejected: ${macClean} sent a missing/incorrect device secret`);
      return res.status(403).json({ success: false, message: 'Invalid device secret' });
    }

    let issuedSecret = existing ? existing.device_secret : null;
    if (!issuedSecret) {
      issuedSecret = crypto.randomBytes(20).toString('hex');
    }

    let pcId;
    if (existing) {
      db.prepare(`
        UPDATE rental_pcs SET name = ?, ip_address = ?, device_secret = ?, last_seen = CURRENT_TIMESTAMP
        WHERE mac_address = ?
      `).run(name, ip || '', issuedSecret, macClean);
      pcId = existing.id;
    } else {
      const result = db.prepare(`
        INSERT INTO rental_pcs (mac_address, name, ip_address, device_secret, last_seen, status)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'candidate')
      `).run(macClean, name, ip || '', issuedSecret);
      pcId = result.lastInsertRowid;
      db.prepare('INSERT INTO rental_sessions (pc_id, minutes_remaining) VALUES (?, 0)').run(pcId);
      require('../services/alertEventService').logAlertEvent(
        'info', 'rental_pc_candidate_detected', `New rental PC "${name}" detected`,
        `MAC ${macClean} is checking in but not yet approved - see PC Rental to adopt it.`
      );
    }

    console.log(`🖥️ Rental PC registered: ${name} (${macClean})`);
    return res.json({ success: true, pc_id: pcId, device_secret: issuedSecret });
  } catch (err) {
    console.error('Rental register error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/rental/status?mac=&device_secret= - polled every ~5s by the
// Windows client. Server is the sole source of truth for locked/unlocked;
// the client never decides this for itself (see windows-rental-client's
// design notes) - it only decides what to do locally on a run of failed
// polls (lock defensively rather than trust a stale "unlocked" answer).
router.get('/status', (req, res) => {
  const mac = String(req.query.mac || '').trim().toLowerCase();
  const secret = req.query.device_secret;
  if (!mac || !isValidMac(mac)) {
    return res.status(400).json({ success: false, message: 'Valid mac required' });
  }

  const pc = db.prepare('SELECT * FROM rental_pcs WHERE mac_address = ?').get(mac);
  if (!pc) {
    return res.status(404).json({ success: false, message: 'Not registered' });
  }
  if (pc.device_secret && secret !== pc.device_secret) {
    return res.status(403).json({ success: false, message: 'Invalid device secret' });
  }

  db.prepare('UPDATE rental_pcs SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(pc.id);

  const session = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(pc.id);
  // hard_expires_at is the single source of truth, not a stored
  // minutes_remaining counter - no decrement cron needed, "remaining" is
  // always just computed live from the timestamp, so it can never go
  // stale the way a periodically-decremented field could.
  const remainingMs = session?.hard_expires_at ? new Date(session.hard_expires_at).getTime() - Date.now() : 0;
  const remainingMinutes = Math.max(0, remainingMs / 60000);
  const active = !!(pc.status === 'adopted' && session && !session.is_paused && remainingMinutes > 0);

  return res.json({
    success: true,
    locked: !active,
    pc_name: pc.name,
    minutes_remaining: Math.round(remainingMinutes * 10) / 10,
    adopted: pc.status === 'adopted'
  });
});

module.exports = router;
