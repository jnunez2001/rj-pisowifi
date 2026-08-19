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
// `isPremium` - which button the customer tapped (portal.js's gold
// PREMIUM button vs the normal INSERT COIN one). Premium rates share the
// exact same coin_value as their regular counterpart (₱10 Normal and ₱10
// Premium both exist), so the coin's own denomination can no longer tell
// them apart on its own - this filters to ONLY Premium or ONLY regular
// rates before matching, so a customer who tapped Premium always gets
// the Premium tier for whatever they insert, never silently falls back
// to the regular one sharing that price.
async function creditCoinValue(mac, coinValue, ip = '', kioskId = null, isPremium = false) {
  const { getRates } = require('./voucherService');
  const { creditOrCreateSession } = require('./sessionService');

  const allRates = getRates()
    .filter((r) => !!r.download_mbps === isPremium)
    .sort((a, b) => b.coin_value - a.coin_value);

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

  // Premium rates carry a bandwidth override (high speed, less time),
  // tracked separately from totalMinutes (sessionService.js's
  // premium_expires_at, not the regular minutes_remaining countdown) so
  // it actually expires instead of sticking around on later plain
  // top-ups. Coin-matching is greedy across multiple tiers, so in
  // principle a mixed insert could match more than one premium tier at
  // once - their minutes stack (that's genuinely how much premium time
  // was paid for), but the higher of any two different speeds wins
  // rather than whichever was encountered last.
  let bandwidthOverride = null;
  let premiumMinutes = 0;
  for (const { rate, times } of matchedRates) {
    if (!rate.download_mbps) continue;
    premiumMinutes += rate.minutes * times;
    if (!bandwidthOverride || rate.download_mbps > bandwidthOverride.download_mbps) {
      bandwidthOverride = { download_mbps: rate.download_mbps, upload_mbps: rate.upload_mbps };
    }
  }
  if (bandwidthOverride) bandwidthOverride.minutes = premiumMinutes;

  // Data-plan cap (Plans > Data type, synced onto its linked rate by
  // admin.js's syncPlanCoinVendoRate). Takes the first matched tier that
  // actually has one - a mixed insert crossing multiple Data tiers is an
  // edge case not worth a combining rule for, unlike bandwidthOverride's
  // "higher speed wins" (there's no equally obvious rule for combining two
  // different data caps).
  let dataLimitMb = null;
  for (const { rate } of matchedRates) {
    if (rate.data_limit_mb) { dataLimitMb = rate.data_limit_mb; break; }
  }

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
  const { session, created } = await creditOrCreateSession(mac, ip || '', totalMinutes, totalExpirationMinutes, bandwidthOverride, dataLimitMb);

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
    matched_as: matchLog,
    premium: !!bandwidthOverride,
    premium_download_mbps: session.premium_download_mbps,
    premium_upload_mbps: session.premium_upload_mbps,
    premium_expires_at: session.premium_expires_at
  };

  return result;
}

module.exports = { creditCoinValue, NoMatchingRateError };
