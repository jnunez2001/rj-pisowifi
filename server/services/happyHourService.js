// ===== HAPPY HOUR SERVICE =====
// Scheduled multiplier ("2x time") promotion on Regular coin purchases -
// see docs/superpowers/specs/2026-09-06-happy-hour-design.md for the full
// design (why Premium/Boost are out of scope, why the clawback math looks
// the way it does in computeClawback() below).

const db = require('../config/database');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // matches Date#getDay() index order

function getSetting(key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

// Parses "HH:MM" into minutes-since-midnight. Returns null (never throws)
// on anything unparseable, so a corrupted setting fails safe (Happy Hour
// simply never activates) rather than crashing the coin-credit path.
function parseTimeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function getSettings() {
  const days = new Set(
    String(getSetting('happy_hour_days', ''))
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  return {
    enabled: getSetting('happy_hour_enabled', '0') === '1',
    days,
    start: getSetting('happy_hour_start', '14:00'),
    end: getSetting('happy_hour_end', '17:00'),
    multiplier: getMultiplier(),
    message: getSetting('happy_hour_message', 'Happy Hour has ended. Your remaining bonus time was converted to regular time.'),
  };
}

// Falls back to 1 (meaning "no bonus, purchase behaves exactly like a
// non-Happy-Hour purchase") on anything unparseable or <= 1 - a corrupted
// or misconfigured multiplier should never make Happy Hour REDUCE the
// time a customer gets, only ever add to it or do nothing.
function getMultiplier() {
  const raw = parseFloat(getSetting('happy_hour_multiplier', '2'));
  if (!Number.isFinite(raw) || raw <= 1) return 1;
  return raw;
}

// Does not currently support a window spanning midnight (e.g. start
// "22:00" end "02:00") - startMinutes > endMinutes is treated as a
// misconfiguration and always returns false. Documented in the admin UI
// (Task 8) rather than silently doing the wrong thing.
function isActive(now = new Date()) {
  const settings = getSettings();
  if (!settings.enabled) return false;

  const today = DAY_KEYS[now.getDay()];
  if (!settings.days.has(today)) return false;

  const startMinutes = parseTimeToMinutes(settings.start);
  const endMinutes = parseTimeToMinutes(settings.end);
  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) return false;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

// Pure function, no DB access - takes plain millisecond timestamps so it's
// trivially unit-testable and reusable by both the sweep (Task 6) and any
// future admin "simulate a conversion" tool. Returns null when there is
// nothing to convert (already expired, or no bonus currently outstanding).
function computeClawback({ nowMs, regularExpiresAtMs, expiresAtMs, multiplier }) {
  if (expiresAtMs <= regularExpiresAtMs) return null; // no bonus outstanding
  if (nowMs >= expiresAtMs) return null; // session already fully expired

  if (nowMs < regularExpiresAtMs) {
    // Customer hasn't touched their bonus at all yet - the whole bonus is outstanding.
    const bonus = expiresAtMs - regularExpiresAtMs;
    const keep = bonus / multiplier;
    return { newExpiresAtMs: Math.round(regularExpiresAtMs + keep) };
  }

  // Customer is currently inside their bonus time.
  const remainingBonus = expiresAtMs - nowMs;
  const keep = remainingBonus / multiplier;
  return { newExpiresAtMs: Math.round(nowMs + keep) };
}

module.exports = { isActive, getMultiplier, getSettings, computeClawback };
