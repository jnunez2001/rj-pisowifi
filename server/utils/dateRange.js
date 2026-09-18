// Resolves the Analytics page's date-range query params into concrete
// inclusive [from, to] calendar dates (YYYY-MM-DD) plus an optional compare
// range. All arithmetic is on plain calendar dates in UTC purely as a
// calendar (no clock times involved), so it can never drift with the box's
// timezone. `today` is passed in by the caller, taken from SQLite's own
// date('now','localtime') so "today" matches how transactions are bucketed.

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 366;
const PRESETS = ['today', 'last7', 'last30', 'last90', 'this_month', 'last_month'];
const COMPARE_MODES = ['none', 'previous', 'year', 'custom'];

function isValidIsoDate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function spanDays(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

// Same calendar date one year earlier; Feb 29 clamps to Feb 28 instead of
// rolling into March.
function shiftBackOneYear(s) {
  const [y, m, day] = s.split('-').map(Number);
  const d = new Date(Date.UTC(y - 1, m - 1, day));
  if (d.getUTCMonth() !== m - 1) return new Date(Date.UTC(y - 1, m, 0)).toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function presetRange(preset, today) {
  const [y, m] = today.split('-').map(Number);
  switch (preset) {
    case 'today': return [today, today];
    case 'last7': return [addDays(today, -6), today];
    case 'last30': return [addDays(today, -29), today];
    case 'last90': return [addDays(today, -89), today];
    case 'this_month': return [`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`, today];
    case 'last_month': {
      const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
      const last = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
      return [first, last];
    }
    default: return null;
  }
}

// query: { preset | from,to | days, compare, compare_from, compare_to }
// Returns { from, to, compare: {from,to,mode} | null } or { error }.
function resolveDateRanges(query, today) {
  const q = query || {};
  let from;
  let to;

  if (q.from || q.to) {
    if (!isValidIsoDate(q.from) || !isValidIsoDate(q.to)) return { error: 'from and to must be valid YYYY-MM-DD dates' };
    from = q.from;
    to = q.to;
  } else if (q.preset) {
    const r = presetRange(String(q.preset), today);
    if (!r) return { error: `preset must be one of: ${PRESETS.join(', ')}` };
    [from, to] = r;
  } else {
    const parsedDays = parseInt(q.days, 10);
    const days = Math.min(Math.max(Number.isFinite(parsedDays) ? parsedDays : 7, 1), 90);
    from = addDays(today, -(days - 1));
    to = today;
  }

  if (from > to) return { error: 'from must be on or before to' };
  if (spanDays(from, to) > MAX_SPAN_DAYS) return { error: `range cannot be longer than ${MAX_SPAN_DAYS} days` };

  const mode = q.compare === undefined || q.compare === '' ? 'previous' : String(q.compare);
  if (!COMPARE_MODES.includes(mode)) return { error: `compare must be one of: ${COMPARE_MODES.join(', ')}` };

  let compare = null;
  if (mode === 'previous') {
    const len = spanDays(from, to);
    const cTo = addDays(from, -1);
    compare = { from: addDays(cTo, -(len - 1)), to: cTo, mode };
  } else if (mode === 'year') {
    compare = { from: shiftBackOneYear(from), to: shiftBackOneYear(to), mode };
  } else if (mode === 'custom') {
    if (!isValidIsoDate(q.compare_from) || !isValidIsoDate(q.compare_to)) return { error: 'compare_from and compare_to must be valid YYYY-MM-DD dates' };
    if (q.compare_from > q.compare_to) return { error: 'compare_from must be on or before compare_to' };
    if (spanDays(q.compare_from, q.compare_to) > MAX_SPAN_DAYS) return { error: `compare range cannot be longer than ${MAX_SPAN_DAYS} days` };
    compare = { from: q.compare_from, to: q.compare_to, mode };
  }

  return { from, to, compare };
}

// Every calendar date from..to inclusive.
function eachDate(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

module.exports = { resolveDateRanges, isValidIsoDate, addDays, spanDays, eachDate, shiftBackOneYear, PRESETS };
