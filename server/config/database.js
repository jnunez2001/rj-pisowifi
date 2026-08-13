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

// Database encryption at rest (opt-in, server/utils/dbEncryption.js) - if
// this box was migrated to an encrypted database, a key file sits next to
// the .db file and better-sqlite3-multiple-ciphers (API-compatible drop-in
// for better-sqlite3, confirmed) is used with that key applied
// immediately after opening. An install that never opted in has no key
// file, uses plain better-sqlite3 exactly as before, and none of this
// branch ever runs - zero behavior change for every existing install.
const { hasEncryptionKey, readEncryptionKey } = require('../utils/dbEncryption');
const dbIsEncrypted = hasEncryptionKey(DB_PATH);
const Database = dbIsEncrypted ? require('better-sqlite3-multiple-ciphers') : require('better-sqlite3');

const db = new Database(DB_PATH);
if (dbIsEncrypted) {
  const key = readEncryptionKey(DB_PATH);
  db.pragma(`key='${key}'`);
}
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
    expires_at DATETIME NOT NULL,
    -- The actual code a customer typed in (promo/voucher), separate from
    -- voucher_code above which is this app's own internally generated
    -- per-session identifier (RJ-XXXXXX). NULL for coin-inserted sessions.
    -- Added because an admin redeeming/looking up a customer's voucher by
    -- the code they were handed had no way to find the session it created -
    -- Active Sessions only ever showed the internal RJ- id, not what the
    -- customer actually typed.
    redeemed_code TEXT,
    -- Per-voucher bandwidth override (promo_vouchers.download_mbps/
    -- upload_mbps), copied here at redemption time. NULL means "use the
    -- global Bandwidth Control setting", same as a coin session. Kept on
    -- the session itself (not re-looked-up from the voucher every time) so
    -- timerService.js's 30s self-healing re-assertion applies the SAME
    -- override on every tick instead of silently reverting a premium
    -- voucher back to the global cap the next time it runs.
    download_mbps INTEGER,
    upload_mbps INTEGER
  );
  -- Note: status column removed (Bug #1) — sessions are deleted on expiry, so existing sessions are always active

  -- No FOREIGN KEY on voucher_code (bug fix, see the migration below for
  -- existing databases that already have one). Sessions are deleted on
  -- expiry (by design - see sessionService.js's expireSession) but
  -- transactions are a permanent revenue ledger that must survive that
  -- deletion. A strict FK here made expireSession() fail with
  -- "FOREIGN KEY constraint failed" for every session that had ever been
  -- credited, which is effectively all of them.
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_code TEXT NOT NULL,
    coin_value INTEGER NOT NULL,
    minutes_added REAL NOT NULL,
    type TEXT DEFAULT 'coin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Client identity at the moment of purchase. Not derivable from
    -- sessions.mac_address since sessions are deleted on expiry (see the
    -- FK-removal note below) - this is the only permanent record of which
    -- client made a given transaction, needed for New vs Returning
    -- reporting on the Hotspot Dashboard.
    mac_address TEXT
  );

  CREATE TABLE IF NOT EXISTS promo_vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    duration_days REAL NOT NULL,
    price INTEGER NOT NULL,
    status TEXT DEFAULT 'unused',
    mac_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    -- NULL = use the global Bandwidth Control setting (Security page),
    -- same as a coin session. Only set when an admin explicitly wants this
    -- specific voucher/batch to override it (e.g. a premium-speed pass).
    download_mbps INTEGER,
    upload_mbps INTEGER
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

  -- The single source of truth for an internet access product (price,
  -- duration, speed, data limit). Vouchers reference a plan instead of
  -- each voucher group carrying its own separate copy of the same
  -- configuration. Client Portal / Coin Vendo / ZenPay integration is
  -- real roadmap, not built yet - this table is deliberately shaped so
  -- those can reference it later without a schema change, but nothing
  -- here claims that wiring exists today.
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'time', -- time | data | unlimited | custom
    status TEXT NOT NULL DEFAULT 'active', -- active | inactive
    price INTEGER NOT NULL,
    duration_minutes REAL,
    validity_minutes REAL,
    download_mbps REAL,
    upload_mbps REAL,
    data_limit_mb INTEGER, -- NULL = unlimited
    device_limit INTEGER DEFAULT 1,
    session_limit INTEGER,
    schedule_start TEXT, -- 'HH:MM', custom-type plans only
    schedule_end TEXT,
    channel_voucher INTEGER NOT NULL DEFAULT 1,
    channel_portal INTEGER NOT NULL DEFAULT 0,
    channel_coin_vendo INTEGER NOT NULL DEFAULT 0,
    channel_account INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Fleet registry for the Routers module - a real, separate MikroTik
  -- device ZenFi connects to over the MikroTik API client
  -- (mikrotikApiClient.js), distinct from this box's own single
  -- mikrotik_host/mikrotik_user/mikrotik_pass settings (Network page,
  -- Controller Mode) which remain untouched. A registered router here is
  -- something ZenFi monitors/manages in addition to, not instead of,
  -- whatever this box itself is doing. Password is encrypted at rest via
  -- secretCrypto.js, same as mikrotik_pass.
  CREATE TABLE IF NOT EXISTS routers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    manufacturer TEXT NOT NULL DEFAULT 'mikrotik', -- mikrotik | tplink | openwrt | ubiquiti (only mikrotik has a working adapter)
    model TEXT,
    mode TEXT NOT NULL DEFAULT 'controller', -- controller | standalone
    site_id INTEGER REFERENCES sites(id),
    host TEXT,
    port INTEGER,
    ssl INTEGER NOT NULL DEFAULT 0,
    username TEXT,
    password_encrypted TEXT,
    status TEXT NOT NULL DEFAULT 'configuration_required', -- online | offline | connecting | warning | configuration_required | unreachable
    firmware_version TEXT,
    uptime_seconds INTEGER,
    cpu_percent INTEGER,
    memory_percent INTEGER,
    last_seen_at DATETIME,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Access Points: discovery-first registry + real reachability
  -- monitoring. Status/last_seen/last_latency are only ever written by a
  -- real ICMP ping (POST /access-points/:id/ping); vlan_id/vlan_evidence
  -- only by real subnet-match detection (networkDiscoveryService.js) -
  -- never fabricated. management_state is honestly 'unmanaged' for every
  -- row today - no vendor adapter (TP-Link Omada/MikroTik wireless API/
  -- etc.) exists yet to actually read or change AP configuration, so
  -- this column exists for the real states that ARE meaningful now
  -- (unmanaged vs pending-approval) without pretending 'managed' works.
  CREATE TABLE IF NOT EXISTS access_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ip_address TEXT,
    mac_address TEXT,
    vendor TEXT,
    model TEXT,
    hostname TEXT,
    site_id INTEGER REFERENCES sites(id),
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'unknown', -- online | offline | unknown
    management_state TEXT NOT NULL DEFAULT 'unmanaged', -- unmanaged | pending
    vlan_id INTEGER,
    vlan_evidence TEXT,
    discovered_via TEXT, -- arp | dhcp | arp+dhcp | manual
    last_seen_at DATETIME,
    last_latency_ms REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  -- Durable record of how long a session actually ran, written once at the
  -- single point every session-ending path already funnels through
  -- (sessionService.js's expireSession) - sessions themselves are deleted
  -- on expiry (by design), so this is the only way "average session
  -- duration" can ever be computed instead of faked from minutes_added
  -- (minutes *granted*, not minutes *used*).
  CREATE TABLE IF NOT EXISTS session_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_code TEXT NOT NULL,
    mac_address TEXT,
    started_at DATETIME,
    ended_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    duration_seconds INTEGER
  );

  CREATE TABLE IF NOT EXISTS free_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT NOT NULL,
    ip_address TEXT,
    claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Web Push subscriptions (portal's "Enable Notifications" opt-in, only
  -- reachable over the LAN-facing HTTPS port since service workers require
  -- a secure context). One MAC can have more than one live subscription
  -- (multiple browsers/devices using the same phone's MAC isn't realistic,
  -- but a customer re-subscribing after clearing site data would otherwise
  -- collide on a UNIQUE mac_address) - endpoint itself is what's actually
  -- unique per browser subscription.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT NOT NULL,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  CREATE TABLE IF NOT EXISTS watchdog_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL,
    issues_json TEXT NOT NULL DEFAULT '[]',
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- A secondary coin acceptor relayed back to this box over WiFi via an
  -- ESP32/ESP8266 board ("Satellite Kiosk", as opposed to this box's own
  -- directly-wired "Main Kiosk"). device_key is a pairing secret the
  -- operator flashes into that board's own config - unregistered relay
  -- traffic (no key, or a key that doesn't match) still works exactly as
  -- it always has, credited as generic "Coins" with no kiosk attribution,
  -- so existing ESP32 deployments in the field are never broken by this.
  CREATE TABLE IF NOT EXISTS satellite_kiosks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    device_key TEXT UNIQUE NOT NULL,
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Bug found via client-capacity audit: standaloneDriver.js's per-client
  -- tc classid used to be a hash (mac -> 100..999), not a real allocation.
  -- With only 900 slots, the birthday paradox makes a collision ~38% likely
  -- at just 30 concurrent shaped clients, ~99.6% by 100 - and a collision
  -- means two different customers silently share one HTB bandwidth class
  -- (one client's rate overwrites the other's), and if either disconnects,
  -- removeClientBandwidth() deletes the class both were using, killing the
  -- other's still-active shaping. This table makes classId a real,
  -- persistent, collision-free allocation instead.
  CREATE TABLE IF NOT EXISTS tc_class_allocations (
    mac_address TEXT PRIMARY KEY,
    class_id INTEGER UNIQUE NOT NULL,
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
    -- Distinct from isolate_clients above: that one is AP/bridge-level
    -- (client-to-client on the SAME lane). This is lane-to-lane isolation
    -- (this lane's traffic to every OTHER lane's subnet is dropped) - the
    -- firewall zone gap found 2026-08-09: an authenticated/paid gated-lane
    -- customer previously had no restriction reaching another lane's
    -- private subnet (e.g. a staff/home "open" lane) once past the
    -- paid-or-not check, since the forward chain only ever checked source
    -- lane (iifname), never destination lane (oifname).
    isolate_from_other_lanes INTEGER DEFAULT 1,
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

  -- Config safety engine (server/services/configSafety.js) audit trail.
  -- One row per attempted network configuration change (Standalone mode
  -- lane/port-role apply), win or lose - snapshot_json is the FULL
  -- pre-change state of every network table, enough to manually replay a
  -- restore even outside the app if something is ever really stuck.
  CREATE TABLE IF NOT EXISTS network_config_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    operator TEXT DEFAULT 'admin',
    reason TEXT DEFAULT '',
    snapshot_json TEXT NOT NULL,
    risk_reasons_json TEXT DEFAULT '[]',
    applied INTEGER DEFAULT 0,
    rolled_back INTEGER DEFAULT 0,
    verify_status TEXT,
    verify_detail TEXT
  );

  -- Named, reusable bandwidth profiles (network power) - previously an
  -- admin had to type raw Mbps numbers into every voucher's optional
  -- override fields by hand, no saved "Premium: 30/15" preset to pick
  -- from. Referenced by promo_vouchers.bandwidth_profile_id below.
  CREATE TABLE IF NOT EXISTS bandwidth_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    download_mbps INTEGER NOT NULL,
    upload_mbps INTEGER NOT NULL,
    burst_mbps INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Voucher Designer templates (Vouchers > Templates). elements_json is
  -- the full canvas layout - an array of {id,type,field,x,y,w,h,fontSize,
  -- fontWeight,color,align,content}, in inches relative to the template's
  -- own width_in/height_in so the same template scales correctly across
  -- different print sizes. is_system=1 templates ship with the app and
  -- can't be deleted (see the DELETE route's own check) - an operator
  -- edits a copy instead (Save as New Template), never the original.
  CREATE TABLE IF NOT EXISTS voucher_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    width_in REAL NOT NULL DEFAULT 3.5,
    height_in REAL NOT NULL DEFAULT 2,
    background_color TEXT DEFAULT '#ffffff',
    elements_json TEXT NOT NULL DEFAULT '[]',
    is_system INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Telemetry Tier 1 (server/services/telemetryService.js) - local-first
  -- outbox. Every event is written here FIRST, synced later, same
  -- "box must never depend on cloud connectivity" principle as
  -- licenseService.js - a box with no internet (or telemetry left off)
  -- just accumulates rows here forever with zero functional impact.
  -- Nothing is ever collected or sent unless the 'telemetry_enabled'
  -- setting is explicitly '1' (default '0' - opt-in, off until a real
  -- Privacy Policy exists to disclose what this table holds).
  CREATE TABLE IF NOT EXISTS telemetry_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    synced INTEGER DEFAULT 0,
    synced_at DATETIME,
    attempts INTEGER DEFAULT 0
  );

  -- Crash/error reports, same outbox+opt-in pattern as telemetry_outbox
  -- above but kept in its own table since these are diagnosed and pruned
  -- differently (e.g. an operator may want to see recent errors in-app
  -- even with sync off, vs. usage telemetry which has no local-viewing
  -- use case).
  CREATE TABLE IF NOT EXISTS error_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    error_type TEXT NOT NULL,
    message TEXT NOT NULL,
    stack TEXT,
    context_json TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    synced INTEGER DEFAULT 0,
    synced_at DATETIME,
    attempts INTEGER DEFAULT 0
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

try {
  db.exec('ALTER TABLE sessions ADD COLUMN redeemed_code TEXT');
} catch (e) {
  // already applied
}

try {
  // No FOREIGN KEY on purpose - a strict FK here would reproduce the same
  // "DELETE fails because a transaction still references it" bug class
  // already found with sessions/transactions. Deleting a kiosk nulls this
  // column out on its transactions first (see satelliteKioskService.js),
  // so this is informational, not enforced.
  db.exec('ALTER TABLE transactions ADD COLUMN kiosk_id INTEGER');
} catch (e) {
  // already applied
}

try {
  // See the mac_address column comment on the CREATE TABLE above - rows
  // from before this migration stay NULL (no way to backfill client
  // identity for already-deleted sessions), so New vs Returning reporting
  // only starts counting from the point this column exists onward.
  db.exec('ALTER TABLE transactions ADD COLUMN mac_address TEXT');
} catch (e) {
  // already applied
}

// Bug fix migration: a database created before this fix still has the old
// FOREIGN KEY(voucher_code) REFERENCES sessions(voucher_code) baked into
// transactions (SQLite doesn't support dropping a constraint in place -
// ALTER TABLE ... DROP CONSTRAINT isn't a thing here - so this rebuilds
// the table without it). Runs once; every boot after the first is a no-op
// once the FK is gone. Wrapped in an explicit transaction so a failure
// partway through leaves the original table untouched rather than losing
// data - this touches the financial ledger, so it does not get to be
// halfway migrated.
try {
  const fkList = db.pragma('foreign_key_list(transactions)');
  const hasVoucherFk = fkList.some(fk => fk.table === 'sessions' && fk.from === 'voucher_code');
  if (hasVoucherFk) {
    console.log('🔧 Migrating transactions table to drop its FK to sessions (fixes expireSession() failing on any session with transaction history)...');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE transactions_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          voucher_code TEXT NOT NULL,
          coin_value INTEGER NOT NULL,
          minutes_added REAL NOT NULL,
          type TEXT DEFAULT 'coin',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          kiosk_id INTEGER
        );
      `);
      db.exec(`
        INSERT INTO transactions_migrated (id, voucher_code, coin_value, minutes_added, type, created_at, kiosk_id)
        SELECT id, voucher_code, coin_value, minutes_added, type, created_at, kiosk_id FROM transactions;
      `);
      const oldCount = db.prepare('SELECT COUNT(*) c FROM transactions').get().c;
      const newCount = db.prepare('SELECT COUNT(*) c FROM transactions_migrated').get().c;
      if (oldCount !== newCount) {
        throw new Error(`Row count mismatch after copy: ${oldCount} -> ${newCount}, aborting migration`);
      }
      db.exec('DROP TABLE transactions');
      db.exec('ALTER TABLE transactions_migrated RENAME TO transactions');
      db.exec('COMMIT');
      console.log(`✅ transactions table migrated (${newCount} rows preserved, FK removed)`);
    } catch (migErr) {
      db.exec('ROLLBACK');
      console.error('⚠️ transactions FK migration failed, rolled back - original table untouched:', migErr.message);
    }
  }
} catch (e) {
  console.error('⚠️ transactions FK migration check failed:', e.message);
}

try {
  db.exec('ALTER TABLE sessions ADD COLUMN download_mbps INTEGER');
  db.exec('ALTER TABLE sessions ADD COLUMN upload_mbps INTEGER');
} catch (e) {
  // already applied
}

try {
  db.exec('ALTER TABLE promo_vouchers ADD COLUMN download_mbps INTEGER');
  db.exec('ALTER TABLE promo_vouchers ADD COLUMN upload_mbps INTEGER');
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
  insertSetting.run('cafe_name', 'ZenFi');
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

  // Dashboard: comprehensive view (live bandwidth graph, extra system
  // health detail) vs a clean/minimal one. Off by default - a clean
  // dashboard is the safer default for a non-technical owner; anyone who
  // wants the deeper view opts in.
  insertSetting.run('dashboard_comprehensive', '0');

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

  // Account tier ('free' or 'premium') - gates MikroTik/OpenWRT router mode
  // to Premium only (free tier is Standalone-only). No real licensing/
  // payment system exists yet (see licenseService.js's own "inert until a
  // real server exists" pattern) - this is the same shape, a real flag
  // ready to be driven by a payment system later, defaulting to the
  // permissive/current-beta behavior until then.
  insertSetting.run('account_tier', 'free');

  // Venue type ('piso_wifi', 'cafe', 'coworking') - changes portal/Overview
  // behavior and labels. Defaults to piso_wifi so every existing install's
  // behavior is completely unchanged until this is explicitly changed.
  insertSetting.run('venue_type', 'piso_wifi');

  // Admin login 2FA (TOTP) - opt-in, off by default.
  insertSetting.run('admin_2fa_enabled', '0');
  insertSetting.run('admin_2fa_secret', '');

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

  // Upstream DNS servers - previously hardcoded to 8.8.8.8/8.8.4.4 in
  // setup-network.sh with no operator control at all (only Pi-hole
  // on/off). These are the real, editable defaults now; Pi-hole (when
  // enabled) still gets prepended ahead of these, unchanged.
  insertSetting.run('dns_upstream_1', '8.8.8.8');
  insertSetting.run('dns_upstream_2', '8.8.4.4');
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
  upsertIfMissing('account_tier', 'free');
  // Admin login 2FA (TOTP) - opt-in, off by default so nothing changes for
  // anyone who doesn't turn it on. admin_2fa_secret is encrypted at rest
  // the same way mikrotik_pass is (secretCrypto.js) - it's effectively a
  // credential, same resale/misuse risk class.
  upsertIfMissing('admin_2fa_enabled', '0');
  upsertIfMissing('admin_2fa_secret', '');
  upsertIfMissing('venue_type', 'piso_wifi');
  // Telemetry (server/services/telemetryService.js) - off by default,
  // mechanism-only until a real Privacy Policy is published and a UI
  // toggle is exposed (see that file's header for the full reasoning).
  upsertIfMissing('telemetry_enabled', '0');
}

// Tracks whether the 2-minutes-remaining push notification has already
// been sent for THIS session, so timerService.js's 30s tick (which
// re-checks every active session every cycle) doesn't re-send it over and
// over for the same session while it sits under the threshold. Reset back
// to 0 whenever more time is added (sessionService.js's addTimeToSession)
// so a customer who tops up before running out can get warned again later.
try {
  db.exec('ALTER TABLE sessions ADD COLUMN push_2min_sent INTEGER DEFAULT 0');
} catch (e) {
  // already applied
}

try {
  // Default 1 (isolated) matches the safe default a gated/guest lane
  // should have; an existing install's rows all backfill to this same
  // safe default rather than silently staying unisolated after upgrade.
  db.exec('ALTER TABLE router_ports ADD COLUMN isolate_from_other_lanes INTEGER DEFAULT 1');
} catch (e) {
  // already applied
}

{
  // Backfill for existing installs that predate the DNS manager - same
  // upsertIfMissing pattern already used for mikrotik_ssl/account_tier
  // etc. above.
  const dnsRow1 = db.prepare("SELECT key FROM settings WHERE key = 'dns_upstream_1'").get();
  if (!dnsRow1) db.prepare("INSERT INTO settings (key, value) VALUES ('dns_upstream_1', '8.8.8.8')").run();
  const dnsRow2 = db.prepare("SELECT key FROM settings WHERE key = 'dns_upstream_2'").get();
  if (!dnsRow2) db.prepare("INSERT INTO settings (key, value) VALUES ('dns_upstream_2', '8.8.4.4')").run();
}

try {
  // Optional link to a saved bandwidth_profiles row - NULL means "use the
  // voucher's own download_mbps/upload_mbps fields directly" (unchanged
  // existing behavior), same "opt-in, nothing breaks" pattern as every
  // other additive column in this file.
  db.exec('ALTER TABLE promo_vouchers ADD COLUMN bandwidth_profile_id INTEGER REFERENCES bandwidth_profiles(id)');
} catch (e) {
  // already applied
}

try {
  // Optional link from a voucher group to a Plan - NULL means the group
  // still carries its own duration/price directly (existing behavior,
  // predates the Plans module). When set, the group's duration/price
  // columns are populated from the plan at creation time so every
  // existing read site (redemption, printing, exports) keeps working
  // unchanged; the link is what lets "Used Today" on the Plans page
  // count real voucher redemptions instead of being a fabricated number.
  db.exec('ALTER TABLE voucher_groups ADD COLUMN plan_id INTEGER REFERENCES plans(id)');
} catch (e) {
  // already applied
}

// Access Points: discovery-first columns added after the initial v1
// (manual-registry-only) release - see access_points table comment.
for (const stmt of [
  "ALTER TABLE access_points ADD COLUMN hostname TEXT",
  "ALTER TABLE access_points ADD COLUMN management_state TEXT NOT NULL DEFAULT 'unmanaged'",
  "ALTER TABLE access_points ADD COLUMN vlan_id INTEGER",
  "ALTER TABLE access_points ADD COLUMN vlan_evidence TEXT",
  "ALTER TABLE access_points ADD COLUMN discovered_via TEXT",
]) {
  try { db.exec(stmt); } catch (e) { /* already applied */ }
}

// VAPID keypair for Web Push (server/services/pushNotificationService.js) -
// generated once and persisted in settings, not regenerated on every boot,
// since every customer's existing push subscription is cryptographically
// tied to whatever public key they subscribed against - rotating it would
// silently break every subscription made before the rotation.
try {
  const hasVapidKeys = db.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get();
  if (!hasVapidKeys) {
    const webpush = require('web-push');
    const vapidKeys = webpush.generateVAPIDKeys();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vapid_public_key', vapidKeys.publicKey);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vapid_private_key', vapidKeys.privateKey);
    console.log('🔑 Generated new VAPID keypair for Web Push notifications');
  }
} catch (e) {
  console.error('⚠️ VAPID key generation failed:', e.message);
}

// ===== MULTI-TENANT DATA MODEL (Organization -> Site) =====
// Foundation layer for ZenFi_Navigation_and_System_Specification.md's nav
// shell (site switcher) and Controller Mode's device adoption flow - see
// this project's multi-tenant decision notes. Schema/data-model only, no
// auth enforcement or nav/UI wiring here (that's later, separate work).
//
// Every existing install is single-tenant today (one box, one operator).
// This does NOT change that in practice: a default Organization + Site
// is created once below and every existing tenant-owned table's rows are
// backfilled to point at it, so nothing currently working changes
// behavior. New code can start scoping queries by site_id going forward;
// old code that ignores site_id still works exactly as before since
// there's only ever been the one site until an operator (or a future
// central dashboard) creates more.
db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    venue_type TEXT DEFAULT 'piso_wifi',
    address TEXT DEFAULT '',
    timezone TEXT DEFAULT '',
    is_default INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- RBAC foundation only - this app still authenticates via the single
  -- admin_password setting (+ optional TOTP), nothing reads or enforces
  -- this table yet. Exists so a future multi-user/site-scoped permissions
  -- page has a real table to build against instead of starting from
  -- nothing, per the sequencing note in the multi-tenant decision (data
  -- model + auth scoping before the pages that depend on it).
  CREATE TABLE IF NOT EXISTS site_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    username TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, username)
  );
`);

// Tenant-owned tables that gain a site_id scope. Deliberately excludes
// `settings` (a genuine global singleton key-value store today, not
// per-site data - splitting it into per-site settings is a larger,
// separate refactor) and the two new telemetry tables (device-level, not
// site-level, by design - see telemetryService.js).
const SITE_SCOPED_TABLES = [
  'sessions', 'transactions', 'promo_vouchers', 'voucher_groups', 'rates',
  'session_history', 'free_claims', 'vlans', 'vendos', 'trusted_devices',
  'watchdog_events', 'satellite_kiosks', 'tc_class_allocations',
  'router_ports', 'static_leases', 'port_forwards', 'client_labels',
  'network_config_versions', 'bandwidth_profiles',
];

try {
  const orgCountRow = db.prepare('SELECT COUNT(*) as c FROM organizations').get();
  if (orgCountRow.c === 0) {
    // First boot on this schema version - create the default org/site
    // this existing single-box install has implicitly always been, and
    // backfill every tenant-owned table's existing rows to it. Runs
    // exactly once: guarded by "no organizations exist yet", not by a
    // version flag, so it's safe even if this code runs again.
    const venueTypeRow = db.prepare("SELECT value FROM settings WHERE key = 'venue_type'").get();
    const venueType = venueTypeRow ? venueTypeRow.value : 'piso_wifi';

    const orgId = db.prepare("INSERT INTO organizations (name) VALUES ('Default Organization')").run().lastInsertRowid;
    const siteId = db.prepare(
      "INSERT INTO sites (organization_id, name, venue_type, is_default) VALUES (?, 'Main Site', ?, 1)"
    ).run(orgId, venueType).lastInsertRowid;

    for (const table of SITE_SCOPED_TABLES) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN site_id INTEGER REFERENCES sites(id)`);
      } catch (e) {
        // column already exists (re-run safety) - fall through to backfill
      }
      db.prepare(`UPDATE ${table} SET site_id = ? WHERE site_id IS NULL`).run(siteId);
    }

    const adminRow = db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get();
    if (adminRow) {
      db.prepare("INSERT OR IGNORE INTO site_memberships (site_id, username, role) VALUES (?, 'admin', 'owner')").run(siteId);
    }

    console.log(`🏢 Multi-tenant data model initialized: Default Organization / Main Site (site_id=${siteId})`);
  } else {
    // Not first boot - still make sure any table added to
    // SITE_SCOPED_TABLES after an install's first boot gets its column
    // (existing rows backfilled to that install's default site).
    const defaultSite = db.prepare('SELECT id FROM sites WHERE is_default = 1 ORDER BY id LIMIT 1').get();
    for (const table of SITE_SCOPED_TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes('site_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN site_id INTEGER REFERENCES sites(id)`);
        if (defaultSite) {
          db.prepare(`UPDATE ${table} SET site_id = ? WHERE site_id IS NULL`).run(defaultSite.id);
        }
      }
    }
  }
} catch (e) {
  console.error('⚠️ Multi-tenant data model migration failed:', e.message);
}

// Seed exactly one real system template ("ZenFi Standard") - not the
// full 8-template gallery a complete Voucher Designer would eventually
// ship, since designing 7 more fully-styled layouts by hand here would
// be inventing content, not building the feature. An operator can
// duplicate/edit this one and save their own from it.
try {
  const hasSystemTemplate = db.prepare("SELECT id FROM voucher_templates WHERE is_system = 1 LIMIT 1").get();
  if (!hasSystemTemplate) {
    const standardElements = [
      { id: 'el1', type: 'text', field: null, x: 0.15, y: 0.12, w: 3.2, h: 0.35, fontSize: 20, fontWeight: '700', color: '#0c8f6d', align: 'left', content: 'ZenFi WiFi' },
      { id: 'el2', type: 'voucher_code', field: 'voucher.code', x: 0.15, y: 0.55, w: 2.0, h: 0.4, fontSize: 22, fontWeight: '900', color: '#111827', align: 'left', content: 'SAMPLE-CODE' },
      { id: 'el3', type: 'price', field: 'voucher.price', x: 0.15, y: 1.0, w: 1.0, h: 0.3, fontSize: 14, fontWeight: '600', color: '#374151', align: 'left', content: '₱10' },
      { id: 'el4', type: 'duration', field: 'voucher.duration', x: 1.2, y: 1.0, w: 1.2, h: 0.3, fontSize: 14, fontWeight: '600', color: '#374151', align: 'left', content: '30 Minutes' },
      { id: 'el5', type: 'qr_code', field: 'voucher.qr_url', x: 2.35, y: 0.12, w: 1.0, h: 1.0, fontSize: 0, fontWeight: '400', color: '#000000', align: 'center', content: '' },
      { id: 'el6', type: 'text', field: null, x: 0.15, y: 1.4, w: 3.2, h: 0.3, fontSize: 10, fontWeight: '400', color: '#6b7280', align: 'left', content: 'Scan the QR code or enter the code above to connect.' },
    ];
    db.prepare(`
      INSERT INTO voucher_templates (name, description, width_in, height_in, background_color, elements_json, is_system)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run('ZenFi Standard', 'Clean general-purpose voucher with a QR code.', 3.5, 2, '#ffffff', JSON.stringify(standardElements));
    console.log('🎫 Seeded default "ZenFi Standard" voucher template');
  }
} catch (e) {
  console.error('⚠️ Voucher template seed failed:', e.message);
}

console.log('✅ Database initialized successfully');

module.exports = db;