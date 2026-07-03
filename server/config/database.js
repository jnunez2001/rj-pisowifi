const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../database/rjpisowifi.db');

// Ensure database directory exists
const dbDir = path.join(__dirname, '../database');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_code TEXT UNIQUE NOT NULL,
    mac_address TEXT NOT NULL,
    ip_address TEXT,
    minutes_remaining REAL NOT NULL,
    is_paused INTEGER DEFAULT 0,
    paused_at DATETIME,
    hard_expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  );
  -- Note: status column removed (Bug #1) — sessions are deleted on expiry, so existing sessions are always active

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_code TEXT NOT NULL,
    coin_value INTEGER NOT NULL,
    minutes_added REAL NOT NULL,
    type TEXT DEFAULT 'coin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(voucher_code) REFERENCES sessions(voucher_code)
  );

  CREATE TABLE IF NOT EXISTS promo_vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    duration_days REAL NOT NULL,
    price INTEGER NOT NULL,
    status TEXT DEFAULT 'unused',
    mac_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_value INTEGER NOT NULL,
    minutes REAL NOT NULL,
    expiration_minutes REAL NOT NULL,
    label TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS free_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT NOT NULL,
    ip_address TEXT,
    claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vendos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    ip_address TEXT,
    firmware TEXT,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const rateCount = db.prepare(
  'SELECT COUNT(*) as count FROM rates'
).get();

if (rateCount.count === 0) {
  const insertRate = db.prepare(
    'INSERT INTO rates (coin_value, minutes, expiration_minutes, label) VALUES (?, ?, ?, ?)'
  );
  insertRate.run(1,   5,    30,    '₱1 = 5 mins');
  insertRate.run(5,   60,   120,   '₱5 = 1 hour');
  insertRate.run(10,  120,  240,   '₱10 = 2 hours');
  insertRate.run(15,  180,  300,   '₱15 = 3 hours');
  insertRate.run(20,  300,  480,   '₱20 = 5 hours');
  insertRate.run(50,  4320, 4320,  '₱50 = 3 days');
  insertRate.run(100, 10080,10080, '₱100 = 7 days');
  insertRate.run(300, 43200,43200, '₱300 = 30 days');
}

const settingCount = db.prepare(
  'SELECT COUNT(*) as count FROM settings'
).get();

if (settingCount.count === 0) {
  const insertSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?)'
  );
  insertSetting.run('cafe_name', 'R&J PisoWifi');
  insertSetting.run('admin_password', 'admin123');
  insertSetting.run('admin_username', 'admin');
  insertSetting.run('currency', '₱');
  insertSetting.run('banner_text', 'HIGH SPEED CONNECTION!');
  insertSetting.run('max_mbps', '5');
  insertSetting.run('spam_max_attempts', '3');
  insertSetting.run('spam_block_minutes', '1');
  // Cafe info
  insertSetting.run('cafe_address', '');
  insertSetting.run('cafe_contact', '');

  // Portal settings
  insertSetting.run('welcome_message', 'Welcome! Insert a coin to get started.');
  insertSetting.run('disconnect_message', 'Your session has ended. Thank you!');
  insertSetting.run('show_voucher', '0');
  insertSetting.run('redirect_url', '');

  // Session settings
  insertSetting.run('allow_pause', '1');
  insertSetting.run('max_pause_minutes', '30');
  insertSetting.run('grace_period_minutes', '0');

  // Coin slot settings
  insertSetting.run('coin_wait_ms', '1500');
  insertSetting.run('min_coins', '1');
  insertSetting.run('free_minutes_enabled', '1');
  insertSetting.run('free_minutes_amount', '5');
  insertSetting.run('vendo_ip', '');

  // Bandwidth control (disabled by default to test full speed)
  insertSetting.run('enable_bandwidth_cap', '0');
  insertSetting.run('bandwidth_cap_download_mbps', '5');
  insertSetting.run('bandwidth_cap_upload_mbps', '5');

  // Network mode
  insertSetting.run('network_mode', 'nodogsplash');
  insertSetting.run('mikrotik_ip', '');
  insertSetting.run('mikrotik_user', 'admin');
  insertSetting.run('mikrotik_pass', '');
  insertSetting.run('mikrotik_interface', 'ether1');
}


console.log('✅ Database initialized successfully');

module.exports = db;