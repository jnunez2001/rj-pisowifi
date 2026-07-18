const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { hashPassword, isHashed } = require('../utils/passwordHash');

// Separate storage area from the app code (env-configurable, set by
// install.sh in production) so an OS reflash or `git pull` over the app
// directory can never take live customer/session data with it. Falls back
// to the old in-repo path for local dev where the env var isn't set.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../database/rjpisowifi.db');

// Ensure database directory exists
const dbDir = path.dirname(DB_PATH);
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

  CREATE TABLE IF NOT EXISTS voucher_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    duration_minutes REAL NOT NULL,
    price INTEGER NOT NULL,
    print_caption TEXT,
    print_logo_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  CREATE TABLE IF NOT EXISTS vlans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_interface TEXT NOT NULL,
    vlan_id INTEGER NOT NULL,
    mode TEXT NOT NULL, -- 'lan' (customer network) or 'wan' (ISP requires VLAN-tagged uplink)
    protocol TEXT NOT NULL DEFAULT 'dhcp', -- 'dhcp' or 'static' (WAN mode only; LAN mode is always static at the fixed gateway IP)
    static_ip TEXT,
    static_gateway TEXT,
    static_netmask TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  -- Devices that should always have internet access, never gated behind
  -- payment - e.g. an ESP32 coin-slot device sharing a WiFi network with
  -- paying customers because the access point can't reliably tag a second
  -- SSID onto its own VLAN (bugslog.md Bug #78 confirmed this hardware
  -- limitation). Trusting a device here calls the same allowClient()
  -- bypass a paid session uses (ip-binding on MikroTik, nftables set in
  -- standalone mode), just without any session/expiry attached, and is
  -- reapplied on every server boot (see timerService.js) so it survives
  -- reboots and router reconfiguration the same way active sessions do.
  CREATE TABLE IF NOT EXISTS trusted_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Router mode (MikroTik) lane definitions (ROUTER_MODE_PLAN.md Stage 3,
  -- extended Stage 7 for VLAN flexibility). One row = one LANE, not one
  -- port - a physical port can carry several lanes at once (one untagged
  -- lane where vlan_id is 0, plus any number of VLAN-tagged lanes on the
  -- same wire), and any lane can join any other lane (same port or a
  -- different one) via bridge_with_id, same building block either way.
  -- This is deliberately general rather than hardcoded to any one
  -- topology, so an operator can wire things however their actual
  -- location calls for.
  --
  -- vlan_id uses 0 (not NULL) to mean "untagged" - SQLite's UNIQUE
  -- constraint treats every NULL as distinct from every other NULL, so
  -- NULL would silently let two "untagged" lanes exist for the same port;
  -- 0 is a real, comparable value, so the constraint actually blocks that.
  CREATE TABLE IF NOT EXISTS router_ports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    port_name TEXT NOT NULL,
    vlan_id INTEGER DEFAULT 0, -- 0 = this lane is the port's untagged/native traffic; 1-4094 = a tagged lane sharing this same physical wire
    role TEXT NOT NULL DEFAULT 'unused', -- 'wan' | 'gated' | 'open' | 'unused'
    lane_name TEXT DEFAULT '',
    speed_mbps INTEGER DEFAULT 0,
    burst_mbps INTEGER DEFAULT 0,
    isolate_clients INTEGER DEFAULT 1,
    bridge_with_id INTEGER DEFAULT NULL REFERENCES router_ports(id), -- another lane definition (by row id) this one joins into
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(port_name, vlan_id)
  );

  -- Standalone-mode Tier 1 networking features (Network tab). Reserving an
  -- IP for a MAC means "always the same IP" (printers, cameras, staff
  -- laptops) - dnsmasq gets a dhcp-host line per row, re-emitted on every
  -- setup-network.sh run the same way VLAN rows already are.
  CREATE TABLE IF NOT EXISTS static_leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT UNIQUE NOT NULL,
    ip_address TEXT NOT NULL,
    label TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Standalone mode only - this box is the router/NAT boundary there, so
  -- port forwarding is a real nftables DNAT rule on WAN_VIF. In mikrotik
  -- mode the MikroTik owns NAT and this table isn't used.
  CREATE TABLE IF NOT EXISTS port_forwards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT DEFAULT '',
    protocol TEXT NOT NULL DEFAULT 'tcp', -- 'tcp' or 'udp'
    external_port INTEGER NOT NULL,
    internal_ip TEXT NOT NULL,
    internal_port INTEGER NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Friendly names for MACs, independent of static_leases (a client can be
  -- named without reserving an IP for it) - shown wherever a MAC address
  -- would otherwise be the only identifier (Sessions, Network diagnostics).
  CREATE TABLE IF NOT EXISTS client_labels (
    mac_address TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// router_ports' shape changed from "one row per port" to "one row per lane
// definition" (port_name + vlan_id) - this table has never been used in a
// real deployment yet (router mode isn't live anywhere), so rebuilding it
// cleanly is simpler and safer than layering a column-type migration onto
// a shape that's fundamentally different, not a real-data-loss concern.
try {
  const cols = db.prepare("PRAGMA table_info(router_ports)").all().map((c) => c.name);
  if (!cols.includes('vlan_id')) {
    db.exec('DROP TABLE router_ports');
    db.exec(`
      CREATE TABLE router_ports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        port_name TEXT NOT NULL,
        vlan_id INTEGER DEFAULT 0,
        role TEXT NOT NULL DEFAULT 'unused',
        lane_name TEXT DEFAULT '',
        speed_mbps INTEGER DEFAULT 0,
        burst_mbps INTEGER DEFAULT 0,
        isolate_clients INTEGER DEFAULT 1,
        bridge_with_id INTEGER DEFAULT NULL REFERENCES router_ports(id),
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(port_name, vlan_id)
      )
    `);
  }
} catch (e) {
  console.error('router_ports rebuild migration failed:', e.message);
}

// CREATE TABLE IF NOT EXISTS doesn't add new columns to an already-existing
// table, so existing installs need this added explicitly. Harmless no-op
// once it's already there (SQLite throws "duplicate column name", caught).
try {
  db.exec('ALTER TABLE promo_vouchers ADD COLUMN group_id INTEGER REFERENCES voucher_groups(id)');
} catch (e) {
  // already applied
}

// Same story as above: free_claims.ip_address was added to the CREATE TABLE
// statement after this install's table already existed, so it was never
// actually created on disk here - every free-minutes claim crashed with
// "no such column: ip_address" the moment session.js's secondary IP check
// ran (found on real hardware).
try {
  db.exec('ALTER TABLE free_claims ADD COLUMN ip_address TEXT');
} catch (e) {
  // already applied
}

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
  insertSetting.run('admin_password', hashPassword('admin123'));
  insertSetting.run('admin_username', 'admin');
  // Fresh installs start with the default password — force a change before
  // the admin panel is usable for real (Bug: default admin123 previously
  // shipped with no forced-change flow at all).
  insertSetting.run('must_change_password', '1');
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
  // Which payment entry points the portal offers - 'coin', 'voucher', or
  // 'both'. Defaults to 'both' so every existing install keeps its exact
  // current behavior (both buttons shown) with no migration needed.
  insertSetting.run('payment_methods', 'both');

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
  insertSetting.run('enable_bandwidth_burst', '0');
  insertSetting.run('bandwidth_burst_mbps', '20');
  insertSetting.run('bandwidth_burst_seconds', '8');

  // Network mode ('standalone' = built-in nftables/tc, no external router needed)
  insertSetting.run('network_mode', 'standalone');
  insertSetting.run('mikrotik_ip', '');
  insertSetting.run('mikrotik_user', 'admin');
  insertSetting.run('mikrotik_pass', '');
  insertSetting.run('mikrotik_interface', 'ether1');
  // Router mode: real ISP plan speed, never hardcoded — every port-role
  // speed warning scales off this (ROUTER_MODE_PLAN.md §4.1).
  insertSetting.run('isp_plan_mbps', '0');
  // Memorable address for gated-lane customers to return to (check/add
  // time) instead of a raw IP - opt-in, empty means disabled.
  insertSetting.run('portal_hostname', '');
  // Which of this server's own network connections is plugged into the
  // gated lane, for the DHCP reservation that keeps the server's own
  // address fixed. Empty = auto-detect only if there's exactly one
  // candidate; on a multi-NIC machine this must be set explicitly
  // (mikrotikProvisioner.js's getOwnMac()).
  insertSetting.run('server_lan_mac', '');
  // Off by default: an existing router may not have api-ssl enabled yet
  // (requires a cert set up on the router side), so defaulting to on would
  // silently break mikrotik mode for anyone who hasn't done that. Admin can
  // flip this on once api-ssl is configured on their router.
  insertSetting.run('mikrotik_ssl', '0');
  insertSetting.run('mikrotik_port', '');

  // Pi-hole DNS filtering (opt-in, off by default). Per the standing
  // fallback-design rule (every add-on must fail open, never cascade into
  // taking the whole system down), this never replaces our own proven
  // per-lane dnsmasq - it only adds Pi-hole as dnsmasq's FIRST upstream
  // resolver (setup-network.sh), with the existing public DNS servers kept
  // right behind it as automatic fallback. If Pi-hole's container goes
  // down, dnsmasq just stops getting answers from that upstream and uses
  // the next one - no customer loses DNS because Pi-hole crashed.
  insertSetting.run('enable_pihole', '0');
}

// One-time migration for existing installs: 'nodogsplash' was the old
// internal name for the standalone mode (the actual Nodogsplash software
// was replaced by this project's own nftables/tc code long ago — only the
// label lingered). Nothing in the codebase checks for the literal string
// 'nodogsplash' (networkService only ever checks `=== 'mikrotik'`), so this
// is a safe rename, not a behavior change.
db.prepare("UPDATE settings SET value = 'standalone' WHERE key = 'network_mode' AND value = 'nodogsplash'").run();

// One-time migration for existing installs: admin_password was stored in
// plaintext. Hash it in place. If it's still the untouched default
// ('admin123'), also flag must_change_password so the admin is forced to
// pick a real one — but if they'd already customized it, leave it as their
// chosen password (just hash it), no need to disrupt a working login.
{
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get();
  if (existing && !isHashed(existing.value)) {
    const wasDefault = existing.value === 'admin123';
    db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_password'")
      .run(hashPassword(existing.value));
    if (wasDefault) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('must_change_password', '1')").run();
    }
  }
  const mustChange = db.prepare("SELECT value FROM settings WHERE key = 'must_change_password'").get();
  if (!mustChange) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('must_change_password', '0')").run();
  }
}

// One-time migration for existing installs: mikrotik_pass was stored in
// plaintext — a MikroTik router's credentials have real value (resale risk
// for router configs is a real concern here), so encrypt it in place with a
// key that lives outside the DB file (server/utils/secretCrypto.js). Also
// backfill mikrotik_ssl/mikrotik_port for installs that predate those
// settings existing.
{
  const { encryptSecret, isEncrypted } = require('../utils/secretCrypto');
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'mikrotik_pass'").get();
  if (existing && existing.value && !isEncrypted(existing.value)) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'mikrotik_pass'")
      .run(encryptSecret(existing.value));
  }
  const upsertIfMissing = (key, def) => {
    const row = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
    if (!row) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, def);
  };
  upsertIfMissing('mikrotik_ssl', '0');
  upsertIfMissing('mikrotik_port', '');
  upsertIfMissing('isp_plan_mbps', '0');
  upsertIfMissing('server_lan_mac', '');
}

console.log('✅ Database initialized successfully');

module.exports = db;