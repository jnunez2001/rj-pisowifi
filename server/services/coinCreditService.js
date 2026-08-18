// ===== COIN CREDIT SERVICE =====
// The "smart coin matching + session credit" logic that used to live
// inline inside routes/coin.js's POST / handler, extracted so both the
// ESP32 HTTP-relay path (coin.js) and the direct-GPIO path
// (coinslotGpio.js, Workstream 4) share one crediting implementation
// instead of two copies that can drift out of sync.
//
// No behavior change from the original inline version in coin.js — same
// greedy largest-tier-first rate matching, same transaction/financial log
// shape, same result object shape.

const db = require('../config/database');
const { logFinancialEvent } = require('./financialLogService');

class NoMatchingRateError extends Error {
  constructor(coinValue) {
    super(`No rate matches coin value ${coinValue}`);
    this.name = 'NoMatchingRateError';
    this.coinValue = coinValue;
  }
}

// Credits `coinValue` pesos to `mac` (creating a session if none exists,
// otherwise topping up the existing one). Throws NoMatchingRateError if no
// configured rate tier can account for any part of the amount — callers
// decide how to handle that (coin.js records a spam attempt; direct-GPIO
// callers just log it, since their own debounce/burst filtering already
// guards against most bad input).
// `kioskId` is optional — null means "Main Kiosk or an unregistered
// Satellite Kiosk," both indistinguishable from generic Coins revenue
// until that specific relay device is paired (see satelliteKioskService.js).
async function creditCoinValue(mac, coinValue, ip = '', kioskId = null) {
  const { getRates } = require('./voucherService');
  const { creditOrCreateSession } = require('./sessionService');

  const allRates = getRates().sort((a, b) => b.coin_value - a.coin_value);

  let remaining = coinValue;
  const matchedRates = [];

  for (const rate of allRates) {
    if (remaining <= 0) break;
    if (rate.coin_value <= remaining) {
      const times = Math.floor(remaining / rate.coin_value);
      matchedRates.push({ rate, times });
      remaining -= rate.coin_value * times;
    }
  }

  if (matchedRates.length === 0 || remaining === coinValue) {
    throw new NoMatchingRateError(coinValue);
  }

  let totalMinutes = 0;
  let totalExpirationMinutes = 0;
  for (const { rate, times } of matchedRates) {
    totalMinutes += rate.minutes * times;
    totalExpirationMinutes += rate.expiration_minutes * times;
  }

  const matchLog = matchedRates
    .map(({ rate, times }) => `₱${rate.coin_value}x${times}`)
    .join(' + ');
  console.log(`💡 ₱${coinValue} matched as: ${matchLog} = ${totalMinutes} mins (mac: ${mac})`);

  // Bug found live: this used to do its own getSessionByMac() check then
  // pick createSession() or addTimeToSession() — a plain check-then-act
  // with an async gap (createSession() awaits allowClient() before
  // returning). A coin landing at nearly the same moment as a free-minutes
  // claim (server/routes/session.js) could see "no session yet" from both
  // requests and each create its own row for the same device: two rows in
  // the admin's connected-devices list, and whichever row the portal's
  // own lookup happened to resolve to silently orphaned the other,
  // stranding whatever coins landed in the row that lost the race.
  // creditOrCreateSession() serializes same-mac callers through an
  // in-memory lock so this check-then-act is atomic against every other
  // caller of it (and against free-claim, which locks on the same mac).
  const { session, created } = await creditOrCreateSession(mac, ip || '', totalMinutes, totalExpirationMinutes);

  db.prepare(`
    INSERT INTO transactions
    (voucher_code, coin_value, minutes_added, type, kiosk_id, mac_address)
    VALUES (?, ?, ?, 'coin', ?, ?)
  `).run(session.voucher_code, coinValue, totalMinutes, kioskId, mac);
  logFinancialEvent({ voucher_code: session.voucher_code, coin_value: coinValue, minutes_added: totalMinutes, type: 'coin', mac });

  console.log(created
    ? `🆕 New session: ${session.voucher_code} for ${mac}`
    : `💰 Added ${totalMinutes} mins to ${session.voucher_code}`);

  const result = {
    success: true,
    action: created ? 'session_created' : 'time_added',
    voucher_code: session.voucher_code,
    minutes_added: totalMinutes,
    minutes_remaining: session.minutes_remaining,
    expires_at: session.expires_at,
    hard_expires_at: session.hard_expires_at,
    matched_as: matchLog
  };

  return result;
}

module.exports = { creditCoinValue, NoMatchingRateError };
