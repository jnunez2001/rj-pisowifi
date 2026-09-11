const express = require('express');
const router = express.Router();
const db = require('../config/database');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifyPassword, hashPassword } = require('../utils/passwordHash');
const { parseSqliteDate } = require('../utils/sqliteDate');
const { checkSpam, recordAttempt, clearAttempts } = require('../services/spamService');

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
  // Mockup's top bar shows member points alongside the name/badge on
  // every poll - cheap to include here rather than a second round trip,
  // same reasoning as the branding fields below. Stays null for guests.
  let loggedInPoints = null;

  if (session?.is_paused) {
    // Staff maintenance pause (POST /pause) - freeze everything exactly
    // where it is. A logged-in member's balance must NOT keep draining
    // while paused, so this skips the member-drain branch entirely
    // instead of just hiding its effect - draining then discarding the
    // result would still burn the balance for real.
    remainingMinutes = session?.member_id
      ? (db.prepare('SELECT seconds FROM rental_members WHERE id = ?').get(session.member_id)?.seconds || 0) / 60
      : Math.max(0, (session?.hard_expires_at ? parseSqliteDate(session.hard_expires_at).getTime() - Date.now() : 0) / 60000);
    if (session?.member_id) {
      const pausedMember = db.prepare('SELECT username, points FROM rental_members WHERE id = ?').get(session.member_id);
      loggedInUser = pausedMember?.username || null;
      loggedInPoints = pausedMember?.points ?? null;
    }
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

      // A member who drains to exactly zero stays logged in (locked, not
      // logged out) - "active" below already correctly requires
      // remainingMinutes > 0, so there's nothing left to special-case here.
      // They only leave rental_sessions.member_id via an explicit
      // POST /member-logout, or the "member row gone" branch below if the
      // account itself is deleted. Bug found live: writing this via SQL's
      // own CURRENT_TIMESTAMP produces a naive "YYYY-MM-DD HH:MM:SS" string
      // in UTC, but JS's `new Date(str)` parses that space-separated
      // (non-ISO) format as LOCAL time, not UTC - reading it back for the
      // elapsed-time math above silently shifted it by the server's UTC
      // offset, draining a member's whole balance in a single poll
      // regardless of how much time had actually passed. Every other
      // timestamp this file/coin.js relies on for real math (expires_at,
      // hard_expires_at) is already built as a real ISO string in JS for
      // exactly this reason - matching that here.
      db.prepare('UPDATE rental_sessions SET updated_at = ? WHERE pc_id = ?').run(new Date().toISOString(), pc.id);
      remainingMinutes = newSeconds / 60;
      loggedInUser = member.username;
      loggedInPoints = member.points;
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
    lock_announcement: getSetting('rental_lock_announcement'),
    instructions_text: getSetting('rental_instructions_text'),
    logged_in_points: loggedInPoints
  });
});

// POST /api/rental/member-login - {mac, device_secret, username, password}.
// The lock screen's login form. Rejects if the PC already has a DIFFERENT
// member logged in (one login at a time per PC). Succeeds regardless of
// balance - a member with 0 seconds still logs in (locked, since GET
// /status's `active` requires remainingMinutes > 0) so they can see their
// points and redeem/top-up from the Member No-Time panel instead of being
// turned away at the door.
router.post('/member-login', (req, res) => {
  const { username, password } = req.body || {};
  const auth = authenticatePc(req.body?.mac, req.body?.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });
  const pc = auth.pc;

  const member = db.prepare('SELECT * FROM rental_members WHERE username = ?').get(String(username || '').trim());
  if (!member || !verifyPassword(password, member.password_hash)) {
    return res.status(401).json({ success: false, message: 'Incorrect username or password' });
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

// GET /api/rental/apps - Café Home's game/app catalog (V1.0.0
// blueprint). Metadata only, no images - see database.js's comment on
// rental_apps for why. Changes far less often than lock state, so the
// Windows client fetches this on a much longer interval than
// StatusPoller's 5s status check, not every tick.
router.get('/apps', (req, res) => {
  const auth = authenticatePc(req.query.mac, req.query.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const categories = db.prepare('SELECT id, name, display_order FROM rental_categories WHERE enabled = 1 ORDER BY display_order ASC, name ASC').all();
  // featured comes back from SQLite as a raw 0/1 integer - the Windows
  // client's System.Text.Json deserializer won't coerce a JSON number
  // into a C# bool (throws instead), so it's cast to a real boolean here
  // rather than passed through raw.
  const apps = db.prepare(`
    SELECT id, name, category_id, type, executable_path, description, featured, display_order
    FROM rental_apps WHERE enabled = 1 ORDER BY display_order ASC, name ASC
  `).all().map((a) => ({ ...a, featured: !!a.featured }));
  return res.json({ success: true, categories, apps });
});

// GET /api/rental/whitelisted-apps - Clean Up on Exit (V1.0.0 mockup
// rebuild) needs to know which running processes are exempt from being
// force-closed when a session ends. Read-only mirror of the admin's
// existing rental_whitelisted_apps CRUD (server/routes/admin.js), just
// exposed device-side the same way GET /apps already is.
router.get('/whitelisted-apps', (req, res) => {
  const auth = authenticatePc(req.query.mac, req.query.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const apps = db.prepare('SELECT app_name FROM rental_whitelisted_apps').all().map((r) => r.app_name);
  return res.json({ success: true, apps });
});

// Debounce for POST /help-request below - holding/mashing the Call Staff
// button shouldn't flood the admin Notifications feed with duplicates.
// In-memory only (pc_id -> last request ms) - worst case after a restart
// is one extra notification, not worth persisting.
const lastHelpRequestAt = new Map();
const HELP_REQUEST_COOLDOWN_MS = 2 * 60 * 1000;

// POST /api/rental/help-request - the lock screen's "Call Staff" button
// (V1.0.0 mockup rebuild). Distinct from the existing staff-override/
// pause routes: those are STAFF authenticating themselves to unlock a
// PC; this is a CUSTOMER flagging that they need help, with no password
// gate. Logs via the same alertEventService pattern already used
// elsewhere in this codebase (e.g. rental_pc_candidate_detected) so it
// surfaces in the admin's existing Notifications feed - no new admin UI
// needed.
router.post('/help-request', (req, res) => {
  const auth = authenticatePc(req.body?.mac, req.body?.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const now = Date.now();
  const last = lastHelpRequestAt.get(auth.pc.id) || 0;
  if (now - last < HELP_REQUEST_COOLDOWN_MS) {
    return res.json({ success: true, message: 'Already notified staff, they\'re on their way.' });
  }
  lastHelpRequestAt.set(auth.pc.id, now);

  require('../services/alertEventService').logAlertEvent(
    'info',
    'rental_help_requested',
    `${auth.pc.name} needs help`,
    `A customer pressed Call Staff on ${auth.pc.name}.`
  );
  return res.json({ success: true, message: 'Staff has been notified.' });
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

// GET /api/rental/share-time/targets?mac=&device_secret= - Share Time's PC
// picker. Lists every OTHER adopted PC (never the caller's own pc_id) with a
// short occupant_label mirroring the same vocabulary GET /status and
// admin.js's rentalStatusFor already use for "who's on this PC": the
// member's username when one is logged in, 'Guest' for an active guest
// credit, 'Idle' when there's nothing to show (no session row at all, or a
// guest session that's already expired).
router.get('/share-time/targets', (req, res) => {
  const auth = authenticatePc(req.query.mac, req.query.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const pcs = db.prepare("SELECT * FROM rental_pcs WHERE status = 'adopted' AND id != ? ORDER BY name ASC").all(auth.pc.id);
  const targets = pcs.map((pc) => {
    const session = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(pc.id);
    let occupantLabel;
    if (!session) {
      occupantLabel = 'Idle';
    } else if (session.member_id) {
      const member = db.prepare('SELECT username FROM rental_members WHERE id = ?').get(session.member_id);
      occupantLabel = member ? member.username : 'Idle';
    } else {
      const remainingMs = session.hard_expires_at ? parseSqliteDate(session.hard_expires_at).getTime() - Date.now() : 0;
      occupantLabel = remainingMs > 0 ? 'Guest' : 'Idle';
    }
    return { pc_id: pc.id, name: pc.name, occupant_label: occupantLabel };
  });

  return res.json({ success: true, targets });
});

// POST /api/rental/share-time - {mac, device_secret, minutes, target_type,
// target_pc_id, target_username}. Lets a logged-in member send some of
// their own rental_members.seconds balance to either another active PC's
// current occupant (target_type 'pc') or straight to another member's
// account by username (target_type 'member'). Only a logged-in MEMBER can
// send - a guest's time is a fixed session, not a shareable balance, so the
// sender is always resolved via the calling PC's own active session, same
// as requireLoggedInMember above (not duplicated as a shared helper since
// this needs the raw session row too, for the member_id presence check).
router.post('/share-time', (req, res) => {
  const auth = authenticatePc(req.body?.mac, req.body?.device_secret);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });
  const senderPc = auth.pc;

  const senderSession = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(senderPc.id);
  if (!senderSession?.member_id) {
    return res.status(403).json({ success: false, message: 'Only a logged-in member can share time' });
  }
  const senderMember = db.prepare('SELECT * FROM rental_members WHERE id = ?').get(senderSession.member_id);
  if (!senderMember) {
    return res.status(404).json({ success: false, message: 'Member account not found' });
  }

  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return res.status(400).json({ success: false, message: 'minutes must be a positive number' });
  }
  const secondsToShare = Math.round(minutes * 60);
  if (secondsToShare > senderMember.seconds) {
    return res.status(400).json({ success: false, message: 'Not enough time to share' });
  }

  const targetType = req.body?.target_type;
  if (targetType !== 'pc' && targetType !== 'member') {
    return res.status(400).json({ success: false, message: "target_type must be 'pc' or 'member'" });
  }

  try {
    if (targetType === 'member') {
      const targetUsername = String(req.body?.target_username || '').trim();
      if (!targetUsername) {
        return res.status(400).json({ success: false, message: 'target_username is required' });
      }
      const targetMember = db.prepare('SELECT * FROM rental_members WHERE username = ?').get(targetUsername);
      if (!targetMember) {
        return res.status(404).json({ success: false, message: 'Member not found' });
      }
      if (targetMember.id === senderMember.id) {
        return res.status(400).json({ success: false, message: "Can't share time with yourself" });
      }

      // A member's seconds balance is persistent and portable across PCs -
      // no rental_sessions row needs touching here, GET /status picks up
      // the new balance next time either member is logged in anywhere.
      const shareToMember = db.transaction(() => {
        db.prepare('UPDATE rental_members SET seconds = seconds - ? WHERE id = ?').run(secondsToShare, senderMember.id);
        db.prepare('UPDATE rental_members SET seconds = seconds + ? WHERE id = ?').run(secondsToShare, targetMember.id);
      });
      shareToMember();

      console.log(`🤝 "${senderMember.username}" shared ${minutes} min directly with member "${targetMember.username}"`);
      return res.json({ success: true });
    }

    // target_type === 'pc'
    const targetPcId = parseInt(req.body?.target_pc_id, 10);
    if (!Number.isFinite(targetPcId)) {
      return res.status(400).json({ success: false, message: 'target_pc_id is required' });
    }
    if (targetPcId === senderPc.id) {
      return res.status(400).json({ success: false, message: "Can't share time with your own PC" });
    }
    const targetPc = db.prepare('SELECT * FROM rental_pcs WHERE id = ?').get(targetPcId);
    if (!targetPc) {
      return res.status(404).json({ success: false, message: 'PC not found' });
    }
    const targetSession = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(targetPcId);

    const shareToPc = db.transaction(() => {
      db.prepare('UPDATE rental_members SET seconds = seconds - ? WHERE id = ?').run(secondsToShare, senderMember.id);

      if (targetSession?.member_id) {
        // Target PC's occupant is itself a logged-in member - credit their
        // portable balance directly (same as the member-target branch
        // above), and refresh their session's updated_at so their next
        // GET /status elapsed-time calc doesn't mistake the gap since
        // their last poll for drain on top of what was just added - same
        // reasoning as coin.js's mode === 'pc_rental' member branch.
        db.prepare('UPDATE rental_members SET seconds = seconds + ? WHERE id = ?').run(secondsToShare, targetSession.member_id);
        db.prepare('UPDATE rental_sessions SET updated_at = ? WHERE pc_id = ?').run(new Date().toISOString(), targetPcId);
      } else {
        // Guest (or no session row yet) - reproduce coin.js's mode ===
        // 'pc_rental' guest-credit math exactly: hard_expires_at is the
        // source of truth, extended by the granted ms on top of whatever
        // real time is already left.
        const currentRemainingMs = targetSession?.hard_expires_at
          ? Math.max(0, new Date(targetSession.hard_expires_at).getTime() - Date.now()) : 0;
        const grantedMs = secondsToShare * 1000;
        const newExpiresAt = new Date(Date.now() + currentRemainingMs + grantedMs).toISOString();
        if (targetSession) {
          db.prepare('UPDATE rental_sessions SET minutes_remaining = ?, expires_at = ?, hard_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE pc_id = ?')
            .run(minutes, newExpiresAt, newExpiresAt, targetPcId);
        } else {
          db.prepare('INSERT INTO rental_sessions (pc_id, minutes_remaining, expires_at, hard_expires_at) VALUES (?, ?, ?, ?)')
            .run(targetPcId, minutes, newExpiresAt, newExpiresAt);
        }
      }
    });
    shareToPc();

    console.log(`🤝 "${senderMember.username}" shared ${minutes} min from "${senderPc.name}" to "${targetPc.name}"`);
    return res.json({ success: true });
  } catch (err) {
    console.error('Share time error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Kiosk Admin Panel (device-scoped, NOT adminAuth) ────────────────────
// The Windows client's new "Admin Panel" screen (mockup) needs authenticated
// access to a handful of settings, but must never require typing the site's
// real global admin password on a physically-exposed kiosk PC. These routes
// authenticate the SAME way every other route in this file does - via
// authenticatePc(mac, device_secret) - PLUS a second, narrower credential:
// rental_admin_panel_password (set/rotated only from the trusted web admin
// panel, see POST /api/admin/rental/admin-panel-password). This is
// deliberately NOT adminAuth and deliberately NOT a generic settings
// passthrough - it can only ever read/touch the specific settings and table
// listed below, since it's guarded by a much weaker credential than the
// real admin password and must not become a backdoor to arbitrary settings.
function requireAdminPanelAuth(req) {
  const auth = authenticatePc(req.body?.mac ?? req.query?.mac, req.body?.device_secret ?? req.query?.device_secret);
  if (auth.error) return auth;
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'rental_admin_panel_password'").get()?.value;
  if (!stored) {
    return { error: 400, message: 'No admin panel password has been set yet - set one in PC Rental > Settings' };
  }
  const password = req.body?.password ?? req.query?.password;
  if (!password || !verifyPassword(password, stored)) {
    return { error: 401, message: 'Incorrect admin panel password' };
  }
  return { pc: auth.pc };
}

// POST /api/rental/admin-panel/verify - {mac, device_secret, password}.
// The Admin Panel screen's own login step - just confirms the password is
// correct, nothing else. Rate-limited via the same spamService already
// used for coin/session/admin-login abuse (see spamService.js) - this is a
// physically-exposed kiosk PC guessing a password with only a 6-character
// minimum, so it needs its own lockout counter distinct from admin-auth's
// (keyed by mac, not IP, since this route is device-scoped).
router.post('/admin-panel/verify', (req, res) => {
  const mac = req.body?.mac;
  const spamKey = `admin-panel-verify:${mac}`;
  const spamCheck = checkSpam(spamKey);
  if (spamCheck.blocked) {
    return res.status(429).json({ success: false, message: spamCheck.message });
  }

  const auth = requireAdminPanelAuth(req);
  if (auth.error) {
    recordAttempt(spamKey);
    return res.status(auth.error).json({ success: false, message: auth.message });
  }
  clearAttempts(spamKey);
  return res.json({ success: true });
});

// POST /api/rental/admin-panel/settings/read - {mac, device_secret,
// password}. Read-only bundle for the Admin Panel screen: a few existing
// operator settings (display only, not editable here) plus the two real
// Guest -> Member Conversion settings and the redeem-rate tiers.
// Deliberately POST (not GET) and on its own /read path, distinct from the
// POST /admin-panel/settings update route below - a body is needed to keep
// device_secret/password out of the URL/query string (same reasoning as
// the other admin-panel routes), and a GET-shaped route can't carry one.
router.post('/admin-panel/settings/read', (req, res) => {
  const auth = requireAdminPanelAuth(req);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  const rates = db.prepare('SELECT id, points, reward_seconds FROM rental_redeem_rates ORDER BY points ASC').all();

  return res.json({
    success: true,
    min_credit_to_register: parseInt(getSetting('rental_create_account_min_credit'), 10) || 0,
    idle_shutdown_secs: parseInt(getSetting('rental_shutdown_timer_secs'), 10) || 0,
    guest_conversion_enabled: getSetting('rental_enable_guest_conversion') === '1',
    guest_conversion_min_minutes: parseInt(getSetting('rental_guest_conversion_min_minutes'), 10) || 0,
    redeem_rates: rates
  });
});

// POST /api/rental/admin-panel/settings - {mac, device_secret, password,
// guest_conversion_enabled?, guest_conversion_min_minutes?}. Updates only
// whichever of these two exact keys is provided, independently - NOT a
// generic bulk settings writer (see the security note above the block).
router.post('/admin-panel/settings', (req, res) => {
  const auth = requireAdminPanelAuth(req);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  if (req.body?.guest_conversion_enabled !== undefined) {
    upsert.run('rental_enable_guest_conversion', req.body.guest_conversion_enabled ? '1' : '0');
  }
  if (req.body?.guest_conversion_min_minutes !== undefined) {
    const minutes = parseInt(req.body.guest_conversion_min_minutes, 10);
    if (!Number.isFinite(minutes) || minutes < 0) {
      return res.status(400).json({ success: false, message: 'guest_conversion_min_minutes must be a non-negative number' });
    }
    upsert.run('rental_guest_conversion_min_minutes', String(minutes));
  }

  return res.json({ success: true });
});

// POST /api/rental/admin-panel/redeem-rates - {mac, device_secret, password,
// points, reward_seconds}. Mirrors POST /api/admin/rental/redeem-rates'
// validation exactly, just re-authenticated via this device-scoped path.
router.post('/admin-panel/redeem-rates', (req, res) => {
  const auth = requireAdminPanelAuth(req);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  const points = parseInt(req.body?.points, 10);
  const rewardSeconds = parseInt(req.body?.reward_seconds, 10);
  if (!Number.isFinite(points) || points <= 0) {
    return res.status(400).json({ success: false, message: 'points must be a positive number' });
  }
  if (!Number.isFinite(rewardSeconds) || rewardSeconds <= 0) {
    return res.status(400).json({ success: false, message: 'reward_seconds must be a positive number' });
  }
  db.prepare('INSERT INTO rental_redeem_rates (points, reward_seconds) VALUES (?, ?)').run(points, rewardSeconds);
  return res.json({ success: true });
});

// DELETE /api/rental/admin-panel/redeem-rates/:id - {mac, device_secret,
// password} in the JSON body. No existing DELETE route in this file to
// match a mac/device_secret-in-query-vs-body precedent against (the only
// other DELETE-shaped admin-side route, /api/admin/rental/redeem-rates/:id,
// is adminAuth-gated and carries no device credentials at all) - body is
// used here since Express/fetch both support a JSON body on DELETE and it
// keeps the device_secret/password out of any URL/query string or logs.
router.delete('/admin-panel/redeem-rates/:id', (req, res) => {
  const auth = requireAdminPanelAuth(req);
  if (auth.error) return res.status(auth.error).json({ success: false, message: auth.message });

  db.prepare('DELETE FROM rental_redeem_rates WHERE id = ?').run(req.params.id);
  return res.json({ success: true });
});

// --- Windows Rental Client OTA self-update -------------------------------
// Same idea as the ESP8266 vendo firmware's own version-check/download pair
// (esp8266/firmware/rj_pisowifi_esp8266/ota.cpp), just for the Windows
// Admin Panel's "Update" button instead of the vendo hardware. Device-scoped
// via requireAdminPanelAuth exactly like every other admin-panel/* route
// above - credentials stay in the POST body, never a query string, so they
// never leak into logs.
const rentalClientDir = process.env.RENTAL_CLIENT_DIR || path.join(__dirname, '../../data/rental-client');
try {
  fs.mkdirSync(rentalClientDir, { recursive: true });
} catch (e) {
  console.warn('Warning: could not create rental client update directory:', e.message);
}
const rentalClientExePath = path.join(rentalClientDir, 'latest.exe');

// POST /api/rental/admin-panel/client-version - {mac, device_secret,
// password}. Returns the currently published client version, or an empty
// string when nothing has ever been published (never an error) - a fresh
// install with no update staged must read as "already current", exactly
// like the vendo firmware's version-check falls back to "" when unset.
// Rate-limited the same way /admin-panel/verify already is above (same
// spamService, keyed by mac since these are device-scoped routes, not by
// IP) - both were missing that gating even though they sit behind the
// same requireAdminPanelAuth password check as every other admin-panel/*
// route, on this same physically-exposed kiosk PC. Shares one bucket
// ("admin-panel-client") across version-check and download, distinct from
// verify's own bucket, since a legitimate update check-then-download is
// one two-call flow, not two independent password guesses.
router.post('/admin-panel/client-version', (req, res) => {
  const mac = req.body?.mac;
  const spamKey = `admin-panel-client:${mac}`;
  const spamCheck = checkSpam(spamKey);
  if (spamCheck.blocked) {
    return res.status(429).json({ success: false, message: spamCheck.message });
  }

  const auth = requireAdminPanelAuth(req);
  if (auth.error) {
    recordAttempt(spamKey);
    return res.status(auth.error).json({ success: false, message: auth.message });
  }
  clearAttempts(spamKey);

  const version = db.prepare("SELECT value FROM settings WHERE key = 'rental_client_version'").get()?.value || '';
  return res.json({ success: true, version });
});

// POST /api/rental/admin-panel/client-download - {mac, device_secret,
// password}. Streams back the published .exe. Same fs.existsSync-then-
// res.sendFile pattern as GET /api/admin/vendo/firmware/download in
// server/routes/admin.js - POST here (not GET) purely so credentials stay
// in the body like every other admin-panel/* route in this file.
router.post('/admin-panel/client-download', (req, res) => {
  const mac = req.body?.mac;
  const spamKey = `admin-panel-client:${mac}`;
  const spamCheck = checkSpam(spamKey);
  if (spamCheck.blocked) {
    return res.status(429).json({ success: false, message: spamCheck.message });
  }

  const auth = requireAdminPanelAuth(req);
  if (auth.error) {
    recordAttempt(spamKey);
    return res.status(auth.error).json({ success: false, message: auth.message });
  }
  clearAttempts(spamKey);

  if (!fs.existsSync(rentalClientExePath)) {
    return res.status(404).json({ success: false, message: 'No client update uploaded yet' });
  }
  res.sendFile(rentalClientExePath, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ success: false, message: 'Failed to send client update' });
    }
  });
});

module.exports = router;
