const db = require('../config/database');
const {
  generateVoucherCode,
  getExpirationMinutesForCoin
} = require('./voucherService');
const {
  allowClient,
  blockClient,
  setClientBandwidth,
  removeClientBandwidth,
  checkRoam
} = require('./networkService');
const sseService = require('./sseService');

// Cache bandwidth settings to avoid repeated DB queries (Bug #35)
let settingCache = {
  enable_bandwidth_cap: null,
  bandwidth_cap_download_mbps: null,
  bandwidth_cap_upload_mbps: null,
  enable_bandwidth_burst: null,
  bandwidth_burst_mbps: null,
  bandwidth_burst_seconds: null,
  last_check: 0
};
const SETTING_CACHE_TTL = 60000; // 1 minute

function isBandwidthCapEnabled() {
  const now = Date.now();
  if (settingCache.enable_bandwidth_cap === null || now - settingCache.last_check > SETTING_CACHE_TTL) {
    const value = db.prepare("SELECT value FROM settings WHERE key = 'enable_bandwidth_cap'").get()?.value || '0';
    settingCache.enable_bandwidth_cap = value === '1';
    settingCache.last_check = now;
  }
  return settingCache.enable_bandwidth_cap;
}

function getMaxMbps() {
  const now = Date.now();
  if (settingCache.bandwidth_cap_download_mbps === null || now - settingCache.last_check > SETTING_CACHE_TTL) {
    const value = db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_cap_download_mbps'").get()?.value || '5';
    settingCache.bandwidth_cap_download_mbps = parseInt(value, 10) || 5;
    settingCache.last_check = now;
  }
  return settingCache.bandwidth_cap_download_mbps;
}

// Bug (ROUTER_MODE_PLAN.md §12): bandwidth_cap_upload_mbps existed as a
// setting and was editable from the admin UI, but nothing ever read it -
// every setClientBandwidth() call only ever passed the download number,
// applied to both directions. Customers' actual upload speed was silently
// whatever the download cap said, not what the upload field promised.
function getMaxUploadMbps() {
  const now = Date.now();
  if (settingCache.bandwidth_cap_upload_mbps === null || now - settingCache.last_check > SETTING_CACHE_TTL) {
    const value = db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_cap_upload_mbps'").get()?.value || '5';
    settingCache.bandwidth_cap_upload_mbps = parseInt(value, 10) || 5;
    settingCache.last_check = now;
  }
  return settingCache.bandwidth_cap_upload_mbps;
}

// Real, router-enforced burst (RouterOS Simple Queue burst-limit) - not
// something that hides itself from a speed test, a genuine short-lived
// higher rate that settles back to the paid-for cap under sustained use.
// Router-mode only (see networkService.js's setClientBandwidth comment);
// returns null when disabled so callers pass burst=null and get plain
// max-limit-only shaping, same as before this existed.
function getBurstConfig() {
  const now = Date.now();
  if (settingCache.enable_bandwidth_burst === null || now - settingCache.last_check > SETTING_CACHE_TTL) {
    const enabled = db.prepare("SELECT value FROM settings WHERE key = 'enable_bandwidth_burst'").get()?.value === '1';
    const mbps = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_burst_mbps'").get()?.value || '20', 10) || 20;
    const seconds = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_burst_seconds'").get()?.value || '8', 10) || 8;
    settingCache.enable_bandwidth_burst = enabled;
    settingCache.bandwidth_burst_mbps = mbps;
    settingCache.bandwidth_burst_seconds = seconds;
    settingCache.last_check = now;
  }
  return settingCache.enable_bandwidth_burst
    ? { mbps: settingCache.bandwidth_burst_mbps, seconds: settingCache.bandwidth_burst_seconds }
    : null;
}

// Bug: mac_address is looked up with a case-sensitive exact match, but
// callers were inconsistent about casing, coin.js lowercased before
// storing, while promo.js/session.js and the portal's own MAC
// auto-detection (uppercase) did not. A session created via coin insert
// (stored lowercase) would silently show as "no active session" the moment
// the portal polled its status using the uppercase MAC it had detected,
// paid, internet unlocked, but the customer's own UI never showing it.
// Normalizing once here, centrally, means every caller gets consistent
// behavior regardless of what case they pass in.
function normalizeMac(mac) {
  return String(mac || '').trim().toLowerCase();
}

// Bug found live: two callers (coin credit and the portal's free-minutes
// claim) each did their own "getSessionByMac, then create if nothing
// found", a plain check-then-act with an async gap in between
// (createSession() awaits allowClient() before returning). A coin landing
// at nearly the same moment as a free-minutes claim could have both
// requests see "no session yet" and both call createSession(), producing
// two separate session rows for the same physical device: the admin
// panel counted it as two connected devices, and whichever row the
// portal's own getSessionByMac() happened to resolve to (no ORDER BY,
// whichever SQLite returns first) silently orphaned the other, making
// coins that landed in the losing row look like they were never
// credited. Node is single-threaded and better-sqlite3 is synchronous,
// so serializing same-mac callers through this in-memory queue closes
// the gap entirely, no DB schema change needed.
const macLocks = new Map();
function withMacLock(mac, fn) {
  const key = normalizeMac(mac);
  const previous = macLocks.get(key) || Promise.resolve();
  const next = previous.then(fn, fn);
  macLocks.set(key, next.catch(() => {}));
  return next;
}

// Shared "top up if a session exists, otherwise create one" used by every
// caller that doesn't need free-claim's "refuse if one already exists"
// business rule (coin credit, voucher redemption), see creditCoinValue()
// in coinCreditService.js. Free-claim (server/routes/session.js) keeps its
// own check-then-refuse-or-create, just wrapped in withMacLock() too, so
// both paths serialize against each other without free-claim silently
// topping up a session it's supposed to reject.
async function creditOrCreateSession(mac, ip, minutes, expirationMinutes, bandwidthOverride = null, dataLimitMb = null) {
  return withMacLock(mac, async () => {
    const existing = getSessionByMac(mac);
    if (existing) {
      const updated = await addTimeToSession(mac, minutes, expirationMinutes, bandwidthOverride, dataLimitMb);
      return { session: updated, created: false };
    }
    const created = await createSession(mac, ip, minutes, expirationMinutes, bandwidthOverride, dataLimitMb);
    return { session: created, created: true };
  });
}

// Called by timerService.js's cron once a session's premium_expires_at
// passes, to actually revert network-level bandwidth back to whatever
// applies next (a voucher's permanent override, the global cap, or
// unrestricted) - effectiveBandwidth() alone only decides what SHOULD be
// applied, this is what makes it real on the router/nftables side.
async function reapplyBandwidth(mac) {
  const session = getSessionByMac(mac);
  if (!session) return;
  const bw = effectiveBandwidth(session);
  try {
    if (bw) {
      await setClientBandwidth(mac, bw.download, bw.upload, getBurstConfig(), !!session.data_limit_mb);
    } else if (isBandwidthCapEnabled()) {
      await setClientBandwidth(mac, getMaxMbps(), getMaxUploadMbps(), getBurstConfig(), !!session.data_limit_mb);
    } else {
      await removeClientBandwidth(mac);
    }
  } catch (e) {
    console.error(`[Network] Failed to reapply bandwidth for ${mac}:`, e.message);
  }
}

function getSessionByMac(mac) {
  return db.prepare(`
    SELECT * FROM sessions
    WHERE mac_address = ?
  `).get(normalizeMac(mac));
}

function getSessionByVoucher(voucherCode) {
  return db.prepare(
    'SELECT * FROM sessions WHERE voucher_code = ?'
  ).get(voucherCode);
}

// Premium (temporary, coin-purchased "high speed, less time") and a
// voucher's own bandwidth override are deliberately kept in SEPARATE
// columns, not conflated - a voucher's download_mbps/upload_mbps is a
// permanent property of that redemption and should keep reasserting
// itself forever (the original intent of the "reapply on every top-up"
// logic below), while Premium is temporary and must actually expire.
// Storing both in the same columns (an earlier version of this code did)
// made a Premium purchase's speed stick around forever on every later
// plain top-up, since there was no way to tell "this session has a
// permanent override" apart from "this session had a temporary one that
// should have worn off by now."
//
// Picks whichever of the two is currently in effect: an unexpired
// Premium purchase wins over a voucher's permanent override (Premium was
// paid for specifically), which wins over the global bandwidth cap.
function effectiveBandwidth(session) {
  if (session.premium_expires_at && new Date(session.premium_expires_at).getTime() > Date.now()) {
    return { download: session.premium_download_mbps, upload: session.premium_upload_mbps || session.premium_download_mbps };
  }
  if (session.download_mbps) {
    return { download: session.download_mbps, upload: session.upload_mbps || session.download_mbps };
  }
  return null;
}

// `bandwidthOverride` - optional { download_mbps, upload_mbps, minutes }
// from a Premium coin rate (coinCreditService.js) - `minutes` is
// specifically the premium-tier duration, not the total credited this
// call, so premium_expires_at reflects only what was actually paid for.
async function createSession(mac, ip, minutes, expirationMinutes, bandwidthOverride = null, dataLimitMb = null) {
  mac = normalizeMac(mac);
  const voucherCode = generateVoucherCode();
  const now = Date.now();

  // Use Math.floor for consistency (Bug #49, floating point precision)
  const mins = Math.floor(parseFloat(minutes) || 0);
  const expMins = Math.floor(parseFloat(expirationMinutes) || mins);

  const expiresAt = new Date(
    now + mins * 60 * 1000
  ).toISOString();

  const hardExpiresAt = new Date(
    now + expMins * 60 * 1000
  ).toISOString();

  console.log(`Creating session: ${mins} mins, expires: ${expiresAt}, hard: ${hardExpiresAt}`);

  const premiumDownload = bandwidthOverride ? bandwidthOverride.download_mbps : null;
  const premiumUpload = bandwidthOverride ? (bandwidthOverride.upload_mbps || bandwidthOverride.download_mbps) : null;
  const premiumExpiresAt = bandwidthOverride
    ? new Date(now + Math.floor(bandwidthOverride.minutes || 0) * 60 * 1000).toISOString()
    : null;

  db.prepare(`
    INSERT INTO sessions
    (voucher_code, mac_address, ip_address, minutes_remaining,
     expires_at, hard_expires_at, premium_download_mbps, premium_upload_mbps, premium_expires_at, data_limit_mb)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(voucherCode, mac, ip, mins, expiresAt, hardExpiresAt, premiumDownload, premiumUpload, premiumExpiresAt, dataLimitMb || null);

  const session = db.prepare('SELECT * FROM sessions WHERE voucher_code = ?').get(voucherCode);
  const bw = effectiveBandwidth(session);

  // Allow internet access
  try {
    await allowClient(mac);
    console.log(`[Network] Internet unlocked for ${mac}`);
    if (bw) {
      await setClientBandwidth(mac, bw.download, bw.upload, getBurstConfig(), !!dataLimitMb);
      console.log(`[Network] ${bandwidthOverride ? 'Premium' : 'Voucher'} bandwidth applied to ${mac}: ${bw.download}Mbps down / ${bw.upload}Mbps up`);
    } else if (isBandwidthCapEnabled()) {
      await setClientBandwidth(mac, getMaxMbps(), getMaxUploadMbps(), getBurstConfig(), !!dataLimitMb);
      console.log(`[Network] Bandwidth cap applied to ${mac}: ${getMaxMbps()}Mbps down / ${getMaxUploadMbps()}Mbps up`);
    } else {
      console.log(`[Network] Bandwidth cap disabled - allowing full speed for ${mac}`);
    }
  } catch(e) {
    console.error(`[Network] Failed to unlock ${mac}:`, e.message);
  }

  // Bug: the portal only found out a coin landed by polling, this pushes
  // an instant wake-up to any open portal tab for this MAC right now,
  // instead of it waiting on its next poll tick.
  sseService.notify(mac);

  return session;
}

// `bandwidthOverride` - optional { download_mbps, upload_mbps, minutes }
// from a Premium coin rate. A top-up WITHOUT one leaves the session's
// existing premium_expires_at untouched (it keeps counting down/expiring
// on its own schedule) rather than reapplying it - the actual "still
// active?" decision happens once, in effectiveBandwidth(), from whatever
// premium_expires_at already says.
async function addTimeToSession(mac, minutes, expirationMinutes, bandwidthOverride = null, dataLimitMb = null) {
  mac = normalizeMac(mac);
  const session = getSessionByMac(mac);
  if (!session) return null;

  // Only adopts a new cap if the session didn't already have one - a plain
  // top-up on an already-capped session shouldn't reset how much data
  // they've already used against a DIFFERENT (possibly larger) limit, and
  // a top-up with no cap of its own shouldn't retroactively impose one.
  const newDataLimitMb = session.data_limit_mb || dataLimitMb || null;

  const now = Date.now();
  const newMinutes = session.minutes_remaining + minutes;

  const newExpiresAt = new Date(
    now + newMinutes * 60 * 1000
  ).toISOString();
  const newHardExpiresAt = new Date(
    now + expirationMinutes * 60 * 1000
  ).toISOString();

  let premiumDownload = session.premium_download_mbps;
  let premiumUpload = session.premium_upload_mbps;
  let premiumExpiresAt = session.premium_expires_at;

  if (bandwidthOverride) {
    // Stacks with time still remaining on an existing Premium purchase
    // instead of overwriting it (buying two Premium coins back to back
    // should add up, not just reset the clock), and always adopts the
    // new override's own Mbps values (a higher-tier Premium purchase
    // should take effect immediately, not wait for the old one to lapse).
    const currentExpiryMs = premiumExpiresAt ? new Date(premiumExpiresAt).getTime() : 0;
    const extendFromMs = Math.max(now, currentExpiryMs);
    premiumDownload = bandwidthOverride.download_mbps;
    premiumUpload = bandwidthOverride.upload_mbps || bandwidthOverride.download_mbps;
    premiumExpiresAt = new Date(extendFromMs + Math.floor(bandwidthOverride.minutes || 0) * 60 * 1000).toISOString();
  }

  // push_2min_sent reset to 0: a customer topping up before running out
  // should get warned again the NEXT time they cross under 2 minutes, not
  // have that suppressed forever because it already fired once earlier.
  db.prepare(`
    UPDATE sessions
    SET minutes_remaining = ?,
        expires_at = ?,
        hard_expires_at = ?,
        push_2min_sent = 0,
        premium_download_mbps = ?,
        premium_upload_mbps = ?,
        premium_expires_at = ?,
        data_limit_mb = ?
    WHERE mac_address = ?
  `).run(newMinutes, newExpiresAt, newHardExpiresAt, premiumDownload, premiumUpload, premiumExpiresAt, newDataLimitMb, mac);

  const updated = db.prepare('SELECT * FROM sessions WHERE mac_address = ?').get(mac);
  const bw = effectiveBandwidth(updated);

  // Ensure internet access is still allowed (in case of reboot)
  try {
    await allowClient(mac);
    // Bug: this always reapplied the GLOBAL cap, silently overwriting a
    // voucher's own bandwidth override (Create Voucher's optional Mbps
    // fields, set on the session at redemption time) the moment a
    // customer added more time to an existing session.
    if (bw) {
      await setClientBandwidth(mac, bw.download, bw.upload, getBurstConfig(), !!newDataLimitMb);
    } else if (isBandwidthCapEnabled()) {
      await setClientBandwidth(mac, getMaxMbps(), getMaxUploadMbps(), getBurstConfig(), !!newDataLimitMb);
    }
  } catch(e) {}

  sseService.notify(mac);

  return updated;
}

async function pauseSession(voucherCode) {
  const session = getSessionByVoucher(voucherCode);
  if (!session || session.is_paused === 1) return null;

  const now = new Date().toISOString();
  const remaining = Math.floor(
    (new Date(session.expires_at) - new Date()) / 60000
  );

  db.prepare(`
    UPDATE sessions
    SET is_paused = 1,
        paused_at = ?,
        minutes_remaining = ?
    WHERE voucher_code = ?
  `).run(now, Math.max(0, remaining), voucherCode);

  // Block internet access when pausing
  try {
    await blockClient(session.mac_address);
    console.log(`[Network] Internet blocked for ${session.mac_address} (paused)`);
  } catch(e) {
    console.error(`[Network] Failed to block ${session.mac_address} on pause:`, e.message);
  }

  sseService.notify(session.mac_address);

  return db.prepare(
    'SELECT * FROM sessions WHERE voucher_code = ?'
  ).get(voucherCode);
}

async function resumeSession(voucherCode) {
  const session = getSessionByVoucher(voucherCode);
  if (!session || session.is_paused === 0) return null;

  const now = new Date();
  const hardExpires = new Date(session.hard_expires_at);
  if (now >= hardExpires) {
    await expireSession(voucherCode);
    return null;
  }

  const newExpiresAt = new Date(
    now.getTime() + session.minutes_remaining * 60 * 1000
  ).toISOString();

  db.prepare(`
    UPDATE sessions
    SET is_paused = 0,
        paused_at = NULL,
        expires_at = ?
    WHERE voucher_code = ?
  `).run(newExpiresAt, voucherCode);

  // Re-enable internet access when resuming
  try {
    await allowClient(session.mac_address);
    console.log(`[Network] Internet unlocked for ${session.mac_address} (resumed)`);
    // Same voucher-override bug as addTimeToSession() above.
    if (session.download_mbps) {
      const upMbps = session.upload_mbps || session.download_mbps;
      await setClientBandwidth(session.mac_address, session.download_mbps, upMbps, getBurstConfig(), !!session.data_limit_mb);
      console.log(`[Network] Voucher bandwidth reapplied to ${session.mac_address}: ${session.download_mbps}Mbps down / ${upMbps}Mbps up`);
    } else if (isBandwidthCapEnabled()) {
      await setClientBandwidth(session.mac_address, getMaxMbps(), getMaxUploadMbps(), getBurstConfig(), !!session.data_limit_mb);
      console.log(`[Network] Bandwidth cap reapplied to ${session.mac_address}: ${getMaxMbps()}Mbps down / ${getMaxUploadMbps()}Mbps up`);
    } else {
      console.log(`[Network] Bandwidth cap disabled - allowing full speed for ${session.mac_address}`);
    }
  } catch(e) {
    console.error(`[Network] Failed to unlock ${session.mac_address} on resume:`, e.message);
  }

  sseService.notify(session.mac_address);

  return db.prepare(
    'SELECT * FROM sessions WHERE voucher_code = ?'
  ).get(voucherCode);
}

async function expireSession(voucherCode) {
  const session = getSessionByVoucher(voucherCode);

  db.prepare(
    'DELETE FROM sessions WHERE voucher_code = ?'
  ).run(voucherCode);

  if (session && session.mac_address) {
    sseService.notify(session.mac_address);
  }

  // Durable record of actual usage duration, written here since this is
  // the one place every session-ending path (timer expiry, admin cut,
  // customer cancel) already funnels through. session.created_at is the
  // real moment the session started (first coin/voucher/promo, not the
  // moment of a later top-up), so this captures true elapsed time, not
  // "sum of minutes granted".
  if (session && session.created_at) {
    // created_at is stored as SQLite's bare UTC 'YYYY-MM-DD HH:MM:SS' (no
    // offset) - same UTC-forcing parse pattern already used elsewhere
    // (devices.js's timeAgo()), needed because Date() would otherwise
    // interpret the bare string in the server's local timezone.
    const startedAtMs = new Date(session.created_at.replace(' ', 'T') + 'Z').getTime();
    const durationSeconds = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
    try {
      db.prepare(`
        INSERT INTO session_history (voucher_code, mac_address, started_at, duration_seconds)
        VALUES (?, ?, ?, ?)
      `).run(session.voucher_code, session.mac_address, session.created_at, durationSeconds);
    } catch (e) {
      console.error(`[SessionHistory] Failed to record duration for ${voucherCode}:`, e.message);
    }
  }

  // Bug found on real hardware: promo.js's /redeem route sets a redeemed
  // voucher's status to 'active' the moment it's used, but nothing ever
  // moved it out of that state once the session it created actually ended
  // - the admin Vouchers page showed "Active" forever for every redeemed
  // code, long after the customer's time (and internet access) was gone.
  // expireSession() is the one place every session-ending path (timer
  // expiry, admin cut, customer cancel) already funnels through, so it's
  // the right single spot to close this out. 'used' (not 'unused'/'active')
  // is what the admin UI already renders as "Expired".
  if (session && session.mac_address) {
    try {
      db.prepare(
        "UPDATE promo_vouchers SET status = 'used' WHERE mac_address = ? AND status = 'active'"
      ).run(session.mac_address);
    } catch (e) {
      console.error(`[Promo] Failed to mark voucher used for ${session.mac_address}:`, e.message);
    }
  }

  // Block internet access
  if (session && session.mac_address) {
    try {
      await blockClient(session.mac_address);
      await removeClientBandwidth(session.mac_address);
      console.log(`[Network] Internet blocked for ${session.mac_address}`);
    } catch(e) {
      console.error(`[Network] Failed to block ${session.mac_address}:`, e.message);
    }

    require('./pushNotificationService').sendPush(
      session.mac_address,
      "⚠️ Time's Up",
      'Your WiFi session has ended. Reconnect to keep browsing.'
    ).catch(() => {});
  }
}

function getActiveSessions() {
  return db.prepare(`
    SELECT * FROM sessions
    ORDER BY created_at DESC
  `).all();
}

// Standalone mode's bandwidth shaping is bound to whichever interface a
// client's IP was on when it was applied (see standaloneDriver.js's
// checkRoam), internet access itself already follows a customer across
// every AP/lane by design, but their speed cap doesn't unless something
// re-applies it after a roam. Called periodically by watchdogService, only
// meaningful in standalone/OpenWRT mode (checkRoam no-ops to
// `{changed:false}` everywhere else, so this is a safe no-op call in
// MikroTik mode too, not just a guarded one).
// The global bandwidth cap (Security page) only ever got baked into new
// sessions going forward, an already-connected client kept whatever speed
// it was given at session start until it reconnected, since nothing ever
// called reapplyBandwidth() for the sessions already running when the
// admin changed the setting. Called once right after a bandwidth-cap
// settings save (see POST /api/admin/spam-settings) so the change is
// felt immediately, not just by future sessions. Only touches sessions on
// the plain default cap, never a session with its own override
// (effectiveBandwidth() already returns null for those, same guard
// reapplyBandwidth() itself uses).
async function reapplyDefaultBandwidthToActiveSessions() {
  const now = new Date().toISOString();
  const active = db.prepare(`
    SELECT mac_address FROM sessions WHERE hard_expires_at > ? AND is_paused = 0
  `).all(now);

  let updated = 0;
  for (const session of active) {
    try {
      await reapplyBandwidth(session.mac_address);
      updated++;
    } catch (e) {
      console.error(`[Network] Failed to reapply default bandwidth cap for ${session.mac_address}:`, e.message);
    }
  }
  return updated;
}

async function repairRoamedSessions() {
  const now = new Date().toISOString();
  const active = db.prepare(`
    SELECT * FROM sessions WHERE hard_expires_at > ? AND is_paused = 0
  `).all(now);

  const repaired = [];
  for (const session of active) {
    let roam;
    try {
      roam = await checkRoam(session.mac_address);
    } catch (e) {
      console.error(`[Network] Roam check failed for ${session.mac_address}:`, e.message);
      continue;
    }
    if (!roam?.changed) continue;

    try {
      // Clean up the old interface's shaping class before reapplying on
      // the new one - removeClientBandwidth() already knows to use the
      // last-shaped IP for this, not a fresh (now-wrong) lookup.
      await removeClientBandwidth(session.mac_address);

      if (session.download_mbps) {
        const upMbps = session.upload_mbps || session.download_mbps;
        await setClientBandwidth(session.mac_address, session.download_mbps, upMbps, getBurstConfig(), !!session.data_limit_mb);
      } else if (isBandwidthCapEnabled()) {
        await setClientBandwidth(session.mac_address, getMaxMbps(), getMaxUploadMbps(), getBurstConfig(), !!session.data_limit_mb);
      }
      // else: bandwidth cap disabled - no shaping to reapply, removing the
      // old class was the whole fix.

      console.log(`[Network] Re-shaped ${session.mac_address} after roam: ${roam.oldIp} -> ${roam.newIp}`);
      repaired.push(session.mac_address);
    } catch (e) {
      console.error(`[Network] Failed to re-shape ${session.mac_address} after roam:`, e.message);
    }
  }
  return repaired;
}

module.exports = {
  getSessionByMac,
  getSessionByVoucher,
  createSession,
  addTimeToSession,
  creditOrCreateSession,
  withMacLock,
  pauseSession,
  resumeSession,
  expireSession,
  getActiveSessions,
  getBurstConfig,
  isBandwidthCapEnabled,
  repairRoamedSessions,
  effectiveBandwidth,
  reapplyBandwidth,
  reapplyDefaultBandwidthToActiveSessions
};
