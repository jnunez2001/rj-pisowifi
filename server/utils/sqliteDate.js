// SQLite's datetime()/CURRENT_TIMESTAMP always store UTC, as a naive
// "YYYY-MM-DD HH:MM:SS" string with no timezone marker. JS's Date
// constructor parses that space-separated (non-ISO) format as LOCAL time,
// not UTC - harmless on a server whose system timezone IS UTC (every value
// round-trips correctly by coincidence), but on any other timezone, every
// comparison against `new Date(sqliteString)` is off by exactly the box's
// UTC offset. A session's hard_expires_at could read as already-expired
// the instant it's created, well before its real deadline.
//
// Use this instead of `new Date(session.hard_expires_at)` (or any other
// SQLite datetime column) anywhere the box's timezone can't be guaranteed.
// Safe to call on values that are already ISO-formatted or Date instances -
// passes them through unchanged.
function parseSqliteDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) {
    return new Date(value.replace(' ', 'T') + 'Z');
  }
  return new Date(value);
}

module.exports = { parseSqliteDate };
