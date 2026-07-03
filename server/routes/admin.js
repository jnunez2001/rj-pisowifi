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
    cb(null, `${type}${ext}`);
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
const { getActiveSessions, expireSession, allowClient } = require('../services/sessionService');
const { getRates } = require('../services/voucherService');
const os = require('os');
const { exec, execSync, execFile } = require('child_process');

// Admin auth middleware
// NOTE: Passwords stored in plaintext (Bug #10). Acceptable for offline single-admin deployments.
// For wider deployment, consider: bcrypt hashing, OAuth2, or certificate-based auth.
function adminAuth(req, res, next) {
  const { password } = req.headers;
  const settings = db.prepare(
    "SELECT value FROM settings WHERE key = 'admin_password'"
  ).get();
  if (!password || password !== settings.value) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
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
    return res.json({ success: true, sessions: sessionsWithTime, count: sessionsWithTime.length });
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
    db.prepare(`
      UPDATE sessions SET minutes_remaining = ?, expires_at = ? WHERE voucher_code = ?
    `).run(newMinutes, newExpiresAt, code);

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
      recent_transactions: recent
    });

  } catch (err) {
    console.error('Admin sales error:', err);
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
    if (!['logo', 'banner'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Type must be logo or banner' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const fileUrl = `/portal/assets/${req.file.filename}`;
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

// GET /api/admin/sysinfo
router.get('/sysinfo', adminAuth, (req, res) => {
  try {
    const cpus = os.cpus();

    const cpuUsage = cpus.map(cpu => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return Math.round((1 - idle / total) * 100);
    });

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const uptimeSecs = os.uptime();
    const days = Math.floor(uptimeSecs / 86400);
    const hours = Math.floor((uptimeSecs % 86400) / 3600);
    const mins = Math.floor((uptimeSecs % 3600) / 60);
    const uptime = `${days}d ${hours}h ${mins}m`;

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

// POST /api/vendo/register — REQUIRES ADMIN AUTH
router.post('/vendo/register', adminAuth, (req, res) => {
  try {
    const { mac, name, ip, version } = req.body;

    if (!mac || !name) {
      return res.status(400).json({ success: false, message: 'MAC and name required' });
    }

    db.prepare(`
      INSERT INTO vendos (mac_address, name, ip_address, firmware, last_seen)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mac_address) DO UPDATE SET
        name = excluded.name,
        ip_address = excluded.ip_address,
        firmware = excluded.firmware,
        last_seen = CURRENT_TIMESTAMP
    `).run(mac, name, ip || '', version || '');

    if (ip) {
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