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

// Movie-credit balance (database.js's movie_credits table) - see the
// 'online_movie' branch of finalizePendingCoins() below and
// GET/POST /api/portal/credit/* in server/routes/portal.js, which is what
// actually lets a customer spend this back as WiFi time.
function addMovieCredit(mac, amountPesos) {
  if (amountPesos <= 0) return;
  db.prepare(`
    INSERT INTO movie_credits (mac_address, balance_pesos, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mac_address) DO UPDATE SET balance_pesos = balance_pesos + excluded.balance_pesos, updated_at = CURRENT_TIMESTAMP
  `).run(mac, amountPesos);
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
// Only set/used when pendingMode === 'online_movie' - the vidrock.ru TMDb
// id being unlocked (server/services/onlineMovieCatalog.js). Separate
// variable from pendingMovieId on purpose: online ids are TMDb ids, local
// ids are the `movies` table's own autoincrement ids, and the two spaces
// can overlap by coincidence, so they must never be conflated.
let pendingOnlineMovieId = null;
// Only set/used when pendingMode === 'pc_rental_create_account' - the
// desired username/hashed password for the new rental_members account
// this coin window is funding, captured at open time (POST /pending) so
// finalize doesn't need a second round trip once enough credit is in.
let pendingCreateUsername = null;
let pendingCreatePasswordHash = null;
const PENDING_TIMEOUT_MS = 40000; // must match/slightly exceed portal's 30s coin timer

// Bug found live, real money lost: every pendingXxx variable above was
// PURELY in-memory - if the Node process restarted for ANY reason
// (a crash, a brownout-triggered reboot, even a routine `systemctl
// restart` during a deploy) while a customer had an open Insert Coin
// window, this state was silently wiped. A real coin landing right
// after found `pendingCoinMac` null and fell through to crediting
// `deviceMac` - the coin ACCEPTOR's own hardware mac, not the
// customer's - creating a real, "successful" session no customer's
// phone could ever see. The server logged nothing wrong; the customer
// got nothing; only a bad review surfaced it. Persisting this state to
// the settings table (mirroring the guarded-migration pattern already
// used elsewhere in this codebase for durable single-row state) and
// reconciling it at boot - exactly the same "don't trust in-memory
// state survived a restart" principle timerService.js's own
// restoreActiveSessions() already applies to sessions - closes this
// permanently. Every mutation site below calls savePendingState()
// immediately after changing these variables.
function savePendingState() {
  try {
    const state = {
      pendingCoinMac, pendingSetAt, pendingTotal, pendingIp, pendingKioskId,
      pendingMode, pendingMovieId, pendingOnlineMovieId,
      pendingCreateUsername, pendingCreatePasswordHash
    };
    db.prepare("INSERT INTO settings (key, value) VALUES ('coin_pending_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(state));
  } catch (e) {
    console.error('Failed to persist pending coin state:', e.message);
  }
}

// Called once at module load (server boot). Restores whatever window
// was open when the process last stopped, and reconciles it against
// real elapsed time exactly like a fresh request would - a window
// still within its timeout gets its finalize timer rescheduled for the
// REMAINING time; one that already expired while the server was down
// gets finalized immediately (crediting whatever real coins had
// already accumulated, same as if the timer had fired normally) rather
// than silently discarded.
function restorePendingStateAtBoot() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'coin_pending_state'").get();
    if (!row?.value) return;
    const state = JSON.parse(row.value);
    if (!state?.pendingCoinMac) return;

    pendingCoinMac = state.pendingCoinMac;
    pendingSetAt = state.pendingSetAt || 0;
    pendingTotal = state.pendingTotal || 0;
    pendingIp = state.pendingIp || '';
    pendingKioskId = state.pendingKioskId ?? null;
    pendingMode = state.pendingMode || 'regular';
    pendingMovieId = state.pendingMovieId ?? null;
    pendingOnlineMovieId = state.pendingOnlineMovieId ?? null;
    pendingCreateUsername = state.pendingCreateUsername ?? null;
    pendingCreatePasswordHash = state.pendingCreatePasswordHash ?? null;

    const elapsed = Date.now() - pendingSetAt;
    if (elapsed < PENDING_TIMEOUT_MS && pendingTotal > 0) {
      console.log(`🔄 Restored an in-flight coin window for ${pendingCoinMac} (₱${pendingTotal}) across a restart - rescheduling finalize for the remaining ${Math.round((PENDING_TIMEOUT_MS - elapsed) / 1000)}s`);
      pendingFinalizeTimer = setTimeout(() => finalizePendingCoins(pendingCoinMac), Math.max(0, PENDING_TIMEOUT_MS - elapsed));
    } else if (pendingTotal > 0) {
      console.log(`🔄 A coin window for ${pendingCoinMac} (₱${pendingTotal}) had already expired while the server was down - finalizing it now instead of losing it.`);
      finalizePendingCoins(pendingCoinMac).catch((e) => console.error('Boot-time finalize failed:', e.message));
    }
  } catch (e) {
    console.error('Failed to restore pending coin state at boot:', e.message);
  }
}
restorePendingStateAtBoot();

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
  const onlineMovieId = pendingOnlineMovieId;
  const createUsername = pendingCreateUsername;
  const createPasswordHash = pendingCreatePasswordHash;

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
  pendingOnlineMovieId = null;
  pendingCreateUsername = null;
  pendingCreatePasswordHash = null;
  if (pendingFinalizeTimer) clearTimeout(pendingFinalizeTimer);
  pendingFinalizeTimer = null;
  savePendingState();

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
  // PC rental self-serve account creation: same shared coin box, same
  // "full price or nothing" rule, but instead of crediting the PC's
  // guest session, the inserted total becomes the new account's
  // starting time balance (converted through the same rental_rates
  // coin_value -> minutes lookup a guest insert uses, not a separate
  // signup fee that's discarded) and the account is created here, once
  // the minimum is actually met. username/passwordHash were captured at
  // POST /pending open time (see pendingCreateUsername above).
  if (mode === 'pc_rental_create_account') {
    const pc = db.prepare('SELECT * FROM rental_pcs WHERE mac_address = ?').get(mac);
    if (!pc) {
      return { success: false, reason: 'pc_not_found' };
    }
    const minCredit = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'rental_create_account_min_credit'").get()?.value, 10) || 0;
    if (total < minCredit) {
      console.error(`⚠️ Create-account coin window for "${pc.name}" closed with ₱${total}, needed ₱${minCredit} - not created.`);
      return { success: false, reason: 'insufficient_amount', total, needed: minCredit };
    }
    const rate = db.prepare('SELECT minutes FROM rental_rates WHERE coin_value = ?').get(total);
    if (!rate) {
      console.error(`⚠️ Create-account coin window for "${pc.name}" closed with ₱${total}, no matching rate - not created.`);
      return { success: false, reason: 'no_matching_rate', total };
    }
    if (!createUsername || !createPasswordHash) {
      return { success: false, reason: 'server_error' };
    }
    // Username could have been taken by someone else in the time between
    // opening the window and finishing the insert - check again here,
    // same defensive re-check pattern as any create-under-contention flow.
    const taken = db.prepare('SELECT id FROM rental_members WHERE username = ?').get(createUsername);
    if (taken) {
      // Real money was already inserted for this - falling back to
      // crediting the PC's own guest session (same math the plain
      // 'pc_rental' branch below uses) rather than just failing and
      // losing it, since physical coins can't be refunded by software.
      const speedMsFallback = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'rental_speed_timer_secs'").get()?.value, 10) || 1000;
      const grantedMsFallback = rate.minutes * 60000 * (speedMsFallback / 1000);
      const existingSessionFallback = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(pc.id);
      const currentRemainingMsFallback = existingSessionFallback?.hard_expires_at
        ? Math.max(0, new Date(existingSessionFallback.hard_expires_at).getTime() - Date.now()) : 0;
      const newExpiresAtFallback = new Date(Date.now() + currentRemainingMsFallback + grantedMsFallback).toISOString();
      if (existingSessionFallback) {
        db.prepare('UPDATE rental_sessions SET minutes_remaining = ?, expires_at = ?, hard_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE pc_id = ?')
          .run(rate.minutes, newExpiresAtFallback, newExpiresAtFallback, pc.id);
      } else {
        db.prepare('INSERT INTO rental_sessions (pc_id, minutes_remaining, expires_at, hard_expires_at) VALUES (?, ?, ?, ?)')
          .run(pc.id, rate.minutes, newExpiresAtFallback, newExpiresAtFallback);
      }
      db.prepare("INSERT INTO rental_transactions (pc_id, coin_value, minutes_added, type) VALUES (?, ?, ?, 'coin')")
        .run(pc.id, total, rate.minutes);
      console.log(`⚠️ Create-account username "${createUsername}" taken - credited "${pc.name}" as guest time instead (₱${total}, ${rate.minutes} min)`);
      return { success: false, reason: 'username_taken', total, result: { pc_credited: true, pc_id: pc.id, minutes_added: rate.minutes } };
    }
    const seconds = rate.minutes * 60;
    db.prepare('INSERT INTO rental_members (username, password_hash, seconds) VALUES (?, ?, ?)')
      .run(createUsername, createPasswordHash, seconds);
    db.prepare("INSERT INTO rental_transactions (pc_id, coin_value, minutes_added, type) VALUES (?, ?, ?, 'coin')")
      .run(pc.id, total, rate.minutes);
    console.log(`✅ Rental account "${createUsername}" created from PC "${pc.name}": ₱${total} (${rate.minutes} min)`);
    return { success: true, result: { account_created: true, username: createUsername, seconds } };
  }
  if (mode === 'pc_rental') {
    const pc = db.prepare('SELECT * FROM rental_pcs WHERE mac_address = ?').get(mac);
    if (!pc) {
      return { success: false, reason: 'pc_not_found' };
    }
    const rate = db.prepare('SELECT minutes, points FROM rental_rates WHERE coin_value = ?').get(total);
    const minutes = rate ? rate.minutes : null;
    if (!minutes) {
      console.error(`⚠️ PC rental coin window for "${pc.name}" closed with ₱${total}, no matching rate - not credited.`);
      return { success: false, reason: 'no_matching_rate', total };
    }
    const existingSession = db.prepare('SELECT * FROM rental_sessions WHERE pc_id = ?').get(pc.id);
    const currentRemainingMs = existingSession?.hard_expires_at
      ? Math.max(0, new Date(existingSession.hard_expires_at).getTime() - Date.now()) : 0;
    // rental_speed_timer_secs applies to real, coin-purchased guest time
    // (this branch) same as it does to a logged-in member's live drain in
    // GET /status - but NOT to admin's manual Add Time button
    // (admin.js POST /rental/pcs/:id/addtime), where an admin typing "60
    // minutes" should get literally 60 real minutes, not a compressed
    // amount. 1000 = real-time, lower = the granted time expires sooner
    // in real wall-clock terms than its nominal minutes would suggest.
    const speedMs = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'rental_speed_timer_secs'").get()?.value, 10) || 1000;
    const grantedMs = minutes * 60000 * (speedMs / 1000);
    const newExpiresAt = new Date(Date.now() + currentRemainingMs + grantedMs).toISOString();

    if (existingSession) {
      db.prepare('UPDATE rental_sessions SET minutes_remaining = ?, expires_at = ?, hard_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE pc_id = ?')
        .run(minutes, newExpiresAt, newExpiresAt, pc.id);
    } else {
      db.prepare('INSERT INTO rental_sessions (pc_id, minutes_remaining, expires_at, hard_expires_at) VALUES (?, ?, ?, ?)')
        .run(pc.id, minutes, newExpiresAt, newExpiresAt);
    }
    db.prepare("INSERT INTO rental_transactions (pc_id, coin_value, minutes_added, type) VALUES (?, ?, ?, 'coin')")
      .run(pc.id, total, minutes);

    // Loyalty points, per-rate (rental_rates.points, set by the admin on
    // Timer Rates) - only awarded when a member is actually logged in on
    // this PC to receive them; a guest walk-in has no account to hold a
    // balance, same "earns nothing" behavior the rate's own points field
    // already implies when an admin sets it to 0 for a guest-facing tier.
    if (existingSession?.member_id && rate.points > 0) {
      db.prepare('UPDATE rental_members SET points = points + ? WHERE id = ?').run(rate.points, existingSession.member_id);
    }

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

  // Online movie rental (vidrock.ru embed catalog): against
  // onlineMovieCatalog + online_movie_rentals instead of movieService +
  // movie_rentals, so the two catalogs' id spaces never mix (see
  // database.js's online_movie_rentals comment). Unlike the local 'movie'
  // branch above, a short or long insert here is never just lost - the
  // difference is banked per-MAC in movie_credits (database.js), spendable
  // later as WiFi time via POST /api/portal/credit/use.
  if (mode === 'online_movie') {
    const onlineMovieCatalog = require('../services/onlineMovieCatalog');
    const movie = onlineMovieCatalog.getById(onlineMovieId);
    if (!movie) {
      return { success: false, reason: 'movie_not_found' };
    }

    // Owner request: Movie Credit should be usable for movies too, not just
    // WiFi time - applied automatically here rather than requiring a
    // separate "use credit" step, and always recalculated from the real,
    // current balance (never trusted from the client) so this can't be
    // spoofed or drift out of sync with a balance spent elsewhere in the
    // meantime. Capped at the price so a big balance can't go negative or
    // leak into "change" on a cheap title - only the amount actually
    // needed is deducted, the rest stays banked for next time.
    const creditRow = db.prepare('SELECT balance_pesos FROM movie_credits WHERE mac_address = ?').get(mac);
    const creditApplied = Math.min(creditRow?.balance_pesos || 0, movie.price_pesos);
    const amountNeeded = movie.price_pesos - creditApplied;

    if (total < amountNeeded) {
      addMovieCredit(mac, total);
      console.log(`⚠️ Online movie rental window for ${mac} closed with ₱${total}` + (creditApplied > 0 ? ` (+₱${creditApplied} credit not yet applied)` : '') + `, needed ₱${amountNeeded} more - not unlocked, ₱${total} credited to their balance instead.`);
      return { success: false, reason: 'insufficient_amount', total, needed: amountNeeded, credited_to_balance: total };
    }

    if (creditApplied > 0) {
      db.prepare('UPDATE movie_credits SET balance_pesos = balance_pesos - ?, updated_at = CURRENT_TIMESTAMP WHERE mac_address = ?').run(creditApplied, mac);
    }
    const changeCredited = total - amountNeeded;
    if (changeCredited > 0) addMovieCredit(mac, changeCredited);

    // 0 (the default) means "no per-movie override" - falls back to the
    // same global setting local rentals use. A positive value (Movies >
    // Online > Price Groups) overrides it for just this title.
    const rentalHours = movie.rental_hours > 0
      ? movie.rental_hours
      : parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'movie_rental_hours'").get()?.value || '48');
    const expiresAt = new Date(Date.now() + rentalHours * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO online_movie_rentals (movie_id, mac_address, expires_at) VALUES (?, ?, ?)').run(movie.id, mac, expiresAt);
    db.prepare(`
      INSERT INTO transactions (voucher_code, coin_value, minutes_added, type, mac_address)
      VALUES (?, ?, 0, 'online_movie_rental', ?)
    `).run(`ONLINE-MOVIE-${movie.id}`, movie.price_pesos, mac);
    console.log(`✅ Online movie rental unlocked for ${mac}: "${movie.title}" (₱${movie.price_pesos})` + (creditApplied > 0 ? `, ₱${creditApplied} from credit` : '') + (changeCredited > 0 ? ` + ₱${changeCredited} credited to their balance` : ''));
    require('../services/vendoAudioService').playVendoAmount(total).catch(() => {});
    return { success: true, result: { movie_unlocked: true, movie_id: movie.id, expires_at: expiresAt, credit_applied: creditApplied, change_credited: changeCredited } };
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
  const { mac, is_premium, mode, movie_id, online_movie_id, username, password } = req.body;
  if (!mac || !isValidMac(mac)) {
    return res.status(400).json({ success: false, message: 'Valid MAC address required' });
  }
  // mode is the current contract ('regular'|'premium'|'convert'|'movie'|
  // 'online_movie'|'pc_rental'|'pc_rental_create_account'); is_premium is
  // kept working for older portal.js builds still sending the plain
  // boolean, mapped onto the same 'premium' mode.
  const resolvedMode = (mode === 'convert' || mode === 'convert_down' || mode === 'movie' || mode === 'online_movie' || mode === 'pc_rental' || mode === 'pc_rental_create_account') ? mode
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
  if (resolvedMode === 'online_movie') {
    const onlineMovieCatalog = require('../services/onlineMovieCatalog');
    const movie = onlineMovieCatalog.getById(parseInt(online_movie_id, 10));
    if (!movie || movie.tier === 'free') {
      return res.status(400).json({ success: false, message: 'Not a rentable online movie' });
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
  let createUsername = null;
  let createPasswordHash = null;
  if (resolvedMode === 'pc_rental_create_account') {
    const pc = db.prepare("SELECT status FROM rental_pcs WHERE mac_address = ?").get(mac.toLowerCase());
    if (!pc || pc.status !== 'adopted') {
      return res.status(400).json({ success: false, message: 'Not an adopted rental PC' });
    }
    const enabled = db.prepare("SELECT value FROM settings WHERE key = 'rental_enable_create_account'").get()?.value !== '0';
    if (!enabled) {
      return res.status(400).json({ success: false, message: 'Account creation is disabled' });
    }
    createUsername = String(username || '').trim();
    if (!createUsername || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    if (db.prepare('SELECT id FROM rental_members WHERE username = ?').get(createUsername)) {
      return res.status(400).json({ success: false, message: 'That username is already taken' });
    }
    createPasswordHash = require('../utils/passwordHash').hashPassword(String(password));
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
  pendingOnlineMovieId = resolvedMode === 'online_movie' ? parseInt(online_movie_id, 10) : null;
  pendingCreateUsername = createUsername;
  pendingCreatePasswordHash = createPasswordHash;
  pendingIp = '';
  pendingKioskId = null;
  pendingMode = resolvedMode;
  pendingFinalizeTimer = null;
  savePendingState();
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
    if (outcome.reason === 'insufficient_amount') {
      return res.status(400).json({
        success: false,
        reason: outcome.reason,
        message: `Insert at least ₱${outcome.needed} to continue (₱${outcome.total} so far).`
      });
    }
    if (outcome.reason === 'username_taken') {
      return res.status(400).json({
        success: false,
        reason: outcome.reason,
        message: 'That username was just taken - your coins were credited as guest time instead. Try a different username next time.'
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
      savePendingState();
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
      const isPcRentalUse = pendingValid && (pendingMode === 'pc_rental' || pendingMode === 'pc_rental_create_account');
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
      savePendingState();
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
    //
    // Fail-safe alert: `mac` at this point is still `deviceMac` (nothing
    // overwrote it, since pendingValid was false the whole way through) -
    // the coin acceptor's OWN hardware mac, not a customer's. Crediting
    // it still happens below (dropping the coin on the floor with zero
    // record would be worse), but this is exactly the failure mode that
    // silently cost real customers real time with no diagnostic trail -
    // now it's impossible to miss in the Notifications feed instead of
    // finding out from a bad review.
    if (deviceMac && mac === String(deviceMac).toLowerCase()) {
      try {
        require('../services/alertEventService').logAlertEvent(
          'warning',
          'coin_credited_no_pending_match',
          `Coin credited with no customer match: ${mac}`,
          `₱${coin_value} was credited to the coin acceptor's own address (${mac}) because no customer's Insert Coin window was open when it arrived. No customer's phone will see this credit. This usually means the pending window was lost (e.g. a server restart mid-insertion) or a coin was dropped without a customer having opened Insert Coin first.`
        );
      } catch (e) {}
    }

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