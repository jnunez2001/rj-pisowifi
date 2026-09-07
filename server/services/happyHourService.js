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

// Tracks whether Happy Hour was active on the PREVIOUS call, so the real
// sweep only runs once, exactly on the active->inactive transition - never
// every tick while it stays inactive. Same in-memory edge-triggered
// pattern already used elsewhere in this codebase for similar
// once-per-transition detection - no restart-survival needed, this
// condition re-evaluates correctly on its own either way (a server
// restart mid-window just means the sweep runs on the next real
// transition it observes, same as if it had been running the whole time).
// Known accepted edge case, called out explicitly during final review: a
// bonus gap created just before a server restart, where the restart
// crosses into the NEXT day's Happy Hour window, gets deferred to that
// next window's close and converted using THAT day's multiplier, not the
// one the bonus was actually earned under - potentially days after
// purchase on a long-expiration rate. Left as-is intentionally (not a
// code fix): correctly detecting and converting mid-restart is more
// complexity than this edge case's real-world frequency justifies.
let wasActive = false;

async function runEndOfWindowSweep() {
  const db = require('../config/database');
  const nowActive = isActive();

  if (wasActive && !nowActive) {
    const multiplier = getMultiplier();
    const nowIso = new Date().toISOString();
    // Bug found in final review: a paused session's expires_at is a
    // frozen snapshot (see pauseSession()), not something advancing in
    // real time, so comparing it against a live nowMs below produced a
    // meaningless clawback figure - and resumeSession() would partly or
    // wholly discard that write anyway once it recomputes expires_at
    // from minutes_remaining on resume. Excluding paused sessions fixes
    // that: resumeSession() already preserves the exact regular/bonus
    // split through a pause (see its own fix), so a session paused when
    // the window closes keeps its frozen gap intact until it resumes.
    // Known accepted tradeoff (same class as the cross-day-restart note
    // below): because this sweep only ever fires once, on the
    // active->inactive transition, a session that stays paused across
    // that exact moment is never revisited by a later sweep - it keeps
    // its full outstanding bonus at the original multiplier for as long
    // as it stays paused (bounded by hard_expires_at and max_pauses).
    // Not fixed here; flagged for the operator/business-decision layer
    // rather than papered over with a guess at the "right" clawback
    // amount for a still-frozen session.
    const sessions = db.prepare(`
      SELECT voucher_code, mac_address, expires_at, regular_expires_at
      FROM sessions
      WHERE expires_at > regular_expires_at
        AND hard_expires_at > ?
        AND is_paused = 0
    `).all(nowIso);

    if (sessions.length > 0) {
      const nowMs = Date.now();
      const update = db.prepare('UPDATE sessions SET expires_at = ?, regular_expires_at = ? WHERE voucher_code = ?');
      const { logAlertEvent } = require('./alertEventService');
      const sseService = require('./sseService');

      // Bug found in final review: this counted every row the WHERE
      // clause matched, not every row actually converted -
      // computeClawback() can still return null here (the
      // "nowMs >= expiresAtMs" guard), and the operator-facing alert
      // was overstating how many sessions were touched by counting
      // those skipped rows too.
      let convertedCount = 0;
      for (const session of sessions) {
        const result = computeClawback({
          nowMs,
          regularExpiresAtMs: new Date(session.regular_expires_at).getTime(),
          expiresAtMs: new Date(session.expires_at).getTime(),
          multiplier,
        });
        if (!result) continue;
        const newExpiresAtIso = new Date(result.newExpiresAtMs).toISOString();
        update.run(newExpiresAtIso, newExpiresAtIso, session.voucher_code);
        sseService.notify(session.mac_address);
        convertedCount++;
      }

      if (convertedCount > 0) {
        logAlertEvent(
          'info',
          'happy_hour_ended',
          'Happy Hour ended',
          `Converted unused bonus time for ${convertedCount} session(s).`
        );
      }
    }
  }

  wasActive = nowActive;
}

module.exports = { isActive, getMultiplier, getSettings, computeClawback, runEndOfWindowSweep };
