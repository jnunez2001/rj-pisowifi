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

// settings.wifi_speed_timer_ms - same "milliseconds per billed second"
// speed setting built for PC Rental (rental_speed_timer_secs). 1000 =
// real-time, lower = drains faster. Returns the real-ms duration to
// actually grant for a given number of nominal minutes - called only
// from createSession/addTimeToSession below (real, customer-earned
// time), never from admin's own manual "Add Time" math in admin.js,
// which stays a literal grant regardless of this setting.
function grantedMsForMinutes(minutes) {
  const speedMs = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'wifi_speed_timer_ms'").get()?.value, 10) || 1000;
  return minutes * 60 * 1000 * (speedMs / 1000);
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
    now + grantedMsForMinutes(mins)
  ).toISOString();

  const hardExpiresAt = new Date(
    now + grantedMsForMinutes(expMins)
  ).toISOString();

  console.log(`Creating session: ${mins} mins, expires: ${expiresAt}, hard: ${hardExpiresAt}`);

  const premiumDownload = bandwidthOverride ? bandwidthOverride.download_mbps : null;
  const premiumUpload = bandwidthOverride ? (bandwidthOverride.upload_mbps || bandwidthOverride.download_mbps) : null;
  const premiumExpiresAt = bandwidthOverride
    ? new Date(now + Math.floor(bandwidthOverride.minutes || 0) * 60 * 1000).toISOString()
    : null;
  const premiumStartedAt = bandwidthOverride ? new Date(now).toISOString() : null;

  db.prepare(`
    INSERT INTO sessions
    (voucher_code, mac_address, ip_address, minutes_remaining,
     expires_at, hard_expires_at, premium_download_mbps, premium_upload_mbps, premium_expires_at, premium_started_at, data_limit_mb)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(voucherCode, mac, ip, mins, expiresAt, hardExpiresAt, premiumDownload, premiumUpload, premiumExpiresAt, premiumStartedAt, dataLimitMb || null);

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

  // Scaling newMinutes (existing + new) as one lump sum would re-scale
  // the ALREADY-elapsed-adjusted remaining portion a second time on every
  // top-up, compounding the speed multiplier - so only the newly-added
  // `minutes` gets scaled here, added on top of the session's REAL
  // current remaining wall-clock time (from expires_at, not the cached
  // minutes_remaining column), same pattern as coin.js's PC Rental
  // guest-credit branch.
  const currentRemainingMs = session.expires_at ? Math.max(0, new Date(session.expires_at).getTime() - now) : 0;
  const newExpiresAt = new Date(
    now + currentRemainingMs + grantedMsForMinutes(minutes)
  ).toISOString();

  // Bug found live: this used to be JUST now + this top-up's own
  // expirationMinutes, ignoring the session's EXISTING hard_expires_at
  // entirely. A customer who bought a long-expiration rate, then later
  // topped up with a coin combo matching a shorter-expiration rate (a
  // completely normal thing to do, rate tiers aren't required to be
  // inserted in any particular order), had their hard expiry silently
  // PULLED IN to the new, shorter window, cutting time off a purchase
  // they'd already made and had every right to keep. Taking the later of
  // the two means a top-up can only ever extend how long the session stays
  // resumable, never shrink it.
  const topUpHardExpiresAtMs = now + grantedMsForMinutes(expirationMinutes);
  const existingHardExpiresAtMs = session.hard_expires_at ? new Date(session.hard_expires_at).getTime() : 0;
  const newHardExpiresAt = new Date(
    Math.max(topUpHardExpiresAtMs, existingHardExpiresAtMs)
  ).toISOString();

  let premiumDownload = session.premium_download_mbps;
  let premiumUpload = session.premium_upload_mbps;
  let premiumExpiresAt = session.premium_expires_at;
  let premiumStartedAt = session.premium_started_at;

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
    // Portal's gold countdown bar needs a real start point to compute
    // elapsed-vs-total progress from, not just the end time. Reset on
    // every fresh Boost purchase, same moment premiumExpiresAt itself
    // gets recalculated, so the bar always reflects THIS purchase's own
    // window.
    premiumStartedAt = new Date(now).toISOString();
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
        premium_started_at = ?,
        data_limit_mb = ?
    WHERE mac_address = ?
  `).run(newMinutes, newExpiresAt, newHardExpiresAt, premiumDownload, premiumUpload, premiumExpiresAt, premiumStartedAt, newDataLimitMb, mac);

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

// "Convert" mode Premium purchase (portal's CONVERT button, distinct from
// "Boost" which is addTimeToSession's bandwidthOverride stacking path).
//
// Bug found live: this used to SET minutes_remaining to just the matched
// Premium rate's own minutes, discarding whatever Regular time the
// customer already had left entirely - a customer with 40 real, paid-for
// minutes remaining who converted lost every one of them the instant they
// did, replaced outright instead of converted. The existing time needs to
// carry over, scaled by conversionRatio (coinCreditService.js's
// convertCoinValue computes this from the matched Premium rate's own
// minutes vs. the Regular rate sharing its exact coin value, i.e. "how
// much less time the same money buys at Premium speed"), not thrown away.
// conversionRatio itself is pure rate-config math, safe to compute before
// this lock; multiplying it against minutes_remaining happens in here,
// against a FRESH read of the session taken after acquiring the lock, so
// a top-up landing in the same instant can never get silently overwritten
// by a ratio calculated against stale data.
//
// Speed itself still goes permanent for the rest of the session
// (session.download_mbps, same permanent field a voucher's own override
// uses - not premium_expires_at, which is specifically for the temporary
// Boost path and would make this silently revert like Boost does,
// defeating the entire point of Convert). Only valid on an existing
// session - there's nothing to "convert," this doesn't create one.
async function convertToPremiumSession(mac, newPremiumMinutes, conversionRatio, expirationMinutes, bandwidthOverride, dataLimitMb = null) {
  return withMacLock(mac, async () => {
    mac = normalizeMac(mac);
    const session = getSessionByMac(mac);
    if (!session) return null;

    const carriedOverMinutes = Math.round((session.minutes_remaining || 0) * conversionRatio);
    const minutes = carriedOverMinutes + newPremiumMinutes;

    const newDataLimitMb = session.data_limit_mb || dataLimitMb || null;
    const now = Date.now();
    const newExpiresAt = new Date(now + minutes * 60 * 1000).toISOString();

    // Same "never shrink an already-locked-in expiry" invariant as
    // addTimeToSession - Convert changes the TIME BUCKET and SPEED, but
    // shouldn't be able to pull in how long the session stays resumable.
    const convertHardExpiresAtMs = now + expirationMinutes * 60 * 1000;
    const existingHardExpiresAtMs = session.hard_expires_at ? new Date(session.hard_expires_at).getTime() : 0;
    const newHardExpiresAt = new Date(Math.max(convertHardExpiresAtMs, existingHardExpiresAtMs)).toISOString();

    db.prepare(`
      UPDATE sessions
      SET minutes_remaining = ?,
          expires_at = ?,
          hard_expires_at = ?,
          push_2min_sent = 0,
          download_mbps = ?,
          upload_mbps = ?,
          premium_download_mbps = NULL,
          premium_upload_mbps = NULL,
          premium_expires_at = NULL,
          converted_to_premium = 1,
          data_limit_mb = ?
      WHERE mac_address = ?
    `).run(minutes, newExpiresAt, newHardExpiresAt, bandwidthOverride.download_mbps,
           bandwidthOverride.upload_mbps || bandwidthOverride.download_mbps, newDataLimitMb, mac);

    const updated = db.prepare('SELECT * FROM sessions WHERE mac_address = ?').get(mac);

    try {
      await allowClient(mac);
      await setClientBandwidth(mac, updated.download_mbps, updated.upload_mbps || updated.download_mbps, getBurstConfig(), !!newDataLimitMb);
    } catch (e) {}

    sseService.notify(mac);
    return updated;
  });
}

// Reverse of convertToPremiumSession() above - only offered when the
// operator has turned it on (settings.allow_premium_to_regular_convert)
// AND the session's elevated speed actually came from a Convert action
// (converted_to_premium = 1), never from a voucher's own permanent
// override, which was never a Premium purchase to "downgrade" from.
// That eligibility check lives in coinCreditService.js's
// convertToRegularValue(), this function just performs the switch once
// it's already been approved. Same "SET, not add" time mechanic as
// Convert-to-Premium, in reverse: minutes_remaining becomes whatever the
// matched Regular rate grants, speed drops back to no override (global
// cap or nothing), permanently, for the rest of the session.
async function convertToRegularSession(mac, newRegularMinutes, conversionRatio, expirationMinutes, dataLimitMb = null) {
  return withMacLock(mac, async () => {
    mac = normalizeMac(mac);
    const session = getSessionByMac(mac);
    if (!session) return null;

    // Same carry-over fix as convertToPremiumSession above, mirrored: the
    // customer's remaining Premium minutes convert to Regular-equivalent
    // minutes (scaled by conversionRatio, computed in
    // coinCreditService.js's convertToRegularValue) rather than being
    // discarded outright.
    const carriedOverMinutes = Math.round((session.minutes_remaining || 0) * conversionRatio);
    const minutes = carriedOverMinutes + newRegularMinutes;

    const newDataLimitMb = session.data_limit_mb || dataLimitMb || null;
    const now = Date.now();
    const newExpiresAt = new Date(now + minutes * 60 * 1000).toISOString();

    const convertHardExpiresAtMs = now + expirationMinutes * 60 * 1000;
    const existingHardExpiresAtMs = session.hard_expires_at ? new Date(session.hard_expires_at).getTime() : 0;
    const newHardExpiresAt = new Date(Math.max(convertHardExpiresAtMs, existingHardExpiresAtMs)).toISOString();

    db.prepare(`
      UPDATE sessions
      SET minutes_remaining = ?,
          expires_at = ?,
          hard_expires_at = ?,
          push_2min_sent = 0,
          download_mbps = NULL,
          upload_mbps = NULL,
          premium_download_mbps = NULL,
          premium_upload_mbps = NULL,
          premium_expires_at = NULL,
          converted_to_premium = 0,
          data_limit_mb = ?
      WHERE mac_address = ?
    `).run(minutes, newExpiresAt, newHardExpiresAt, newDataLimitMb, mac);

    const updated = db.prepare('SELECT * FROM sessions WHERE mac_address = ?').get(mac);

    try {
      await allowClient(mac);
      if (isBandwidthCapEnabled()) {
        await setClientBandwidth(mac, getMaxMbps(), getMaxUploadMbps(), getBurstConfig(), !!newDataLimitMb);
      } else {
        await removeClientBandwidth(mac);
      }
    } catch (e) {}

    sseService.notify(mac);
    return updated;
  });
}

// Real request: an operator wants a cap on how many times the same
// session can be paused, and the portal to show the customer how many
// pauses they have left rather than an unlimited button. Returns the
// literal string 'limit_reached' (distinct from null, which already
// means "no session"/"already paused") so the route can tell the two
// apart and answer with the right message.
// `reason` - 'manual' (customer tapped Pause) or 'idle' (timerService.js's
// away detection). An idle pause deliberately does NOT call blockClient()
// - staying connected is what lets real traffic auto-trigger resumeSession()
// later, and it doesn't consume the customer's limited max_pauses
// allowance, since it's a system action, not something they chose to use up.
async function pauseSession(voucherCode, reason = 'manual') {
  const session = getSessionByVoucher(voucherCode);
  if (!session || session.is_paused === 1) return null;

  if (reason === 'manual') {
    const maxPauses = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'max_pauses'").get()?.value || '0', 10) || 0;
    if (maxPauses > 0 && (session.pause_count || 0) >= maxPauses) {
      return 'limit_reached';
    }
  }

  const now = new Date().toISOString();
  const remaining = Math.floor(
    (new Date(session.expires_at) - new Date()) / 60000
  );

  db.prepare(`
    UPDATE sessions
    SET is_paused = 1,
        paused_at = ?,
        minutes_remaining = ?,
        pause_count = pause_count + ?,
        pause_reason = ?
    WHERE voucher_code = ?
  `).run(now, Math.max(0, remaining), reason === 'manual' ? 1 : 0, reason, voucherCode);

  if (reason === 'manual') {
    // Block internet access when pausing
    try {
      await blockClient(session.mac_address);
      console.log(`[Network] Internet blocked for ${session.mac_address} (paused)`);
    } catch(e) {
      console.error(`[Network] Failed to block ${session.mac_address} on pause:`, e.message);
    }
  } else {
    console.log(`[Network] ${session.mac_address} auto-paused (idle) - connection left up so activity can auto-resume it`);
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
        pause_reason = NULL,
        expires_at = ?
    WHERE voucher_code = ?
  `).run(newExpiresAt, voucherCode);

  if (session.pause_reason === 'idle') {
    // Nothing to restore - an idle pause never called blockClient(), the
    // device stayed connected the whole time (that's what made this
    // auto-resume possible in the first place).
    console.log(`[Network] ${session.mac_address} auto-resumed (activity detected) - connection was never cut`);
  } else {
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

  // Owner's call, now switchable (Movies page toggle, settings.
  // movie_credit_persists): by default Movie Credit (banked over/underpaid
  // movie-rental coins, database.js's movie_credits) is only meant to be
  // spent DURING the WiFi time the customer already paid for - "use it
  // before there connection time ends or it will be lost or not be
  // refunded." Forfeited (not carried forward) the moment their session
  // actually ends, through this same single choke-point every ending path
  // already funnels through (timer expiry, admin cut, customer cancel -
  // same reasoning as the promo_vouchers cleanup above). With the toggle
  // switched on, this step is simply skipped and the balance persists into
  // the customer's next session instead, same as a real store credit.
  if (session && session.mac_address) {
    const persists = db.prepare("SELECT value FROM settings WHERE key = 'movie_credit_persists'").get()?.value === '1';
    if (!persists) {
      try {
        db.prepare('DELETE FROM movie_credits WHERE mac_address = ?').run(session.mac_address);
      } catch (e) {
        console.error(`[MovieCredit] Failed to forfeit balance for ${session.mac_address}:`, e.message);
      }
    }
  }

  // Block internet access
  if (session && session.mac_address) {
    try {
      // Bug found live: blockClient() (mikrotikService.js in Controller
      // mode) never actually throws on failure - it catches its own
      // errors internally and resolves with `false`. This call discarded
      // that return value entirely, so the try/catch below never fired
      // for the exact failure it exists to catch - a customer whose
      // session ended during a router API blip kept a real, working
      // bypass binding forever with zero record anywhere, confirmed live
      // via a leftover bypass with no matching session. Capturing the
      // return value and alerting on false closes that gap; watchdogService's
      // periodic reconciliation is the backstop that cleans up the binding
      // itself even if this alert is the only thing anyone ever sees.
      // Standalone/OpenWRT drivers deliberately resolve with `undefined`
      // either way (their own documented "just log and resolve"
      // contract, see networkService.js) - only MikroTik's blockClient
      // returns a real true/false. Checking `=== false` specifically
      // (not falsy) so this only ever fires on MikroTik's explicit
      // failure signal, never misfires as a false alarm on every single
      // standalone/OpenWRT session expiry.
      const blocked = await blockClient(session.mac_address);
      await removeClientBandwidth(session.mac_address);
      if (blocked !== false) {
        console.log(`[Network] Internet blocked for ${session.mac_address}`);
      } else {
        console.error(`[Network] Failed to block ${session.mac_address} - may still have access until the next reconciliation pass`);
        try {
          require('./alertEventService').logAlertEvent(
            'warning',
            'session_end_block_failed',
            `Could not confirm internet was blocked for ${session.mac_address}`,
            'Their session ended, but the router/firewall did not confirm access was actually cut - they may still have a working connection until the next automatic reconciliation pass (Controller mode) or a manual check.'
          );
        } catch (e) {}
      }
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
  convertToPremiumSession,
  convertToRegularSession,
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
