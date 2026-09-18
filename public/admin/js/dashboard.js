// ===== DASHBOARD =====
// Reference-style layout: date range + compare in the header, a row of four
// KPI cards, a large revenue chart with revenue-by-source tiles, weekday
// activity, best-selling plans, hotspot status and recent transactions.
// Range figures come from GET /api/admin/analytics/summary (the same
// endpoint and range/compare logic as the Analytics page); today's sales,
// hotspot status and recent transactions are live, from /sales and friends.
// Real data only: nothing here is a placeholder or an invented target.

let dbRevenueChart = null;
let dbWeekdayChart = null;
let dbLast = null;
let dbRequestSeq = 0;
let dbKioskBreakdownOpen = false;

// The dashboard always opens on Today (compared with yesterday). Changing
// the range only lasts until you leave the page or hit refresh.
function dbDefaultState() {
  return { preset: 'today', from: '', to: '', compareOn: true, resolved: null };
}
const dbState = dbDefaultState();

const DB_ACCENT = '#2563eb';
const DB_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const HS_SOURCE_CONFIG = {
  main_kiosk: { color: '#0c8f6d' },
  satellite_kiosks: { color: '#1a9c63' },
  voucher: { color: '#8a6d3d' },
  promo: { color: '#3d6d94' },
  movies: { color: '#a6486b' },
  other: { color: '#64748b' },
  free: { color: '#9e9e9e' },
};

let hsKiosksCache = [];

async function loadDashboard() {
  Object.assign(dbState, dbDefaultState());
  dbSyncControls();
  await hsLoadKiosks();
  hsRenderOfflineKioskAlert();
  await Promise.all([
    dbLoadRange(),
    hsLoadTodayAndRecent(),
    hsLoadActiveSessionsCount(),
    hsLoadSystemStatus(),
  ]);
  // Must run LAST - hsRenderOfflineKioskAlert() above can set the offline
  // alert banner back to visible (display:flex) if stale kiosk records
  // exist, which would silently undo an earlier suppression. Applying the
  // venue-type hide/suppress after everything else guarantees nothing
  // later in this sequence can override it.
  hsApplyVenueTypeCards();

  // Tells app.js's post-login splash the dashboard's first real load is
  // done, so it can fade out instead of just guessing a fixed delay - a
  // slow box gets a splash that waits for it, a fast one doesn't sit on a
  // splash longer than it has to. Guarded since loadDashboard() also runs
  // on plain in-session navigation (Sidebar > Dashboard), not just right
  // after login, where no splash is showing.
  if (typeof dashboardReady === 'function') dashboardReady();
}

function destroyDashboard() {
  if (dbRevenueChart) { dbRevenueChart.destroy(); dbRevenueChart = null; }
  if (dbWeekdayChart) { dbWeekdayChart.destroy(); dbWeekdayChart = null; }
}

// ---------- date range + compare ----------

function dbFmtDate(iso, withYear) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', withYear
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' });
}

function dbRangeText(from, to) {
  return from === to ? dbFmtDate(from, true) : `${dbFmtDate(from, true)} to ${dbFmtDate(to, true)}`;
}

function dbEl(id) { return document.getElementById(id); }

// Peso amount with thousands separators, e.g. \u20B11,075.00
function dbPeso(n) {
  return '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dbShowError(msg) {
  const el = dbEl('dbRangeError');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function dbSyncControls() {
  if (!dbEl('dbPreset')) return;
  dbEl('dbPreset').value = dbState.preset;
  dbEl('dbFrom').value = dbState.from;
  dbEl('dbTo').value = dbState.to;
  dbEl('dbCompareOn').checked = dbState.compareOn;
  dbEl('dbCustomRange').style.display = dbState.preset === 'custom' ? 'inline-flex' : 'none';
}

function dbBuildQuery() {
  const p = new URLSearchParams();
  if (dbState.preset === 'custom') {
    if (!dbState.from || !dbState.to) return { error: 'Pick both a start and an end date.' };
    if (dbState.from > dbState.to) return { error: 'The start date must be on or before the end date.' };
    p.set('from', dbState.from);
    p.set('to', dbState.to);
  } else {
    p.set('preset', dbState.preset);
  }
  p.set('compare', dbState.compareOn ? 'previous' : 'none');
  return { query: p.toString() };
}

function dbOnPresetChange() {
  dbState.preset = dbEl('dbPreset').value;
  if (dbState.preset === 'custom' && !dbState.from && dbState.resolved) {
    dbState.from = dbState.resolved.from;
    dbState.to = dbState.resolved.to;
  }
  dbSyncControls();
  dbLoadRange();
}

function dbOnCustomChange() {
  dbState.from = dbEl('dbFrom').value;
  dbState.to = dbEl('dbTo').value;
  dbLoadRange();
}

function dbOnCompareChange() {
  dbState.compareOn = dbEl('dbCompareOn').checked;
  dbLoadRange();
}

async function dbLoadRange() {
  const built = dbBuildQuery();
  if (built.error) { dbShowError(built.error); return; }
  dbShowError('');

  const seq = ++dbRequestSeq;
  try {
    const data = await apiCall('GET', `/api/admin/analytics/summary?${built.query}`);
    if (seq !== dbRequestSeq) return; // a newer selection superseded this one
    if (!data.success) { dbShowError(data.message || 'Could not load the dashboard.'); return; }
    dbLast = data;

    dbState.resolved = { from: data.period.from, to: data.period.to };
    if (dbState.preset !== 'custom') {
      dbState.from = data.period.from;
      dbState.to = data.period.to;
      if (dbEl('dbFrom')) { dbEl('dbFrom').value = data.period.from; dbEl('dbTo').value = data.period.to; }
    }
    const label = dbEl('dbRangeLabel');
    if (label) {
      label.textContent = dbRangeText(data.period.from, data.period.to)
        + (data.compare ? `, compared to ${dbRangeText(data.compare.from, data.compare.to)}` : '');
    }

    dbRenderKpis(data);
    dbRenderRevenueChart(data);
    dbRenderSources(data);
    dbRenderActivity(data);
    dbRenderPlans(data.bestSellingPlans);
  } catch (e) {
    console.error('Dashboard load error:', e);
    if (seq === dbRequestSeq) dbShowError('Could not load the dashboard.');
  }
}

// ---------- KPI cards ----------

// Change vs the compare range as a small chip. Empty when compare is off.
function dbChipHtml(changePercent, compare) {
  if (!compare || changePercent === null || changePercent === undefined) return '';
  const label = compare.mode === 'previous' ? 'vs last period'
    : compare.mode === 'year' ? 'vs last year'
    : `vs ${dbRangeText(compare.from, compare.to)}`;
  if (changePercent === 0) return `<span class="db-chip flat">0%</span><span class="db-vs">${label}</span>`;
  const up = changePercent > 0;
  return `<span class="db-chip ${up ? 'up' : 'down'}">${Math.abs(changePercent)}%</span><span class="db-vs">${label}</span>`;
}

function dbFormatDuration(seconds) {
  if (!seconds) return '--';
  if (seconds < 60) return `${seconds} sec`;
  return hsFormatMins(Math.round(seconds / 60));
}

function dbRenderKpis(data) {
  const k = data.kpi;
  const c = data.compare;
  const peso = dbPeso;

  dbEl('dbKpiRevenue').textContent = peso(k.revenue.value);
  dbEl('dbKpiRevenueFoot').innerHTML = dbChipHtml(k.revenue.changePercent, c);
  dbEl('dbKpiSessions').textContent = k.sessions.value;
  dbEl('dbKpiSessionsFoot').innerHTML = dbChipHtml(k.sessions.changePercent, c);
  dbEl('dbKpiUsers').textContent = k.users.value;
  dbEl('dbKpiUsersFoot').innerHTML = dbChipHtml(k.users.changePercent, c);
  dbEl('dbKpiDuration').textContent = dbFormatDuration(k.avgSessionDurationSeconds.value);
  dbEl('dbKpiDurationFoot').innerHTML = dbChipHtml(k.avgSessionDurationSeconds.changePercent, c);

  // Repeat customers (devices that bought more than once in the range) and
  // new vs returning sessions, shown small under Users and Sessions.
  const users = k.users.value;
  const repeat = data.sessionAnalytics.repeatUsers;
  dbEl('dbKpiUsersSub').textContent = users > 0 ? `${Math.round((repeat / users) * 1000) / 10}% repeat customers` : '';
  const sa = data.sessionAnalytics;
  dbEl('dbKpiSessionsSub').textContent = (sa.newSessions + sa.returningSessions) > 0
    ? `${sa.newSessions} new, ${sa.returningSessions} returning` : '';

  dbEl('dbRevenueBig').textContent = peso(k.revenue.value);
  dbEl('dbRevenueFoot').innerHTML = dbChipHtml(k.revenue.changePercent, c);
}

// ---------- charts ----------

function dbChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    text: isDark ? '#a7b0bd' : '#64748b',
    grid: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)',
    idle: isDark ? 'rgba(255,255,255,0.14)' : '#e2e8f0',
  };
}

// Multi-day range: one point per day. Single-day range (Today, or a custom
// one-day range): one point per hour, so the chart shows when the money came
// in instead of a lone dot.
function dbRenderRevenueChart(data) {
  const canvas = dbEl('dbRevenueChart');
  if (!canvas) return;
  if (dbRevenueChart) { dbRevenueChart.destroy(); dbRevenueChart = null; }
  const colors = dbChartColors();

  const hourly = !!data.revenueByHour;
  const series = hourly ? data.revenueByHour : data.revenueSeries;
  const compareSeries = hourly ? data.compareRevenueByHour : data.compareSeries;
  const pointRadius = hourly ? 3 : (series.length > 45 ? 0 : 2);

  const labels = hourly ? series.map((h) => dbHourLabel(h.hour)) : series.map((s) => dbFmtDate(s.date, false));
  const titleFor = (i) => (hourly
    ? `${dbHourLabelLong(series[i].hour)}, ${dbFmtDate(data.period.from, true)}`
    : dbFmtDate(series[i].date, true));
  const compareDateFor = (i) => {
    if (!compareSeries || !compareSeries[i]) return null;
    return hourly ? dbFmtDate(data.compare.from, true) : dbFmtDate(compareSeries[i].date, true);
  };

  const datasets = [{
    label: 'This period',
    data: series.map((s) => s.revenue || 0),
    borderColor: DB_ACCENT,
    backgroundColor: 'rgba(37,99,235,0.08)',
    borderWidth: 2,
    pointRadius,
    pointHoverRadius: 4,
    tension: hourly ? 0.15 : 0.35,
    fill: true,
  }];
  if (compareSeries) {
    // Lined up point-for-point by position (day 1 against day 1, or hour
    // against the same hour of the compare day).
    datasets.push({
      label: 'Last period',
      data: series.map((_, i) => (compareSeries[i] ? compareSeries[i].revenue || 0 : null)),
      borderColor: '#94a3b8',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      tension: hourly ? 0.15 : 0.35,
      isCompare: true,
    });
  }

  dbRevenueChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? titleFor(items[0].dataIndex) : ''),
            label: (ctx) => {
              const base = `${ctx.dataset.label}: ${dbPeso(ctx.parsed.y)}`;
              const cd = ctx.dataset.isCompare ? compareDateFor(ctx.dataIndex) : null;
              return cd ? `${base} (${cd})` : base;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: colors.text, font: { size: 10 }, autoSkip: true, maxTicksLimit: hourly ? 8 : 8, maxRotation: 0 } },
        y: { grid: { color: colors.grid }, border: { display: false }, beginAtZero: true, ticks: { color: colors.text, font: { size: 10 }, maxTicksLimit: 5, callback: (v) => `\u20B1${v}` } },
      },
    },
  });
}

// "12a", "1a" ... "12p", "1p" ... for the hour-of-day chart.
function dbHourLabel(h) {
  return `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
}
function dbHourLabelLong(h) {
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}

// Most Day Active (sessions by day of week) for a multi-day range. When the
// range is a single day (Today, or a custom one-day range) a weekday
// breakdown is meaningless, so it becomes Most Time Active: sessions by hour.
function dbRenderActivity(data) {
  const canvas = dbEl('dbWeekdayChart');
  if (!canvas) return;
  if (dbWeekdayChart) { dbWeekdayChart.destroy(); dbWeekdayChart = null; }
  const colors = dbChartColors();

  const singleDay = data.period.from === data.period.to;
  const points = singleDay
    ? data.sessionsByHour.map((d) => ({ label: dbHourLabel(d.hour), long: dbHourLabelLong(d.hour), count: d.count }))
    : data.sessionsByWeekday.map((d) => ({ label: DB_WEEKDAYS[d.day], long: DB_WEEKDAYS[d.day], count: d.count }));

  dbEl('dbActivityTitle').textContent = singleDay ? 'Most Time Active' : 'Most Day Active';

  const counts = points.map((p) => p.count);
  const max = Math.max(...counts);
  const peakIdx = max > 0 ? counts.indexOf(max) : -1;

  const peak = dbEl('dbPeakDay');
  if (peak) peak.textContent = peakIdx >= 0 ? `Busiest: ${points[peakIdx].long} (${max})` : '';

  dbWeekdayChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: points.map((p) => p.label),
      datasets: [{
        data: counts,
        backgroundColor: counts.map((_, i) => (i === peakIdx ? DB_ACCENT : colors.idle)),
        borderRadius: singleDay ? 4 : 8,
        borderSkipped: false,
        maxBarThickness: singleDay ? 12 : 26,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? points[items[0].dataIndex].long : ''),
            label: (ctx) => `${ctx.parsed.y} session${ctx.parsed.y === 1 ? '' : 's'}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: colors.text, font: { size: singleDay ? 10 : 11 }, autoSkip: true, maxTicksLimit: singleDay ? 8 : 7, maxRotation: 0 } },
        y: { display: false, beginAtZero: true },
      },
    },
  });
}

// Plan length as people say it: "30 mins", "1 hr", "1.5 hrs", "2 days".
function dbPlanDuration(minutes) {
  const m = Math.round(minutes);
  const fmt = (n, unit) => {
    const t = Number.isInteger(n) ? n : Math.round(n * 10) / 10;
    return `${t} ${unit}${t === 1 ? '' : 's'}`;
  };
  if (m < 60) return fmt(m, 'min');
  if (m < 1440) return fmt(m / 60, 'hr');
  return fmt(m / 1440, 'day');
}

function dbRenderPlans(plans) {
  const el = dbEl('dbPlans');
  if (!el) return;
  if (!plans || plans.length === 0) {
    el.innerHTML = '<div class="db-empty">No plans sold in this range</div>';
    return;
  }
  const max = Math.max(...plans.map((p) => p.revenue));
  el.innerHTML = plans.map((p, i) => `
    <div class="db-plan">
      <div class="db-plan-rank">${i + 1}</div>
      <div class="db-plan-body">
        <div class="db-plan-top">
          <span class="db-plan-name">${dbPeso(p.price)} for ${dbPlanDuration(p.minutes)}</span>
          <span class="db-plan-revenue">${dbPeso(p.revenue)}</span>
        </div>
        <div class="db-plan-bar"><span style="width:${max > 0 ? Math.round((p.revenue / max) * 100) : 0}%;"></span></div>
        <div class="db-plan-meta">${p.count} sold, ${p.percent}% of revenue</div>
      </div>
    </div>`).join('');
}

// ---------- revenue by source ----------

function dbRenderSources(data) {
  const el = dbEl('dbSources');
  if (!el) return;
  const hasSatellite = hsKiosksCache.length > 0 || (data.kioskRevenue || []).length > 0;
  const rows = data.revenueBySource.filter((r) => r.key !== 'satellite_kiosks' || hasSatellite);

  el.innerHTML = rows.map((r) => {
    const color = (HS_SOURCE_CONFIG[r.key] || HS_SOURCE_CONFIG.other).color;
    const isFree = r.key === 'free';
    const value = isFree ? `${r.count} claim${r.count === 1 ? '' : 's'}` : dbPeso(r.amount);
    const meta = isFree ? '' : `<span>${r.amount > 0 ? r.percent + '%' : '--'}</span><span>${r.count} transaction${r.count === 1 ? '' : 's'}</span>`;
    const kioskLink = r.key === 'satellite_kiosks'
      ? `<a href="#" class="db-source-link" onclick="dbToggleKioskBreakdown(event)">${dbKioskBreakdownOpen ? 'Hide' : 'View by Kiosk'}</a>`
      : '';
    const bar = isFree ? '' : `<div class="db-source-bar"><span style="width:${Math.min(r.percent, 100)}%;background:${color};"></span></div>`;
    return `
      <div class="db-source">
        <div class="db-source-label">${r.label}${kioskLink}</div>
        <div class="db-source-value">${value}</div>
        <div class="db-source-meta">${meta}</div>
        ${bar}
      </div>`;
  }).join('');

  const bd = dbEl('dbKioskBreakdown');
  if (bd) {
    const list = data.kioskRevenue || [];
    bd.innerHTML = dbKioskBreakdownOpen && list.length
      ? `<div class="db-kiosk-list">${list.map((k) => `
          <div class="db-kiosk-row"><span>${hsEscapeHtml(k.name)}</span><span>${dbPeso(k.amount)} <span class="db-vs">(${k.count})</span></span></div>`).join('')}</div>`
      : '';
  }
}

function dbToggleKioskBreakdown(e) {
  e.preventDefault();
  dbKioskBreakdownOpen = !dbKioskBreakdownOpen;
  if (dbLast) dbRenderSources(dbLast);
}

// ---------- export ----------

function dbExportCsv() {
  if (!dbLast) return;
  const hasCompare = !!dbLast.compareSeries;
  const header = ['Date', 'Revenue', 'Transactions'];
  if (hasCompare) header.push('Compare Date', 'Compare Revenue', 'Compare Transactions');
  const rows = [header];
  dbLast.revenueSeries.forEach((s, i) => {
    const row = [s.date, s.revenue || 0, s.sessions || 0];
    if (hasCompare) {
      const c = dbLast.compareSeries[i];
      row.push(c ? c.date : '', c ? c.revenue || 0 : '', c ? c.sessions || 0 : '');
    }
    rows.push(row);
  });
  const csv = rows.map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `starkfi-dashboard-${dbLast.period.from}-to-${dbLast.period.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- live: today's numbers + recent transactions ----------

async function hsLoadTodayAndRecent() {
  try {
    const data = await apiCall('GET', '/api/admin/sales');
    if (!data.success) return;

    const t = data.today;
    dbEl('hsTodaySales').textContent = dbPeso(t.total_income);
    dbEl('hsMinutesSold').textContent = formatDurationShort(t.minutes_sold || 0);

    const totalTransactions = (t.coin_transactions || 0) + (t.voucher_transactions || 0) + (t.promo_transactions || 0) + (t.movie_transactions || 0) + (t.free_claims || 0);
    dbEl('hsAvgPerTransaction').textContent =
      totalTransactions > 0 ? dbPeso((t.total_income || 0) / totalTransactions) : dbPeso(0);

    const durationEl = dbEl('hsAvgSessionDuration');
    if (durationEl) {
      const durSec = t.avg_session_duration_seconds || 0;
      durationEl.textContent = (t.sessions_ended_today || 0) === 0 ? 'No data yet' : dbFormatDuration(durSec);
    }

    const tbody = dbEl('hsRecentTransactions');
    const transactions = data.recent_transactions || [];
    if (transactions.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">
            No transactions yet
          </td>
        </tr>`;
      return;
    }

    // Coin transactions show the specific kiosk name when one is known
    // (via the LEFT JOIN in /api/admin/sales) - "Main Kiosk" when it's a
    // coin credit with no kiosk_id, never a bare "Coin" that leaves the
    // source ambiguous once more than one kiosk exists.
    const sourceLabel = (tx) => {
      if (tx.type === 'voucher') return 'Voucher';
      if (tx.type === 'promo') return 'Promo';
      if (tx.type === 'free') return 'Free';
      return tx.kiosk_name ? hsEscapeHtml(tx.kiosk_name) : 'Main Kiosk';
    };
    tbody.innerHTML = transactions.slice(0, 10).map((tx) => `
      <tr>
        <td data-label="Session ID">
          <span style="font-family:monospace;font-size:13px;font-weight:700;">${hsEscapeHtml(tx.voucher_code)}</span>
        </td>
        <td data-label="Amount">\u20B1${tx.coin_value}</td>
        <td data-label="Time Added">${hsFormatMins(tx.minutes_added)}</td>
        <td data-label="Source">${sourceLabel(tx)}</td>
        <td data-label="Time" style="color:var(--text-muted);font-size:13px;">
          ${new Date(tx.created_at).toLocaleTimeString()}
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('Dashboard today/recent error:', e);
  }
}

// ---------- kept as-is from the previous dashboard ----------

function hsEscapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Overview tab per venue_type (network power / cafe+coworking parity,
// first slice - the coin slot is the one clearly Piso-WiFi-specific card
// on this page). Same "don't show a card with nothing behind it" rule
// already used elsewhere for venue_type (Main Kiosk Coin Slot hidden from
// Settings for Cafe/Co-working, since there's no coin acceptor to
// configure for those venue types) - a cafe or coworking space has no
// coin slot to show status for either.
function hsApplyVenueTypeCards() {
  const venueType = window.currentVenueType || 'piso_wifi';
  const isPisoWifi = venueType === 'piso_wifi';

  const coinSlotRow = document.getElementById('hsCoinSlotRow');
  if (coinSlotRow) coinSlotRow.style.display = isPisoWifi ? '' : 'none';

  // hsRenderOfflineKioskAlert() (called later in loadDashboard via
  // hsLoadKiosks) would otherwise show a permanently-offline kiosk
  // warning for coin-slot hardware that was never supposed to exist on a
  // cafe/coworking venue - suppress it the same way the row itself is
  // hidden, rather than leaving a confusing false alarm on the dashboard.
  if (!isPisoWifi) {
    const alertEl = document.getElementById('hsOfflineKioskAlert');
    if (alertEl) alertEl.style.display = 'none';
  }
}

async function hsLoadSystemStatus() {
  try {
    const sysinfo = await apiCall('GET', '/api/admin/sysinfo');
    if (sysinfo.success) {
      const wifiEl = document.getElementById('hsWifiApStatus');
      if (wifiEl) {
        const status = sysinfo.sysinfo.wifi_ap_status;
        wifiEl.className = `badge ${status === 'up' ? 'badge-green' : status === 'down' ? 'badge-red' : 'badge-orange'}`;
        wifiEl.innerHTML = `<span class="status-dot ${status === 'up' ? 'online' : ''}"></span>${
          status === 'up' ? 'Online' : status === 'down' ? 'Offline' : 'Unknown'
        }`;
        const wifiRow = document.getElementById('hsWifiApRow');
        if (wifiRow && sysinfo.sysinfo.wifi_ap_detail) wifiRow.title = sysinfo.sysinfo.wifi_ap_detail;
      }
      const coinRow = document.getElementById('hsCoinSlotRow');
      if (coinRow) coinRow.style.display = sysinfo.sysinfo.payment_methods === 'voucher' ? 'none' : 'flex';
    }
  } catch (e) {}

  try {
    const vendos = await apiCall('GET', '/api/admin/vendos');
    const coinEl = document.getElementById('hsCoinSlotStatus');
    if (coinEl) {
      if (vendos.success && vendos.vendos.length > 0) {
        const on = vendos.vendos.some(v => isOnline(v.last_seen));
        coinEl.className = `badge ${on ? 'badge-green' : 'badge-red'}`;
        coinEl.textContent = on ? 'Online' : 'Offline';
      } else {
        coinEl.className = 'badge badge-orange';
        coinEl.textContent = 'Unknown';
      }
    }
  } catch (e) {}
}

async function hsLoadActiveSessionsCount() {
  try {
    const data = await apiCall('GET', '/api/admin/sessions');
    if (data.success) {
      document.getElementById('hsActiveSessions').textContent = data.active_count ?? data.count ?? 0;
    }
  } catch (e) {}
}

async function hsLoadKiosks() {
  try {
    const data = await apiCall('GET', '/api/admin/satellite-kiosks');
    hsKiosksCache = data.success ? data.kiosks : [];
  } catch (e) {
    hsKiosksCache = [];
  }
}

// A kiosk that has never checked in at all (last_seen null) was just
// registered and hasn't been wired up yet - that's a setup step, not an
// alert-worthy outage. Only flag one that WAS seen before and has since
// gone quiet (matches satelliteKioskService.js's own isOnline() window).
function hsRenderOfflineKioskAlert() {
  const banner = document.getElementById('hsOfflineKioskAlert');
  if (!banner) return;
  const offline = hsKiosksCache.filter(k => k.last_seen && !k.online);
  if (offline.length === 0) {
    banner.style.display = 'none';
    return;
  }
  // Set via textContent below, not innerHTML - no HTML-escaping needed
  // (or wanted; escaping here would show literal "&amp;" instead of "&").
  const names = offline.map(k => k.name).join(', ');
  document.getElementById('hsOfflineKioskMessage').textContent = offline.length === 1
    ? `${offline[0].name} has gone offline. Check its power and WiFi connection.`
    : `${offline.length} Satellite Kiosks have gone offline: ${names}. Check their power and WiFi connections.`;
  banner.style.display = 'flex';
}

function hsFormatMins(mins) {
  if (mins >= 1440) return `${Math.round(mins / 1440)} days`;
  if (mins >= 60) return `${Math.round(mins / 60)} hrs`;
  return `${Math.round(mins)} mins`;
}

// Shared global used by other admin pages (users.js, analytics.js) - was
// defined in the old dashboard.js this file replaced, dropped by mistake
// during that swap since the Hotspot Dashboard content had its own
// hsFormatMins instead. Restored under its original name so those other
// pages don't need to change what they call.
function formatMins(mins) {
  if (mins >= 1440) return `${Math.round(mins / 1440)} days`;
  if (mins >= 60) return `${Math.round(mins / 60)} hrs`;
  return `${Math.round(mins)} mins`;
}
