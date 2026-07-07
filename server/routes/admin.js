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

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { getActiveSessions, expireSession, pauseSession, resumeSession } = require('../services/sessionService');
const { getRates } = require('../services/voucherService');
const { checkSpam, recordAttempt, clearAttempts } = require('../services/spamService');
const os = require('os');
const { exec, execSync, execFile } = require('child_process');

// No reverse proxy sits in front of this server (setup/nginx.conf is an
// unused empty placeholder), so the raw socket address is the real client IP.
function getRealClientIp(req) {
  const raw = req.connection.remoteAddress || req.socket.remoteAddress || '';
  return raw.replace('::ffff:', '').trim();
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
  if (!password || !settings || password !== settings.value) {
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
    return res.json({ success: true, settings: settingsObj });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/settings
router.post('/settings', adminAuth, (req, res) => {
  try {
    const updates = req.body;
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(updates)) {
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
    const { enable_bandwidth_cap, bandwidth_cap_download_mbps, bandwidth_cap_upload_mbps, max_mbps, spam_max_attempts, spam_block_minutes } = req.body;
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
        license
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

// GET /api/admin/vendos
router.get('/vendos', adminAuth, (req, res) => {
  try {
    const vendos = db.prepare(`SELECT * FROM vendos ORDER BY last_seen DESC`).all();
    return res.json({ success: true, vendos });
  } catch (err) {
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

    let netplanConfig = '';
    if (type === 'dhcp') {
      netplanConfig = `network:\n  ethernets:\n    enp0s3:\n      dhcp4: true\n  version: 2\n`;
    } else {
      netplanConfig = `network:\n  ethernets:\n    enp0s3:\n      dhcp4: false\n      addresses:\n        - ${ip}/${subnet || '24'}\n      routes:\n        - to: default\n          via: ${gateway}\n      nameservers:\n        addresses:\n          - ${dns || '8.8.8.8'}\n          - 8.8.4.4\n  version: 2\n`;
    }

    // Write config to temp file
    const tmpFile = '/tmp/rj-network-' + Date.now() + '.yaml';
    fs.writeFileSync(tmpFile, netplanConfig, { mode: 0o600 });

    // Use execFile with array args for safety (Bug #22)
    execFile('sudo', ['cp', tmpFile, '/etc/netplan/50-cloud-init.yaml'], { timeout: 5000 }, (err) => {
      fs.unlinkSync(tmpFile); // Clean up temp file
      if (err) {
        console.error('Network config copy error:', err);
        return res.status(500).json({ success: false, message: 'Failed to apply config' });
      }

      // Apply netplan
      execFile('sudo', ['netplan', 'apply'], { timeout: 5000 }, (err2) => {
        if (err2) {
          console.error('Netplan apply error:', err2);
          return res.status(500).json({ success: false, message: 'Failed to apply netplan' });
        }

        // All commands succeeded — update settings
        const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        upsert.run('network_type', type);
        upsert.run('static_ip', ip || '');
        upsert.run('static_gateway', gateway || '');
        upsert.run('static_dns', dns || '8.8.8.8');
        upsert.run('static_subnet', subnet || '24');

        console.log(`🌐 Network changed to: ${type}`);
        return res.json({ success: true, message: `Network set to ${type}` });
      });
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

module.exports = router;