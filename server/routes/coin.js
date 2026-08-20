const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { checkSpam, recordAttempt, clearAttempts } = require('../services/spamService');
const { creditCoinValue, NoMatchingRateError } = require('../services/coinCreditService');
const { resolveDeviceKey } = require('../services/satelliteKioskService');
const sseService = require('../services/sseService');

// MAC address validation helper (Bug #27)
function isValidMac(mac) {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(String(mac || '').trim());
}

// In-memory store of which MAC is currently "pending" a coin insertion.
// Single-vendo setup: only one pending slot needed at a time.
let pendingCoinMac = null;
let pendingSetAt = 0;
// Running total (pesos) accumulated since this pending window opened, not
// yet credited to a session, lets the portal show "how much have I
// inserted so far" without having to reverse-engineer pesos from minutes
// (not reliably invertible: different coin denominations buy minutes at
// different rates).
let pendingTotal = 0;
let pendingIp = '';
let pendingKioskId = null;
let pendingFinalizeTimer = null;
// Which button the customer tapped on the portal (normal vs the gold
// PREMIUM button) - set once when the window opens (POST /pending) and
// used at finalize to match against the Premium rate rather than the
// regular one sharing the same coin_value, since coin denominations no
// longer disambiguate Premium from regular on their own.
let pendingIsPremium = false;
const PENDING_TIMEOUT_MS = 40000; // must match/slightly exceed portal's 30s coin timer

// Bug found live: crediting each coin the instant it was detected meant a
// session got created (and network access granted via sessionService's
// allowClient()) on the very first coin, not once the customer was done
// inserting. Someone burn-testing with 30 pesos in separate coins got
// "connected" and had their portal close out after the first one. JuanFi
// (a comparable PisoWifi coinslot system) accumulates coins into a running
// total while its own countdown window is open, and only credits/grants
// access ONCE, when that window closes with no further coins. Mirroring
// that here: accumulate into pendingTotal per coin, and only call
// creditCoinValue(), which is what actually creates/tops-up the session
// and grants access, when the window's silence timer fires.
function scheduleFinalize(mac) {
  if (pendingFinalizeTimer) clearTimeout(pendingFinalizeTimer);
  pendingFinalizeTimer = setTimeout(() => finalizePendingCoins(mac), PENDING_TIMEOUT_MS);
}

// Returns a result object when called from the portal's "Done" button (see
// POST /finalize below), so the customer gets an immediate answer instead
// of a silent console log. The timer-driven call (scheduleFinalize) just
// ignores the return value, same as before.
async function finalizePendingCoins(mac) {
  if (pendingCoinMac !== mac || pendingTotal <= 0) {
    return { success: false, reason: 'no_pending_coins' };
  }

  const total = pendingTotal;
  const kioskId = pendingKioskId;
  const isPremium = pendingIsPremium;

  // pendingIp only ever held whatever the coin-relay device (ESP32) self-
  // reported as its OWN WiFi IP, not the paying customer's - a physical
  // coin slot is shared across many different customers over time and has
  // no way to know whose phone is inserting a coin from its own network
  // layer. Real bug this caused: the session's stored ip_address ended up
  // identical to the vendo device's own IP, confusing for the operator (a
  // customer's Live Sessions row showing the coin slot's address) and
  // making standaloneDriver.js's roam detection (which compares a
  // session's stored IP against its current live one) see a permanent
  // false "roamed" state since the phone's real IP could never match.
  // Looked up here by the customer's own MAC instead, falling back to the
  // old self-reported value only if that lookup can't resolve (e.g. the
  // lease isn't visible yet), so this never regresses to storing nothing.
  const ip = (await require('../services/networkService').getIpFromMac(mac)) || pendingIp;

  // Clear the window before crediting, not after. A coin that happens to
  // land while creditCoinValue() is mid-flight should start a fresh
  // window of its own instead of silently folding into this one.
  pendingCoinMac = null;
  pendingTotal = 0;
  pendingIp = '';
  pendingKioskId = null;
  pendingIsPremium = false;
  if (pendingFinalizeTimer) clearTimeout(pendingFinalizeTimer);
  pendingFinalizeTimer = null;

  try {
    const result = await creditCoinValue(mac, total, ip, kioskId, isPremium);
    console.log(`✅ Pending window closed for ${mac}: credited ₱${total} (${result.matched_as})`);
    return { success: true, result };
  } catch (err) {
    if (err instanceof NoMatchingRateError) {
      // The old immediate-credit path recorded a spam attempt on every
      // non-matching coin, which is what actually blocks someone (or a
      // miscalibrated coin acceptor) hammering invalid values. Accumulating
      // silently for the whole window must not lose that. Record it here
      // against the final total, same as the still-present fallback branch
      // below does for direct/manual posts.
      const attempt = recordAttempt(mac);
      console.error(`⚠️ Pending window for ${mac} closed with ₱${total} matching no rate tier, not credited.`);
      return { success: false, reason: 'no_matching_rate', total, attempt };
    }
    console.error('Finalize pending coin error:', err);
    return { success: false, reason: 'server_error' };
  }
}

// Idempotency cache for coin.cpp's postCoin() event_id. The ESP32 retries
// a coin POST only when it never received a response (network-level
// failure - see coin.cpp's own comment), which means the server may have
// already successfully credited it before the retry arrives. Without this,
// a retry is indistinguishable from a second real coin and gets credited
// twice. Keyed on event_id -> the exact response object first returned for
// it, replayed verbatim on a repeat instead of crediting again. 5 minutes
// covers the firmware's worst case (3 attempts, 5s timeout + 1s delay each,
// well under 30s) with generous margin, and old entries are swept so this
// never grows unbounded on a box that runs for months.
const coinEventCache = new Map();
const COIN_EVENT_TTL_MS = 5 * 60 * 1000;
function pruneCoinEventCache() {
  const cutoff = Date.now() - COIN_EVENT_TTL_MS;
  for (const [id, entry] of coinEventCache) {
    if (entry.at < cutoff) coinEventCache.delete(id);
  }
}

// POST /api/coin/pending, portal calls this right when INSERT COIN modal opens
router.post('/pending', (req, res) => {
  const { mac, is_premium } = req.body;
  if (!mac || !isValidMac(mac)) {
    return res.status(400).json({ success: false, message: 'Valid MAC address required' });
  }
  if (pendingFinalizeTimer) clearTimeout(pendingFinalizeTimer);
  pendingCoinMac = mac.toLowerCase();
  pendingSetAt = Date.now();
  pendingTotal = 0;
  pendingIp = '';
  pendingKioskId = null;
  pendingIsPremium = !!is_premium;
  pendingFinalizeTimer = null;
  console.log(`⏳ Pending coin registered for ${pendingCoinMac}${pendingIsPremium ? ' (Premium)' : ''}`);
  return res.json({ success: true });
});

// GET /api/coin/pending/:mac, portal polls this while the INSERT COIN modal
// is open, to show a running total and detect new coins to reset its timer.
router.get('/pending/:mac', (req, res) => {
  const mac = String(req.params.mac || '').trim().toLowerCase();
  const stillValid = pendingCoinMac === mac && (Date.now() - pendingSetAt < PENDING_TIMEOUT_MS);
  return res.json({ success: true, pending: stillValid, total: stillValid ? pendingTotal : 0 });
});

// POST /api/coin/finalize, portal calls this when the customer taps "Done"
// / "Already inserted? Connect" in the Insert Coin modal, so they don't
// have to wait out the full silence window (PENDING_TIMEOUT_MS) once
// they're finished dropping coins.
router.post('/finalize', async (req, res) => {
  const mac = String(req.body.mac || '').trim().toLowerCase();
  if (!mac || !isValidMac(mac)) {
    return res.status(400).json({ success: false, message: 'Valid MAC address required' });
  }
  if (pendingCoinMac !== mac) {
    // Nothing pending for this MAC, not an error, the customer may have
    // an existing session already and just closed the modal with no new
    // coins inserted this time.
    return res.json({
      success: false,
      reason: 'no_pending_coins',
      message: 'No coins detected yet, insert one first.'
    });
  }

  const outcome = await finalizePendingCoins(mac);
  if (!outcome.success) {
    if (outcome.reason === 'no_matching_rate') {
      return res.status(400).json({
        success: false,
        reason: outcome.reason,
        message: `₱${outcome.total} doesn't match any rate, insert a bit more or a different combination.`
      });
    }
    if (outcome.reason === 'server_error') {
      return res.status(500).json({
        success: false,
        reason: outcome.reason,
        message: 'Something went wrong crediting your coins, please try again.'
      });
    }
    return res.json({ ...outcome, message: outcome.message || 'No coins detected yet, insert one first.' });
  }
  return res.json({ success: true, ...outcome.result });
});

// POST /api/coin, ESP32 calls this when a coin is detected
router.post('/', async (req, res) => {
  try {
    const { mac: deviceMac, coin_value, ip, device_key, event_id } = req.body;

    // Idempotency replay: event_id is optional (absent on any ESP32
    // running older firmware, which must keep working exactly as before -
    // same "optional, unaffected if missing" contract as device_key
    // below). If present and already seen, this is a retry of a coin the
    // server already credited - answer with the original result instead
    // of running creditCoinValue() again.
    if (event_id) {
      pruneCoinEventCache();
      const cached = coinEventCache.get(String(event_id));
      if (cached) {
        console.log(`🔁 Duplicate coin event_id ${event_id}, replaying original result (no double-credit)`);
        return res.json(cached.result);
      }
    }

    // Optional - absent on every existing ESP32 deployment in the field,
    // which must keep working exactly as before. Only a request that
    // actually carries a key matching a paired Satellite Kiosk gets
    // attributed to it; anything else (no key, unrecognized key) resolves
    // to null and is credited as generic Coins, same as today.
    const kioskId = resolveDeviceKey(device_key);

    if (!coin_value || typeof coin_value !== 'number' || coin_value <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid coin value required'
      });
    }

    // Determine the customer MAC: use pending MAC if still valid,
    // otherwise fall back to whatever MAC was sent (legacy/manual testing).
    let mac = deviceMac;
    const pendingValid = pendingCoinMac && (Date.now() - pendingSetAt < PENDING_TIMEOUT_MS);

    if (pendingValid) {
      mac = pendingCoinMac;
    } else if (pendingCoinMac) {
      // expired pending slot, clear it
      pendingCoinMac = null;
    }

    // Validate MAC format early (Bug #27)
    if (!mac || !isValidMac(mac)) {
      return res.status(400).json({
        success: false,
        message: 'Valid MAC address required'
      });
    }
    mac = mac.toLowerCase();

    // Check spam
    const spamCheck = checkSpam(mac);
    if (spamCheck.blocked) {
      return res.status(429).json({
        success: false,
        blocked: true,
        remaining: spamCheck.remaining,
        message: spamCheck.message
      });
    }

    if (pendingValid && mac === pendingCoinMac) {
      // Accumulate into the running total instead of crediting this coin on
      // its own, renew the window so a customer dropping several coins a
      // few seconds apart doesn't run out of time mid-insertion, and
      // (re)schedule the finalize timer so the actual credit + session
      // creation/access grant only happens once, after the window falls
      // silent (see finalizePendingCoins() above).
      pendingSetAt = Date.now();
      pendingTotal += coin_value;
      pendingIp = ip || pendingIp;
      if (kioskId != null) pendingKioskId = kioskId;
      scheduleFinalize(mac);

      // Bug found live: nothing pushed a wake-up while coins were still
      // accumulating (sseService.notify() only ever fired once a session
      // was actually created/topped-up, i.e. at finalize), the portal's
      // running total only moved on its 1.5s poll tick, so a customer
      // watching the modal saw their credit lag 1-3 seconds behind the
      // coin acceptor's own beep/LED. Notifying here lets the portal's
      // already-open SSE connection trigger an immediate poll per coin.
      sseService.notify(mac);

      clearAttempts(mac);

      const ack = { success: true, action: 'coin_accumulated', total: pendingTotal };
      if (event_id) {
        coinEventCache.set(String(event_id), { result: ack, at: Date.now() });
      }
      return res.json(ack);
    }

    // No active pending window, e.g. a direct/manual coin POST that never
    // went through the portal's /pending handshake. Credit immediately,
    // same as this endpoint always did before the accumulate-then-finalize
    // change above. Same real-IP lookup as finalizePendingCoins() above,
    // req.body's own ip is the relay device's, not necessarily the
    // customer's.
    let result;
    try {
      const realIp = (await require('../services/networkService').getIpFromMac(mac)) || ip;
      result = await creditCoinValue(mac, coin_value, realIp, kioskId);
    } catch (err) {
      if (err instanceof NoMatchingRateError) {
        const attempt = recordAttempt(mac);
        return res.status(400).json({
          success: false,
          blocked: attempt.blocked,
          remaining: attempt.remaining,
          remaining_attempts: attempt.remaining_attempts,
          message: attempt.blocked
            ? attempt.message
            : `Invalid coin. ${attempt.remaining_attempts} attempts left.`
        });
      }
      throw err;
    }

    if (event_id) {
      coinEventCache.set(String(event_id), { result, at: Date.now() });
    }

    clearAttempts(mac);
    return res.json(result);

  } catch (err) {
    console.error('Coin error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== DIRECT GPIO COINSLOT (Workstream 4) =====
// Separate from the pendingCoinMac mechanism above, which is specific to
// the ESP32 HTTP-relay flow, this is the busy-lock/rate-limited waiting-
// client registration for a coin acceptor wired directly into the box's
// own GPIO header. See server/services/coinslotGpio.js.

// POST /api/coin/gpio/register, portal calls this when Insert Coin opens
// in direct-GPIO mode.
router.post('/gpio/register', (req, res) => {
  const { mac, is_premium } = req.body;
  if (!mac || !isValidMac(mac)) {
    return res.status(400).json({ success: false, message: 'Valid MAC address required' });
  }
  const coinslotGpio = require('../services/coinslotGpio');
  const { status, windowSeconds } = coinslotGpio.registerWaitingClient(mac, !!is_premium);
  if (status === coinslotGpio.REGISTER_BUSY) {
    return res.status(409).json({ success: false, status, message: 'Coin slot is busy with another customer.' });
  }
  if (status === coinslotGpio.REGISTER_RATE_LIMITED) {
    return res.status(429).json({ success: false, status, message: 'Too many attempts, please wait before trying again.' });
  }
  return res.json({ success: true, status, window_seconds: windowSeconds });
});

// POST /api/coin/gpio/cancel, portal calls this when the Insert Coin
// modal is closed without paying.
router.post('/gpio/cancel', (req, res) => {
  const { mac } = req.body;
  if (!mac || !isValidMac(mac)) {
    return res.status(400).json({ success: false, message: 'Valid MAC address required' });
  }
  const coinslotGpio = require('../services/coinslotGpio');
  const cancelled = coinslotGpio.cancelWaitingClient(mac);
  return res.json({ success: true, cancelled });
});

// GET /api/coin/gpio/status/:mac, portal polls this to know whose coin
// window is currently active.
router.get('/gpio/status/:mac', (req, res) => {
  const mac = normalizeMacParam(req.params.mac);
  const coinslotGpio = require('../services/coinslotGpio');
  const waitingMac = coinslotGpio.currentWaitingMac();
  return res.json({ success: true, is_waiting: !!mac && waitingMac === mac });
});

function normalizeMacParam(mac) {
  return String(mac || '').trim().toLowerCase();
}

// GET /api/coin/status/:mac
router.get('/status/:mac', (req, res) => {
  const { mac } = req.params;
  const spamCheck = checkSpam(mac);

  const maxAttempts = db.prepare(
    "SELECT value FROM settings WHERE key = 'spam_max_attempts'"
  ).get()?.value || '3';

  const blockMinutes = db.prepare(
    "SELECT value FROM settings WHERE key = 'spam_block_minutes'"
  ).get()?.value || '1';

  res.json({
    blocked: spamCheck.blocked,
    remaining: spamCheck.remaining || 0,
    max_attempts: parseInt(maxAttempts),
    block_minutes: parseInt(blockMinutes)
  });
});

module.exports = router;