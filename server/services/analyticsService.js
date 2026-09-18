// Aggregations behind the Analytics page (Overview + Sales Report tabs).
// Every query filters on an inclusive calendar-date range in the box's
// local time (date(col,'localtime') BETWEEN from AND to), the same
// convention /sales already uses, so a "day" always matches the operator's
// own calendar day. Ranges come from server/utils/dateRange.js.
//
// Not included on purpose (no real data behind them in this app): data
// usage in GB, per-access-point traffic, historical WAN uptime. See the
// /analytics/summary route comment in server/routes/admin.js.

const { eachDate } = require('../utils/dateRange');

const LOCAL_TX_DATE = "date(created_at, 'localtime')";
const LOCAL_ENDED_DATE = "date(ended_at, 'localtime')";
const TX_LIMIT = 500;

const pctChange = (curr, prev) => {
  if (!prev) return curr ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
};

// With no compare range there is nothing to compare against: previousValue
// and changePercent are null rather than a fabricated 0.
const metric = (curr, prev, hasCompare) => ({
  value: curr || 0,
  previousValue: hasCompare ? (prev || 0) : null,
  changePercent: hasCompare ? pctChange(curr || 0, prev || 0) : null,
});

function periodStats(db, from, to) {
  const tx = db.prepare(`
    SELECT
      SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as revenue,
      COUNT(DISTINCT CASE WHEN mac_address IS NOT NULL THEN mac_address END) as users,
      COUNT(*) as transactions
    FROM transactions
    WHERE ${LOCAL_TX_DATE} BETWEEN ? AND ?
  `).get(from, to);

  const sess = db.prepare(`
    SELECT COUNT(*) as sessions, AVG(duration_seconds) as avg_duration
    FROM session_history WHERE ${LOCAL_ENDED_DATE} BETWEEN ? AND ?
  `).get(from, to);

  const revenue = tx.revenue || 0;
  const users = tx.users || 0;
  return {
    revenue,
    users,
    transactions: tx.transactions || 0,
    sessions: sess.sessions || 0,
    avgDurationSeconds: Math.round(sess.avg_duration || 0),
    avgRevenuePerUser: users > 0 ? Math.round((revenue / users) * 100) / 100 : 0,
  };
}

// One point per calendar day in the range, zero-filled, so a main range and
// a compare range line up index-for-index on the chart.
function dailySeries(db, from, to) {
  const rows = db.prepare(`
    SELECT ${LOCAL_TX_DATE} as date,
      SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as revenue,
      COUNT(*) as sessions
    FROM transactions
    WHERE ${LOCAL_TX_DATE} BETWEEN ? AND ?
    GROUP BY ${LOCAL_TX_DATE}
  `).all(from, to);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return eachDate(from, to).map((date) => ({
    date,
    revenue: byDate.get(date)?.revenue || 0,
    sessions: byDate.get(date)?.sessions || 0,
  }));
}

// Revenue and transaction count for each hour (0-23, box local time) of one
// calendar day, zero-filled. Used when the selected range is a single day, so
// the revenue chart shows when money came in instead of a single point.
function hourlySeries(db, date) {
  const rows = db.prepare(`
    SELECT CAST(strftime('%H', created_at, 'localtime') as INTEGER) as hour,
      SUM(CASE WHEN type != 'free' THEN coin_value ELSE 0 END) as revenue,
      COUNT(*) as transactions
    FROM transactions
    WHERE ${LOCAL_TX_DATE} = ?
    GROUP BY hour
  `).all(date);
  const byHour = new Map(rows.map((r) => [r.hour, r]));
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    revenue: byHour.get(hour)?.revenue || 0,
    transactions: byHour.get(hour)?.transactions || 0,
  }));
}

// Top-selling rates over the range: transactions grouped by price and
// minutes granted, ranked by revenue. Only time-selling types count (coin,
// voucher, promo). Free claims (no price) and movie rentals are not plans.
function bestSellingPlansFor(db, from, to, totalRevenue) {
  return db.prepare(`
    SELECT coin_value as price, minutes_added as minutes, COUNT(*) as count, SUM(coin_value) as revenue
    FROM transactions
    WHERE ${LOCAL_TX_DATE} BETWEEN ? AND ? AND type IN ('coin', 'voucher', 'promo') AND coin_value > 0
    GROUP BY coin_value, minutes_added
    ORDER BY revenue DESC, count DESC, price DESC
    LIMIT 5
  `).all(from, to).map((r) => ({
    price: r.price,
    minutes: r.minutes,
    count: r.count,
    revenue: r.revenue || 0,
    percent: totalRevenue > 0 ? Math.round(((r.revenue || 0) / totalRevenue) * 1000) / 10 : 0,
  }));
}

const MOVIE_TYPES = ['movie_rental', 'online_movie_rental', 'online_movie_rental_credit', 'tv_series_rental', 'tv_series_rental_credit'];

// Revenue per source over the range: the same categories the Dashboard has
// always shown (Main Kiosk vs Satellite Kiosks are coin transactions split
// on kiosk_id, plus Vouchers, Promos, Movies & TV, and Free claims, which
// carry a count but no revenue). Anything else that earns revenue (e.g.
// plan conversions) is reported as "Other" so the rows always add up to the
// real total instead of silently dropping money.
function revenueBySourceFor(db, from, to, totalRevenue) {
  const sum = (where) => db.prepare(`
    SELECT SUM(coin_value) as amount, COUNT(*) as count FROM transactions
    WHERE ${LOCAL_TX_DATE} BETWEEN ? AND ? AND ${where}
  `).get(from, to);
  const movieList = MOVIE_TYPES.map((t) => `'${t}'`).join(',');

  const rows = [
    { key: 'main_kiosk', label: 'Main Kiosk', ...sum("type = 'coin' AND kiosk_id IS NULL") },
    { key: 'satellite_kiosks', label: 'Satellite Kiosks', ...sum("type = 'coin' AND kiosk_id IS NOT NULL") },
    { key: 'voucher', label: 'Vouchers', ...sum("type = 'voucher'") },
    { key: 'promo', label: 'Promos', ...sum("type = 'promo'") },
    { key: 'movies', label: 'Movies & TV', ...sum(`type IN (${movieList})`) },
  ].map((r) => ({ key: r.key, label: r.label, amount: r.amount || 0, count: r.count || 0 }));

  const known = rows.reduce((a, r) => a + r.amount, 0);
  const other = Math.round((totalRevenue - known) * 100) / 100;
  if (other > 0) rows.push({ key: 'other', label: 'Other', amount: other, count: 0 });

  const free = sum("type = 'free'");
  rows.push({ key: 'free', label: 'Free Claims', amount: 0, count: free.count || 0 });

  const revenueBySource = rows.map((r) => ({
    ...r,
    percent: totalRevenue > 0 ? Math.round((r.amount / totalRevenue) * 1000) / 10 : 0,
  }));

  const kioskRevenue = db.prepare(`
    SELECT sk.name as name, SUM(t.coin_value) as amount, COUNT(*) as count
    FROM transactions t JOIN satellite_kiosks sk ON sk.id = t.kiosk_id
    WHERE date(t.created_at, 'localtime') BETWEEN ? AND ? AND t.type = 'coin'
    GROUP BY sk.id ORDER BY amount DESC
  `).all(from, to).map((r) => ({ name: r.name, amount: r.amount || 0, count: r.count || 0 }));

  return { revenueBySource, kioskRevenue };
}

function getAnalyticsSummary(db, range) {
  const { from, to, compare } = range;
  const hasCompare = !!compare;

  const cur = periodStats(db, from, to);
  const prev = hasCompare ? periodStats(db, compare.from, compare.to) : null;

  const revenueSeries = dailySeries(db, from, to);
  const compareSeries = hasCompare ? dailySeries(db, compare.from, compare.to) : null;

  // Single-day range: also return money-per-hour, and the compare day's
  // hours when the compare range is one day too (it always is for
  // "previous period"; a custom multi-day compare has no hour-for-hour match).
  const singleDay = from === to;
  const revenueByHour = singleDay ? hourlySeries(db, from) : null;
  const compareRevenueByHour = singleDay && hasCompare && compare.from === compare.to
    ? hourlySeries(db, compare.from)
    : null;

  const breakdownRows = db.prepare(`
    SELECT type, SUM(coin_value) as amount
    FROM transactions
    WHERE ${LOCAL_TX_DATE} BETWEEN ? AND ? AND type != 'free'
    GROUP BY type ORDER BY amount DESC
  `).all(from, to);
  const breakdownTotal = breakdownRows.reduce((sum, r) => sum + (r.amount || 0), 0);
  const typeLabels = { coin: 'Coin Sales', voucher: 'Voucher Sales', promo: 'Promo Redemptions' };
  const revenueBreakdown = breakdownRows.map((r) => ({
    type: r.type,
    label: typeLabels[r.type] || r.type,
    amount: r.amount || 0,
    percent: breakdownTotal > 0 ? Math.round(((r.amount || 0) / breakdownTotal) * 1000) / 10 : 0,
  }));

  const hourRows = db.prepare(`
    SELECT CAST(strftime('%H', started_at, 'localtime') as INTEGER) as hour, COUNT(*) as count
    FROM session_history
    WHERE started_at IS NOT NULL AND ${LOCAL_ENDED_DATE} BETWEEN ? AND ?
    GROUP BY hour
  `).all(from, to);
  const hourMap = new Map(hourRows.map((r) => [r.hour, r.count]));
  const sessionsByHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourMap.get(h) || 0 }));

  // Sessions by day of week (0 = Sunday ... 6 = Saturday), same session_history
  // rows and range as sessionsByHour.
  const weekdayRows = db.prepare(`
    SELECT CAST(strftime('%w', started_at, 'localtime') as INTEGER) as day, COUNT(*) as count
    FROM session_history
    WHERE started_at IS NOT NULL AND ${LOCAL_ENDED_DATE} BETWEEN ? AND ?
    GROUP BY day
  `).all(from, to);
  const weekdayMap = new Map(weekdayRows.map((r) => [r.day, r.count]));
  const sessionsByWeekday = Array.from({ length: 7 }, (_, d) => ({ day: d, count: weekdayMap.get(d) || 0 }));

  const { revenueBySource, kioskRevenue } = revenueBySourceFor(db, from, to, cur.revenue);
  const bestSellingPlans = bestSellingPlansFor(db, from, to, cur.revenue);

  // New vs returning: "new" = the transaction date is that MAC's first-ever
  // transaction date (across all history, not just this range).
  const firstSeenRows = db.prepare(`
    SELECT mac_address, MIN(${LOCAL_TX_DATE}) as first_date
    FROM transactions WHERE mac_address IS NOT NULL GROUP BY mac_address
  `).all();
  const firstSeenByMac = new Map(firstSeenRows.map((r) => [r.mac_address, r.first_date]));
  const periodMacRows = db.prepare(`
    SELECT mac_address, ${LOCAL_TX_DATE} as tx_date, COUNT(*) as tx_count
    FROM transactions
    WHERE mac_address IS NOT NULL AND ${LOCAL_TX_DATE} BETWEEN ? AND ?
    GROUP BY mac_address, tx_date
  `).all(from, to);
  const macTxCounts = new Map();
  let newSessions = 0;
  let returningSessions = 0;
  periodMacRows.forEach((r) => {
    const isNew = firstSeenByMac.get(r.mac_address) === r.tx_date;
    if (isNew) newSessions += r.tx_count; else returningSessions += r.tx_count;
    macTxCounts.set(r.mac_address, (macTxCounts.get(r.mac_address) || 0) + r.tx_count);
  });
  const repeatUsers = Array.from(macTxCounts.values()).filter((c) => c > 1).length;

  const topSpenders = db.prepare(`
    SELECT mac_address, SUM(coin_value) as total, COUNT(*) as transaction_count
    FROM transactions
    WHERE ${LOCAL_TX_DATE} BETWEEN ? AND ? AND mac_address IS NOT NULL AND mac_address != ''
    GROUP BY mac_address ORDER BY total DESC LIMIT 5
  `).all(from, to);
  const durations = db.prepare(`
    SELECT mac_address, AVG(duration_seconds) as avg_duration, COUNT(*) as session_count
    FROM session_history
    WHERE ${LOCAL_ENDED_DATE} BETWEEN ? AND ? AND mac_address IS NOT NULL
    GROUP BY mac_address
  `).all(from, to);
  const durationByMac = new Map(durations.map((r) => [r.mac_address, r]));
  const topUsers = topSpenders.map((s) => ({
    mac_address: s.mac_address,
    total: s.total,
    transaction_count: s.transaction_count,
    session_count: durationByMac.get(s.mac_address)?.session_count || 0,
    avg_duration_seconds: Math.round(durationByMac.get(s.mac_address)?.avg_duration || 0),
  }));

  const portalClicks = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM portal_events
    WHERE ${LOCAL_TX_DATE} BETWEEN ? AND ?
    GROUP BY event_type ORDER BY count DESC
  `).all(from, to);

  return {
    period: { from, to },
    compare: compare ? { from: compare.from, to: compare.to, mode: compare.mode } : null,
    kpi: {
      revenue: metric(cur.revenue, prev?.revenue, hasCompare),
      sessions: metric(cur.sessions, prev?.sessions, hasCompare),
      users: metric(cur.users, prev?.users, hasCompare),
      avgSessionDurationSeconds: metric(cur.avgDurationSeconds, prev?.avgDurationSeconds, hasCompare),
      avgRevenuePerUser: metric(cur.avgRevenuePerUser, prev?.avgRevenuePerUser, hasCompare),
    },
    revenueSeries,
    compareSeries,
    revenueByHour,
    compareRevenueByHour,
    revenueBreakdown,
    sessionsByHour,
    sessionsByWeekday,
    revenueBySource,
    kioskRevenue,
    bestSellingPlans,
    sessionAnalytics: {
      newSessions,
      returningSessions,
      avgSessionDurationSeconds: cur.avgDurationSeconds,
      repeatUsers,
    },
    topUsers,
    portalClicks,
  };
}

function salesTotals(db, from, to) {
  const paid = db.prepare(`
    SELECT SUM(coin_value) as revenue, COUNT(*) as transactions, SUM(minutes_added) as minutes
    FROM transactions WHERE ${LOCAL_TX_DATE} BETWEEN ? AND ? AND type != 'free'
  `).get(from, to);
  const free = db.prepare(`
    SELECT COUNT(*) as claims, SUM(minutes_added) as minutes
    FROM transactions WHERE ${LOCAL_TX_DATE} BETWEEN ? AND ? AND type = 'free'
  `).get(from, to);
  return {
    revenue: paid.revenue || 0,
    transactions: paid.transactions || 0,
    minutesSold: paid.minutes || 0,
    freeClaims: free.claims || 0,
    freeMinutes: free.minutes || 0,
  };
}

function getSalesReport(db, range) {
  const { from, to, compare } = range;
  const hasCompare = !!compare;

  const cur = salesTotals(db, from, to);
  const prev = hasCompare ? salesTotals(db, compare.from, compare.to) : null;

  // Zero-filled per-day revenue for the range (same series the Overview
  // chart uses), for the "Revenue by Day" chart and breakdown list.
  const daily = dailySeries(db, from, to).map((d) => ({ date: d.date, total: d.revenue, transactions: d.sessions }));

  const totalCount = db.prepare(`
    SELECT COUNT(*) as n FROM transactions WHERE ${LOCAL_TX_DATE} BETWEEN ? AND ?
  `).get(from, to).n;
  const transactions = db.prepare(`
    SELECT t.*, sk.name as kiosk_name
    FROM transactions t
    LEFT JOIN satellite_kiosks sk ON sk.id = t.kiosk_id
    WHERE date(t.created_at, 'localtime') BETWEEN ? AND ?
    ORDER BY t.created_at DESC LIMIT ${TX_LIMIT}
  `).all(from, to);

  return {
    period: { from, to },
    compare: compare ? { from: compare.from, to: compare.to, mode: compare.mode } : null,
    totals: {
      revenue: metric(cur.revenue, prev?.revenue, hasCompare),
      transactions: metric(cur.transactions, prev?.transactions, hasCompare),
      minutesSold: metric(cur.minutesSold, prev?.minutesSold, hasCompare),
      freeClaims: metric(cur.freeClaims, prev?.freeClaims, hasCompare),
      freeMinutes: cur.freeMinutes,
    },
    daily,
    transactions,
    transactionCount: totalCount,
    truncated: totalCount > transactions.length,
    transactionLimit: TX_LIMIT,
  };
}

module.exports = { getAnalyticsSummary, getSalesReport };
