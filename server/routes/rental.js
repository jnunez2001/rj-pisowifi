const express = require('express');
const router = express.Router();
const db = require('../config/database');
const crypto = require('crypto');
const { verifyPassword, hashPassword } = require('../utils/passwordHash');
const { parseSqliteDate } = require('../utils/sqliteDate');

// Every device-facing route here (register/status/member-login/logout/
// staff-override) authenticates the CALLING PC via its own device_secret
// (see POST /register) - never adminAuth, since the Windows client has no
// admin login of its own. This helper centralizes that lookup+check.
function authenticatePc(mac, secret) {
  if (!mac || !isValidMac(mac)) return { error: 400, message: 'Valid mac required' };
  const pc = db.prepare('SELECT * FROM rental_pcs WHERE mac_address = ?').get(mac.toLowerCase());
  if (!pc) return { error: 404, message: 'Not registered' };
  if (pc.device_secret && secret !== pc.device_secret) return { error: 403, message: 'Invalid device secret' };
  return { pc };
}

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
  const auth = authenticatePc(req.query.mac, req.query.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });
  const pc = auth.pc;

  db.prepare('UPDATE rental_pcs SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(pc.id);

  let session = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(pc.id);
  let remainingMinutes;
  let loggedInUser = null;

  if (session?.is_paused) {
    // Staff maintenance pause (POST /pause) - freeze everything exactly
    // where it is. A logged-in member's balance must NOT keep draining
    // while paused, so this skips the member-drain branch entirely
    // instead of just hiding its effect - draining then discarding the
    // result would still burn the balance for real.
    remainingMinutes = session?.member_id
      ? (db.prepare('SELECT seconds FROM rental_members WHERE id = ?').get(session.member_id)?.seconds || 0) / 60
      : Math.max(0, (session?.hard_expires_at ? parseSqliteDate(session.hard_expires_at).getTime() - Date.now() : 0) / 60000);
    loggedInUser = session?.member_id
      ? db.prepare('SELECT username FROM rental_members WHERE id = ?').get(session.member_id)?.username || null
      : null;
  } else if (session?.member_id) {
    // A logged-in member's time is a live-draining balance, not a fixed
    // expiry timestamp (unlike guest credit below) - it has to be, since
    // the same balance can be spent across different PCs on different
    // visits. Decremented here, on every poll, by exactly how much wall-
    // clock time has actually passed since the last poll (session.
    // updated_at) - server-authoritative, same "client never trusts
    // itself" principle as the guest path, just computed differently
    // because a portable balance can't be expressed as one fixed
    // timestamp the way a single PC's guest session can.
    const member = db.prepare('SELECT * FROM rental_members WHERE id = ?').get(session.member_id);
    if (member) {
      const realElapsedSeconds = Math.max(0, (Date.now() - parseSqliteDate(session.updated_at).getTime()) / 1000);
      // rental_speed_timer_secs is how many real milliseconds count as
      // one billed second (1000 = real-time, lower = drains faster) -
      // see the guarded migration in database.js for why the default
      // isn't just always 1000. Invalid/zero/missing falls back to
      // real-time rather than dividing by zero or silently freezing
      // billing.
      const speedMs = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'rental_speed_timer_secs'").get()?.value, 10) || 1000;
      const elapsedSeconds = realElapsedSeconds * (1000 / speedMs);
      const newSeconds = Math.max(0, member.seconds - elapsedSeconds);
      db.prepare('UPDATE rental_members SET seconds = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?').run(Math.round(newSeconds), member.id);

      if (newSeconds <= 0) {
        // Ran out while logged in - same as an explicit logout, just
        // triggered by hitting zero instead of the member choosing to end
        // it. Nothing left to preserve either way.
        db.prepare('UPDATE rental_sessions SET member_id = NULL WHERE pc_id = ?').run(pc.id);
        session = { ...session, member_id: null };
        remainingMinutes = 0;
      } else {
        // Bug found live: writing this via SQL's own CURRENT_TIMESTAMP
        // produces a naive "YYYY-MM-DD HH:MM:SS" string in UTC, but
        // JS's `new Date(str)` parses that space-separated (non-ISO)
        // format as LOCAL time, not UTC - reading it back for the
        // elapsed-time math above silently shifted it by the server's
        // UTC offset, draining a member's whole balance in a single
        // poll regardless of how much time had actually passed. Every
        // other timestamp this file/coin.js relies on for real math
        // (expires_at, hard_expires_at) is already built as a real ISO
        // string in JS for exactly this reason - matching that here.
        db.prepare('UPDATE rental_sessions SET updated_at = ? WHERE pc_id = ?').run(new Date().toISOString(), pc.id);
        remainingMinutes = newSeconds / 60;
        loggedInUser = member.username;
      }
    } else {
      // Member row gone (deleted) but the session still pointed at it -
      // clear the dangling reference rather than crash on it.
      db.prepare('UPDATE rental_sessions SET member_id = NULL WHERE pc_id = ?').run(pc.id);
      remainingMinutes = 0;
    }
  } else {
    // Guest credit - hard_expires_at is the source of truth, not a
    // stored minutes_remaining counter, so "remaining" is always
    // computed live and can never go stale the way a periodically-
    // decremented field could.
    const remainingMs = session?.hard_expires_at ? parseSqliteDate(session.hard_expires_at).getTime() - Date.now() : 0;
    remainingMinutes = Math.max(0, remainingMs / 60000);
  }

  const active = !!(pc.status === 'adopted' && !session?.is_paused && remainingMinutes > 0);

  // Branding for the client's lock screen - included on every poll
  // rather than a separate endpoint, since it's cheap and rarely
  // changes; simpler than the client having to make (and cache) a
  // second round trip.
  const activeWallpaper = db.prepare('SELECT image_path FROM rental_wallpapers WHERE active = 1 LIMIT 1').get()?.image_path || null;
  const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null;

  return res.json({
    success: true,
    locked: !active,
    paused: !!session?.is_paused,
    pc_name: pc.name,
    minutes_remaining: Math.round(remainingMinutes * 10) / 10,
    adopted: pc.status === 'adopted',
    logged_in_user: loggedInUser,
    logo_url: getSetting('rental_logo_url'),
    wallpaper_url: activeWallpaper,
    lock_announcement: getSetting('rental_lock_announcement')
  });
});

// POST /api/rental/member-login - {mac, device_secret, username, password}.
// The lock screen's login form. Rejects if the PC already has a DIFFERENT
// member logged in (one login at a time per PC) or if this member has
// nothing left to spend.
router.post('/member-login', (req, res) => {
  const { username, password } = req.body || {};
  const auth = authenticatePc(req.body?.mac, req.body?.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });
  const pc = auth.pc;

  const member = db.prepare('SELECT * FROM rental_members WHERE username = ?').get(String(username || '').trim());
  if (!member || !verifyPassword(password, member.password_hash)) {
    return res.status(401).json({ success: false, message: 'Incorrect username or password' });
  }
  if (member.seconds <= 0) {
    return res.status(400).json({ success: false, message: 'No time remaining on this account' });
  }

  const session = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(pc.id);
  if (session?.member_id && session.member_id !== member.id) {
    return res.status(409).json({ success: false, message: 'Another member is already logged in on this PC' });
  }

  // updated_at written as a JS ISO string, not SQL's CURRENT_TIMESTAMP -
  // see the matching comment in GET /status, same bug class.
  db.prepare(`
    UPDATE rental_sessions SET member_id = ?, is_paused = 0, updated_at = ? WHERE pc_id = ?
  `).run(member.id, new Date().toISOString(), pc.id);
  db.prepare('UPDATE rental_members SET last_active = CURRENT_TIMESTAMP WHERE id = ?').run(member.id);

  console.log(`👤 Member "${member.username}" logged in on rental PC "${pc.name}"`);
  return res.json({ success: true, minutes_remaining: Math.round((member.seconds / 60) * 10) / 10 });
});

// POST /api/rental/member-logout - {mac, device_secret}. Whatever the
// member hasn't spent stays in their balance untouched - draining only
// ever happens between logged-in polls (GET /status above), never after
// logout.
router.post('/member-logout', (req, res) => {
  const auth = authenticatePc(req.body?.mac, req.body?.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  db.prepare('UPDATE rental_sessions SET member_id = NULL WHERE pc_id = ?').run(auth.pc.id);
  console.log(`👤 Member logged out on rental PC "${auth.pc.name}"`);
  return res.json({ success: true });
});

// POST /api/rental/staff-override - {mac, device_secret, password}. A
// purely LOCAL physical fail-safe (per the client's own design notes) -
// this only verifies the password, it never touches rental_sessions or
// grants server-side credit. The client itself decides what a
// successful override means locally (typically: unlock temporarily
// without changing anything server-side).
router.post('/staff-override', (req, res) => {
  const auth = authenticatePc(req.body?.mac, req.body?.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const stored = db.prepare("SELECT value FROM settings WHERE key = 'rental_app_password'").get()?.value;
  if (!stored) {
    return res.status(400).json({ success: false, message: 'No app password has been set yet - set one in PC Rental > Settings' });
  }
  if (!req.body?.password || !verifyPassword(req.body.password, stored)) {
    return res.status(401).json({ success: false, message: 'Incorrect app password' });
  }
  return res.json({ success: true });
});

// POST /api/rental/pause - {mac, device_secret, password}. Staff-
// initiated maintenance pause, distinct from Staff Override above:
// override is a short local unlock that never touches server state,
// this suspends real enforcement (no lock screen, no member time drain)
// until explicitly resumed. Reuses rental_sessions.is_paused - the same
// field admin.js's Manage PC Lock/Unlock buttons already drive - so the
// admin panel sees this as the same "Paused" status, not a second,
// conflicting flag. Password-gated so a customer can't pause their own
// lock; resuming isn't security-sensitive the same way, so /resume
// doesn't require it.
router.post('/pause', (req, res) => {
  const auth = authenticatePc(req.body?.mac, req.body?.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const stored = db.prepare("SELECT value FROM settings WHERE key = 'rental_app_password'").get()?.value;
  if (!stored) {
    return res.status(400).json({ success: false, message: 'No app password has been set yet - set one in PC Rental > Settings' });
  }
  if (!req.body?.password || !verifyPassword(req.body.password, stored)) {
    return res.status(401).json({ success: false, message: 'Incorrect app password' });
  }

  db.prepare('UPDATE rental_sessions SET is_paused = 1 WHERE pc_id = ?').run(auth.pc.id);
  console.log(`⏸️ Rental PC "${auth.pc.name}" paused by staff`);
  return res.json({ success: true });
});

// POST /api/rental/resume - {mac, device_secret}. No password required -
// see comment above /pause.
router.post('/resume', (req, res) => {
  const auth = authenticatePc(req.body?.mac, req.body?.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  db.prepare('UPDATE rental_sessions SET is_paused = 0 WHERE pc_id = ?').run(auth.pc.id);
  console.log(`▶️ Rental PC "${auth.pc.name}" resumed by staff`);
  return res.json({ success: true });
});

// Shared by /member-points, /redeem, /change-password - all three only
// make sense for whichever member is currently logged into the calling
// PC, derived from its session rather than an admin-supplied :id.
function requireLoggedInMember(pcId) {
  const session = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(pcId);
  if (!session?.member_id) return null;
  return db.prepare('SELECT * FROM rental_members WHERE id = ?').get(session.member_id);
}

// GET /api/rental/member-points?mac=&device_secret= - the claim panel's
// data source: current points balance plus every active redeem rate.
router.get('/member-points', (req, res) => {
  const auth = authenticatePc(req.query.mac, req.query.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const member = requireLoggedInMember(auth.pc.id);
  if (!member) return res.status(400).json({ success: false, message: 'No member logged in on this PC' });

  const rates = db.prepare('SELECT id, points, reward_seconds FROM rental_redeem_rates ORDER BY points ASC').all();
  return res.json({ success: true, points: member.points, redeem_rates: rates });
});

// POST /api/rental/redeem - {mac, device_secret, redeem_rate_id}. Mirrors
// POST /admin/rental/members/:id/redeem exactly, just deriving the member
// from the calling PC's session instead of an admin-supplied :id.
router.post('/redeem', (req, res) => {
  const auth = authenticatePc(req.body?.mac, req.body?.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const member = requireLoggedInMember(auth.pc.id);
  if (!member) return res.status(400).json({ success: false, message: 'No member logged in on this PC' });

  const redeemRateId = parseInt(req.body?.redeem_rate_id, 10);
  const rate = db.prepare('SELECT * FROM rental_redeem_rates WHERE id = ?').get(redeemRateId);
  if (!rate) return res.status(404).json({ success: false, message: 'Redeem rate not found' });
  if (member.points < rate.points) {
    return res.status(400).json({ success: false, message: 'Not enough points' });
  }

  const remainingPoints = member.points - rate.points;
  db.prepare('UPDATE rental_members SET points = ?, seconds = seconds + ? WHERE id = ?')
    .run(remainingPoints, rate.reward_seconds, member.id);
  db.prepare('INSERT INTO rental_redemptions (member_id, points_spent, reward_seconds, remaining_points) VALUES (?, ?, ?, ?)')
    .run(member.id, rate.points, rate.reward_seconds, remainingPoints);

  console.log(`🎁 Member "${member.username}" redeemed ${rate.points} points for ${rate.reward_seconds}s on PC "${auth.pc.name}"`);
  return res.json({ success: true, remaining_points: remainingPoints, seconds_added: rate.reward_seconds });
});

// POST /api/rental/change-password - {mac, device_secret, current_password,
// new_password}. The logged-in member changing their own password from
// the widget's Account panel.
router.post('/change-password', (req, res) => {
  const auth = authenticatePc(req.body?.mac, req.body?.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const member = requireLoggedInMember(auth.pc.id);
  if (!member) return res.status(400).json({ success: false, message: 'No member logged in on this PC' });

  const { current_password, new_password } = req.body || {};
  if (!verifyPassword(current_password, member.password_hash)) {
    return res.status(401).json({ success: false, message: 'Current password is incorrect' });
  }
  if (!new_password || String(new_password).length < 4) {
    return res.status(400).json({ success: false, message: 'New password must be at least 4 characters' });
  }

  db.prepare('UPDATE rental_members SET password_hash = ? WHERE id = ?').run(hashPassword(String(new_password)), member.id);
  console.log(`🔑 Member "${member.username}" changed their password`);
  return res.json({ success: true });
});

module.exports = router;
