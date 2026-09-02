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
  -- Note: status column removed (Bug #1), sessions are deleted on expiry, so existing sessions are always active

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
    is_premium INTEGER NOT NULL DEFAULT 0,
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
  -- device StarkFi connects to over the MikroTik API client
  -- (mikrotikApiClient.js), distinct from this box's own single
  -- mikrotik_host/mikrotik_user/mikrotik_pass settings (Network page,
  -- Controller Mode) which remain untouched. A registered router here is
  -- something StarkFi monitors/manages in addition to, not instead of,
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
    label TEXT NOT NULL,
    download_mbps REAL,
    upload_mbps REAL
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
    device_secret TEXT,
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

  -- Persisted event/alert log, backing the notification bell. Distinct
  -- from watchdog_events (which re-saves the FULL current issue list every
  -- 2 minutes, no concept of new-vs-ongoing) - this table only gets a row
  -- when something actually happens: a real state transition (a watchdog
  -- issue newly appearing/clearing, a vendo connecting/disconnecting), or
  -- a one-off occurrence (a coin credited, a new candidate device seen).
  -- See server/services/alertEventService.js.
  CREATE TABLE IF NOT EXISTS alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    severity TEXT NOT NULL, -- 'critical' | 'warning' | 'info'
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Customer-submitted issue reports from the portal's "Report a Problem"
  -- button (server/routes/portal.js's POST /report), shown in the admin
  -- panel's Reports page so the operator can see and resolve complaints
  -- without needing the customer to flag someone down in person.
  CREATE TABLE IF NOT EXISTS customer_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT,
    voucher_code TEXT,
    name TEXT,
    category TEXT NOT NULL DEFAULT 'other', -- 'slow_internet' | 'credit_missed' | 'other'
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'spam'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  );

  -- A MAC blocked here can no longer submit new reports (server/routes/
  -- portal.js's POST /report) - the operator's tool for a customer using
  -- the report button to send junk/prank messages rather than a real
  -- issue. Separate from network access entirely - a blocked MAC keeps
  -- its WiFi/session exactly as before, this only silences the report
  -- channel.
  CREATE TABLE IF NOT EXISTS report_blocked_macs (
    mac_address TEXT PRIMARY KEY,
    blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Two-way thread under a customer_reports row - the admin's reply and
  -- any follow-up from the customer, not just a single status change.
  -- 'system' entries are auto-generated (e.g. "Admin credited ₱10"), so
  -- the approve-credit action leaves a visible paper trail in the same
  -- thread instead of a silent DB update.
  CREATE TABLE IF NOT EXISTS report_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES customer_reports(id),
    sender TEXT NOT NULL, -- 'admin' | 'customer' | 'system'
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Raw receipt log for every coin pulse report the server gets from a
  -- vendo (server/routes/coin.js's POST /), logged the instant it's
  -- received - before spam-blocking, pending-window accumulation, or
  -- crediting decide what happens to it. This is the "backup sensor":
  -- when a customer disputes a missed credit, this table is the proof
  -- the hardware really did (or didn't) send a signal to the server at
  -- that time, independent of whatever the pending/credit logic then did
  -- with it.
  CREATE TABLE IF NOT EXISTS coin_pulse_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT,
    coin_value INTEGER,
    kiosk_id INTEGER,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- A vendo device's OWN account of what it experienced while it
  -- couldn't reach the server (WiFi lost, setup mode auto-triggered, a
  -- coin queued for later sync) - uploaded once it reconnects via
  -- POST /api/admin/vendo/device-log-sync. device_at is the device's own
  -- millis()-since-boot timestamp at the time of the event (meaningless
  -- as an absolute time, only useful for ordering events relative to
  -- each other within one sync batch) - received_at is the real,
  -- server-side clock time this row was actually stored.
  CREATE TABLE IF NOT EXISTS vendo_device_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT,
    message TEXT,
    device_at INTEGER,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Local movie library (server/services/movieService.js). One row per
  -- source video file found under settings.movies_source_dir. 'free'
  -- tier movies are watchable by anyone with an active WiFi session (the
  -- same gate as internet access); 'premium' movies need a separate
  -- per-device coin unlock (movie_rentals below), independent of the
  -- WiFi timer - matches new releases being pay-per-unlock while the
  -- older library is bundled with any paid session.
  CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'free', -- 'free' | 'premium'
    price_pesos INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER,
    thumbnail_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'transcoding' | 'ready' | 'failed'
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- One row per device that has paid to unlock one premium movie.
  -- expires_at follows settings.movie_rental_hours (operator-adjustable,
  -- same "rental window" concept as a real video-rental unlock) rather
  -- than being permanent.
  CREATE TABLE IF NOT EXISTS movie_rentals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    movie_id INTEGER NOT NULL REFERENCES movies(id),
    mac_address TEXT NOT NULL,
    rented_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  );

  -- Separate ledger for the ONLINE (vidrock.ru embed) movie catalog - see
  -- server/services/onlineMovieCatalog.js. movie_id here is a TMDb id, NOT
  -- a foreign key into the local movies table above; kept in its own
  -- table specifically so an online TMDb id can never collide with a local
  -- movies.id (both are small integers and could otherwise overlap).
  CREATE TABLE IF NOT EXISTS online_movie_rentals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    movie_id INTEGER NOT NULL,
    mac_address TEXT NOT NULL,
    rented_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  );

  -- A real vending machine can't make change, so an online-movie coin
  -- window that closes short of the price (or over it) used to just keep
  -- the money with nothing to show for it - same as local movie rentals.
  -- This table gives that leftover a home instead: it accumulates per MAC
  -- (both underpaid and overpaid amounts land here) and the customer can
  -- spend it later as regular WiFi coin credit (POST /api/portal/credit/use,
  -- which runs the balance through the same rate-matching creditCoinValue()
  -- already uses for a normal coin insert). One row per device.
  CREATE TABLE IF NOT EXISTS movie_credits (
    mac_address TEXT PRIMARY KEY,
    balance_pesos INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- One-time metadata lookup cache for the online movie catalog (see
  -- server/services/tmdbService.js) - keyed by the same TMDb id used
  -- everywhere else for these titles. poster_path is null when TMDb has no
  -- poster for that id; genres is a JSON array of genre name strings (e.g.
  -- '["Action","Science Fiction"]'), captured from the SAME API response as
  -- the poster lookup - no extra request. Used to group the Online tab into
  -- Netflix-style genre rows instead of one giant tier row. NULL
  -- fetched_at means "never looked up yet".
  CREATE TABLE IF NOT EXISTS tmdb_poster_cache (
    tmdb_id INTEGER PRIMARY KEY,
    poster_path TEXT,
    genres TEXT,
    fetched_at DATETIME
  );

  -- Real per-title play counts for the online catalog, incremented once per
  -- successful GET /online-movies/:id/embed (server/routes/portal.js) - i.e.
  -- every time a customer actually presses play and the movie was unlocked,
  -- not just every page view. Drives the client's "Top 10 Most Watched" row
  -- (public/portal/assets/js/movies-online.js) - a real, live ranking, not a
  -- hand-picked/fake one.
  CREATE TABLE IF NOT EXISTS online_movie_views (
    movie_id INTEGER PRIMARY KEY,
    views INTEGER NOT NULL DEFAULT 0
  );

  -- Superseded by streaming_sources further down (kept, not dropped - see
  -- that table's comment for why, and the one-time migration below that
  -- copies these rows forward).
  CREATE TABLE IF NOT EXISTS movie_streaming_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url_template TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Admin-managed price overrides/additions for the online catalog (see
  -- server/services/onlineMovieCatalog.js). A tmdb_id with no row here is
  -- 'free' by default - a row only needs to exist for something the admin
  -- has deliberately priced, or a title added directly by TMDb ID or via
  -- search that wasn't already in the synced feed. This table (+
  -- tmdb_movie_feed) is the ENTIRE catalog now - there is no hardcoded
  -- starter list anymore, on purpose (removed per owner request so nothing
  -- ships in code that isn't visible/editable in the admin panel).
  CREATE TABLE IF NOT EXISTS online_movie_pricing (
    tmdb_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'paid', -- 'free' | 'paid'
    price_pesos INTEGER NOT NULL DEFAULT 0,
    poster_path TEXT,
    -- Admin-set display priority (Movies > Online > Price Groups) - higher
    -- shows first within the 🔥 Exclusive row and within each genre row,
    -- replacing TMDb's own popularity/rating ordering with something the
    -- operator actually controls. Default 0 (no manual boost).
    priority INTEGER NOT NULL DEFAULT 0,
    -- Per-movie rental window in hours for paid titles - 0 means "use the
    -- global movie_rental_hours setting" (see server/routes/coin.js), a
    -- positive value overrides it for just this title (e.g. a 12-hour
    -- window for a title priced differently than the rest of the catalog).
    -- Permanent-per-device access is a separate, manual admin grant (see
    -- online_movie_rentals below) - not a property of the movie itself.
    rental_hours INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Auto-populated from TMDB's own Trending/Popular/Top Rated lists (admin
  -- panel's Movies > Online > "Sync from TMDB" button, see
  -- server/services/tmdbService.js's syncFeed()) so the browsable catalog
  -- doesn't depend on anyone hand-typing TMDb ids. Merged with the hardcoded
  -- starter CATALOG in onlineMovieCatalog.js - everything here is free by
  -- default unless it also has a row in online_movie_pricing.
  CREATE TABLE IF NOT EXISTS tmdb_movie_feed (
    tmdb_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    poster_path TEXT,
    genres TEXT, -- JSON array of genre name strings
    source TEXT, -- 'trending' | 'popular' | 'top_rated' | 'new_release', whichever it was first seen in
    release_date TEXT, -- TMDb's 'YYYY-MM-DD', or NULL for rows synced before this column existed
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- A tmdb_id an admin has explicitly removed from the Online Movies catalog
  -- (Movies > Online > Price Groups' Delete button) - e.g. a title that
  -- isn't appropriate for customers to see. Separate from just deleting the
  -- pricing/feed rows because tmdb-sync would otherwise just re-add it the
  -- next time it's popular/trending; this is checked by both syncFeed() and
  -- onlineMovieCatalog.getAll()/getById() so a hidden title is gone for good
  -- until an admin explicitly un-hides it (not currently exposed in the UI -
  -- re-adding by TMDb ID or search clears it, see onlineMovieCatalog.js).
  CREATE TABLE IF NOT EXISTS online_movie_hidden (
    tmdb_id INTEGER PRIMARY KEY,
    hidden_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- One row per search that ended in the customer actually opening a movie
  -- from the results (not every keystroke - a search that goes nowhere
  -- says nothing about real demand). Powers the admin's "Top Searches"
  -- panel (Movies > Online) - what customers are looking for, including
  -- titles that aren't in the catalog yet if the click-through target is
  -- still recorded as whatever they clicked closest to their intent.
  CREATE TABLE IF NOT EXISTS online_movie_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    movie_id INTEGER NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'movie', -- 'movie' | 'tv' - reused by TV Shows' Top Searches
    searched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- "Request a Movie" form in the portal's Movies tab (public/portal/
  -- assets/js/movies-online.js) - a customer asks for a title that isn't in
  -- the catalog yet. One row per submission, rate-limited to one per
  -- mac_address per rolling 24h (see POST /api/portal/movie-requests) so a
  -- device can't spam the list, but a device CAN submit many different
  -- requests over time (one a day, forever). Reviewed in the admin panel's
  -- Movies > Online > Movie Requests panel.
  CREATE TABLE IF NOT EXISTS movie_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT NOT NULL,
    requester_name TEXT NOT NULL,
    title TEXT NOT NULL,
    year TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'added' | 'declined'
    media_type TEXT NOT NULL DEFAULT 'movie', -- 'movie' | 'tv' - reused by TV Shows' Requests panel
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ===== TV SHOWS (series/anime/K-drama with seasons & episodes) =====
  -- A parallel system to the Online Movies tables above, on purpose kept
  -- entirely separate rather than reusing tmdb_movie_feed/
  -- online_movie_pricing: TMDb's TV endpoints (/tv/*, /search/tv,
  -- /discover/tv) are a different API surface from /movie/*, a series id
  -- and a movie id can collide (both are just small TMDb integers, same
  -- reason online_movie_rentals never shared a table with movie_rentals),
  -- and a series needs season/episode structure a movie has no concept of
  -- at all. Same owner-approved design as movies: whole-series pricing
  -- (pay once, unlock every season/episode for the rental window, not
  -- per-episode), and rows organized automatically from TMDb's own
  -- genre + origin_country data (Anime = Animation genre + Japan origin,
  -- K-Drama = Korea origin) rather than manual per-title tagging.
  -- Separate from tmdb_poster_cache on purpose - a TV series id and a
  -- movie id are both just small TMDb integers from two different id
  -- spaces and can coincidentally collide, same reasoning as
  -- tv_series_rentals vs movie_rentals. Also carries origin_country
  -- (genres alone can't tell Anime from any other Animation, or K-Drama
  -- from any other Drama).
  CREATE TABLE IF NOT EXISTS tv_poster_cache (
    tmdb_id INTEGER PRIMARY KEY,
    poster_path TEXT,
    genres TEXT, -- JSON array of genre name strings
    origin_country TEXT, -- JSON array, e.g. '["JP"]'
    fetched_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS tv_series_feed (
    tmdb_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    poster_path TEXT,
    genres TEXT, -- JSON array of genre name strings
    origin_country TEXT, -- JSON array, e.g. '["JP"]' - drives Anime/K-Drama auto-rows
    source TEXT, -- 'trending' | 'popular' | 'top_rated' | 'new_release'
    first_air_date TEXT, -- TMDb's 'YYYY-MM-DD'
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tv_series_pricing (
    tmdb_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'paid', -- 'free' | 'paid'
    price_pesos INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    rental_hours INTEGER NOT NULL DEFAULT 0, -- 0 = use movie_rental_hours global default
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tv_series_hidden (
    tmdb_id INTEGER PRIMARY KEY,
    hidden_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Unlocks the WHOLE series (every season/episode) for the rental window,
  -- not one episode - mirrors online_movie_rentals exactly, including the
  -- same far-future-sentinel convention for a permanent admin grant (see
  -- server/routes/admin.js's PERMANENT_RENTAL_EXPIRY).
  CREATE TABLE IF NOT EXISTS tv_series_rentals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    mac_address TEXT NOT NULL,
    rented_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  );

  -- Superseded by streaming_sources below (kept, not dropped, so a
  -- pre-existing install's rows are never destroyed - the one-time
  -- migration further down copies them forward instead).
  CREATE TABLE IF NOT EXISTS tv_streaming_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url_template TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- One combined "Streaming Sources" list for both Movies and TV Shows,
  -- replacing movie_streaming_sources/tv_streaming_sources above (owner
  -- request: a real provider is usually one server offering both movie
  -- and series embeds, e.g. vidcore.org/embed/movie/{tmdb_id} AND
  -- vidcore.org/embed/tv/{tmdb_id}/{season}/{episode} - two separate
  -- admin sections just duplicated the same "Server 1/2/3" list for no
  -- reason). Either template can be NULL (a provider that only serves one
  -- kind), but at least one is required - enforced in the admin route, not
  -- here, so this stays a straightforward CREATE TABLE.
  -- Season/episode placeholder NAMING varies by provider (seen live:
  -- {season}/{episode} and {season_number}/{episode_number}) - the actual
  -- substitution in server/routes/portal.js accepts either, so an admin
  -- can paste whatever token names their specific provider's docs use
  -- rather than being forced into one exact spelling.
  CREATE TABLE IF NOT EXISTS streaming_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    movie_url_template TEXT,
    tv_url_template TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Real per-series play counts (incremented once per episode actually
  -- played, not per browse) - same "Top Watched" role online_movie_views
  -- plays for movies. Series-level, not per-episode: a customer watching
  -- through a season shouldn't fragment the count across 12 rows.
  CREATE TABLE IF NOT EXISTS tv_series_views (
    series_id INTEGER PRIMARY KEY,
    views INTEGER NOT NULL DEFAULT 0
  );

  -- Short-lived cache of a season's episode list (TMDb's /tv/{id}/season/
  -- {n}) - fetched live the first time any customer opens that season,
  -- reused for a day afterward so ten customers browsing the same popular
  -- series' Season 1 in one evening doesn't mean ten separate TMDb calls.
  CREATE TABLE IF NOT EXISTS tv_season_cache (
    series_id INTEGER NOT NULL,
    season_number INTEGER NOT NULL,
    data TEXT NOT NULL, -- JSON array of {episode_number, name, still_path, air_date}
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (series_id, season_number)
  );

  -- Portal ad/promo carousel (new movies, promos, whatever the operator
  -- wants customers to see the moment they connect) - a list of images
  -- shown above the STARKFI banner text, distinct from the existing
  -- single low-opacity settings.banner_url background image. See
  -- server/routes/admin.js's /promo-banner-images* routes.
  CREATE TABLE IF NOT EXISTS promo_banner_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_path TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ===== PC RENTAL =====
  -- Completely separate ledger/session model from WiFi (sessions/
  -- transactions) - a rental PC is a fixed station identified by its own
  -- MAC, not a roaming phone, and its "session" is desktop lock/unlock
  -- state, not bandwidth gating. Windows client pairing mirrors vendos'
  -- candidate/adopted + device_secret pattern exactly (server/routes/
  -- rental.js's POST /register).
  CREATE TABLE IF NOT EXISTS rental_pcs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    mac_address TEXT UNIQUE NOT NULL,
    device_secret TEXT,
    ip_address TEXT,
    status TEXT NOT NULL DEFAULT 'candidate', -- 'candidate' | 'adopted'
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- One live row per PC (pc_id UNIQUE), same absolute-timestamp expiry
  -- approach as sessions.expires_at/hard_expires_at rather than a poll-
  -- driven countdown - the Windows client just asks "am I locked right
  -- now" and the server always has an authoritative answer regardless of
  -- how often it's asked.
  CREATE TABLE IF NOT EXISTS rental_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pc_id INTEGER UNIQUE NOT NULL REFERENCES rental_pcs(id),
    minutes_remaining REAL NOT NULL DEFAULT 0,
    expires_at DATETIME,
    hard_expires_at DATETIME,
    is_paused INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Revenue trail, mirrors transactions - never shares rows with WiFi's
  -- transactions table, PC rental income is tracked completely separately.
  CREATE TABLE IF NOT EXISTS rental_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pc_id INTEGER NOT NULL REFERENCES rental_pcs(id),
    coin_value INTEGER NOT NULL,
    minutes_added REAL NOT NULL,
    type TEXT NOT NULL DEFAULT 'coin', -- 'coin' | 'admin_credit'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Separate pricing from WiFi's own rates table - PC rental time is
  -- priced independently. tier splits pricing the way the reference
  -- system does (NON-VIP/VIP/VVIP get different time-per-coin), points
  -- is how many loyalty points a member earns for redeeming this rate
  -- (0 for guest/walk-in credit, which earns no points).
  CREATE TABLE IF NOT EXISTS rental_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_value INTEGER NOT NULL,
    minutes REAL NOT NULL,
    tier TEXT NOT NULL DEFAULT 'non_vip', -- 'non_vip' | 'vip' | 'vvip'
    points INTEGER NOT NULL DEFAULT 0
  );

  -- A member account, separate from the anonymous per-PC guest model
  -- (rental_pcs/rental_sessions) - a member's time follows THEM across
  -- whichever PC they log into, tracked as three independent balances
  -- (one per tier) rather than one pooled number, matching the reference
  -- system exactly (a member can hold NON-VIP time from cheap coins and
  -- VIP time redeemed from points at the same time).
  CREATE TABLE IF NOT EXISTS rental_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    non_vip_seconds INTEGER NOT NULL DEFAULT 0,
    vip_seconds INTEGER NOT NULL DEFAULT 0,
    vvip_seconds INTEGER NOT NULL DEFAULT 0,
    credit_pesos INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME
  );

  -- Points -> time conversion menu (Redeem Rates page). Independent of
  -- rental_rates (coin -> time) - this is the points economy's own
  -- pricing.
  CREATE TABLE IF NOT EXISTS rental_redeem_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    points INTEGER NOT NULL,
    reward_seconds INTEGER NOT NULL
  );

  -- One row per redemption (Redeem History page) - a real, permanent log,
  -- not derived/recomputed, since rental_members.points is mutated in
  -- place and this is the only record of what a member actually redeemed
  -- and when.
  CREATE TABLE IF NOT EXISTS rental_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES rental_members(id),
    points_spent INTEGER NOT NULL,
    reward_seconds INTEGER NOT NULL,
    remaining_points INTEGER NOT NULL,
    redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Apps exempted from the Windows client's auto-close-all-running-apps
  -- behavior on lockscreen (a Settings toggle, see settings.rental_
  -- enable_auto_close) - e.g. antivirus, the client itself.
  CREATE TABLE IF NOT EXISTS rental_whitelisted_apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name TEXT NOT NULL
  );

  -- Lock-screen wallpaper images the Windows client displays - separate
  -- from the WiFi portal's own branding (public/portal), since this
  -- shows on the physical rental PC's screen, not a customer's phone.
  -- Only one is 'active' at a time.
  CREATE TABLE IF NOT EXISTS rental_wallpapers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_path TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Cash reconciliation: an operator's own physical coin count for a
  -- period, compared against what the system logged as credited over that
  -- same window (transactions.coin_value). A mismatch here isn't
  -- necessarily theft, it can just as easily be an electrical glitch
  -- crediting a bit of extra free time, but without a record to compare
  -- against, either way looks like an unexplained gap when counting coins
  -- against the books. system_amount is captured at save time, not
  -- recomputed later, so an old reconciliation stays a true snapshot even
  -- if transactions data is later pruned by dataRetentionService.js.
  CREATE TABLE IF NOT EXISTS cash_reconciliations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_start DATETIME NOT NULL,
    period_end DATETIME NOT NULL,
    physical_amount REAL NOT NULL,
    system_amount REAL NOT NULL,
    difference REAL NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  -- Network Devices: admin-defined groups (Gaming/Kids/IoT/Guest/etc.),
  -- for future firewall/QoS/schedule integration per the spec. One group
  -- per device (mac_address is the primary key) - simplest model matching
  -- how an admin actually thinks about grouping ("this device is in
  -- Gaming"), not a many-to-many tagging system.
  CREATE TABLE IF NOT EXISTS device_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS device_group_members (
    mac_address TEXT PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE
  );

  -- Network Devices + Vendo history/audit log, one shared table rather than
  -- a separate one per feature (the reconciliation earlier this session
  -- was exactly this mistake happening once already - two disconnected
  -- registries for the same concept). Admin-initiated events only for now
  -- (adopted/renamed/group changed/removed) - automatic IP/hostname/
  -- online-offline change tracking would need a continuous background
  -- poller comparing snapshots over time, a bigger addition not built yet.
  -- Network Devices: which MACs an admin has explicitly blocked. Real
  -- enforcement (networkService.blockClient(), the same mode-aware nftables/
  -- RouterOS mechanism session management already uses) - this table is
  -- just persistence so the UI can show blocked state and the block
  -- survives this box's own process restart. It does NOT survive a full
  -- network reconfiguration (setup-network.sh rebuilding firewall state
  -- from scratch at boot) - reapplying blocks at boot isn't wired up yet,
  -- a real, documented limitation rather than something silently broken.
  CREATE TABLE IF NOT EXISTS device_blocks (
    mac_address TEXT PRIMARY KEY,
    blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS device_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT NOT NULL,
    event_type TEXT NOT NULL,
    details TEXT,
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

// customer_reports gained name/category after some installs already had
// the table (from the report-button feature's first pass, before these
// columns existed) - same additive-migration pattern as above.
try {
  db.exec("ALTER TABLE customer_reports ADD COLUMN name TEXT");
} catch (e) { /* already applied */ }
try {
  db.exec("ALTER TABLE customer_reports ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
} catch (e) { /* already applied */ }

// rental_rates gained tier/points after some installs already had the
// table (PC Rental's first pass, before the Members/points economy
// existed) - same additive-migration pattern as above. Missing this
// meant any install that created a rate before this commit would have
// every subsequent rate insert fail with "no column named tier".
try {
  db.exec("ALTER TABLE rental_rates ADD COLUMN tier TEXT NOT NULL DEFAULT 'non_vip'");
} catch (e) { /* already applied */ }
try {
  db.exec("ALTER TABLE rental_rates ADD COLUMN points INTEGER NOT NULL DEFAULT 0");
} catch (e) { /* already applied */ }

// Members simplified from three tier balances (NON-VIP/VIP/VVIP) down to
// one plain "seconds" balance - guest vs member is the only distinction
// that matters now, not a tier system. Existing rows keep whatever
// they'd already banked, summed into the new single column so nothing
// is lost.
try {
  db.exec("ALTER TABLE rental_members ADD COLUMN seconds INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE rental_members SET seconds = non_vip_seconds + vip_seconds + vvip_seconds WHERE seconds = 0");
} catch (e) { /* already applied */ }

// Marks which member (if any) is currently logged into a given rental
// PC - NULL means guest-credited (the original, unchanged behavior).
// See server/routes/rental.js's POST /member-login|/member-logout and
// the extended GET /status.
try {
  db.exec("ALTER TABLE rental_sessions ADD COLUMN member_id INTEGER REFERENCES rental_members(id)");
} catch (e) { /* already applied */ }

// Vendo Devices: satellite_kiosks extended in place rather than a separate
// table - a Vendo IS a satellite kiosk (same device_key pairing, same
// transactions.kiosk_id revenue attribution), just discovered automatically
// instead of manually created by an admin typing a name. Every existing
// kiosk defaults to status='adopted' (it was already manually paired, so
// it's not a pending candidate) - this migration never changes behavior for
// installs that don't use auto-discovery.
try {
  db.exec("ALTER TABLE satellite_kiosks ADD COLUMN mac_address TEXT");
} catch (e) { /* already applied */ }
try {
  db.exec("ALTER TABLE satellite_kiosks ADD COLUMN firmware_version TEXT");
} catch (e) { /* already applied */ }
try {
  db.exec("ALTER TABLE satellite_kiosks ADD COLUMN hardware TEXT");
} catch (e) { /* already applied */ }
try {
  db.exec("ALTER TABLE satellite_kiosks ADD COLUMN status TEXT DEFAULT 'adopted'");
} catch (e) { /* already applied */ }
try {
  db.exec("ALTER TABLE satellite_kiosks ADD COLUMN discovered_via TEXT");
} catch (e) { /* already applied */ }

// Vendo adoption gate on the REAL, already-working vendos table (real ESP32
// firmware already self-registers here via POST /api/vendo/register on
// boot + every 60s heartbeat - the satellite_kiosks columns/functions added
// above were a parallel, disconnected system built without checking for
// this one first; reconciled here per explicit user direction rather than
// keeping two device registries). Existing rows default to 'adopted' so
// every already-registered real device already in the field stays exactly
// as trusted as it was before this migration - only a MAC this box has
// never seen before starts as an unapproved 'candidate'.
try {
  db.exec("ALTER TABLE vendos ADD COLUMN status TEXT DEFAULT 'adopted'");
} catch (e) { /* already applied */ }
// Vendo Protocol spec section 17: "Support Main / Sub-vendo / Standalone.
// Do not hard-code only one main Vendo." Purely organizational - doesn't
// change how any Vendo is discovered, adopted, or credited.
try {
  db.exec("ALTER TABLE vendos ADD COLUMN role TEXT DEFAULT 'standalone'");
} catch (e) { /* already applied */ }

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

try {
  db.exec('ALTER TABLE vendos ADD COLUMN device_secret TEXT');
} catch (e) {
  // already applied
}

// Premium rates: same coin-to-minutes tier, plus an optional bandwidth
// override applied to the session (high speed, less time) - separate
// try/catch per column, same reasoning as the vendos migration above.
try {
  db.exec('ALTER TABLE rates ADD COLUMN download_mbps REAL');
} catch (e) {
  // already applied
}
try {
  db.exec('ALTER TABLE rates ADD COLUMN upload_mbps REAL');
} catch (e) {
  // already applied
}

// Mirrors a linked Plan's data_limit_mb onto the rates row itself (see
// admin.js's syncPlanCoinVendoRate) so coinCreditService.js can pick it up
// at credit time without a join back to plans. NULL = no data cap (every
// existing rate/plan before this feature existed).
try {
  db.exec('ALTER TABLE rates ADD COLUMN data_limit_mb INTEGER');
} catch (e) {
  // already applied
}

// Explicit Premium flag for plans created before this column existed -
// separate from whether download_mbps happens to be set, since a plan's
// own speed cap and "is this the Premium tier" are two different
// questions (see admin.js's syncPlanCoinVendoRate).
try {
  db.exec('ALTER TABLE plans ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  // already applied
}

// Links a rates row back to the Plan it was generated from, so admin.js's
// plan save/delete handlers can find and sync "their" rates row instead of
// guessing by coin_value (which collides - a Normal and Premium plan can
// share the same price). NULL for rows created directly on the old Rates
// page (never plan-backed).
try {
  db.exec('ALTER TABLE rates ADD COLUMN plan_id INTEGER');
} catch (e) {
  // already applied
}

// Bug found in review: a Premium coin purchase's speed boost was being
// stored in the SAME sessions.download_mbps/upload_mbps columns a
// voucher's own permanent bandwidth override already uses - a later
// plain (non-Premium) top-up had no way to tell "this is a voucher's
// forever-override" apart from "this is a Premium purchase that should
// wear off," so it always just kept reapplying whatever was already
// there. A customer who bought Premium once, then kept adding regular
// time, got Premium speed forever for free. Tracked separately here so
// Premium can actually expire (timerService.js's cron reverts it once
// premium_expires_at passes) without touching voucher override behavior
// at all.
try {
  db.exec('ALTER TABLE sessions ADD COLUMN premium_download_mbps REAL');
} catch (e) {
  // already applied
}

// Data-plan tracking. data_limit_mb is copied onto the session at credit
// time (from the matched rate/plan) so a later change to the plan doesn't
// retroactively change an in-progress session's cap. data_used_bytes is a
// running total this app maintains itself (timerService.js's 30s tick) -
// router-side counters (MikroTik queue bytes, tc class bytes) aren't
// trustworthy as a standalone source of truth across a session's whole
// lifetime: MikroTik's per-client queue gets deleted and recreated on
// every reassert tick (resetting its counter), so only a DELTA sampled
// each tick is meaningful there, while standalone's tc class persists
// in place and reports a true running total - the two need different
// accumulation logic, but both feed into this one column.
try {
  db.exec('ALTER TABLE sessions ADD COLUMN data_limit_mb INTEGER');
} catch (e) {
  // already applied
}
try {
  db.exec('ALTER TABLE sessions ADD COLUMN data_used_bytes INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  // already applied
}
try {
  db.exec('ALTER TABLE sessions ADD COLUMN premium_upload_mbps REAL');
} catch (e) {
  // already applied
}
try {
  db.exec('ALTER TABLE sessions ADD COLUMN premium_expires_at TEXT');
} catch (e) {
  // already applied
}

// Separate try/catch per column, not one shared block - if this box was
// ever left in a partially-migrated state (has one of these two columns
// but not the other), a shared block would throw "duplicate column" on
// the first ALTER and never reach the second, permanently skipping it.
try {
  // 'HH:MM' (24h) or NULL for no scheduled restart - checked once a
  // minute by timerService.js's cron job.
  db.exec('ALTER TABLE vendos ADD COLUMN restart_schedule TEXT');
} catch (e) {
  // already applied
}
try {
  db.exec('ALTER TABLE vendos ADD COLUMN last_scheduled_restart TEXT');
} catch (e) {
  // already applied
}
try {
  // 'wifi'|'pc'|'both' - which business line this vendo's shared coin
  // acceptor may credit. Per-device, not global: an operator running
  // several coin boxes may want only some of them serving PC Rental.
  // Defaults to 'wifi' so every existing install is unaffected until an
  // operator deliberately opts a specific vendo in (see coin.js POST /).
  db.exec("ALTER TABLE vendos ADD COLUMN coinslot_purpose TEXT DEFAULT 'wifi'");
} catch (e) {
  // already applied
}
// (No new pause column needed here - the Windows client's Staff pause/
// resume reuses rental_sessions.is_paused, the same field admin.js's
// existing Lock/Unlock buttons already drive, rather than adding a
// second, conflicting pause flag. See POST /pause, /resume in
// server/routes/rental.js.)

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

// Premium rates: same coin_value AND same minutes/expiration as their
// regular counterpart (₱1 Premium costs ₱1 and lasts exactly as long as
// regular ₱1) - the only difference is 10 Mbps down / 10 Mbps up instead
// of the normal bandwidth cap. Since the coin denomination (and now the
// duration too) can no longer disambiguate "which ₱1 did they mean," the
// customer's choice of button on the portal (normal INSERT COIN vs the
// gold PREMIUM button) is what selects between them - see
// coinCreditService.js's isPremium filter and coin.js's pendingIsPremium.
// Guarded on its own (not folded into the rateCount===0 check above) so
// it seeds exactly once even on an existing box that already has the
// original 8 non-premium tiers.
const premiumRateCount = db.prepare(
  "SELECT COUNT(*) as count FROM rates WHERE download_mbps IS NOT NULL"
).get();

if (premiumRateCount.count === 0) {
  const insertPremiumRate = db.prepare(
    'INSERT INTO rates (coin_value, minutes, expiration_minutes, label, download_mbps, upload_mbps) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertPremiumRate.run(1,   1,    30,    '₱1 Premium = 1 min (10 Mbps)', 10, 10);
  insertPremiumRate.run(5,   15,   120,   '₱5 Premium = 15 mins (10 Mbps)', 10, 10);
  insertPremiumRate.run(10,  30,   240,   '₱10 Premium = 30 mins (10 Mbps)', 10, 10);
  insertPremiumRate.run(15,  45,   300,   '₱15 Premium = 45 mins (10 Mbps)', 10, 10);
  insertPremiumRate.run(20,  75,   480,   '₱20 Premium = 1hr 15min (10 Mbps)', 10, 10);
  insertPremiumRate.run(50,  1080, 4320,  '₱50 Premium = 18 hours (10 Mbps)', 10, 10);
  insertPremiumRate.run(100, 2520, 10080, '₱100 Premium = 1.75 days (10 Mbps)', 10, 10);
  insertPremiumRate.run(300, 10800,43200, '₱300 Premium = 7.5 days (10 Mbps)', 10, 10);
}

// Same reasoning as the rates seed above, for the newer Plans module - an
// admin opening Plans for the first time got an empty list and "Create
// Plan" as the only option, when the same ready-made tiers already used
// for coin rates make just as much sense as a starting point here. Tied
// to the Voucher channel specifically, since that's the one channel this
// table is actually wired to today (voucher_groups.plan_id) - Client
// Portal/Coin Vendo/Account channels stay off since nothing consumes
// plans through them yet (see this table's own definition comment above).
const planCount = db.prepare('SELECT COUNT(*) as count FROM plans').get();

if (planCount.count === 0) {
  const insertPlan = db.prepare(`
    INSERT INTO plans (
      name, description, type, status, price, duration_minutes, validity_minutes,
      channel_voucher, channel_portal, channel_coin_vendo, channel_account, display_order
    ) VALUES (?, ?, 'time', 'active', ?, ?, ?, 1, 0, 0, 0, ?)
  `);
  insertPlan.run('5 Minutes',  '₱1 voucher',   1,   5,    30,    0);
  insertPlan.run('1 Hour',     '₱5 voucher',   5,   60,   120,   1);
  insertPlan.run('2 Hours',    '₱10 voucher',  10,  120,  240,   2);
  insertPlan.run('3 Hours',    '₱15 voucher',  15,  180,  300,   3);
  insertPlan.run('5 Hours',    '₱20 voucher',  20,  300,  480,   4);
  insertPlan.run('3 Days',     '₱50 voucher',  50,  4320, 4320,  5);
  insertPlan.run('7 Days',     '₱100 voucher', 100, 10080,10080, 6);
  insertPlan.run('30 Days',    '₱300 voucher', 300, 43200,43200, 7);
}

const settingCount = db.prepare(
  'SELECT COUNT(*) as count FROM settings'
).get();

if (settingCount.count === 0) {
  const insertSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?)'
  );
  insertSetting.run('cafe_name', 'StarkFi');
  insertSetting.run('admin_password', hashPassword('admin123'));
  insertSetting.run('admin_username', 'admin');
  // Fresh installs start with the default password, force a change before
  // the admin panel is usable for real (Bug: default admin123 previously
  // shipped with no forced-change flow at all).
  insertSetting.run('must_change_password', '1');
  insertSetting.run('currency', '₱');
  insertSetting.run('banner_text', 'HIGH SPEED CONNECTION!');
  insertSetting.run('max_mbps', '5');
  insertSetting.run('spam_max_attempts', '5');
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
  insertSetting.run('max_pauses', '0');
  insertSetting.run('grace_period_minutes', '0');
  insertSetting.run('allow_premium_to_regular_convert', '0');

  // Coin slot settings
  insertSetting.run('coin_wait_ms', '1500');
  insertSetting.run('min_coins', '1');
  insertSetting.run('free_minutes_enabled', '1');
  insertSetting.run('free_minutes_amount', '5');
  insertSetting.run('vendo_ip', '');

  // Bandwidth control (disabled by default to test full speed)
  insertSetting.run('enable_bandwidth_cap', '0');
  insertSetting.run('bandwidth_cap_download_mbps', '5');
  insertSetting.run('bandwidth_cap_upload_mbps', '2');
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
  // Router mode: real ISP plan speed, never hardcoded, every port-role
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
// was replaced by this project's own nftables/tc code long ago, only the
// label lingered). Nothing in the codebase checks for the literal string
// 'nodogsplash' (networkService only ever checks `=== 'mikrotik'`), so this
// is a safe rename, not a behavior change.
db.prepare("UPDATE settings SET value = 'standalone' WHERE key = 'network_mode' AND value = 'nodogsplash'").run();

// One-time migration for existing installs: admin_password was stored in
// plaintext. Hash it in place. If it's still the untouched default
// ('admin123'), also flag must_change_password so the admin is forced to
// pick a real one, but if they'd already customized it, leave it as their
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
// plaintext, a MikroTik router's credentials have real value (resale risk
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
  // System Terminal (admin panel > System > Terminal) - a SEPARATE
  // password from admin_password, required every time before the
  // terminal opens, on top of already being logged into the admin panel.
  // Empty means not set up yet (the terminal page refuses to open until
  // the operator sets one) - this is real root-equivalent shell access to
  // the server itself, deliberately not defaulted to anything guessable
  // or left implicitly open just because someone has admin login.
  upsertIfMissing('terminal_password', '');
  // Cap on how many reports a single MAC can submit via the portal's
  // "Report a Problem" button per rolling 24h window (server/routes/
  // portal.js's POST /report) - keeps the report channel usable for real
  // issues without needing to manually block every prankster one at a
  // time. Operator-adjustable in Settings.
  upsertIfMissing('max_reports_per_mac', '5');
  // Local movie server (server/services/movieService.js) - where source
  // video files live on disk, and how long a premium per-movie rental
  // unlock lasts once paid for.
  upsertIfMissing('movies_source_dir', '');
  upsertIfMissing('movie_rental_hours', '48');
  // Movie Credit (banked over/underpaid movie-rental coins, database.js's
  // movie_credits table) forfeits when a customer's WiFi session ends by
  // default (server/services/sessionService.js's expireSession()) - '0'
  // here means "forfeit as normal", '1' means the owner has switched it to
  // persist across sessions instead (Movies page toggle).
  upsertIfMissing('movie_credit_persists', '0');
  // Captive-portal WiFi login webviews (Android's CaptivePortalLogin,
  // iOS's Captive Network Assistant) are stripped-down browser shells -
  // no real fullscreen, autoplay often blocked, video generally worse
  // than a real browser tab. '1' makes the Movies button try to force
  // Android devices into a real Chrome tab instead (public/portal/
  // assets/js/portal.js's openMoviesLink(), an intent:// URL - the one
  // reliable way to do this from inside that webview). iOS has no
  // equivalent: Apple's CNA deliberately blocks switching to Safari from
  // inside it, so iPhone customers are unaffected either way and just see
  // the normal in-portal behavior regardless of this setting.
  upsertIfMissing('movies_open_in_chrome', '0');
  // PC Rental Settings (public/admin/rental) - all read/written through
  // the existing generic GET/POST /api/admin/settings, same as every
  // other operator-facing setting in this file. Defaults match the
  // reference system's own defaults where one was shown, mapped onto
  // this app's actual built features - toggles for features not built
  // yet (Watch TV, Camera Recording, Spectate, PC Performance) are
  // stored but inert until those features exist.
  upsertIfMissing('rental_shutdown_timer_secs', '120');
  upsertIfMissing('rental_insert_timer_secs', '60');
  upsertIfMissing('rental_max_attempt', '5');
  upsertIfMissing('rental_max_attempt_lockout_secs', '50');
  upsertIfMissing('rental_create_account_min_credit', '20');
  upsertIfMissing('rental_insert_beep_alert_on_secs', '120');
  upsertIfMissing('rental_speed_timer_secs', '600');
  upsertIfMissing('rental_enable_member_login', '1');
  upsertIfMissing('rental_enable_create_account', '1');
  upsertIfMissing('rental_enable_voucher', '0');
  upsertIfMissing('rental_enable_watch_tv', '0');
  upsertIfMissing('rental_enable_auto_reset_guest_time_on_shutdown', '0');
  upsertIfMissing('rental_enable_auto_close_apps', '0');
  upsertIfMissing('rental_enable_camera_recording', '0');
  upsertIfMissing('rental_enable_transfer_time', '1');
  upsertIfMissing('rental_minimum_transfer_time_minutes', '5');
  upsertIfMissing('rental_enable_spectate', '0');
  upsertIfMissing('rental_enable_pc_performance', '0');
  upsertIfMissing('rental_antiabuse_enabled', '1');
  upsertIfMissing('rental_antiabuse_min_consume_minutes', '5');
  upsertIfMissing('rental_antiabuse_max_attempt', '3');
  upsertIfMissing('rental_antiabuse_lock_minutes', '5');
  upsertIfMissing('rental_antiabuse_penalty_minutes', '5');
  upsertIfMissing('rental_lock_announcement', '');
  upsertIfMissing('rental_close_announcement', '');
  upsertIfMissing('rental_schedule_enabled', '0');
  upsertIfMissing('rental_schedule_open_time', '06:00');
  upsertIfMissing('rental_schedule_before_close_time', '22:50');
  upsertIfMissing('rental_schedule_closed_time', '23:15');
  upsertIfMissing('rental_app_password', '');

  // rental_speed_timer_secs was stored from the start (default '600')
  // but never actually read anywhere - wiring it up now (GET /status's
  // member live-drain) means every existing install would suddenly
  // drain member time ~1.67x faster than real time the moment this
  // ships, an unannounced billing change nobody asked for. Guarded the
  // same way the ZenFi->StarkFi cafe_name migration guards its own
  // default-value change: only resets it to '1000' (true real-time) if
  // it's still exactly the untouched original default, never overwrites
  // a value an operator has already deliberately set.
  const speedTimerRow = db.prepare("SELECT value FROM settings WHERE key = 'rental_speed_timer_secs'").get();
  if (speedTimerRow && speedTimerRow.value === '600') {
    db.prepare("UPDATE settings SET value = '1000' WHERE key = 'rental_speed_timer_secs'").run();
  }

  // The physical coin acceptor is shared hardware, not duplicated per
  // feature - this decides what it's allowed to be used for. Defaults to
  // 'wifi' so every existing install keeps its current behavior until an
  // operator deliberately opts a coinslot into PC Rental. See
  // server/routes/coin.js's POST /pending enforcement.
  upsertIfMissing('coinslot_purpose', 'wifi');
  // Same "milliseconds per billed second" speed setting built for PC
  // Rental (rental_speed_timer_secs above), mirrored for the main WiFi
  // hotspot's own countdown. 1000 = real-time, lower = drains faster.
  // Applied only where real, customer-earned time gets granted
  // (sessionService.js's createSession/addTimeToSession, used by coin
  // credit, voucher redemption, and free-minute claims) - never to an
  // admin's manual "Add Time" on a session, which stays a literal grant.
  upsertIfMissing('wifi_speed_timer_ms', '1000');
  // Telemetry (server/services/telemetryService.js) - off by default,
  // mechanism-only until a real Privacy Policy is published and a UI
  // toggle is exposed (see that file's header for the full reasoning).
  upsertIfMissing('telemetry_enabled', '0');
  // Vendo fleet OTA auto-update - defaults on so existing installs keep
  // today's "push = every device updates on next check-in" behavior
  // unchanged. An install that already has a firmware version pushed
  // before this setting existed was already live under the old
  // always-auto behavior - mark it released so this migration doesn't
  // retroactively "unrelease" firmware devices may have already fetched.
  upsertIfMissing('vendo_firmware_auto_update', '1');
  // How many times a customer can pause/resume the SAME session before
  // the Pause button stops working for it. 0 = unlimited, matches this
  // file's existing "0 = unlimited" convention elsewhere.
  upsertIfMissing('max_pauses', '0');
  // Away/idle auto-pause - separate from the manual Pause button above.
  // Reads real per-client traffic (already-sampled for data-cap
  // tracking in timerService.js) to detect a customer who's stopped
  // actually using their connection, freezing their billing clock
  // without cutting their internet (unlike a manual pause) so it can
  // auto-resume the instant real traffic returns, no action needed from
  // them. Not available in OpenWRT mode, which has no per-client
  // traffic counter today. Off by default.
  upsertIfMissing('enable_auto_pause_idle', '0');
  upsertIfMissing('auto_pause_idle_minutes', '10');
  // Anti-tethering detection (server/services/ttlMonitorService.js) -
  // standalone mode only (needs raw packet capture on the LAN
  // interface), log/alert only for now, never blocks or throttles
  // anyone automatically. Off by default.
  upsertIfMissing('enable_tethering_detection', '0');
  // Whether a customer who used CONVERT to permanently switch to Premium
  // speed can later convert back down to a Regular rate (same "minutes
  // SET to the matched rate's own value" mechanic, in reverse). Off by
  // default - an operator selling Premium as a one-way upgrade shouldn't
  // have to opt out of a downgrade path they never intended to offer.
  upsertIfMissing('allow_premium_to_regular_convert', '0');
  // Outage/brownout time compensation (server/services/timerService.js's
  // reconcileOutageCompensation(), called at boot; watchdogService.js's
  // Controller-mode router-liveness check). Real incident: a brownout hit
  // both this server and (separately) the coin credit path - once fixed,
  // the natural next question is "did the outage itself eat customers'
  // paid time while nothing could serve them?" On by default since this
  // protects customer trust/reputation exactly like the incident that
  // prompted it - an operator who'd rather not extend sessions
  // automatically can turn it off in Settings.
  upsertIfMissing('enable_outage_compensation', '1');
  if (!db.prepare("SELECT key FROM settings WHERE key = 'vendo_firmware_released'").get()) {
    const hadVersion = !!db.prepare("SELECT value FROM settings WHERE key = 'vendo_firmware_version'").get()?.value;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('vendo_firmware_released', hadVersion ? '1' : '0');
  }

  // Rebrand: ZenFi -> StarkFi. Only touches an install that still has the
  // exact old default value untouched - an operator who already customized
  // their own site name/tagline keeps it exactly as they set it, this
  // never overwrites a real customization.
  const cafeNameRow = db.prepare("SELECT value FROM settings WHERE key = 'cafe_name'").get();
  if (cafeNameRow && cafeNameRow.value === 'ZenFi') {
    db.prepare("UPDATE settings SET value = 'StarkFi' WHERE key = 'cafe_name'").run();
  }
}

// One-time migration for existing installs: Premium rate tiers were seeded
// with upload_mbps = download_mbps (10/10) and an expiration_minutes equal
// to the matching regular tier's, so Premium never actually differed from
// Regular except in minutes granted. Bring already-seeded rows in line with
// the new defaults (10 down / 5 up, expiration halved). Guarded by a
// settings flag so this only ever runs once, since expiration_minutes/2
// isn't idempotent.
{
  const already = db.prepare("SELECT value FROM settings WHERE key = 'premium_rate_speed_migration_done'").get();
  if (!already) {
    db.prepare('UPDATE rates SET upload_mbps = 5 WHERE download_mbps IS NOT NULL AND upload_mbps = 10').run();
    db.prepare('UPDATE rates SET expiration_minutes = CAST(expiration_minutes / 2 AS INTEGER) WHERE download_mbps IS NOT NULL').run();

    // Some installs' Premium rows had minutes equal to the matching Regular
    // tier's (Premium should always grant less time than Regular for the
    // same coin value, since it trades duration for speed) - reset to the
    // intended defaults, keyed by coin_value, same values voucherService.js
    // seeds fresh.
    const premiumMinutesByCoin = { 1: 1, 5: 15, 10: 30, 15: 45, 20: 75, 50: 1080, 100: 2520, 300: 10800 };
    const updateMinutes = db.prepare('UPDATE rates SET minutes = ? WHERE download_mbps IS NOT NULL AND coin_value = ?');
    for (const [coinValue, minutes] of Object.entries(premiumMinutesByCoin)) {
      updateMinutes.run(minutes, parseInt(coinValue, 10));
    }

    db.prepare("UPDATE settings SET value = '2' WHERE key = 'bandwidth_cap_upload_mbps' AND value = '5'").run();

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('premium_rate_speed_migration_done', '1')").run();
  }
}

// One-time migration: makes the default coin-to-minutes tiers real Plans
// with the Coin Vendo channel checked, instead of bare rows only the Rates
// table ever knew about - so the Plans page always reflects what the coin
// slot can actually sell, per the operator's own request ("seed the
// default tiers as Plans"). Adopts each EXISTING legacy rates row (set its
// plan_id) rather than inserting a duplicate, since installs that had
// coin vendo working before Plans existed already have these 16 rows.
// Regular-tier plans (channel_voucher=1 already, from an earlier/separate
// default-plans seed) just get channel_coin_vendo turned on; Premium-tier
// plans don't exist yet anywhere, so those are inserted fresh.
{
  const already = db.prepare("SELECT value FROM settings WHERE key = 'coin_vendo_default_plans_seeded'").get();
  if (!already) {
    const regularTiers = [
      { price: 1, name: '5 Minutes', duration_minutes: 5, validity_minutes: 30 },
      { price: 5, name: '1 Hour', duration_minutes: 60, validity_minutes: 120 },
      { price: 10, name: '2 Hours', duration_minutes: 120, validity_minutes: 240 },
      { price: 15, name: '3 Hours', duration_minutes: 180, validity_minutes: 300 },
      { price: 20, name: '5 Hours', duration_minutes: 300, validity_minutes: 480 },
      { price: 50, name: '3 Days', duration_minutes: 4320, validity_minutes: 4320 },
      { price: 100, name: '7 Days', duration_minutes: 10080, validity_minutes: 10080 },
      { price: 300, name: '30 Days', duration_minutes: 43200, validity_minutes: 43200 },
    ];
    const premiumTiers = [
      { price: 1, name: '₱1 Premium', duration_minutes: 1, validity_minutes: 15 },
      { price: 5, name: '₱5 Premium', duration_minutes: 15, validity_minutes: 60 },
      { price: 10, name: '₱10 Premium', duration_minutes: 30, validity_minutes: 120 },
      { price: 15, name: '₱15 Premium', duration_minutes: 45, validity_minutes: 150 },
      { price: 20, name: '₱20 Premium', duration_minutes: 75, validity_minutes: 240 },
      { price: 50, name: '₱50 Premium', duration_minutes: 1080, validity_minutes: 2160 },
      { price: 100, name: '₱100 Premium', duration_minutes: 2520, validity_minutes: 5040 },
      { price: 300, name: '₱300 Premium', duration_minutes: 10800, validity_minutes: 21600 },
    ];

    // A plan matching a Regular tier's exact price+duration but flagged
    // is_premium (e.g. from testing the Premium checkbox in the admin UI)
    // is contradictory - Premium always has a shorter duration than
    // Regular for the same price - so it's mislabeled test data, not a
    // real Premium plan. Fix it in place rather than seeding a duplicate.
    const fixMislabeled = db.prepare("UPDATE plans SET is_premium = 0, download_mbps = NULL, upload_mbps = NULL WHERE price = ? AND duration_minutes = ? AND is_premium = 1");
    for (const tier of regularTiers) fixMislabeled.run(tier.price, tier.duration_minutes);

    const findRegularPlan = db.prepare("SELECT id FROM plans WHERE price = ? AND (is_premium = 0 OR is_premium IS NULL)");
    const findLegacyRate = db.prepare('SELECT id FROM rates WHERE coin_value = ? AND plan_id IS NULL AND download_mbps IS NULL');
    const findLegacyPremiumRate = db.prepare('SELECT id FROM rates WHERE coin_value = ? AND plan_id IS NULL AND download_mbps IS NOT NULL');
    const linkRate = db.prepare('UPDATE rates SET plan_id = ? WHERE id = ?');
    const enableCoinVendo = db.prepare('UPDATE plans SET channel_coin_vendo = 1 WHERE id = ?');
    const insertPlan = db.prepare(`
      INSERT INTO plans (name, type, status, price, duration_minutes, validity_minutes, download_mbps, upload_mbps, is_premium, channel_voucher, channel_coin_vendo)
      VALUES (?, 'time', 'active', ?, ?, ?, ?, ?, ?, 1, 1)
    `);

    for (const tier of regularTiers) {
      const existingPlan = findRegularPlan.get(tier.price);
      let planId;
      if (existingPlan) {
        planId = existingPlan.id;
        enableCoinVendo.run(planId);
      } else {
        planId = insertPlan.run(tier.name, tier.price, tier.duration_minutes, tier.validity_minutes, null, null, 0).lastInsertRowid;
      }
      const legacyRate = findLegacyRate.get(tier.price);
      if (legacyRate) linkRate.run(planId, legacyRate.id);
    }

    for (const tier of premiumTiers) {
      const planId = insertPlan.run(tier.name, tier.price, tier.duration_minutes, tier.validity_minutes, 10, 5, 1).lastInsertRowid;
      const legacyRate = findLegacyPremiumRate.get(tier.price);
      if (legacyRate) linkRate.run(planId, legacyRate.id);
    }

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('coin_vendo_default_plans_seeded', '1')").run();
    console.log('💡 Default coin-to-minutes tiers seeded/linked as Plans (Coin Vendo channel)');
  }
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

// Real request: an operator wants a cap on how many times a customer can
// pause/resume the same session, and the portal to show how many pauses
// they have left, not just an unlimited pause button. Counted per session
// (resets to 0 on a brand new session, same as every other per-session
// counter here), incremented in sessionService.js's pauseSession(). 0 in
// the max_pauses setting means unlimited, matching this file's existing
// "0 = unlimited" convention (see coinslot_gpio_max_empty_opens).
try {
  db.exec('ALTER TABLE sessions ADD COLUMN pause_count INTEGER DEFAULT 0');
} catch (e) {
  // already applied
}

// 'manual' (customer tapped Pause) or 'idle' (auto-paused by
// timerService.js's away detection) - lets resumeSession() know whether
// to touch network access at all. An idle pause never called
// blockClient() in the first place (the whole point is staying
// connected so real traffic can trigger auto-resume), so resuming it
// must not call allowClient() either - there's nothing to restore.
try {
  db.exec("ALTER TABLE sessions ADD COLUMN pause_reason TEXT DEFAULT NULL");
} catch (e) {
  // already applied
}

// Distinguishes "this session's current permanent speed came from a
// CONVERT action" from "this session has a voucher's own permanent
// bandwidth override" - both use the same download_mbps/upload_mbps
// columns, but only the former should ever be eligible for the
// Convert-back-to-Regular flow (coinCreditService.js's
// convertToRegularValue). Without a dedicated flag, that flow would have
// no reliable way to tell the two apart and could offer "convert back to
// Regular" on a session whose elevated speed actually came from a
// voucher, not a Premium purchase - a downgrade that was never paid for.
try {
  db.exec('ALTER TABLE sessions ADD COLUMN converted_to_premium INTEGER DEFAULT 0');
} catch (e) {
  // already applied
}

// When a Boost purchase's temporary window most recently (re)started, so
// the portal's gold countdown bar can show real elapsed-vs-total progress
// (percentage = time left / total window) instead of just a bare minutes
// countdown. Reset to "now" every time addTimeToSession() applies a NEW
// bandwidthOverride (a fresh Boost purchase, whether the first one or a
// top-up buying more Boost time), same moment premium_expires_at itself
// gets recalculated, so the bar always reflects the CURRENT purchase's
// own window, not a stale one from an earlier Boost that's since expired.
try {
  db.exec('ALTER TABLE sessions ADD COLUMN premium_started_at TEXT');
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

// Access Points: adapter adoption columns (AP_INTEGRATION_ARCHITECTURE.md).
// adapter_type identifies which server/services/apAdapters/*.js module owns
// this device once adopted; credentials_encrypted is the login password
// stored via server/utils/secretCrypto.js (never plaintext, never returned
// to the frontend). management_state gains 'monitored' alongside the
// existing unmanaged/pending values now that a real adapter can read live
// data - 'managed' (write access) is intentionally not introduced yet,
// since no adapter has validated write endpoints against real hardware.
for (const stmt of [
  "ALTER TABLE access_points ADD COLUMN adapter_type TEXT",
  "ALTER TABLE access_points ADD COLUMN credentials_encrypted TEXT",
  "ALTER TABLE access_points ADD COLUMN adapter_last_error TEXT",
  "ALTER TABLE access_points ADD COLUMN adapter_last_polled_at DATETIME",
]) {
  try { db.exec(stmt); } catch (e) { /* already applied */ }
}

// network_config_versions originally only ever recorded Standalone mode
// applies (see the table's own comment above) - 'scope' distinguishes
// those from the MikroTik role-change transactions configSafety.js's
// applyMikrotikRoleChangeTransaction() also logs here now, since both
// share the same audit trail rather than needing a second table.
try {
  db.exec("ALTER TABLE network_config_versions ADD COLUMN scope TEXT NOT NULL DEFAULT 'standalone'");
} catch (e) { /* already applied */ }

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
// Foundation layer for StarkFi_Navigation_and_System_Specification.md's nav
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
  'watchdog_events', 'alert_events', 'satellite_kiosks', 'tc_class_allocations',
  'router_ports', 'static_leases', 'port_forwards', 'client_labels',
  'network_config_versions', 'bandwidth_profiles', 'cash_reconciliations',
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

// Seed exactly one real system template ("StarkFi Standard") - not the
// full 8-template gallery a complete Voucher Designer would eventually
// ship, since designing 7 more fully-styled layouts by hand here would
// be inventing content, not building the feature. An operator can
// duplicate/edit this one and save their own from it.
try {
  const hasSystemTemplate = db.prepare("SELECT id FROM voucher_templates WHERE is_system = 1 LIMIT 1").get();
  if (!hasSystemTemplate) {
    const standardElements = [
      { id: 'el1', type: 'text', field: null, x: 0.15, y: 0.12, w: 3.2, h: 0.35, fontSize: 20, fontWeight: '700', color: '#0c8f6d', align: 'left', content: 'StarkFi WiFi' },
      { id: 'el2', type: 'voucher_code', field: 'voucher.code', x: 0.15, y: 0.55, w: 2.0, h: 0.4, fontSize: 22, fontWeight: '900', color: '#111827', align: 'left', content: 'SAMPLE-CODE' },
      { id: 'el3', type: 'price', field: 'voucher.price', x: 0.15, y: 1.0, w: 1.0, h: 0.3, fontSize: 14, fontWeight: '600', color: '#374151', align: 'left', content: '₱10' },
      { id: 'el4', type: 'duration', field: 'voucher.duration', x: 1.2, y: 1.0, w: 1.2, h: 0.3, fontSize: 14, fontWeight: '600', color: '#374151', align: 'left', content: '30 Minutes' },
      { id: 'el5', type: 'qr_code', field: 'voucher.qr_url', x: 2.35, y: 0.12, w: 1.0, h: 1.0, fontSize: 0, fontWeight: '400', color: '#000000', align: 'center', content: '' },
      { id: 'el6', type: 'text', field: null, x: 0.15, y: 1.4, w: 3.2, h: 0.3, fontSize: 10, fontWeight: '400', color: '#6b7280', align: 'left', content: 'Scan the QR code or enter the code above to connect.' },
    ];
    db.prepare(`
      INSERT INTO voucher_templates (name, description, width_in, height_in, background_color, elements_json, is_system)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run('StarkFi Standard', 'Clean general-purpose voucher with a QR code.', 3.5, 2, '#ffffff', JSON.stringify(standardElements));
    console.log('🎫 Seeded default "StarkFi Standard" voucher template');
  }
} catch (e) {
  console.error('⚠️ Voucher template seed failed:', e.message);
}

// Performance: none of the tables above had any index beyond their
// implicit primary key, yet several of the busiest queries in the app
// filter or sort by columns other than id - getActiveSessions() (runs on
// every session/dashboard load and every timer tick) by mac_address and
// by hard_expires_at+is_paused, voucher redemption by voucher_code,
// Dashboard/Analytics/Vouchers revenue queries by transactions'
// created_at/type/mac_address, and the History/Watchdog/Alerts pages by
// their own date or checked_at columns. On a small dev database SQLite's
// planner just table-scans those and nobody notices; on a real box after
// months of sessions/transactions accumulating, the exact same queries
// degenerate into full scans that get slower every day. CREATE INDEX IF
// NOT EXISTS is purely additive (no schema/data risk, safe to run on
// every boot) - this only teaches SQLite to use SEARCH instead of SCAN.
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_mac_address ON sessions(mac_address);
    CREATE INDEX IF NOT EXISTS idx_sessions_voucher_code ON sessions(voucher_code);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry_paused ON sessions(hard_expires_at, is_paused);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_transactions_mac_address ON transactions(mac_address);
    CREATE INDEX IF NOT EXISTS idx_session_history_ended_at ON session_history(ended_at);
    CREATE INDEX IF NOT EXISTS idx_watchdog_events_checked_at ON watchdog_events(checked_at);
    CREATE INDEX IF NOT EXISTS idx_alert_events_created_at ON alert_events(created_at);
  `);
  // Most of the revenue/reporting queries above filter on "date(created_at)
  // >= / = date(...)" rather than the raw timestamp column (grouping by
  // calendar day, not by exact instant), so a plain index on created_at
  // wouldn't actually get used - SQLite can't apply a normal index to a
  // column wrapped in a function. An expression index on date(created_at)
  // matches the query shape those routes really use.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_date_created ON transactions(date(created_at))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_history_date_ended ON session_history(date(ended_at))`);
} catch (e) {
  console.error('⚠️ Index creation failed:', e.message);
}

try {
  // Existing installs synced their feed before this column existed - those
  // rows just stay NULL (no way to backfill without re-syncing) and simply
  // won't show up in the client's "New Releases" row until the next sync.
  db.exec('ALTER TABLE tmdb_movie_feed ADD COLUMN release_date TEXT');
} catch (e) {
  // already applied
}

try {
  db.exec('ALTER TABLE online_movie_pricing ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  // already applied
}

try {
  db.exec('ALTER TABLE online_movie_pricing ADD COLUMN rental_hours INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  // already applied
}

// Reused by TV Shows (online_movie_searches -> Top Searches, movie_requests
// -> the Requests panel) instead of duplicating both tables/admin panels
// just for a second content type - 'movie' is the default so every
// existing row (all pre-dating TV Shows) keeps meaning exactly what it
// always meant.
try {
  db.exec("ALTER TABLE online_movie_searches ADD COLUMN media_type TEXT NOT NULL DEFAULT 'movie'");
} catch (e) {
  // already applied
}

try {
  db.exec("ALTER TABLE movie_requests ADD COLUMN media_type TEXT NOT NULL DEFAULT 'movie'");
} catch (e) {
  // already applied
}

// One-time migration for existing installs: movie_embed_url_template used
// to be the only streaming source (a single settings row), before Movies >
// Online supported multiple named servers. Carries that value forward as
// "Server 1" instead of silently dropping it, then removes the old
// setting so it can't drift out of sync with the new table.
{
  const old = db.prepare("SELECT value FROM settings WHERE key = 'movie_embed_url_template'").get();
  if (old && old.value && old.value.includes('{tmdb_id}')) {
    const alreadyMigrated = db.prepare('SELECT 1 FROM movie_streaming_sources WHERE url_template = ?').get(old.value);
    if (!alreadyMigrated) {
      db.prepare('INSERT INTO movie_streaming_sources (name, url_template, is_default, sort_order) VALUES (?, ?, 1, 0)')
        .run('Server 1', old.value);
    }
  }
  db.prepare("DELETE FROM settings WHERE key = 'movie_embed_url_template'").run();
}

// One-time migration: merges movie_streaming_sources + tv_streaming_sources
// into the combined streaming_sources table (owner request: one list per
// real provider, not two separately-managed sections for the same
// "Server 1/2/3" servers). Matches rows by name - "Server 1" movie +
// "Server 1" tv become one combined row with both templates; a name that
// only existed on one side becomes a row with just that template set.
// Guarded on streaming_sources being empty so this can only ever run
// once - an admin adding a brand-new source afterward never re-triggers
// a merge that could duplicate rows.
{
  const alreadyMigrated = db.prepare('SELECT COUNT(*) as c FROM streaming_sources').get().c > 0;
  if (!alreadyMigrated) {
    const movieSources = db.prepare('SELECT * FROM movie_streaming_sources').all();
    const tvSources = db.prepare('SELECT * FROM tv_streaming_sources').all();
    if (movieSources.length > 0 || tvSources.length > 0) {
      const byName = new Map();
      for (const m of movieSources) {
        byName.set(m.name, { name: m.name, movie_url_template: m.url_template, tv_url_template: null, is_default: m.is_default, sort_order: m.sort_order });
      }
      for (const t of tvSources) {
        if (byName.has(t.name)) {
          const existing = byName.get(t.name);
          existing.tv_url_template = t.url_template;
          existing.is_default = existing.is_default || t.is_default;
        } else {
          byName.set(t.name, { name: t.name, movie_url_template: null, tv_url_template: t.url_template, is_default: t.is_default, sort_order: t.sort_order });
        }
      }
      const insertMerged = db.prepare(`
        INSERT INTO streaming_sources (name, movie_url_template, tv_url_template, is_default, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of byName.values()) {
        insertMerged.run(row.name, row.movie_url_template, row.tv_url_template, row.is_default ? 1 : 0, row.sort_order);
      }
      console.log(`✅ Migrated ${byName.size} streaming source(s) into the combined table`);
    }
  }
}

console.log('✅ Database initialized successfully');

module.exports = db;