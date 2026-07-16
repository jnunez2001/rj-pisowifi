const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Pre-create upload directory on startup (Bug #16)
const uploadPath = path.join(__dirname, '../../public/portal/assets');
try {
  fs.mkdirSync(uploadPath, { recursive: true });
} catch(e) {
  console.warn('Warning: could not create upload directory:', e.message);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Double-check directory exists (Bug #16)
    if (!fs.existsSync(uploadPath)) {
      return cb(new Error('Upload directory does not exist'));
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const type = req.params.type;
    const ext = path.extname(file.originalname);
    // logo/banner are singular settings, always the same filename by design
    // (overwrite the one global image). Voucher-group logos are per-group,
    // so they need a unique filename or every group would overwrite the
    // same "voucher.png" and all print with whichever was uploaded last.
    const suffix = type === 'voucher' ? `-${Date.now()}` : '';
    cb(null, `${type}${suffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('Images only!'));
  }
});

// ESP32 vendo firmware (.bin) storage — same reasoning as DB_PATH/
// FINANCIAL_LOG_DIR living outside the app directory (server/config/
// database.js, server/services/financialLogService.js): a re-clone or
// reset of the app directory shouldn't be able to wipe out the currently-
// deployed firmware.
const firmwareDir = process.env.VENDO_FIRMWARE_DIR || path.join(__dirname, '../../data/firmware');
try {
  fs.mkdirSync(firmwareDir, { recursive: true });
} catch(e) {
  console.warn('Warning: could not create firmware directory:', e.message);
}
const firmwarePath = path.join(firmwareDir, 'latest.bin');
const firmwareUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, firmwareDir),
    filename: (req, file, cb) => cb(null, 'latest.bin'),
  }),
  limits: { fileSize: 4 * 1024 * 1024 }, // ESP32 flash partitions are well under this
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.bin') cb(null, true);
    else cb(new Error('Firmware must be a .bin file'));
  }
});

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { hashPassword, verifyPassword } = require('../utils/passwordHash');
const { encryptSecret } = require('../utils/secretCrypto');
const { getActiveSessions, expireSession, pauseSession, resumeSession } = require('../services/sessionService');
const { getRates } = require('../services/voucherService');
const { checkSpam, recordAttempt, clearAttempts } = require('../services/spamService');
const os = require('os');
const { exec, execSync, execFile } = require('child_process');

// No reverse proxy sits in front of this server (setup/nginx.conf is an
// unused empty placeholder), so the raw socket address is the real client IP.
function getRealClientIp(req) {
  const raw = (req.connection.remoteAddress || req.socket.remoteAddress || '')
    .replace('::ffff:', '').trim();
  // WAN admin access now goes through nginx (setup/nginx.conf), which always
  // connects from loopback and sets X-Forwarded-For to the real client IP.
  // Only trust that header when the TCP connection itself is from loopback —
  // a remote attacker can set whatever X-Forwarded-For they like, but they
  // cannot make their own raw socket connection originate from 127.0.0.1,
  // so this can't be spoofed by anyone except nginx itself. LAN clients
  // (never proxied — DNAT'd straight to this app) fall through to raw below.
  if (raw === '127.0.0.1' || raw === '::1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return raw;
}

// Admin auth middleware
// NOTE: Passwords stored in plaintext (Bug #10). Acceptable for offline single-admin deployments.
// For wider deployment, consider: bcrypt hashing, OAuth2, or certificate-based auth.
//
// Bug: there was no rate limiting at all here — with a plaintext password
// and no dedicated /login route (the admin panel authenticates by sending
// the password header on every request, starting with GET /settings), an
// attacker could brute-force the admin password with unlimited requests.
// Reuses the same spamService already used for coin/session-action abuse.
function adminAuth(req, res, next) {
  const ip = getRealClientIp(req);
  const spamCheck = checkSpam(`admin-auth:${ip}`);
  if (spamCheck.blocked) {
    return res.status(429).json({ success: false, message: spamCheck.message });
  }

  const { password } = req.headers;
  const settings = db.prepare(
    "SELECT value FROM settings WHERE key = 'admin_password'"
  ).get();
  if (!password || !settings || !verifyPassword(password, settings.value)) {
    recordAttempt(`admin-auth:${ip}`);
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  clearAttempts(`admin-auth:${ip}`);
  next();
}

// GET /api/admin/sessions
router.get('/sessions', adminAuth, (req, res) => {
  try {
    const sessions = getActiveSessions();
    const sessionsWithTime = sessions.map(s => ({
      ...s,
      minutes_remaining: Math.max(0, Math.floor((new Date(s.expires_at) - new Date()) / 60000))
    }));
    // Bug: `count` included paused sessions, but the dashboard/sidebar/
    // sessions-page all label this "Currently Connected"/"connected" —
    // a paused session has its internet blocked, so it isn't connected.
    // `count` is kept as the total row count (the table shows paused rows
    // too, correctly marked); `active_count` is the real "connected" number.
    const activeCount = sessionsWithTime.filter(s => s.is_paused !== 1).length;
    return res.json({
      success: true,
      sessions: sessionsWithTime,
      count: sessionsWithTime.length,
      active_count: activeCount
    });
  } catch (err) {
    console.error('Admin sessions error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/session/:code
router.delete('/session/:code', adminAuth, async (req, res) => {
  try {
    const { code } = req.params;
    await expireSession(code);
    console.log(`✂️ Admin cut session: ${code}`);
    return res.json({ success: true, message: `Session ${code} terminated` });
  } catch (err) {
    console.error('Admin cut error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/session/:code/addtime
router.post('/session/:code/addtime', adminAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const { minutes } = req.body;

    const m = parseFloat(minutes);
    if (!Number.isFinite(m) || m === 0) {
      return res.status(400).json({ success: false, message: 'Minutes must be a non-zero number' });
    }

    const session = db.prepare(
      "SELECT * FROM sessions WHERE voucher_code = ?"
    ).get(code);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    const newMinutes = Math.max(0, session.minutes_remaining + m);
    const newExpiresAt = new Date(Date.now() + newMinutes * 60 * 1000).toISOString();

    // Keep hard_expires_at in sync (Bug: admin-added time could get silently
    // wiped — resumeSession() and GET /api/session/mac/:mac both force-expire
    // once hard_expires_at passes, regardless of minutes_remaining/expires_at.
    // Shift it by the same delta being added/removed here, never letting it
    // fall behind the new expires_at.
    const currentHardExpires = new Date(session.hard_expires_at).getTime();
    const shiftedHardExpires = currentHardExpires + m * 60 * 1000;
    const newHardExpiresAt = new Date(
      Math.max(shiftedHardExpires, new Date(newExpiresAt).getTime())
    ).toISOString();

    db.prepare(`
      UPDATE sessions SET minutes_remaining = ?, expires_at = ?, hard_expires_at = ? WHERE voucher_code = ?
    `).run(newMinutes, newExpiresAt, newHardExpiresAt, code);

    // Ensure MAC is unlocked (in case of reboot)
    try {
      const { allowClient } = require('../services/networkService');
      await allowClient(session.mac_address);
    } catch(e) {}

    console.log(`➕ Admin added ${m} mins to ${code} (new total: ${newMinutes})`);
    return res.json({
      success: true,
      message: `${m > 0 ? 'Added' : 'Removed'} ${Math.abs(m)} minutes to ${code}`,
      minutes_remaining: newMinutes
    });
  } catch (err) {
    console.error('Admin addtime error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/session/:code/pause — staff-initiated pause (e.g. a
// customer at the counter asks to pause while they step out), reusing the
// exact same pauseSession() the customer-facing portal uses.
router.post('/session/:code/pause', adminAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const session = await pauseSession(code);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found or already paused' });
    }
    console.log(`⏸️ Admin paused: ${code}`);
    return res.json({ success: true, message: `Session ${code} paused`, minutes_remaining: session.minutes_remaining });
  } catch (err) {
    console.error('Admin pause error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/session/:code/resume
router.post('/session/:code/resume', adminAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const session = await resumeSession(code);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found, not paused, or hard expiration passed' });
    }
    console.log(`▶️ Admin resumed: ${code}`);
    return res.json({ success: true, message: `Session ${code} resumed`, minutes_remaining: session.minutes_remaining });
  } catch (err) {
    console.error('Admin resume error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/sales
router.get('/sales', adminAuth, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const todaySales = db.prepare(`
      SELECT COUNT(*) as transaction_count, SUM(coin_value) as total_coins, SUM(minutes_added) as total_minutes
      FROM transactions WHERE date(created_at) = ? AND type = 'coin'
    `).get(today);

    const todayPromo = db.prepare(`
      SELECT COUNT(*) as promo_count, SUM(coin_value) as promo_income
      FROM transactions WHERE date(created_at) = ? AND type = 'promo'
    `).get(today);

    const todayFree = db.prepare(`
      SELECT COUNT(*) as free_count, SUM(minutes_added) as free_minutes
      FROM transactions WHERE date(created_at) = ? AND type = 'free'
    `).get(today);

    const weekSales = db.prepare(`
      SELECT date(created_at) as date,
        SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as total,
        COUNT(*) as transactions
      FROM transactions WHERE date(created_at) >= date('now', '-7 days')
      GROUP BY date(created_at) ORDER BY date DESC
    `).all();

    // Bug: the admin UI showed "Monthly Sales" as weekTotal * 4 — a rough
    // guess, not real data (wrong the moment revenue isn't perfectly flat
    // week to week, and dashboard.html didn't even label it an estimate).
    // Compute the real month-to-date total instead.
    const monthSales = db.prepare(`
      SELECT SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as total
      FROM transactions WHERE date(created_at) >= date('now', 'start of month')
    `).get();

    // Bug: the dashboard's Daily/Weekly/Monthly chart-range buttons never
    // actually changed what was charted — every click re-rendered the same
    // fixed 7-day view. `range` now genuinely changes the granularity;
    // `week` above is kept as-is for the "This Week" stat card, which
    // should stay accurate regardless of which chart range is selected.
    const range = ['daily', 'weekly', 'monthly'].includes(req.query.range) ? req.query.range : 'weekly';
    let chart, chartFormat;
    if (range === 'daily') {
      chart = db.prepare(`
        SELECT strftime('%H:00', created_at) as label,
          SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as total,
          COUNT(*) as transactions
        FROM transactions WHERE date(created_at) = date('now')
        GROUP BY strftime('%H', created_at) ORDER BY label ASC
      `).all();
      chartFormat = 'hour';
    } else if (range === 'monthly') {
      chart = db.prepare(`
        SELECT date(created_at) as label,
          SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as total,
          COUNT(*) as transactions
        FROM transactions WHERE date(created_at) >= date('now', '-30 days')
        GROUP BY date(created_at) ORDER BY label ASC
      `).all();
      chartFormat = 'date';
    } else {
      chart = [...weekSales].reverse().map(d => ({ label: d.date, total: d.total, transactions: d.transactions }));
      chartFormat = 'date';
    }

    const recent = db.prepare(`
      SELECT * FROM transactions ORDER BY created_at DESC LIMIT 20
    `).all();

    return res.json({
      success: true,
      today: {
        coin_income: todaySales.total_coins || 0,
        promo_income: todayPromo.promo_income || 0,
        total_income: (todaySales.total_coins || 0) + (todayPromo.promo_income || 0),
        transactions: todaySales.transaction_count || 0,
        minutes_sold: todaySales.total_minutes || 0,
        free_claims: todayFree.free_count || 0,
        free_minutes: todayFree.free_minutes || 0
      },
      week: weekSales,
      month: { total_income: monthSales.total || 0 },
      chart,
      chart_format: chartFormat,
      recent_transactions: recent
    });

  } catch (err) {
    console.error('Admin sales error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/transactions/export — full transaction history for CSV
// export. /sales' recent_transactions is capped at 20 for the dashboard
// preview table; this returns everything for bookkeeping purposes.
router.get('/transactions/export', adminAuth, (req, res) => {
  try {
    const transactions = db.prepare(
      'SELECT * FROM transactions ORDER BY created_at DESC'
    ).all();
    return res.json({ success: true, transactions });
  } catch (err) {
    console.error('Admin transactions export error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/promos
router.get('/promos', adminAuth, (req, res) => {
  try {
    const promos = db.prepare('SELECT * FROM promo_vouchers ORDER BY created_at DESC').all();
    return res.json({ success: true, promos });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/promos
router.post('/promos', adminAuth, (req, res) => {
  try {
    const { duration_days, duration_minutes, price } = req.body;

    // Support both duration_minutes (new) and duration_days (old)
    const minutes = duration_minutes || (duration_days * 1440);
    const p = parseInt(price, 10);

    if (!minutes || minutes <= 0) {
      return res.status(400).json({ success: false, message: 'Duration must be a positive number' });
    }
    if (!Number.isFinite(p) || p < 0) {
      return res.status(400).json({ success: false, message: 'Price must be a non-negative number' });
    }

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = 'PROMO-';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Store as fractional days for backward compat
    const durationDays = minutes / 1440;
    db.prepare('INSERT INTO promo_vouchers (code, duration_days, price) VALUES (?, ?, ?)').run(code, durationDays, p);
    console.log(`🎫 Promo created: ${code} — ${minutes} mins`);
    return res.json({ success: true, code, duration_minutes: minutes, price: p });
  } catch (err) {
    console.error('Admin create promo error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/promos/:id
router.delete('/promos/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM promo_vouchers WHERE id = ?').run(req.params.id);
    return res.json({ success: true, message: 'Promo deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== VOUCHER GROUPS (batch creation, configurable code format) =====

function generateCustomVoucherCode(length, charset, caseOption) {
  const sets = {
    letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    numbers: '0123456789',
    mixed: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  };
  const pool = sets[charset] || sets.mixed;

  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += pool.charAt(Math.floor(Math.random() * pool.length));
    }
    if (caseOption === 'lower') {
      code = code.toLowerCase();
    } else if (caseOption === 'mixed') {
      code = code.split('').map(c => Math.random() < 0.5 ? c.toLowerCase() : c.toUpperCase()).join('');
    }
    // Bug-avoidance: promo.js's redeem normalization treats a code starting
    // with the literal prefixes "PROMO" or "RJ" specially (inserts a dash).
    // A custom-format code that happens to start with one of those would
    // get silently mangled on redemption. Regenerate rather than risk it.
    if (/^(PROMO|RJ)/.test(code)) continue;
    const exists = db.prepare('SELECT id FROM promo_vouchers WHERE code = ?').get(code);
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique code — try a longer length or wider character set');
}

// POST /api/admin/vouchers/groups — batch-create N vouchers at once with a
// configurable code format (length/charset/case), tagged together so they
// can be viewed and printed as one batch later.
router.post('/vouchers/groups', adminAuth, (req, res) => {
  try {
    const { name, quantity, duration_minutes, price, code_length, code_charset, code_case, print_caption, print_logo_url } = req.body;

    const qty = parseInt(quantity, 10);
    const minutes = parseFloat(duration_minutes);
    const p = parseInt(price, 10);
    const length = parseInt(code_length, 10);
    const charset = ['letters', 'numbers', 'mixed'].includes(code_charset) ? code_charset : 'mixed';
    const caseOption = ['upper', 'lower', 'mixed'].includes(code_case) ? code_case : 'upper';

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Group name is required' });
    }
    if (!Number.isFinite(qty) || qty < 1 || qty > 500) {
      return res.status(400).json({ success: false, message: 'Quantity must be between 1 and 500' });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ success: false, message: 'Duration must be a positive number' });
    }
    if (!Number.isFinite(p) || p < 0) {
      return res.status(400).json({ success: false, message: 'Price must be a non-negative number' });
    }
    if (!Number.isFinite(length) || length < 6 || length > 20) {
      return res.status(400).json({ success: false, message: 'Code length must be between 6 and 20' });
    }

    const insertGroup = db.prepare(`
      INSERT INTO voucher_groups (name, quantity, duration_minutes, price, print_caption, print_logo_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const groupResult = insertGroup.run(name.trim(), qty, minutes, p, print_caption || null, print_logo_url || null);
    const groupId = groupResult.lastInsertRowid;

    const durationDays = minutes / 1440;
    const insertVoucher = db.prepare(`
      INSERT INTO promo_vouchers (code, duration_days, price, group_id) VALUES (?, ?, ?, ?)
    `);

    const codes = [];
    const insertBatch = db.transaction(() => {
      for (let i = 0; i < qty; i++) {
        const code = generateCustomVoucherCode(length, charset, caseOption);
        insertVoucher.run(code, durationDays, p, groupId);
        codes.push(code);
      }
    });
    insertBatch();

    console.log(`🎫 Voucher group created: "${name}" — ${qty} codes, ${minutes} mins each`);
    return res.json({ success: true, group_id: groupId, codes });
  } catch (err) {
    console.error('Admin create voucher group error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// GET /api/admin/vouchers/groups — list all groups with usage counts
router.get('/vouchers/groups', adminAuth, (req, res) => {
  try {
    const groups = db.prepare(`
      SELECT g.*,
        COUNT(v.id) as actual_count,
        SUM(CASE WHEN v.status = 'unused' THEN 1 ELSE 0 END) as unused_count,
        SUM(CASE WHEN v.status != 'unused' THEN 1 ELSE 0 END) as used_count
      FROM voucher_groups g
      LEFT JOIN promo_vouchers v ON v.group_id = g.id
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `).all();
    return res.json({ success: true, groups });
  } catch (err) {
    console.error('Admin list voucher groups error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/vouchers/groups/:id — a group's vouchers, for printing
router.get('/vouchers/groups/:id', adminAuth, (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM voucher_groups WHERE id = ?').get(req.params.id);
    if (!group) {
      return res.status(404).json({ success: false, message: 'Voucher group not found' });
    }
    const vouchers = db.prepare('SELECT * FROM promo_vouchers WHERE group_id = ? ORDER BY id ASC').all(req.params.id);
    return res.json({ success: true, group, vouchers });
  } catch (err) {
    console.error('Admin get voucher group error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/vouchers/groups/:id — deletes the group and its vouchers
router.delete('/vouchers/groups/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM promo_vouchers WHERE group_id = ?').run(req.params.id);
    db.prepare('DELETE FROM voucher_groups WHERE id = ?').run(req.params.id);
    return res.json({ success: true, message: 'Voucher group deleted' });
  } catch (err) {
    console.error('Admin delete voucher group error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/rates
router.get('/rates', adminAuth, (req, res) => {
  try {
    const rates = getRates();
    return res.json({ success: true, rates });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/rates
router.post('/rates', adminAuth, (req, res) => {
  try {
    const { coin_value, minutes, expiration_minutes, label } = req.body;

    // Validate inputs
    const cv = parseInt(coin_value, 10);
    const m = parseInt(minutes, 10);
    const em = parseInt(expiration_minutes, 10);

    if (!Number.isFinite(cv) || cv <= 0) {
      return res.status(400).json({ success: false, message: 'coin_value must be a positive number' });
    }
    if (!Number.isFinite(m) || m <= 0) {
      return res.status(400).json({ success: false, message: 'minutes must be a positive number' });
    }
    if (!Number.isFinite(em) || em <= 0) {
      return res.status(400).json({ success: false, message: 'expiration_minutes must be a positive number' });
    }
    if (!label || label.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'label is required' });
    }

    db.prepare('INSERT INTO rates (coin_value, minutes, expiration_minutes, label) VALUES (?, ?, ?, ?)').run(cv, m, em, label.trim());
    return res.json({ success: true, message: 'Rate added' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/admin/rates/:id
router.put('/rates/:id', adminAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { coin_value, minutes, expiration_minutes, label } = req.body;

    // Validate inputs
    const cv = parseInt(coin_value, 10);
    const m = parseInt(minutes, 10);
    const em = parseInt(expiration_minutes, 10);

    if (!Number.isFinite(cv) || cv <= 0) {
      return res.status(400).json({ success: false, message: 'coin_value must be a positive number' });
    }
    if (!Number.isFinite(m) || m <= 0) {
      return res.status(400).json({ success: false, message: 'minutes must be a positive number' });
    }
    if (!Number.isFinite(em) || em <= 0) {
      return res.status(400).json({ success: false, message: 'expiration_minutes must be a positive number' });
    }
    if (!label || label.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'label is required' });
    }

    db.prepare('UPDATE rates SET coin_value = ?, minutes = ?, expiration_minutes = ?, label = ? WHERE id = ?').run(cv, m, em, label.trim(), id);
    return res.json({ success: true, message: 'Rate updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/rates/:id
router.delete('/rates/:id', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM rates WHERE id = ?').run(req.params.id);
    return res.json({ success: true, message: 'Rate deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/settings
router.get('/settings', adminAuth, (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings').all();
    const settingsObj = {};
    const sensitiveKeys = ['admin_password', 'admin_username', 'mikrotik_pass'];
    settings.forEach(s => {
      if (!sensitiveKeys.includes(s.key)) settingsObj[s.key] = s.value;
    });
    // The raw/encrypted password never leaves this endpoint, but the admin
    // panel still needs to know a password IS saved so it can show a
    // masked placeholder instead of always looking blank (which made it
    // look like nothing was ever saved, even though it was).
    const mikrotikPass = settings.find(s => s.key === 'mikrotik_pass');
    settingsObj.mikrotik_pass_set = !!(mikrotikPass && mikrotikPass.value);
    return res.json({ success: true, settings: settingsObj });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/router/password — reveals the saved MikroTik password on
// demand. Deliberately a separate endpoint from GET /settings (which never
// includes it) so the plaintext password is only ever sent to the browser
// when an authenticated admin explicitly clicks "Show," not on every page
// load.
router.get('/router/password', adminAuth, (req, res) => {
  try {
    const { decryptSecret } = require('../utils/secretCrypto');
    const row = db.prepare("SELECT value FROM settings WHERE key = 'mikrotik_pass'").get();
    const password = row && row.value ? decryptSecret(row.value) : '';
    res.json({ success: true, password });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not retrieve password' });
  }
});

// POST /api/admin/settings
router.post('/settings', adminAuth, (req, res) => {
  try {
    const updates = req.body;
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'admin_password') {
        // Never store the raw password (Bug: was plaintext at rest).
        // Setting a new one always counts as satisfying the forced-change
        // requirement, whether this is the first change or a routine one.
        upsert.run('admin_password', hashPassword(String(value)));
        upsert.run('must_change_password', '0');
        continue;
      }
      if (key === 'mikrotik_pass') {
        // Router credentials have real resale value here — never store raw
        // (Bug: was plaintext at rest, same class as admin_password above).
        // Blank means "leave current value alone" (matches the frontend's
        // "leave blank to keep current" pattern for admin_password).
        if (String(value) !== '') {
          upsert.run('mikrotik_pass', encryptSecret(String(value)));
        }
        continue;
      }
      upsert.run(key, String(value));
    }
    console.log('⚙️ Settings updated:', Object.keys(updates).join(', '));
    return res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/spam-settings
router.get('/spam-settings', adminAuth, (req, res) => {
  try {
    const getSetting = (key, def) => {
      const s = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return s ? s.value : def;
    };
    return res.json({
      success: true,
      enable_bandwidth_cap: getSetting('enable_bandwidth_cap', '0'),
      bandwidth_cap_download_mbps: getSetting('bandwidth_cap_download_mbps', '5'),
      bandwidth_cap_upload_mbps: getSetting('bandwidth_cap_upload_mbps', '5'),
      enable_bandwidth_burst: getSetting('enable_bandwidth_burst', '0'),
      bandwidth_burst_mbps: getSetting('bandwidth_burst_mbps', '20'),
      bandwidth_burst_seconds: getSetting('bandwidth_burst_seconds', '8'),
      max_mbps: getSetting('max_mbps', '5'),
      spam_max_attempts: getSetting('spam_max_attempts', '3'),
      spam_block_minutes: getSetting('spam_block_minutes', '1')
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/spam-settings
router.post('/spam-settings', adminAuth, (req, res) => {
  try {
    const { enable_bandwidth_cap, bandwidth_cap_download_mbps, bandwidth_cap_upload_mbps, enable_bandwidth_burst, bandwidth_burst_mbps, bandwidth_burst_seconds, max_mbps, spam_max_attempts, spam_block_minutes } = req.body;
    const updateSetting = (key, value) => {
      if (value === undefined) return;
      const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
      if (existing) {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value), key);
      } else {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
      }
    };
    updateSetting('enable_bandwidth_cap', enable_bandwidth_cap);
    updateSetting('bandwidth_cap_download_mbps', bandwidth_cap_download_mbps);
    updateSetting('bandwidth_cap_upload_mbps', bandwidth_cap_upload_mbps);
    updateSetting('enable_bandwidth_burst', enable_bandwidth_burst);
    updateSetting('bandwidth_burst_mbps', bandwidth_burst_mbps);
    updateSetting('bandwidth_burst_seconds', bandwidth_burst_seconds);
    updateSetting('max_mbps', max_mbps);
    updateSetting('spam_max_attempts', spam_max_attempts);
    updateSetting('spam_block_minutes', spam_block_minutes);
    console.log('⚙️ Spam/bandwidth settings updated');
    return res.json({ success: true, message: 'Settings updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/upload/:type
router.post('/upload/:type', adminAuth, upload.single('image'), (req, res) => {
  try {
    const { type } = req.params;
    if (!['logo', 'banner', 'voucher'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Type must be logo, banner, or voucher' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const fileUrl = `/portal/assets/${req.file.filename}`;

    // 'voucher' logos belong to a specific voucher_groups row (passed in by
    // the caller when creating the group), not a single global setting.
    if (type === 'voucher') {
      console.log(`📸 Uploaded voucher logo: ${fileUrl}`);
      return res.json({ success: true, url: fileUrl, message: 'Logo uploaded successfully' });
    }

    const key = type === 'logo' ? 'logo_url' : 'banner_url';
    const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
    if (existing) {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(fileUrl, key);
    } else {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, fileUrl);
    }
    console.log(`📸 Uploaded ${type}: ${fileUrl}`);
    return res.json({ success: true, url: fileUrl, message: `${type} uploaded successfully` });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// GET /api/admin/assets
router.get('/assets', adminAuth, (req, res) => {
  try {
    const logo = db.prepare("SELECT value FROM settings WHERE key = 'logo_url'").get();
    const banner = db.prepare("SELECT value FROM settings WHERE key = 'banner_url'").get();
    return res.json({
      success: true,
      logo_url: logo ? logo.value : null,
      banner_url: banner ? banner.value : null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/backup
router.get('/backup', adminAuth, (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings').all();
    const settingsObj = {};
    settings.forEach(s => { settingsObj[s.key] = s.value; });

    const rates = db.prepare('SELECT * FROM rates ORDER BY coin_value ASC').all();
    const promos = db.prepare('SELECT * FROM promo_vouchers ORDER BY created_at DESC').all();
    const transactions = db.prepare('SELECT * FROM transactions ORDER BY created_at DESC').all();

    const backup = {
      version: '1.0.0',
      exported_at: new Date().toISOString(),
      settings: settingsObj,
      rates,
      promo_vouchers: promos,
      transactions
    };

    console.log('💾 Backup exported');
    return res.json({ success: true, backup });
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ success: false, message: 'Backup failed' });
  }
});

// POST /api/admin/restore
router.post('/restore', adminAuth, (req, res) => {
  try {
    const { backup } = req.body;

    if (!backup || !backup.version) {
      return res.status(400).json({ success: false, message: 'Invalid backup file' });
    }

    // Validate backup structure (Bug #18)
    if (backup.rates && !Array.isArray(backup.rates)) {
      return res.status(400).json({ success: false, message: 'Invalid rates format' });
    }
    if (backup.promo_vouchers && !Array.isArray(backup.promo_vouchers)) {
      return res.status(400).json({ success: false, message: 'Invalid promo_vouchers format' });
    }
    if (backup.transactions && !Array.isArray(backup.transactions)) {
      return res.status(400).json({ success: false, message: 'Invalid transactions format' });
    }

    if (backup.settings) {
      const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(backup.settings)) {
        upsert.run(key, String(value));
      }
    }

    if (backup.rates && backup.rates.length > 0) {
      db.prepare('DELETE FROM rates').run();
      const insertRate = db.prepare(
        'INSERT INTO rates (coin_value, minutes, expiration_minutes, label) VALUES (?, ?, ?, ?)'
      );
      for (const r of backup.rates) {
        // Skip ID to prevent conflicts (Bug #19) — let DB auto-increment
        if (!r.coin_value || !r.minutes || !r.expiration_minutes || !r.label) {
          throw new Error('Invalid rate data');
        }
        insertRate.run(r.coin_value, r.minutes, r.expiration_minutes, r.label);
      }
    }

    if (backup.promo_vouchers && backup.promo_vouchers.length > 0) {
      db.prepare('DELETE FROM promo_vouchers').run();
      const insertPromo = db.prepare(
        'INSERT INTO promo_vouchers (code, duration_days, price, status, mac_address, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const p of backup.promo_vouchers) {
        // Skip ID to prevent conflicts (Bug #19)
        if (!p.code || !p.duration_days) {
          throw new Error('Invalid promo data');
        }
        insertPromo.run(p.code, p.duration_days, p.price || 0, p.status || 'unused', p.mac_address || null, p.created_at || new Date().toISOString(), p.expires_at || null);
      }
    }

    if (backup.transactions && backup.transactions.length > 0) {
      db.prepare('DELETE FROM transactions').run();
      const insertTx = db.prepare(
        'INSERT INTO transactions (voucher_code, coin_value, minutes_added, type, created_at) VALUES (?, ?, ?, ?, ?)'
      );
      for (const t of backup.transactions) {
        // Skip ID to prevent conflicts (Bug #19)
        if (!t.voucher_code || typeof t.minutes_added !== 'number') {
          throw new Error('Invalid transaction data');
        }
        insertTx.run(t.voucher_code, t.coin_value || 0, t.minutes_added, t.type || 'coin', t.created_at || new Date().toISOString());
      }
    }

    console.log('♻️ Restore completed with validation');
    return res.json({ success: true, message: 'Restore completed successfully' });
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ success: false, message: 'Restore failed: ' + err.message });
  }
});

// Bug: the Dashboard's "WiFi AP" status badge was hardcoded HTML
// ("Online", no id, nothing ever touches it) — it would say Online even
// if the AP interface were physically down. Checks the actual LAN
// interface link state (same interface bandwidth shaping already targets).
function getWifiApStatus() {
  try {
    const lanIf = db.prepare("SELECT value FROM settings WHERE key = 'lan_interface'").get()?.value || 'enp0s8';
    const output = execSync(`ip link show ${lanIf}`, { timeout: 2000 }).toString();
    if (/state UP/.test(output)) return 'up';
    if (/state DOWN/.test(output)) return 'down';
    return 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

// Bug: os.cpus()[i].times are cumulative tick counts since the system
// booted, not since the last check — computing usage from a single
// snapshot gives "average load since boot" (barely moves, and on a
// server that's been up for weeks looks nothing like current load).
// Real usage needs two samples with a delay and the delta between them.
async function getCpuUsagePercents(cpusBefore, sampleMs = 300) {
  await new Promise(resolve => setTimeout(resolve, sampleMs));
  const cpusAfter = os.cpus();
  return cpusBefore.map((before, i) => {
    const after = cpusAfter[i].times;
    const idleDelta = after.idle - before.times.idle;
    const totalDelta = Object.keys(after).reduce(
      (sum, key) => sum + (after[key] - before.times[key]), 0
    );
    return totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
  });
}

// Bug: os.freemem() counts reclaimable page cache/buffers as "used" —
// on Linux that overstates real memory pressure (this project's docs
// elsewhere are explicit about caring about accurate RAM usage on
// low-spec hardware). /proc/meminfo's MemAvailable is the real figure
// `free -m`'s "available" column uses; fall back to os.freemem() where
// that file doesn't exist (non-Linux, or old kernels pre-3.14).
function getAvailableMem() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (match) return parseInt(match[1], 10) * 1024;
  } catch (e) {}
  return os.freemem();
}

// GET /api/admin/sysinfo
router.get('/sysinfo', adminAuth, async (req, res) => {
  try {
    const cpus = os.cpus();
    const cpuUsage = await getCpuUsagePercents(cpus);

    const totalMem = os.totalmem();
    const freeMem = getAvailableMem();
    const usedMem = totalMem - freeMem;

    const uptimeSecs = os.uptime();
    const days = Math.floor(uptimeSecs / 86400);
    const hours = Math.floor((uptimeSecs % 86400) / 3600);
    const mins = Math.floor((uptimeSecs % 3600) / 60);
    const uptime = `${days}d ${hours}h ${mins}m`;
    // Bug: the Dashboard's "Server Uptime" widget never called this endpoint
    // at all — it ran its own client-side timer starting from page load, so
    // every browser refresh reset it to 00:00:00 regardless of how long the
    // actual server had been running. Raw seconds let it seed a real base.
    const uptimeSeconds = Math.floor(uptimeSecs);

    const nets = os.networkInterfaces();
    let ipAddress = 'N/A';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          ipAddress = net.address;
          break;
        }
      }
      if (ipAddress !== 'N/A') break;
    }

    let machineId = 'N/A';
    try {
      machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    } catch(e) {}

    let gateway = 'N/A';
    try {
      const route = execSync('ip route show default', { timeout: 2000 }).toString();
      const match = route.match(/via\s+(\S+)/);
      if (match) gateway = match[1];
    } catch(e) {}

    let storage = { total: 'N/A', used: 'N/A', free: 'N/A', percent: 0 };
    try {
      const df = execSync('df -h / --output=size,used,avail,pcent', { timeout: 2000 }).toString();
      const lines = df.trim().split('\n');
      if (lines[1]) {
        const parts = lines[1].trim().split(/\s+/);
        storage = {
          total: parts[0],
          used: parts[1],
          free: parts[2],
          percent: parseInt(parts[3]) || 0
        };
      }
    } catch(e) {}

    const licenseSetting = db.prepare(
      "SELECT value FROM settings WHERE key = 'license'"
    ).get();
    const license = licenseSetting ? licenseSetting.value : 'Private';
    const wifiApStatus = getWifiApStatus();
    const hardwareTier = require('../services/hardwareDetection').detect();

    return res.json({
      success: true,
      sysinfo: {
        platform: os.type() + ' ' + os.release(),
        processor: cpus[0].model,
        cpu_cores: cpus.length,
        cpu_usage: cpuUsage,
        total_mem: totalMem,
        used_mem: usedMem,
        free_mem: freeMem,
        mem_percent: Math.round((usedMem / totalMem) * 100),
        uptime,
        wifi_ap_status: wifiApStatus,
        uptime_seconds: uptimeSeconds,
        ip_address: ipAddress,
        gateway,
        machine_id: machineId,
        storage,
        version: 'v' + require('../../package.json').version,
        license,
        hardware_tier: hardwareTier
      }
    });

  } catch (err) {
    console.error('Sysinfo error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/vendo/register
// Bug: this required adminAuth, but it's called by the ESP32 vendo
// hardware itself (on boot, and every ~60s as a heartbeat) — the firmware
// has no admin password and was never built to send one, so every single
// registration/heartbeat call has always been silently rejected with 401.
// In practice this meant the Devices page and the Dashboard's "Coin Slot"
// status could never show a real vendo as online. Matches the existing
// unauthenticated-trusted-LAN-hardware pattern already used for POST
// /api/coin (also called directly by the ESP32, also no admin password).
router.post('/vendo/register', (req, res) => {
  try {
    const { name, ip, version } = req.body;

    if (!req.body.mac || !name) {
      return res.status(400).json({ success: false, message: 'MAC and name required' });
    }

    // Normalize casing — vendos.mac_address is UNIQUE with an ON CONFLICT
    // upsert below, which only matches same-case duplicates.
    const mac = String(req.body.mac).trim().toLowerCase();

    db.prepare(`
      INSERT INTO vendos (mac_address, name, ip_address, firmware, last_seen)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mac_address) DO UPDATE SET
        name = excluded.name,
        ip_address = excluded.ip_address,
        firmware = excluded.firmware,
        last_seen = CURRENT_TIMESTAMP
    `).run(mac, name, ip || '', version || '');

    // No auth on this route (see note above) means anyone on the LAN could
    // otherwise POST a fake ip here and hijack vendo_ip — the address
    // portal.js's /relay/:action route sends every "Insert Coin" relay
    // trigger to. Confining it to private LAN ranges at least keeps a
    // hijack attempt on-network rather than redirecting relay calls to an
    // arbitrary external address.
    const isPrivateLanIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip || '');
    if (ip && isPrivateLanIp) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run('vendo_ip', ip);
    }

    console.log(`📡 Vendo registered: ${name} (${mac}) at ${ip}`);
    return res.json({ success: true, message: 'Vendo registered' });

  } catch (err) {
    console.error('Vendo register error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/vendo/firmware — current pushed version, for the Devices
// page's own display (admin-authenticated, this one's a UI read, not
// something the ESP32 itself needs to call).
router.get('/vendo/firmware', adminAuth, (req, res) => {
  try {
    const version = db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_version'").get()?.value || null;
    const uploadedAt = db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_uploaded_at'").get()?.value || null;
    const hasFile = fs.existsSync(firmwarePath);
    return res.json({ success: true, version, uploaded_at: uploadedAt, has_file: hasFile });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/vendo/firmware — push a new firmware .bin (compiled via
// Arduino IDE's Sketch > Export Compiled Binary) for every ESP32 vendo to
// pick up over its next OTA check (esp32/firmware/rj_pisowifi/ota.cpp),
// instead of needing a USB cable and Arduino IDE on-site for every update.
router.post('/vendo/firmware', adminAuth, firmwareUpload.single('firmware'), (req, res) => {
  try {
    const { version } = req.body;
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No firmware file uploaded' });
    }
    if (!version || !String(version).trim()) {
      return res.status(400).json({ success: false, message: 'Version is required (must match FIRMWARE_VERSION in config.h)' });
    }
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    upsert.run('vendo_firmware_version', String(version).trim());
    // devices.js's timeAgo() expects SQLite's own CURRENT_TIMESTAMP shape
    // ("YYYY-MM-DD HH:MM:SS", space-separated, no "Z") - a plain
    // toISOString() has a "T" and trailing "Z" already, which timeAgo()'s
    // own "add a Z" step would double up into an unparseable string.
    upsert.run('vendo_firmware_uploaded_at', new Date().toISOString().slice(0, 19).replace('T', ' '));
    console.log(`📦 Vendo firmware updated: ${version}`);
    return res.json({ success: true, message: 'Firmware uploaded — vendos will pick it up on their next check-in' });
  } catch (err) {
    console.error('Vendo firmware upload error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/vendo/firmware/version — unauthenticated, same reasoning
// as /vendo/register above: called directly by ESP32 firmware with no
// admin password. Just the version string so a device can cheaply decide
// whether it needs to bother downloading the actual binary.
router.get('/vendo/firmware/version', (req, res) => {
  try {
    const version = db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_version'").get()?.value || '';
    return res.json({ version });
  } catch (err) {
    res.status(500).json({ version: '' });
  }
});

// GET /api/admin/vendo/firmware/download — unauthenticated, same reasoning
// as above. Serves the raw .bin an ESP32 flashes itself with via ota.cpp.
router.get('/vendo/firmware/download', (req, res) => {
  if (!fs.existsSync(firmwarePath)) {
    return res.status(404).json({ success: false, message: 'No firmware uploaded yet' });
  }
  res.sendFile(firmwarePath, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ success: false, message: 'Failed to send firmware' });
    }
  });
});

// GET /api/admin/vendos
router.get('/vendos', adminAuth, (req, res) => {
  try {
    const vendos = db.prepare(`SELECT * FROM vendos ORDER BY last_seen DESC`).all();
    return res.json({ success: true, vendos });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/vendos/:id — removes a stale/replaced ESP32 entry from
// the Devices list. Purely a DB row (the device re-registers itself via
// POST /vendo/register on its next check-in if it's still actually live),
// so this is safe to use for "that unit got swapped out" or "that MAC is
// a dead board" cleanup without any live-access side effects.
router.delete('/vendos/:id', adminAuth, (req, res) => {
  try {
    const vendo = db.prepare('SELECT * FROM vendos WHERE id = ?').get(req.params.id);
    if (!vendo) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }
    db.prepare('DELETE FROM vendos WHERE id = ?').run(req.params.id);
    console.log(`🗑️  Vendo removed: ${vendo.mac_address} (${vendo.name})`);
    return res.json({ success: true, message: 'Device removed' });
  } catch (err) {
    console.error('Vendo delete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== TRUSTED DEVICES =====
// Devices that should always have internet access, never gated behind
// payment (see database.js's trusted_devices table comment for why this
// exists — a coin-slot ESP32 sharing WiFi with paying customers because
// the access point can't reliably tag a second SSID onto its own VLAN,
// bugslog.md Bug #78). Trusting a device calls the same allowClient()
// bypass a paid session uses, works identically in both standalone and
// router mode since networkService.js already picks the right backend.

// GET /api/admin/trusted-devices
router.get('/trusted-devices', adminAuth, (req, res) => {
  try {
    const devices = db.prepare('SELECT * FROM trusted_devices ORDER BY created_at DESC').all();
    return res.json({ success: true, devices });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/trusted-devices
router.post('/trusted-devices', adminAuth, async (req, res) => {
  try {
    const { mac_address, label } = req.body;
    const mac = String(mac_address || '').trim().toLowerCase();
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
      return res.status(400).json({ success: false, message: 'Invalid MAC address' });
    }

    const existing = db.prepare('SELECT id FROM trusted_devices WHERE mac_address = ?').get(mac);
    if (existing) {
      return res.status(409).json({ success: false, message: 'This device is already trusted' });
    }

    const result = db.prepare(
      'INSERT INTO trusted_devices (mac_address, label) VALUES (?, ?)'
    ).run(mac, String(label || '').trim());

    const { allowClient } = require('../services/networkService');
    try {
      await allowClient(mac);
    } catch (err) {
      // Row is saved either way — timerService.js's boot-time restore will
      // retry the actual bypass later (e.g. router unreachable right now).
      console.error('Trusted device saved but bypass failed to apply immediately:', err.message);
    }

    console.log(`🔓 Trusted device added: ${mac} (${label || 'no label'})`);
    return res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Trusted device add error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/trusted-devices/:id
router.delete('/trusted-devices/:id', adminAuth, async (req, res) => {
  try {
    const device = db.prepare('SELECT * FROM trusted_devices WHERE id = ?').get(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, message: 'Trusted device not found' });
    }

    db.prepare('DELETE FROM trusted_devices WHERE id = ?').run(req.params.id);

    const { blockClient } = require('../services/networkService');
    try {
      await blockClient(device.mac_address);
    } catch (err) {
      console.error('Trusted device removed from list but revoking access failed:', err.message);
    }

    console.log(`🔒 Trusted device removed: ${device.mac_address}`);
    return res.json({ success: true, message: 'Trusted device removed' });
  } catch (err) {
    console.error('Trusted device remove error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/check-update
router.get('/check-update', adminAuth, async (req, res) => {
  try {
    const pkg = require('../../package.json');
    const currentVersion = pkg.version;

    const https = require('https');
    const options = {
      hostname: 'api.github.com',
      path: '/repos/jnunez2001/rj-pisowifi/releases/latest',
      headers: { 'User-Agent': 'RJ-PisoWifi' }
    };

    const req = https.get(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const release = JSON.parse(data);
          const latestVersion = release.tag_name?.replace('v', '') || currentVersion;
          const hasUpdate = latestVersion !== currentVersion;
          return res.json({
            success: true,
            current_version: currentVersion,
            latest_version: latestVersion,
            has_update: hasUpdate,
            release_notes: release.body || '',
            release_name: release.name || `v${latestVersion}`
          });
        } catch(e) {
          return res.json({
            success: true,
            current_version: currentVersion,
            latest_version: currentVersion,
            has_update: false,
            release_notes: ''
          });
        }
      });
    }).on('error', () => {
      return res.json({
        success: true,
        current_version: currentVersion,
        latest_version: currentVersion,
        has_update: false,
        release_notes: ''
      });
    });

    // Timeout after 5 seconds
    req.setTimeout(5000, () => {
      req.destroy();
      return res.json({
        success: true,
        current_version: currentVersion,
        latest_version: currentVersion,
        has_update: false,
        release_notes: ''
      });
    });

  } catch(err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/install-update (Bug #21 - verify git state before pulling)
router.post('/install-update', adminAuth, (req, res) => {
  const appDir = process.cwd();

  // Safety checks before pulling (Bug #21)
  try {
    // Verify it's a git repo
    execSync('git rev-parse --git-dir', { cwd: appDir });
    // Verify remote is https://github.com/jnunez2001/rj-pisowifi (trusted)
    const remoteUrl = execSync('git config --get remote.origin.url', { cwd: appDir }).toString().trim();
    if (!remoteUrl.includes('jnunez2001/rj-pisowifi')) {
      console.error('❌ Remote URL mismatch:', remoteUrl);
      return res.status(400).json({ success: false, message: 'Git remote misconfigured' });
    }
  } catch(e) {
    console.error('❌ Git verification failed:', e.message);
    return res.status(400).json({ success: false, message: 'Git repository invalid' });
  }

  res.json({ success: true, message: 'Update started! Server will restart shortly.' });
  setTimeout(() => {
    exec(`cd ${appDir} && git pull`, (err, stdout) => {
      if (err) { console.error('Git pull error:', err); return; }
      console.log('Git pull:', stdout);
      exec('sudo systemctl restart rj-pisowifi', (err) => {
        if (err) console.error('Restart error:', err);
        else console.log('✅ Updated and restarted!');
      });
    });
  }, 500);
});

// GET /api/admin/version
router.get('/version', adminAuth, (req, res) => {
  const pkg = require('../../package.json');
  res.json({ success: true, version: pkg.version });
});

// POST /api/admin/system/reboot — the admin panel requires typing "REBOOT"
// before this fires, but the server checks the exact same word again
// server-side too, since a client-side-only check is trivially bypassable
// by anyone calling the API directly (this is a real power action, not a
// cosmetic one). Uses execFile (Bug #22 pattern) — no shell interpolation.
router.post('/system/reboot', adminAuth, (req, res) => {
  if (req.body.confirm !== 'REBOOT') {
    return res.status(400).json({ success: false, message: 'Confirmation text did not match' });
  }
  console.log('🔄 Admin triggered server reboot');
  res.json({ success: true, message: 'Rebooting now — this may take a minute.' });
  setTimeout(() => {
    execFile('sudo', ['reboot'], (err) => {
      if (err) console.error('Reboot command failed:', err.message);
    });
  }, 500);
});

// POST /api/admin/system/shutdown — same server-side confirmation
// requirement as reboot above. Unlike reboot, this does NOT come back on
// its own — flagged clearly in the confirmation dialog on the frontend.
router.post('/system/shutdown', adminAuth, (req, res) => {
  if (req.body.confirm !== 'SHUTDOWN') {
    return res.status(400).json({ success: false, message: 'Confirmation text did not match' });
  }
  console.log('🛑 Admin triggered server shutdown');
  res.json({ success: true, message: 'Shutting down now.' });
  setTimeout(() => {
    execFile('sudo', ['shutdown', '-h', 'now'], (err) => {
      if (err) console.error('Shutdown command failed:', err.message);
    });
  }, 500);
});

const { applyNetworkConfig } = require('../services/hostNetworkService');

// POST /api/admin/network (Bug #22 - use execFile for safer execution)
router.post('/network', adminAuth, (req, res) => {
  try {
    const { type, ip, gateway, dns, subnet } = req.body;

    // Validate input (Bug #22 - path traversal defense)
    if (!['dhcp', 'static'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid network type' });
    }
    if (type === 'static' && (!ip || !gateway)) {
      return res.status(400).json({ success: false, message: 'IP and gateway required for static' });
    }

    applyNetworkConfig({ type, ip, gateway, dns, subnet })
      .then(() => {
        // All commands succeeded — update settings
        const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        upsert.run('network_type', type);
        upsert.run('static_ip', ip || '');
        upsert.run('static_gateway', gateway || '');
        upsert.run('static_dns', dns || '8.8.8.8');
        upsert.run('static_subnet', subnet || '24');

        console.log(`🌐 Network changed to: ${type}`);
        return res.json({ success: true, message: `Network set to ${type}` });
      })
      .catch((err) => {
        console.error('Network apply error:', err);
        res.status(500).json({ success: false, message: 'Failed to apply network settings' });
      });
  } catch(err) {
    console.error('Network error:', err);
    res.status(500).json({ success: false, message: 'Failed to apply network settings' });
  }
});

// GET /api/admin/network
router.get('/network', adminAuth, (req, res) => {
  try {
    const getSetting = (key, def) => {
      const s = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return s ? s.value : def;
    };
    return res.json({
      success: true,
      type: getSetting('network_type', 'dhcp'),
      ip: getSetting('static_ip', ''),
      gateway: getSetting('static_gateway', ''),
      dns: getSetting('static_dns', '8.8.8.8'),
      subnet: getSetting('static_subnet', '24')
    });
  } catch(err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== ADMIN PORTAL ADDRESS (renamable .local mDNS hostname) =====
// Was previously fixed to whatever install.sh baked in at setup time
// ("rjcyberzone.local"), with no way to change it afterward short of SSHing
// in. Reads the live system hostname directly (os.hostname()) rather than
// a settings-table value, so this can never drift from what avahi is
// actually advertising.
const HOSTNAME_REGEX = /^[a-zA-Z0-9-]{1,63}$/;

router.get('/hostname', adminAuth, (req, res) => {
  try {
    res.json({ success: true, hostname: os.hostname() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not read hostname' });
  }
});

router.post('/hostname', adminAuth, (req, res) => {
  const { hostname } = req.body;
  if (!hostname || !HOSTNAME_REGEX.test(hostname)) {
    return res.status(400).json({
      success: false,
      message: 'Hostname can only contain letters, numbers, and hyphens (max 63 characters)'
    });
  }

  execFile('sudo', ['hostnamectl', 'set-hostname', hostname], { timeout: 5000 }, (err) => {
    if (err) {
      console.error('Hostname change error:', err);
      return res.status(500).json({ success: false, message: 'Failed to change hostname' });
    }

    execFile('sudo', ['systemctl', 'restart', 'avahi-daemon'], { timeout: 5000 }, (err2) => {
      if (err2) {
        console.error('Avahi restart error:', err2);
        return res.status(500).json({ success: false, message: 'Hostname changed but failed to restart mDNS service' });
      }

      console.log(`🌐 Admin hostname changed to: ${hostname}.local`);
      res.json({ success: true, hostname, message: `Admin panel now reachable at ${hostname}.local` });
    });
  });
});

// ===== VLAN MANAGEMENT =====
// Lets an owner reproduce the "everything on one unmanaged switch, VLAN
// tags separate the traffic" wiring pattern common in other piso-wifi
// setups: an ISP that requires a VLAN-tagged uplink (mode 'wan'), and/or
// an access point tagging customer WiFi traffic to keep it off the ISP's
// wire (mode 'lan'). Applying a change re-runs setup-network.sh so the
// owner never has to SSH in and run it by hand.

function applyNetworkSetup(callback) {
  const scriptPath = path.join(__dirname, '../../setup/setup-network.sh');
  execFile('sudo', ['bash', scriptPath], { timeout: 20000 }, (err) => {
    if (err) console.error('setup-network.sh re-apply failed:', err.message);
    if (callback) callback(err);
  });
}

// GET /api/admin/network/interfaces — physical interfaces available as a
// VLAN base (wired/wireless naming only, skips loopback/virtual ones this
// script itself creates like nft/tc-managed devices or prior VLAN subs).
router.get('/network/interfaces', adminAuth, (req, res) => {
  try {
    if (!fs.existsSync('/sys/class/net')) {
      // Not on Linux (e.g. local dev on Windows) - nothing to list.
      return res.json({ success: true, interfaces: [] });
    }
    const names = fs.readdirSync('/sys/class/net').filter(n =>
      /^(eth|enp|ens|enx|wlan|wlx|wlp)/.test(n) && !n.includes('.')
    );
    const interfaces = names.map(name => {
      let operstate = 'unknown';
      try {
        operstate = fs.readFileSync(`/sys/class/net/${name}/operstate`, 'utf8').trim();
      } catch (e) {}
      let mac = '';
      try {
        mac = fs.readFileSync(`/sys/class/net/${name}/address`, 'utf8').trim();
      } catch (e) {}
      return { name, status: operstate, mac };
    });
    return res.json({ success: true, interfaces });
  } catch (err) {
    console.error('Interfaces list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/network/vlans
router.get('/network/vlans', adminAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM vlans ORDER BY id DESC').all();
    const vlans = rows.map(v => {
      const ifName = `${v.base_interface}.${v.vlan_id}`;
      let status = 'down';
      try {
        status = fs.readFileSync(`/sys/class/net/${ifName}/operstate`, 'utf8').trim();
      } catch (e) {}
      return { ...v, interface_name: ifName, status };
    });
    return res.json({ success: true, vlans });
  } catch (err) {
    console.error('VLAN list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/network/vlans
router.post('/network/vlans', adminAuth, (req, res) => {
  try {
    const { base_interface, vlan_id, mode, protocol, static_ip, static_gateway, static_netmask } = req.body;

    if (!base_interface || !/^[a-zA-Z0-9]+$/.test(base_interface)) {
      return res.status(400).json({ success: false, message: 'Invalid base interface' });
    }
    const vlanIdNum = parseInt(vlan_id, 10);
    if (!Number.isInteger(vlanIdNum) || vlanIdNum < 1 || vlanIdNum > 4094) {
      return res.status(400).json({ success: false, message: 'VLAN ID must be between 1 and 4094' });
    }
    if (!['lan', 'wan'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'Mode must be lan or wan' });
    }
    const proto = protocol === 'static' ? 'static' : 'dhcp';
    if (proto === 'static' && (!static_ip || !static_gateway || !static_netmask)) {
      return res.status(400).json({ success: false, message: 'Static IP, gateway, and netmask are required for static protocol' });
    }

    const existing = db.prepare(
      'SELECT id FROM vlans WHERE base_interface = ? AND vlan_id = ?'
    ).get(base_interface, vlanIdNum);
    if (existing) {
      return res.status(409).json({ success: false, message: 'This VLAN ID already exists on that interface' });
    }

    const result = db.prepare(`
      INSERT INTO vlans (base_interface, vlan_id, mode, protocol, static_ip, static_gateway, static_netmask)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(base_interface, vlanIdNum, mode, proto, static_ip || null, static_gateway || null, static_netmask || null);

    console.log(`🔀 VLAN created: ${base_interface}.${vlanIdNum} (${mode}/${proto})`);
    applyNetworkSetup();

    return res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('VLAN create error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/network/vlans/:id
router.delete('/network/vlans/:id', adminAuth, (req, res) => {
  try {
    const vlan = db.prepare('SELECT * FROM vlans WHERE id = ?').get(req.params.id);
    if (!vlan) {
      return res.status(404).json({ success: false, message: 'VLAN not found' });
    }

    const ifName = `${vlan.base_interface}.${vlan.vlan_id}`;
    // Bug: setup-network.sh only ever creates VLAN sub-interfaces, it never
    // tears down ones that get removed from the DB - without this, a
    // deleted VLAN's interface (and whatever IP/routes/dnsmasq were bound
    // to it) would keep running until the next reboot.
    execFile('sudo', ['ip', 'link', 'delete', ifName], () => {
      db.prepare('DELETE FROM vlans WHERE id = ?').run(req.params.id);
      console.log(`🔀 VLAN deleted: ${ifName}`);
      applyNetworkSetup();
      return res.json({ success: true, message: 'VLAN deleted' });
    });
  } catch (err) {
    console.error('VLAN delete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== TIER 1 STANDALONE FEATURES: static DHCP leases, client naming,
// port forwarding, diagnostics (STANDALONE_ARCHITECTURE_PLAN.md) =====

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
function isValidPort(n) {
  const p = parseInt(n, 10);
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

// ── Static DHCP leases ──────────────────────────────────────────
router.get('/network/leases', adminAuth, (req, res) => {
  try {
    const leases = db.prepare('SELECT * FROM static_leases ORDER BY id DESC').all();
    res.json({ success: true, leases });
  } catch (err) {
    console.error('Leases list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/network/leases', adminAuth, (req, res) => {
  try {
    const { mac_address, ip_address, label } = req.body;
    const mac = String(mac_address || '').trim().toLowerCase();
    const ip = String(ip_address || '').trim();
    if (!MAC_REGEX.test(mac)) {
      return res.status(400).json({ success: false, message: 'Invalid MAC address' });
    }
    if (!IP_REGEX.test(ip)) {
      return res.status(400).json({ success: false, message: 'Invalid IP address' });
    }
    const existing = db.prepare('SELECT id FROM static_leases WHERE mac_address = ?').get(mac);
    if (existing) {
      return res.status(409).json({ success: false, message: 'This device already has a reserved IP' });
    }
    const result = db.prepare(
      'INSERT INTO static_leases (mac_address, ip_address, label) VALUES (?, ?, ?)'
    ).run(mac, ip, String(label || '').trim());
    console.log(`📌 Static lease created: ${mac} → ${ip}`);
    applyNetworkSetup();
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Lease create error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/network/leases/:id', adminAuth, (req, res) => {
  try {
    const lease = db.prepare('SELECT * FROM static_leases WHERE id = ?').get(req.params.id);
    if (!lease) {
      return res.status(404).json({ success: false, message: 'Lease not found' });
    }
    db.prepare('DELETE FROM static_leases WHERE id = ?').run(req.params.id);
    console.log(`📌 Static lease deleted: ${lease.mac_address}`);
    applyNetworkSetup();
    res.json({ success: true, message: 'Lease deleted' });
  } catch (err) {
    console.error('Lease delete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Client naming ───────────────────────────────────────────────
router.get('/network/client-labels', adminAuth, (req, res) => {
  try {
    const labels = db.prepare('SELECT * FROM client_labels ORDER BY updated_at DESC').all();
    res.json({ success: true, labels });
  } catch (err) {
    console.error('Client labels list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/network/client-labels', adminAuth, (req, res) => {
  try {
    const { mac_address, label } = req.body;
    const mac = String(mac_address || '').trim().toLowerCase();
    const lbl = String(label || '').trim();
    if (!MAC_REGEX.test(mac)) {
      return res.status(400).json({ success: false, message: 'Invalid MAC address' });
    }
    if (!lbl) {
      db.prepare('DELETE FROM client_labels WHERE mac_address = ?').run(mac);
      return res.json({ success: true, message: 'Label cleared' });
    }
    db.prepare(`
      INSERT INTO client_labels (mac_address, label, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mac_address) DO UPDATE SET label = excluded.label, updated_at = CURRENT_TIMESTAMP
    `).run(mac, lbl);
    res.json({ success: true, message: 'Label saved' });
  } catch (err) {
    console.error('Client label save error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Port forwarding (standalone mode only — MikroTik owns NAT in router mode) ──
router.get('/network/port-forwards', adminAuth, (req, res) => {
  try {
    const forwards = db.prepare('SELECT * FROM port_forwards ORDER BY id DESC').all();
    res.json({ success: true, forwards });
  } catch (err) {
    console.error('Port forwards list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/network/port-forwards', adminAuth, (req, res) => {
  try {
    const { label, protocol, external_port, internal_ip, internal_port } = req.body;
    const proto = protocol === 'udp' ? 'udp' : 'tcp';
    if (!isValidPort(external_port) || !isValidPort(internal_port)) {
      return res.status(400).json({ success: false, message: 'Ports must be between 1 and 65535' });
    }
    const ip = String(internal_ip || '').trim();
    if (!IP_REGEX.test(ip)) {
      return res.status(400).json({ success: false, message: 'Invalid internal IP address' });
    }
    const result = db.prepare(`
      INSERT INTO port_forwards (label, protocol, external_port, internal_ip, internal_port, enabled)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(String(label || '').trim(), proto, parseInt(external_port, 10), ip, parseInt(internal_port, 10));
    console.log(`↪️  Port forward created: ${proto}/${external_port} → ${ip}:${internal_port}`);
    applyNetworkSetup();
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Port forward create error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/network/port-forwards/:id/toggle', adminAuth, (req, res) => {
  try {
    const fwd = db.prepare('SELECT * FROM port_forwards WHERE id = ?').get(req.params.id);
    if (!fwd) {
      return res.status(404).json({ success: false, message: 'Port forward not found' });
    }
    db.prepare('UPDATE port_forwards SET enabled = ? WHERE id = ?').run(fwd.enabled ? 0 : 1, req.params.id);
    applyNetworkSetup();
    res.json({ success: true, enabled: !fwd.enabled });
  } catch (err) {
    console.error('Port forward toggle error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/network/port-forwards/:id', adminAuth, (req, res) => {
  try {
    const fwd = db.prepare('SELECT * FROM port_forwards WHERE id = ?').get(req.params.id);
    if (!fwd) {
      return res.status(404).json({ success: false, message: 'Port forward not found' });
    }
    db.prepare('DELETE FROM port_forwards WHERE id = ?').run(req.params.id);
    console.log(`↪️  Port forward deleted: ${fwd.protocol}/${fwd.external_port}`);
    applyNetworkSetup();
    res.json({ success: true, message: 'Port forward deleted' });
  } catch (err) {
    console.error('Port forward delete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── In-panel diagnostics ────────────────────────────────────────
// Target validated as a hostname or IP only (no flags/spaces) before ever
// reaching execFile — execFile itself doesn't go through a shell, but a
// value like "-c 100" would still be accepted as a legitimate-looking ping
// argument and let a caller turn a 4-packet ping into a flood, so the
// format is restricted regardless.
const DIAG_TARGET_REGEX = /^[a-zA-Z0-9.-]{1,253}$/;

router.post('/network/diagnostics/ping', adminAuth, (req, res) => {
  const target = String(req.body.target || '').trim();
  if (!DIAG_TARGET_REGEX.test(target)) {
    return res.status(400).json({ success: false, message: 'Invalid target' });
  }
  execFile('ping', ['-c', '4', '-W', '2', target], { timeout: 15000 }, (err, stdout, stderr) => {
    res.json({ success: true, output: (stdout || '') + (stderr || '') || (err ? err.message : '') });
  });
});

router.post('/network/diagnostics/traceroute', adminAuth, (req, res) => {
  const target = String(req.body.target || '').trim();
  if (!DIAG_TARGET_REGEX.test(target)) {
    return res.status(400).json({ success: false, message: 'Invalid target' });
  }
  execFile('traceroute', ['-m', '15', '-w', '2', target], { timeout: 30000 }, (err, stdout, stderr) => {
    res.json({ success: true, output: (stdout || '') + (stderr || '') || (err ? err.message : '') });
  });
});

// ===== STANDALONE PORTS AND ROLES + PROVISIONING
// (STANDALONE_ARCHITECTURE_PLAN.md - VLAN-based multi-lane engine) =====
// Reuses router_ports the same way router/MikroTik mode does, but scoped
// strictly to interfaces that actually exist on THIS box - a MikroTik's
// own saved port names (ether1, ether2...) never match a real local
// interface, so switching modes can never let one mode's saved lanes leak
// into the other's save/delete logic.

function getLocalPhysicalInterfaces() {
  if (!fs.existsSync('/sys/class/net')) return [];
  return fs.readdirSync('/sys/class/net').filter((n) =>
    /^(eth|enp|ens|enx|wlan|wlx|wlp)/.test(n) && !n.includes('.')
  );
}

router.get('/network/standalone/ports', adminAuth, (req, res) => {
  try {
    const localNames = getLocalPhysicalInterfaces();
    const physical_ports = localNames.map((name) => {
      let operstate = 'unknown';
      try { operstate = fs.readFileSync(`/sys/class/net/${name}/operstate`, 'utf8').trim(); } catch (e) {}
      let mac = '';
      try { mac = fs.readFileSync(`/sys/class/net/${name}/address`, 'utf8').trim(); } catch (e) {}
      return { name, status: operstate, mac };
    });

    const allLanes = localNames.length
      ? db.prepare(`SELECT * FROM router_ports WHERE port_name IN (${localNames.map(() => '?').join(',')}) ORDER BY port_name, vlan_id`).all(...localNames)
      : [];
    const lanes = allLanes.map((l) => ({
      id: l.id,
      port_name: l.port_name,
      vlan_id: l.vlan_id || 0,
      role: l.role,
      lane_name: l.lane_name,
      speed_mbps: l.speed_mbps,
      burst_mbps: l.burst_mbps,
      isolate_clients: !!l.isolate_clients,
      bridge_with_id: l.bridge_with_id,
    }));

    const planSetting = db.prepare("SELECT value FROM settings WHERE key = 'isp_plan_mbps'").get();
    const guaranteedTotal = lanes.reduce((sum, l) => sum + (l.role !== 'unused' && l.role !== 'wan' && !l.bridge_with_id ? (l.speed_mbps || 0) : 0), 0);
    const hardware = require('../services/hardwareDetection').detect();

    return res.json({
      success: true,
      physical_ports,
      lanes,
      isp_plan_mbps: planSetting ? parseInt(planSetting.value, 10) || 0 : 0,
      guaranteed_total_mbps: guaranteedTotal,
      max_vlan_lanes: hardware.features.maxVlanLanes,
    });
  } catch (err) {
    console.error('Standalone ports list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/network/standalone/ports — same shape/validation as
// POST /router/ports, but stale-row deletion is scoped to this box's own
// real interfaces only, so saving Standalone lanes can never wipe out
// router-mode lane definitions saved for a MikroTik, or vice versa.
router.post('/network/standalone/ports', adminAuth, (req, res) => {
  try {
    const { lanes } = req.body;
    if (!Array.isArray(lanes)) {
      return res.status(400).json({ success: false, message: 'lanes array required' });
    }
    const localNames = getLocalPhysicalInterfaces();
    const validRoles = ['wan', 'gated', 'open', 'unused'];
    const keyOf = (l) => `${l.port_name}::${parseInt(l.vlan_id, 10) || 0}`;
    const byKey = new Map(lanes.map((l) => [keyOf(l), l]));

    for (const l of lanes) {
      if (!l.port_name || !localNames.includes(l.port_name) || !validRoles.includes(l.role)) {
        return res.status(400).json({ success: false, message: `Invalid lane entry: ${JSON.stringify(l)}` });
      }
      if (l.bridge_with_port) {
        const targetKey = `${l.bridge_with_port}::${parseInt(l.bridge_with_vlan, 10) || 0}`;
        if (targetKey === keyOf(l)) {
          return res.status(400).json({ success: false, message: `${l.port_name} (VLAN ${l.vlan_id || 'none'}) can't join its own lane` });
        }
        const target = byKey.get(targetKey);
        if (!target) {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port}: that lane isn't in this request` });
        }
        if (target.role === 'wan' || target.role === 'unused') {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port}: that lane has no role (${target.role})` });
        }
        if (target.bridge_with_port) {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port}: that lane is itself joined to another one. Join the other lane's primary instead.` });
        }
      }
    }

    const hardware = require('../services/hardwareDetection').detect();
    const activeLaneCount = lanes.filter((l) => (l.role === 'gated' || l.role === 'open') && !l.bridge_with_port).length;
    if (activeLaneCount > hardware.features.maxVlanLanes) {
      return res.status(400).json({ success: false, message: `This hardware tier (${hardware.tier}) supports up to ${hardware.features.maxVlanLanes} lanes, ${activeLaneCount} were submitted` });
    }

    // Stale-row deletion scoped to real local interfaces only (see comment
    // above) - a router-mode lane saved for e.g. "ether1" never matches any
    // of these names, so it's never touched by this delete.
    const deleteStale = db.prepare(`
      DELETE FROM router_ports WHERE port_name IN (${localNames.map(() => '?').join(',') || "''"})
      AND (port_name || '::' || vlan_id) NOT IN (${lanes.map(() => '?').join(',') || "''"})
    `);
    if (localNames.length > 0) {
      deleteStale.run(...localNames, ...lanes.map((l) => keyOf(l)));
    }

    const upsert = db.prepare(`
      INSERT INTO router_ports (port_name, vlan_id, role, lane_name, speed_mbps, burst_mbps, isolate_clients, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(port_name, vlan_id) DO UPDATE SET
        role = excluded.role,
        lane_name = excluded.lane_name,
        speed_mbps = excluded.speed_mbps,
        burst_mbps = excluded.burst_mbps,
        isolate_clients = excluded.isolate_clients,
        updated_at = CURRENT_TIMESTAMP
    `);
    for (const l of lanes) {
      upsert.run(
        l.port_name,
        parseInt(l.vlan_id, 10) || 0,
        l.role,
        String(l.lane_name || ''),
        parseInt(l.speed_mbps, 10) || 0,
        parseInt(l.burst_mbps, 10) || 0,
        l.isolate_clients === false ? 0 : 1
      );
    }
    const findId = db.prepare('SELECT id FROM router_ports WHERE port_name = ? AND vlan_id = ?');
    const setBridge = db.prepare('UPDATE router_ports SET bridge_with_id = ? WHERE port_name = ? AND vlan_id = ?');
    for (const l of lanes) {
      const vlanId = parseInt(l.vlan_id, 10) || 0;
      if (l.bridge_with_port) {
        const target = findId.get(l.bridge_with_port, parseInt(l.bridge_with_vlan, 10) || 0);
        setBridge.run(target ? target.id : null, l.port_name, vlanId);
      } else {
        setBridge.run(null, l.port_name, vlanId);
      }
    }

    return res.json({ success: true, message: 'Port roles saved' });
  } catch (err) {
    console.error('Standalone ports save error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/network/standalone/provision/preview — mirrors, in Node,
// the same lane-numbering rule setup-network.sh itself uses (head lanes in
// id order, octet = 50 + position) purely for display. setup-network.sh
// remains the actual source of truth; this never touches the network.
router.get('/network/standalone/provision/preview', adminAuth, (req, res) => {
  try {
    const localNames = getLocalPhysicalInterfaces();
    const heads = localNames.length
      ? db.prepare(`
          SELECT * FROM router_ports
          WHERE role IN ('gated','open') AND bridge_with_id IS NULL AND port_name IN (${localNames.map(() => '?').join(',')})
          ORDER BY id
        `).all(...localNames)
      : [];
    const steps = [];
    heads.forEach((h, idx) => {
      const octet = 50 + idx + 1;
      const iface = h.vlan_id ? `${h.port_name}.${h.vlan_id}` : h.port_name;
      const members = db.prepare('SELECT port_name, vlan_id FROM router_ports WHERE bridge_with_id = ?').all(h.id);
      const laneIf = members.length ? `br-lane${h.id}` : iface;
      steps.push(`Lane "${h.lane_name || iface}" (${h.role}): ${laneIf} → 10.${octet}.0.1/24, ${h.speed_mbps || 100}mbit${members.length ? `, bridged with ${members.map((m) => m.vlan_id ? `${m.port_name}.${m.vlan_id}` : m.port_name).join(', ')}` : ''}`);
    });
    if (heads.length === 0) {
      steps.push('No gated/open lanes configured yet — the legacy single-lane 10.0.0.0/24 setup will be used, unchanged.');
    }
    res.json({ success: true, steps, lane_count: heads.length });
  } catch (err) {
    console.error('Standalone provision preview error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/network/standalone/provision/apply — the actual
// "Configure" action. setup-network.sh always does a full rebuild from the
// database on every run (already true for VLANs/leases/port-forwards), so
// there's no separate backup/rollback step the way MikroTik provisioning
// needs — re-running it is the same idempotent operation the boot-time
// systemd service already performs.
router.post('/network/standalone/provision/apply', adminAuth, (req, res) => {
  const scriptPath = path.join(__dirname, '../../setup/setup-network.sh');
  execFile('sudo', ['bash', scriptPath], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Standalone provision apply error:', err.message);
      return res.status(500).json({ success: false, message: 'Provisioning failed: ' + err.message });
    }
    console.log('⚡ Standalone lane engine provisioned');
    res.json({ success: true, message: 'Configuration applied' });
  });
});

// ===== ROUTER MODE (MikroTik) — ROUTER_MODE_PLAN.md Stage 3 =====

// GET /api/admin/router/ports — live-scans the router's actual physical
// ports (no hardcoded model list) and returns every saved lane definition
// alongside them. A physical port can carry more than one lane (an
// untagged one plus any number of VLAN-tagged ones sharing the same
// wire), so this returns two separate lists rather than merging them into
// one row per port the way earlier versions did.
router.get('/router/ports', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    const livePorts = await mikrotikService.getRouterPorts();
    const physical_ports = livePorts.map((p) => ({
      name: p.name, mac: p.mac, running: p.running, disabled: p.disabled,
    }));

    const lanes = db.prepare('SELECT * FROM router_ports ORDER BY port_name, vlan_id').all().map((l) => ({
      id: l.id,
      port_name: l.port_name,
      vlan_id: l.vlan_id || 0,
      role: l.role,
      lane_name: l.lane_name,
      speed_mbps: l.speed_mbps,
      burst_mbps: l.burst_mbps,
      isolate_clients: !!l.isolate_clients,
      bridge_with_id: l.bridge_with_id,
    }));

    const planSetting = db.prepare("SELECT value FROM settings WHERE key = 'isp_plan_mbps'").get();
    // A lane joined to another one (bridge_with_id set) doesn't carry its
    // own speed - it inherits the primary's - so it must not be counted
    // a second time here.
    const guaranteedTotal = lanes.reduce((sum, l) => sum + (l.role !== 'unused' && l.role !== 'wan' && !l.bridge_with_id ? (l.speed_mbps || 0) : 0), 0);

    return res.json({
      success: true,
      physical_ports,
      lanes,
      isp_plan_mbps: planSetting ? parseInt(planSetting.value, 10) || 0 : 0,
      guaranteed_total_mbps: guaranteedTotal,
    });
  } catch (err) {
    console.error('Router ports scan error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to reach router' });
  }
});

// POST /api/admin/router/ports — replaces the full set of saved lane
// definitions with exactly what's submitted (so removing a lane in the UI
// actually removes it here too, not just orphans it).
// Body: { lanes: [{ port_name, vlan_id, role, lane_name, speed_mbps,
// burst_mbps, isolate_clients, bridge_with_port, bridge_with_vlan }, ...] }
// bridge_with_port/vlan identifies another lane in the SAME request this
// one joins (e.g. a VLAN-tagged lane on one port joining an untagged lane
// on a different port) - kept flat on purpose, a lane can join a primary,
// but a primary that's itself joining something else isn't allowed, so
// there's never a chain to resolve.
router.post('/router/ports', adminAuth, (req, res) => {
  try {
    const { lanes } = req.body;
    if (!Array.isArray(lanes)) {
      return res.status(400).json({ success: false, message: 'lanes array required' });
    }
    const validRoles = ['wan', 'gated', 'open', 'unused'];
    const keyOf = (l) => `${l.port_name}::${parseInt(l.vlan_id, 10) || 0}`;
    const byKey = new Map(lanes.map((l) => [keyOf(l), l]));

    for (const l of lanes) {
      if (!l.port_name || !validRoles.includes(l.role)) {
        return res.status(400).json({ success: false, message: `Invalid lane entry: ${JSON.stringify(l)}` });
      }
      if (l.bridge_with_port) {
        const targetKey = `${l.bridge_with_port}::${parseInt(l.bridge_with_vlan, 10) || 0}`;
        if (targetKey === keyOf(l)) {
          return res.status(400).json({ success: false, message: `${l.port_name} (VLAN ${l.vlan_id || 'none'}) can't join its own lane` });
        }
        const target = byKey.get(targetKey);
        if (!target) {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port} (VLAN ${l.bridge_with_vlan || 'none'}): that lane isn't in this request` });
        }
        if (target.role === 'wan' || target.role === 'unused') {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port}: that lane has no role (${target.role})` });
        }
        if (target.bridge_with_port) {
          return res.status(400).json({ success: false, message: `${l.port_name} can't join ${l.bridge_with_port}: that lane is itself joined to another one. Join the other lane's primary instead.` });
        }
      }
    }

    const submittedKeys = lanes.map((l) => keyOf(l));
    const deleteStale = db.prepare(`DELETE FROM router_ports WHERE (port_name || '::' || vlan_id) NOT IN (${submittedKeys.map(() => '?').join(',') || "''"})`);
    if (submittedKeys.length > 0) deleteStale.run(...submittedKeys);
    else db.prepare('DELETE FROM router_ports').run();

    const upsert = db.prepare(`
      INSERT INTO router_ports (port_name, vlan_id, role, lane_name, speed_mbps, burst_mbps, isolate_clients, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(port_name, vlan_id) DO UPDATE SET
        role = excluded.role,
        lane_name = excluded.lane_name,
        speed_mbps = excluded.speed_mbps,
        burst_mbps = excluded.burst_mbps,
        isolate_clients = excluded.isolate_clients,
        updated_at = CURRENT_TIMESTAMP
    `);
    // First pass: every lane exists as a real row before any bridge_with_id
    // can be resolved to a real id.
    for (const l of lanes) {
      upsert.run(
        l.port_name,
        parseInt(l.vlan_id, 10) || 0,
        l.role,
        String(l.lane_name || ''),
        parseInt(l.speed_mbps, 10) || 0,
        parseInt(l.burst_mbps, 10) || 0,
        l.isolate_clients === false ? 0 : 1
      );
    }
    // Second pass: resolve bridge_with_port/vlan into a real row id now
    // that every lane in this batch definitely has one.
    const findId = db.prepare('SELECT id FROM router_ports WHERE port_name = ? AND vlan_id = ?');
    const setBridge = db.prepare('UPDATE router_ports SET bridge_with_id = ? WHERE port_name = ? AND vlan_id = ?');
    for (const l of lanes) {
      const vlanId = parseInt(l.vlan_id, 10) || 0;
      if (l.bridge_with_port) {
        const target = findId.get(l.bridge_with_port, parseInt(l.bridge_with_vlan, 10) || 0);
        setBridge.run(target ? target.id : null, l.port_name, vlanId);
      } else {
        setBridge.run(null, l.port_name, vlanId);
      }
    }

    return res.json({ success: true, message: 'Port roles saved' });
  } catch (err) {
    console.error('Router ports save error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/router/status — live status card, read straight from the
// router (ROUTER_MODE_PLAN.md §4.7), not our own database.
router.get('/router/status', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    const status = await mikrotikService.getLiveStatus();
    return res.json({ success: true, status });
  } catch (err) {
    console.error('Router status error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to reach router' });
  }
});

// POST /api/admin/router/test-connection
router.post('/router/test-connection', adminAuth, async (req, res) => {
  try {
    const mikrotikService = require('../services/mikrotikService');
    await mikrotikService.testConnection();
    return res.json({ success: true, message: 'Connected' });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || 'Connection failed' });
  }
});

// POST /api/admin/router/terminal — runs a raw MikroTik API command
// straight from the admin panel, so a quick check or fix doesn't require
// opening WinBox separately. Deliberately unrestricted, same as WinBox's
// own terminal: this account already has full admin-level MikroTik
// credentials on file, so there's nothing meaningfully protected by trying
// to sandbox individual commands here.
router.post('/router/terminal', adminAuth, async (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ success: false, message: 'Enter a command' });
  }

  // Tokenize on whitespace, keeping quoted sections (values with spaces,
  // e.g. a comment) together as one word. Commands are expected in the
  // same combined-path form every other call in this codebase already
  // uses (e.g. "/ip/hotspot/ip-binding/print"), not the space-separated
  // form the interactive CLI console alone accepts.
  const words = command.trim().match(/"[^"]*"|'[^']*'|\S+/g).map(w =>
    (w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))
      ? w.slice(1, -1)
      : w
  );

  try {
    const { getMikrotikConfig } = require('../services/mikrotikConfigHelper');
    const { withMikrotik } = require('../services/mikrotikApiClient');
    const config = getMikrotikConfig();
    if (!config.ip) {
      return res.status(400).json({ success: false, message: 'MikroTik is not configured yet' });
    }

    const result = await withMikrotik(config, (client) => client.talk(words));
    res.json({ success: true, result });
  } catch (err) {
    console.error('Router terminal error:', err);
    res.status(400).json({ success: false, message: err.message || 'Command failed' });
  }
});

// GET /api/admin/router/local-interfaces — this server's own network
// connections, so the admin can pick which one is on the gated lane
// (Bug: auto-guessing this on a multi-NIC machine could reserve the wrong
// device's address, silently breaking the walled-garden fixed-address
// guarantee — see mikrotikProvisioner.js's getOwnMac()).
router.get('/router/local-interfaces', adminAuth, (req, res) => {
  try {
    const provisioner = require('../services/mikrotikProvisioner');
    const interfaces = provisioner.listLocalInterfaces();
    return res.json({ success: true, interfaces });
  } catch (err) {
    console.error('Local interfaces list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/router/provision/preview — shows exactly what "Configure"
// would run, without touching the router (ROUTER_MODE_PLAN.md §4.6).
router.get('/router/provision/preview', adminAuth, async (req, res) => {
  try {
    const provisioner = require('../services/mikrotikProvisioner');
    const preview = await provisioner.preview();
    return res.json({ success: true, ...preview });
  } catch (err) {
    console.error('Provision preview error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to build preview' });
  }
});

// POST /api/admin/router/provision/apply — the actual "Configure" action.
// Always backs up the router's current config first, stops immediately on
// the first failed step rather than pushing a half-applied config further.
router.post('/router/provision/apply', adminAuth, async (req, res) => {
  try {
    const provisioner = require('../services/mikrotikProvisioner');
    const result = await provisioner.apply();
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('Provision apply error:', err.message);
    res.status(500).json({
      success: false,
      message: err.message || 'Provisioning failed',
      log: err.log || [],
      warnings: err.warnings || [],
      backedUp: !!err.backedUp,
    });
  }
});

module.exports = router;