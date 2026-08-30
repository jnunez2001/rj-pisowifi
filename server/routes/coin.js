const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { checkSpam, recordAttempt, clearAttempts } = require('../services/spamService');
const { creditCoinValue, convertCoinValue, convertToRegularValue, NoMatchingRateError } = require('../services/coinCreditService');
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
// Which button the customer tapped on the portal - 'regular', 'premium'
// (the gold "Boost" button, temporary speed stack) or 'convert' (permanent
// speed switch, sets minutes to the matched Premium rate's own value
// instead of adding to what's left - see coinCreditService.js's
// convertCoinValue). Set once when the window opens (POST /pending) and
// used at finalize to match against the right rate/crediting path, since
// coin denominations alone don't disambiguate any of these three.
let pendingMode = 'regular';
// Only set/used when pendingMode === 'movie' - which premium movie this
// coin window is paying to unlock (server/services/movieService.js). A
// movie rental never touches session.minutes_remaining at all, it's a
// completely separate real-coin payment from WiFi time (see
// finalizePendingCoins()'s 'movie' branch below).
let pendingMovieId = null;
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
  const mode = pendingMode;
  const movieId = pendingMovieId;

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
  pendingMode = 'regular';
  pendingMovieId = null;
  if (pendingFinalizeTimer) clearTimeout(pendingFinalizeTimer);
  pendingFinalizeTimer = null;

  // Movie rental: a completely separate real-coin payment from WiFi
  // time, never touches sessions/minutes_remaining at all - see
  // server/services/movieService.js and the "no deduction of time"
  // requirement this replaced the old approve-credit-style minutes
  // deduction with. Requires the FULL price in one window; falling short
  // just closes the window with nothing unlocked (matches how a real
  // coin-op device has no way to give change either).
  // PC rental: staff-triggered from the admin panel's PC Rental page
  // (shared coin box), targeting a specific rental_pcs row by its OWN
  // registered mac_address (reusing the universal `mac` param rather than
  // inventing a separate id field). Completely separate ledger from WiFi
  // minutes AND from movie rentals - never touches sessions or
  // movie_rentals. Same "full price or nothing" rule as movie rentals -
  // the shared box can't give change either.
  if (mode === 'pc_rental') {
    const pc = db.prepare('SELECT * FROM rental_pcs WHERE mac_address = ?').get(mac);
    if (!pc) {
      return { success: false, reason: 'pc_not_found' };
    }
    const rate = db.prepare('SELECT minutes FROM rental_rates WHERE coin_value = ?').get(total);
    const minutes = rate ? rate.minutes : null;
    if (!minutes) {
      console.error(`⚠️ PC rental coin window for "${pc.name}" closed with ₱${total}, no matching rate - not credited.`);
      return { success: false, reason: 'no_matching_rate', total };
    }
    const existingSession = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(pc.id);
    const currentRemainingMs = existingSession?.hard_expires_at
      ? Math.max(0, new Date(existingSession.hard_expires_at).getTime() - Date.now()) : 0;
    const newExpiresAt = new Date(Date.now() + currentRemainingMs + minutes * 60000).toISOString();

    if (existingSession) {
      db.prepare('UPDATE rental_sessions SET minutes_remaining = ?, expires_at = ?, hard_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE pc_id = ?')
        .run(minutes, newExpiresAt, newExpiresAt, pc.id);
    } else {
      db.prepare('INSERT INTO rental_sessions (pc_id, minutes_remaining, expires_at, hard_expires_at) VALUES (?, ?, ?, ?)')
        .run(pc.id, minutes, newExpiresAt, newExpiresAt);
    }
    db.prepare("INSERT INTO rental_transactions (pc_id, coin_value, minutes_added, type) VALUES (?, ?, ?, 'coin')")
      .run(pc.id, total, minutes);

    console.log(`✅ PC rental credited for "${pc.name}": ₱${total} (${minutes} min)`);
    return { success: true, result: { pc_credited: true, pc_id: pc.id, minutes_added: minutes } };
  }

  if (mode === 'movie') {
    const movieService = require('../services/movieService');
    const movie = movieService.getMovie(movieId);
    if (!movie) {
      return { success: false, reason: 'movie_not_found' };
    }
    if (total < movie.price_pesos) {
      console.error(`⚠️ Movie rental window for ${mac} closed with ₱${total}, needed ₱${movie.price_pesos} - not unlocked.`);
      return { success: false, reason: 'insufficient_amount', total, needed: movie.price_pesos };
    }
    const rentalHours = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'movie_rental_hours'").get()?.value || '48');
    const expiresAt = new Date(Date.now() + rentalHours * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO movie_rentals (movie_id, mac_address, expires_at) VALUES (?, ?, ?)').run(movie.id, mac, expiresAt);
    db.prepare(`
      INSERT INTO transactions (voucher_code, coin_value, minutes_added, type, mac_address)
      VALUES (?, ?, 0, 'movie_rental', ?)
    `).run(`MOVIE-${movie.id}`, total, mac);
    console.log(`✅ Movie rental unlocked for ${mac}: "${movie.title}" (₱${total})`);
    require('../services/vendoAudioService').playVendoAmount(total).catch(() => {});
    return { success: true, result: { movie_unlocked: true, movie_id: movie.id, expires_at: expiresAt } };
  }

  try {
    let result;
    if (mode === 'convert') result = await convertCoinValue(mac, total, ip, kioskId);
    else if (mode === 'convert_down') result = await convertToRegularValue(mac, total, ip, kioskId);
    else result = await creditCoinValue(mac, total, ip, kioskId, mode === 'premium');
    console.log(`✅ Pending window closed for ${mac}: credited ₱${total} (${result.matched_as})`);
    // Best-effort, never blocks the credit itself on the vendo being
    // reachable or having a speaker wired up - see vendoAudioService.js.
    // Fires from here (not the frontend) because this is the one place
    // that knows the exact peso total credited; the portal only ever
    // sees minutes added, which isn't the same number an operator's rate
    // tiers use.
    require('../services/vendoAudioService').playVendoAmount(total).catch(() => {});
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
    if (mode === 'convert' || mode === 'convert_down') {
      console.error(`⚠️ Convert failed for ${mac}: ${err.message}`);
      return { success: false, reason: 'convert_failed', message: err.message, total };
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
  const { mac, is_premium, mode, movie_id } = req.body;
  if (!mac || !isValidMac(mac)) {
    return res.status(400).json({ success: false, message: 'Valid MAC address required' });
  }
  // mode is the current contract ('regular'|'premium'|'convert'|'movie'|
  // 'pc_rental'); is_premium is kept working for older portal.js builds
  // still sending the plain boolean, mapped onto the same 'premium' mode.
  const resolvedMode = (mode === 'convert' || mode === 'convert_down' || mode === 'movie' || mode === 'pc_rental') ? mode
    : (mode === 'premium' || is_premium) ? 'premium' : 'regular';

  // Coinslot purpose (wifi/pc/both) is enforced per-vendo, not here -
  // this request only carries whichever mac the coin credit should go
  // to (the customer's phone for wifi, the rental PC's own mac for
  // pc_rental), never the actual coin acceptor's mac, so there's no
  // device to look a purpose up against at this point. The real gate is
  // in POST / below, where the ESP32's own deviceMac genuinely
  // identifies which physical vendo is about to receive the coin.

  if (resolvedMode === 'movie') {
    const movieId = parseInt(movie_id, 10);
    const movie = require('../services/movieService').getMovie(movieId);
    if (!movie || movie.tier !== 'premium') {
      return res.status(400).json({ success: false, message: 'Not a rentable movie' });
    }
  }
  if (resolvedMode === 'pc_rental') {
    // mac IS the rental PC's own registered MAC here, not a customer's
    // phone - already validated as a well-formed MAC above; just confirm
    // it's actually a known, adopted rental PC.
    const pc = db.prepare("SELECT status FROM rental_pcs WHERE mac_address = ?").get(mac.toLowerCase());
    if (!pc || pc.status !== 'adopted') {
      return res.status(400).json({ success: false, message: 'Not an adopted rental PC' });
    }
  }
  const normalizedMac = mac.toLowerCase();

  // Single physical coin acceptor: only one customer can actually be
  // dropping coins at a time. Without this, a second customer opening
  // Insert Coin while the first one's window was still live silently
  // overwrote pendingCoinMac out from under them, whatever coin the first
  // customer then inserted got attributed to the SECOND customer's MAC
  // instead, real money crediting the wrong person's session with no
  // error either side. Mirrors the busy-lock the direct-GPIO path
  // (coinslotGpio.js's registerWaitingClient) already has.
  const otherWindowActive = pendingCoinMac && pendingCoinMac !== normalizedMac &&
    (Date.now() - pendingSetAt < PENDING_TIMEOUT_MS);
  if (otherWindowActive) {
    return res.status(409).json({ success: false, status: 'busy', message: 'Coin slot is busy with another customer.' });
  }

  if (pendingFinalizeTimer) clearTimeout(pendingFinalizeTimer);
  pendingCoinMac = mac.toLowerCase();
  pendingSetAt = Date.now();
  pendingTotal = 0;
  pendingMovieId = resolvedMode === 'movie' ? parseInt(movie_id, 10) : null;
  pendingIp = '';
  pendingKioskId = null;
  pendingMode = resolvedMode;
  pendingFinalizeTimer = null;
  console.log(`⏳ Pending coin registered for ${pendingCoinMac} (${pendingMode})`);
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

    // Per-vendo coinslot purpose gate. deviceMac (captured above, before
    // the pendingCoinMac fallback overwrote `mac`) is genuinely this
    // physical coin acceptor's own mac, unlike `mac` itself which may now
    // be a customer's phone or a rental PC's mac - so this is the one
    // place in the coin flow where "which vendo is this?" can actually be
    // answered. A vendo not yet paired/adopted (not found) defaults to
    // 'wifi', same fallback used everywhere else, so existing installs
    // are unaffected until an operator opts a specific vendo into PC
    // Rental via Devices > (device) > Coinslot Purpose.
    if (deviceMac && isValidMac(deviceMac)) {
      const vendo = db.prepare('SELECT coinslot_purpose FROM vendos WHERE mac_address = ?').get(String(deviceMac).toLowerCase());
      const coinslotPurpose = vendo?.coinslot_purpose || 'wifi';
      const isPcRentalUse = pendingValid && pendingMode === 'pc_rental';
      if (isPcRentalUse && coinslotPurpose === 'wifi') {
        return res.status(400).json({ success: false, message: 'This coin slot is set to WiFi only.' });
      }
      if (!isPcRentalUse && coinslotPurpose === 'pc') {
        return res.status(400).json({ success: false, message: 'This coin slot is set to PC Rental only.' });
      }
    }

    // Raw receipt proof, logged before spam-blocking/pending-accumulation
    // decide what happens to this pulse - see CREATE TABLE coin_pulse_log
    // in database.js. Best-effort, must never block a real coin credit.
    try {
      db.prepare(
        'INSERT INTO coin_pulse_log (mac_address, coin_value, kiosk_id) VALUES (?, ?, ?)'
      ).run(mac, coin_value, kioskId ?? null);
    } catch (e) {}

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