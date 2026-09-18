// Tests for the Analytics date-range resolver and aggregation service.
// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Must be set before server/config/database.js is first required, so the
// tests never touch a real box's database.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starkfi-analytics-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { resolveDateRanges } = require('../server/utils/dateRange');
const db = require('../server/config/database');
const { getAnalyticsSummary, getSalesReport } = require('../server/services/analyticsService');

const TODAY = '2026-09-19';

test('presets resolve to inclusive calendar ranges', () => {
  assert.deepStrictEqual(resolveDateRanges({ preset: 'today', compare: 'none' }, TODAY), { from: TODAY, to: TODAY, compare: null });
  const l7 = resolveDateRanges({ preset: 'last7', compare: 'none' }, TODAY);
  assert.strictEqual(l7.from, '2026-09-13');
  assert.strictEqual(l7.to, TODAY);
  const tm = resolveDateRanges({ preset: 'this_month', compare: 'none' }, TODAY);
  assert.strictEqual(tm.from, '2026-09-01');
  const lm = resolveDateRanges({ preset: 'last_month', compare: 'none' }, TODAY);
  assert.deepStrictEqual([lm.from, lm.to], ['2026-08-01', '2026-08-31']);
  const jan = resolveDateRanges({ preset: 'last_month', compare: 'none' }, '2026-01-15');
  assert.deepStrictEqual([jan.from, jan.to], ['2025-12-01', '2025-12-31']);
});

test('previous period is the same length immediately before', () => {
  const r = resolveDateRanges({ from: '2026-09-10', to: '2026-09-16' }, TODAY);
  assert.deepStrictEqual(r.compare, { from: '2026-09-03', to: '2026-09-09', mode: 'previous' });
});

test('same period last year, with Feb 29 clamped', () => {
  const r = resolveDateRanges({ from: '2024-02-29', to: '2024-03-02', compare: 'year' }, TODAY);
  assert.deepStrictEqual(r.compare, { from: '2023-02-28', to: '2023-03-02', mode: 'year' });
});

test('custom compare and legacy days param', () => {
  const r = resolveDateRanges({ from: '2026-09-10', to: '2026-09-12', compare: 'custom', compare_from: '2026-01-01', compare_to: '2026-01-05' }, TODAY);
  assert.deepStrictEqual(r.compare, { from: '2026-01-01', to: '2026-01-05', mode: 'custom' });
  const legacy = resolveDateRanges({ days: '7' }, TODAY);
  assert.strictEqual(legacy.from, '2026-09-13');
  assert.strictEqual(legacy.compare.mode, 'previous');
});

test('invalid input returns an error', () => {
  for (const q of [
    { from: '2026-09-10' },
    { from: '2026-13-01', to: '2026-13-02' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-09-12', to: '2026-09-10' },
    { from: '2025-01-01', to: '2026-09-19' },
    { preset: 'nope' },
    { preset: 'last7', compare: 'weird' },
    { preset: 'last7', compare: 'custom' },
    { preset: 'last7', compare: 'custom', compare_from: '2026-02-01', compare_to: '2026-01-01' },
  ]) {
    assert.ok(resolveDateRanges(q, TODAY).error, `expected error for ${JSON.stringify(q)}`);
  }
});

// Timestamps are stored as UTC; the box's TZ decides the local day. Use
// midday UTC so the local date equals the UTC date for any zone within
// +/- 11 hours of UTC, keeping this test timezone-independent.
function tx(code, value, minutes, type, date, mac) {
  db.prepare('INSERT INTO transactions (voucher_code, coin_value, minutes_added, type, created_at, mac_address) VALUES (?,?,?,?,?,?)')
    .run(code, value, minutes, type, `${date} 12:00:00`, mac);
}

test('summary and sales report aggregate the selected range and compare range', () => {
  db.exec('DELETE FROM transactions; DELETE FROM session_history; DELETE FROM portal_events;');
  // Current range 2026-09-10..2026-09-12
  tx('A1', 5, 30, 'coin', '2026-09-10', 'aa:aa');
  tx('A2', 10, 60, 'coin', '2026-09-10', 'bb:bb');
  tx('A3', 20, 120, 'voucher', '2026-09-12', 'aa:aa');
  tx('A4', 0, 5, 'free', '2026-09-11', 'cc:cc');
  // Previous range 2026-09-07..2026-09-09
  tx('B1', 10, 60, 'coin', '2026-09-08', 'aa:aa');
  // Outside both
  tx('Z1', 99, 1, 'coin', '2026-08-01', 'dd:dd');
  db.prepare("INSERT INTO session_history (voucher_code, mac_address, started_at, ended_at, duration_seconds) VALUES ('A1','aa:aa','2026-09-10 10:00:00','2026-09-10 12:00:00',600)").run();
  db.prepare("INSERT INTO session_history (voucher_code, mac_address, started_at, ended_at, duration_seconds) VALUES ('A2','bb:bb','2026-09-10 10:00:00','2026-09-10 13:00:00',1200)").run();

  const range = resolveDateRanges({ from: '2026-09-10', to: '2026-09-12' }, TODAY);
  const s = getAnalyticsSummary(db, range);

  assert.strictEqual(s.kpi.revenue.value, 35);          // 5+10+20, free excluded
  assert.strictEqual(s.kpi.revenue.previousValue, 10);
  assert.strictEqual(s.kpi.revenue.changePercent, 250);
  assert.strictEqual(s.kpi.users.value, 3);              // aa, bb, cc
  assert.strictEqual(s.kpi.sessions.value, 2);
  assert.strictEqual(s.kpi.avgSessionDurationSeconds.value, 900);
  assert.strictEqual(s.revenueSeries.length, 3);          // zero-filled per day
  assert.deepStrictEqual(s.revenueSeries.map((d) => d.revenue), [15, 0, 20]);
  assert.deepStrictEqual(s.compareSeries.map((d) => d.date), ['2026-09-07', '2026-09-08', '2026-09-09']);
  assert.deepStrictEqual(s.compareSeries.map((d) => d.revenue), [0, 10, 0]);
  assert.deepStrictEqual(s.revenueBreakdown.map((b) => [b.type, b.amount]), [['voucher', 20], ['coin', 15]]);
  assert.strictEqual(s.sessionsByHour.length, 24);
  assert.strictEqual(s.period.from, '2026-09-10');

  const none = getAnalyticsSummary(db, resolveDateRanges({ from: '2026-09-10', to: '2026-09-12', compare: 'none' }, TODAY));
  assert.strictEqual(none.compare, null);
  assert.strictEqual(none.compareSeries, null);
  assert.strictEqual(none.kpi.revenue.previousValue, null);
  assert.strictEqual(none.kpi.revenue.changePercent, null);

  const r = getSalesReport(db, range);
  assert.strictEqual(r.totals.revenue.value, 35);
  assert.strictEqual(r.totals.transactions.value, 3);
  assert.strictEqual(r.totals.minutesSold.value, 210);
  assert.strictEqual(r.totals.freeClaims.value, 1);
  assert.strictEqual(r.totals.freeMinutes, 5);
  assert.strictEqual(r.transactionCount, 4);
  assert.strictEqual(r.transactions.length, 4);
  assert.strictEqual(r.truncated, false);
  assert.deepStrictEqual(r.daily.map((d) => d.total), [15, 0, 20]);
  assert.strictEqual(r.totals.revenue.previousValue, 10);
});

test('revenue by source splits kiosks, groups movies, reconciles the rest as Other', () => {
  db.exec('DELETE FROM transactions; DELETE FROM session_history; DELETE FROM satellite_kiosks;');
  const k = db.prepare("INSERT INTO satellite_kiosks (name, device_key) VALUES ('Lobby Kiosk', 'k1')").run().lastInsertRowid;
  const txk = (code, value, type, kioskId) => db.prepare(
    'INSERT INTO transactions (voucher_code, coin_value, minutes_added, type, created_at, mac_address, kiosk_id) VALUES (?,?,?,?,?,?,?)'
  ).run(code, value, 10, type, '2026-09-10 12:00:00', 'aa:aa', kioskId);
  txk('S1', 10, 'coin', null);        // main kiosk
  txk('S2', 20, 'coin', k);           // satellite
  txk('S3', 5, 'voucher', null);
  txk('S4', 7, 'promo', null);
  txk('S5', 30, 'movie_rental', null);
  txk('S6', 3, 'convert', null);      // not a named source -> Other
  txk('S7', 0, 'free', null);

  const s = getAnalyticsSummary(db, resolveDateRanges({ from: '2026-09-10', to: '2026-09-10', compare: 'none' }, TODAY));
  const by = Object.fromEntries(s.revenueBySource.map((r) => [r.key, r]));
  assert.strictEqual(s.kpi.revenue.value, 75);
  assert.deepStrictEqual([by.main_kiosk.amount, by.satellite_kiosks.amount, by.voucher.amount, by.promo.amount, by.movies.amount, by.other.amount], [10, 20, 5, 7, 30, 3]);
  assert.strictEqual(by.free.count, 1);
  assert.strictEqual(by.free.amount, 0);
  const sum = s.revenueBySource.reduce((a, r) => a + r.amount, 0);
  assert.strictEqual(sum, s.kpi.revenue.value, 'rows add up to the real total');
  assert.strictEqual(by.movies.percent, 40);
  assert.deepStrictEqual(s.kioskRevenue, [{ name: 'Lobby Kiosk', amount: 20, count: 1 }]);
});

test('sessions by weekday counts session_history by start day', () => {
  db.exec('DELETE FROM session_history;');
  const ins = db.prepare("INSERT INTO session_history (voucher_code, mac_address, started_at, ended_at, duration_seconds) VALUES (?,?,?,?,?)");
  ins.run('W1', 'aa:aa', '2026-09-10 12:00:00', '2026-09-10 13:00:00', 600); // Thursday
  ins.run('W2', 'aa:aa', '2026-09-10 12:30:00', '2026-09-10 13:30:00', 600); // Thursday
  ins.run('W3', 'bb:bb', '2026-09-12 12:00:00', '2026-09-12 13:00:00', 600); // Saturday
  const s = getAnalyticsSummary(db, resolveDateRanges({ from: '2026-09-10', to: '2026-09-12', compare: 'none' }, TODAY));
  assert.strictEqual(s.sessionsByWeekday.length, 7);
  const thu = new Date('2026-09-10T12:00:00Z').getUTCDay();
  const sat = new Date('2026-09-12T12:00:00Z').getUTCDay();
  assert.strictEqual(s.sessionsByWeekday[thu].count, 2);
  assert.strictEqual(s.sessionsByWeekday[sat].count, 1);
  assert.strictEqual(s.sessionsByWeekday.reduce((a, d) => a + d.count, 0), 3);
});

test('single-day range adds money-per-hour, with the compare day when it is one day too', () => {
  db.exec('DELETE FROM transactions;');
  const localHour = (ts) => db.prepare("SELECT CAST(strftime('%H', ?, 'localtime') as INTEGER) h").get(ts).h;
  const ins = (code, value, type, ts) => db.prepare(
    'INSERT INTO transactions (voucher_code, coin_value, minutes_added, type, created_at, mac_address) VALUES (?,?,?,?,?,?)'
  ).run(code, value, 10, type, ts, 'aa:aa');
  ins('H1', 5, 'coin', '2026-09-10 12:00:00');
  ins('H2', 10, 'coin', '2026-09-10 12:30:00');
  ins('H3', 20, 'voucher', '2026-09-10 15:00:00');
  ins('H4', 0, 'free', '2026-09-10 15:10:00');   // free: counted, no revenue
  ins('H5', 7, 'coin', '2026-09-09 12:00:00');   // the previous day

  const one = getAnalyticsSummary(db, resolveDateRanges({ from: '2026-09-10', to: '2026-09-10' }, TODAY));
  assert.strictEqual(one.revenueByHour.length, 24);
  const h1 = localHour('2026-09-10 12:00:00');
  const h2 = localHour('2026-09-10 15:00:00');
  assert.strictEqual(one.revenueByHour[h1].revenue, 15);
  assert.strictEqual(one.revenueByHour[h1].transactions, 2);
  assert.strictEqual(one.revenueByHour[h2].revenue, 20);
  assert.strictEqual(one.revenueByHour[h2].transactions, 2);
  assert.strictEqual(one.revenueByHour.reduce((a, h) => a + h.revenue, 0), one.kpi.revenue.value);
  assert.strictEqual(one.compareRevenueByHour.length, 24);
  assert.strictEqual(one.compareRevenueByHour[localHour('2026-09-09 12:00:00')].revenue, 7);

  const noCompare = getAnalyticsSummary(db, resolveDateRanges({ from: '2026-09-10', to: '2026-09-10', compare: 'none' }, TODAY));
  assert.strictEqual(noCompare.compareRevenueByHour, null);
  const wideCompare = getAnalyticsSummary(db, resolveDateRanges({ from: '2026-09-10', to: '2026-09-10', compare: 'custom', compare_from: '2026-09-01', compare_to: '2026-09-09' }, TODAY));
  assert.strictEqual(wideCompare.compareRevenueByHour, null);

  const many = getAnalyticsSummary(db, resolveDateRanges({ from: '2026-09-09', to: '2026-09-10' }, TODAY));
  assert.strictEqual(many.revenueByHour, null);
  assert.strictEqual(many.compareRevenueByHour, null);
});

test('best-selling plans rank price+minutes combos by revenue, time-selling types only', () => {
  db.exec('DELETE FROM transactions;');
  const ins = (code, value, minutes, type, date) => db.prepare(
    'INSERT INTO transactions (voucher_code, coin_value, minutes_added, type, created_at, mac_address) VALUES (?,?,?,?,?,?)'
  ).run(code, value, minutes, type, `${date} 12:00:00`, 'aa:aa');
  // P20/120min x3 = 60 revenue (one via voucher: same plan), P10/60min x4 = 40, P5/30min x2 = 10
  ins('P1', 20, 120, 'coin', '2026-09-10'); ins('P2', 20, 120, 'coin', '2026-09-10'); ins('P3', 20, 120, 'voucher', '2026-09-11');
  for (let i = 0; i < 4; i++) ins(`Q${i}`, 10, 60, 'coin', '2026-09-10');
  ins('R1', 5, 30, 'promo', '2026-09-10'); ins('R2', 5, 30, 'coin', '2026-09-12');
  ins('F1', 0, 5, 'free', '2026-09-10');                // free: never a plan
  ins('M1', 50, 0, 'movie_rental', '2026-09-10');       // movie: not a plan, but is revenue
  ins('O1', 5, 30, 'coin', '2026-09-01');               // outside the range

  const s = getAnalyticsSummary(db, resolveDateRanges({ from: '2026-09-10', to: '2026-09-12', compare: 'none' }, TODAY));
  assert.deepStrictEqual(s.bestSellingPlans.map((p) => [p.price, p.minutes, p.count, p.revenue]), [[20, 120, 3, 60], [10, 60, 4, 40], [5, 30, 2, 10]]);
  assert.strictEqual(s.kpi.revenue.value, 160);   // 60 + 40 + 10 + 50
  assert.strictEqual(s.bestSellingPlans[0].percent, 37.5);
  assert.strictEqual(s.bestSellingPlans.length <= 5, true);

  // at most five, most revenue first
  for (let i = 0; i < 8; i++) ins(`X${i}`, 100 + i, 10, 'coin', '2026-09-11');
  const many = getAnalyticsSummary(db, resolveDateRanges({ from: '2026-09-10', to: '2026-09-12', compare: 'none' }, TODAY));
  assert.strictEqual(many.bestSellingPlans.length, 5);
  assert.strictEqual(many.bestSellingPlans[0].price, 107);

  const none = getAnalyticsSummary(db, resolveDateRanges({ from: '2020-01-01', to: '2020-01-02', compare: 'none' }, TODAY));
  assert.deepStrictEqual(none.bestSellingPlans, []);
});

test('empty range yields zeros, not errors', () => {
  const s = getAnalyticsSummary(db, resolveDateRanges({ from: '2020-01-01', to: '2020-01-03' }, TODAY));
  assert.strictEqual(s.kpi.revenue.value, 0);
  assert.strictEqual(s.kpi.revenue.changePercent, 0);
  assert.strictEqual(s.topUsers.length, 0);
});

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
