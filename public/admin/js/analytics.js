// ===== ANALYTICS PAGE =====
// Two tabs (Overview, Sales Report) sharing one date range + compare
// selector. Overview: GET /api/admin/analytics/summary. Sales Report:
// GET /api/admin/analytics/sales-report (see sales.js). Range/compare
// params are resolved on the SERVER (presets included) so "today" and every
// day boundary match the box's own local calendar day, never the browser's.
// Real data only. Two widgets from the original spec are NOT built here on
// purpose: Traffic Analytics (total GB down/up) and Top Access Points -
// this app has no per-session bandwidth-volume accounting and no
// access-point concept in Standalone/Router Mode, so there is nothing real
// to show. Rendering them as zero would look like a real measurement rather
// than "not tracked" - see the /analytics/summary route's own comment.
let anRevenueSessionChart = null;
let anBreakdownChart = null;
let anHourChart = null;
let anLastData = null;

// Survives navigating away and back (this script is loaded once).
const anState = {
  tab: 'overview',
  preset: 'last7',
  from: '',
  to: '',
  compareOn: true,
  compareMode: 'previous',
  compareFrom: '',
  compareTo: '',
  resolved: null, // { from, to } as resolved by the server for the last good response
};
let anRequestSeq = 0;

function anEl(id) { return document.getElementById(id); }

function anFmtDate(iso, withYear) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', withYear
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' });
}

function anRangeText(from, to) {
  return from === to ? anFmtDate(from, true) : `${anFmtDate(from, true)} to ${anFmtDate(to, true)}`;
}

function anDaysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

// Builds the query string for the current selection, or returns an error
// string when a custom range is incomplete/invalid (nothing is requested).
function anBuildQuery() {
  const p = new URLSearchParams();
  if (anState.preset === 'custom') {
    if (!anState.from || !anState.to) return { error: 'Pick both a start and an end date.' };
    if (anState.from > anState.to) return { error: 'The start date must be on or before the end date.' };
    p.set('from', anState.from);
    p.set('to', anState.to);
  } else {
    p.set('preset', anState.preset);
  }
  if (!anState.compareOn) {
    p.set('compare', 'none');
  } else {
    p.set('compare', anState.compareMode);
    if (anState.compareMode === 'custom') {
      if (!anState.compareFrom || !anState.compareTo) return { error: 'Pick both compare dates.' };
      if (anState.compareFrom > anState.compareTo) return { error: 'The compare start date must be on or before the compare end date.' };
      p.set('compare_from', anState.compareFrom);
      p.set('compare_to', anState.compareTo);
    }
  }
  return { query: p.toString() };
}

function anShowError(msg) {
  const el = anEl('anRangeError');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

// Push state into the controls (the page HTML is re-created on every
// navigation, but anState persists).
function anSyncControls() {
  if (!anEl('anPreset')) return;
  anEl('anPreset').value = anState.preset;
  anEl('anFrom').value = anState.from;
  anEl('anTo').value = anState.to;
  anEl('anCompareOn').checked = anState.compareOn;
  anEl('anCompareMode').value = anState.compareMode;
  anEl('anCompareFrom').value = anState.compareFrom;
  anEl('anCompareTo').value = anState.compareTo;
  anToggleControlVisibility();
}

function anToggleControlVisibility() {
  const custom = anState.preset === 'custom';
  anEl('anCustomRange').style.display = custom ? '' : 'none';
  anEl('anCustomRangeTo').style.display = custom ? '' : 'none';
  anEl('anCompareMode').disabled = !anState.compareOn;
  const cc = anState.compareOn && anState.compareMode === 'custom';
  anEl('anCompareFromWrap').style.display = cc ? '' : 'none';
  anEl('anCompareToWrap').style.display = cc ? '' : 'none';
}

function anApplyTab() {
  const isSales = anState.tab === 'sales';
  if (anEl('anTabOverview')) anEl('anTabOverview').style.display = isSales ? 'none' : '';
  if (anEl('anTabSales')) anEl('anTabSales').style.display = isSales ? '' : 'none';
  if (anEl('anTabBtnOverview')) anEl('anTabBtnOverview').classList.toggle('active', !isSales);
  if (anEl('anTabBtnSales')) anEl('anTabBtnSales').classList.toggle('active', isSales);
}

function switchAnalyticsTab(tab) {
  anState.tab = tab === 'sales' ? 'sales' : 'overview';
  anApplyTab();
  loadAnalytics();
}

// After a successful response: remember what the server resolved, fill the
// custom date inputs with it (so switching to Custom starts from the range
// you were just looking at), and show the range label.
function anApplyResolved(period, compare) {
  anState.resolved = { from: period.from, to: period.to };
  if (anState.preset !== 'custom') {
    anState.from = period.from;
    anState.to = period.to;
    if (anEl('anFrom')) anEl('anFrom').value = period.from;
    if (anEl('anTo')) anEl('anTo').value = period.to;
  }
  if (compare && anState.compareMode !== 'custom') {
    anState.compareFrom = compare.from;
    anState.compareTo = compare.to;
    if (anEl('anCompareFrom')) anEl('anCompareFrom').value = compare.from;
    if (anEl('anCompareTo')) anEl('anCompareTo').value = compare.to;
  }
  const label = anEl('anRangeLabel');
  if (!label) return;
  let text = anRangeText(period.from, period.to);
  if (compare) {
    text += `, compared to ${anRangeText(compare.from, compare.to)}`;
    const n = anDaysBetween(period.from, period.to);
    const m = anDaysBetween(compare.from, compare.to);
    if (n !== m) text += ` (${n} days vs ${m} days)`;
  }
  label.textContent = text;
}

function onAnalyticsPresetChange() {
  anState.preset = anEl('anPreset').value;
  anToggleControlVisibility();
  if (anState.preset === 'custom') {
    if (!anState.from && anState.resolved) { anState.from = anState.resolved.from; anState.to = anState.resolved.to; }
    anEl('anFrom').value = anState.from;
    anEl('anTo').value = anState.to;
  }
  loadAnalytics();
}

function onAnalyticsCustomChange() {
  anState.from = anEl('anFrom').value;
  anState.to = anEl('anTo').value;
  loadAnalytics();
}

function onAnalyticsCompareChange() {
  anState.compareOn = anEl('anCompareOn').checked;
  anState.compareMode = anEl('anCompareMode').value;
  anState.compareFrom = anEl('anCompareFrom').value;
  anState.compareTo = anEl('anCompareTo').value;
  anToggleControlVisibility();
  loadAnalytics();
}

// Entry point (also the Refresh button and every range/compare change):
// loads whichever tab is showing.
async function loadAnalytics() {
  if (window.analyticsInitialTab) {
    anState.tab = window.analyticsInitialTab;
    window.analyticsInitialTab = null;
  }
  anSyncControls();
  anApplyTab();

  const built = anBuildQuery();
  if (built.error) { anShowError(built.error); return; }
  anShowError('');

  if (anState.tab === 'sales') {
    if (typeof loadSales === 'function') loadSales(built.query);
    return;
  }

  const seq = ++anRequestSeq;
  try {
    const data = await apiCall('GET', `/api/admin/analytics/summary?${built.query}`);
    if (seq !== anRequestSeq) return; // a newer selection superseded this one
    if (!data.success) { anShowError(data.message || 'Could not load analytics.'); return; }
    anLastData = data;
    anApplyResolved(data.period, data.compare);

    renderAnalyticsKpis(data.kpi, data.compare);
    renderRevenueSessionChart(data.revenueSeries, data.compareSeries);
    renderBreakdownChart(data.revenueBreakdown);
    renderHourChart(data.sessionsByHour);
    renderSessionAnalytics(data.sessionAnalytics);
    renderTopUsers(data.topUsers);
    renderPortalClicks(data.portalClicks);
  } catch (e) {
    console.error('Analytics load error:', e);
    if (seq === anRequestSeq) anShowError('Could not load analytics.');
  }
  loadNetworkSnapshot();
}

function destroyAnalytics() {
  if (anRevenueSessionChart) { anRevenueSessionChart.destroy(); anRevenueSessionChart = null; }
  if (anBreakdownChart) { anBreakdownChart.destroy(); anBreakdownChart = null; }
  if (anHourChart) { anHourChart.destroy(); anHourChart = null; }
  if (typeof destroySalesChart === 'function') destroySalesChart();
}

// Change vs the compare range, as plain text. Empty when compare is off.
function trendHtml(changePercent, compare) {
  if (!compare || changePercent === null || changePercent === undefined) return '';
  const label = `vs ${anRangeText(compare.from, compare.to)}`;
  if (changePercent === 0) return `0% ${label}`;
  const up = changePercent > 0;
  return `<span class="${up ? 'up' : 'down'}"><i class="fas fa-arrow-${up ? 'up' : 'down'}"></i> ${Math.abs(changePercent)}%</span> ${label}`;
}

function renderAnalyticsKpis(kpi, compare) {
  anEl('anRevenue').textContent = `\u20B1${kpi.revenue.value.toFixed(2)}`;
  anEl('anRevenueTrend').innerHTML = trendHtml(kpi.revenue.changePercent, compare);

  anEl('anSessions').textContent = kpi.sessions.value;
  anEl('anSessionsTrend').innerHTML = trendHtml(kpi.sessions.changePercent, compare);

  anEl('anUsers').textContent = kpi.users.value;
  anEl('anUsersTrend').innerHTML = trendHtml(kpi.users.changePercent, compare);

  anEl('anAvgDuration').textContent = formatMins(Math.round(kpi.avgSessionDurationSeconds.value / 60));
  anEl('anAvgDurationTrend').innerHTML = trendHtml(kpi.avgSessionDurationSeconds.changePercent, compare);

  anEl('anRevenuePerUser').textContent = `\u20B1${kpi.avgRevenuePerUser.value.toFixed(2)}`;
  anEl('anRevenuePerUserTrend').innerHTML = trendHtml(kpi.avgRevenuePerUser.changePercent, compare);
}

function renderRevenueSessionChart(series, compareSeries) {
  const canvas = anEl('anRevenueSessionChart');
  if (!canvas) return;
  if (anRevenueSessionChart) { anRevenueSessionChart.destroy(); anRevenueSessionChart = null; }
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  const textColor = isDark ? '#a7b0bd' : '#64748b';
  const pointRadius = series.length > 45 ? 0 : 3;

  const datasets = [
    {
      label: 'Revenue (\u20B1)',
      data: series.map((s) => s.revenue || 0),
      borderColor: '#2563eb',
      backgroundColor: 'rgba(37,99,235,0.08)',
      borderWidth: 2,
      pointRadius,
      tension: 0.3,
      fill: true,
      yAxisID: 'y',
    },
    {
      label: 'Sessions',
      data: series.map((s) => s.sessions || 0),
      borderColor: '#16a34a',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius,
      tension: 0.3,
      yAxisID: 'y1',
    },
  ];

  // Compare range, lined up day-for-day by position (day 1 against day 1).
  // If the compare range is shorter the tail is left empty; if longer the
  // extra days are not drawn (the range label already says "N days vs M").
  if (compareSeries) {
    const aligned = series.map((_, i) => compareSeries[i] || null);
    datasets.push({
      label: 'Revenue (compare)',
      data: aligned.map((c) => (c ? c.revenue || 0 : null)),
      borderColor: '#2563eb',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      tension: 0.3,
      yAxisID: 'y',
      _compareDates: aligned.map((c) => (c ? c.date : null)),
    });
    datasets.push({
      label: 'Sessions (compare)',
      data: aligned.map((c) => (c ? c.sessions || 0 : null)),
      borderColor: '#16a34a',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      tension: 0.3,
      yAxisID: 'y1',
      _compareDates: aligned.map((c) => (c ? c.date : null)),
    });
  }

  anRevenueSessionChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: series.map((s) => anFmtDate(s.date, false)), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { color: textColor, boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? anFmtDate(series[items[0].dataIndex].date, true) : ''),
            label: (ctx) => {
              const cd = ctx.dataset._compareDates && ctx.dataset._compareDates[ctx.dataIndex];
              const base = `${ctx.dataset.label}: ${ctx.formattedValue}`;
              return cd ? `${base} (${anFmtDate(cd, true)})` : base;
            },
          },
        },
      },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 }, autoSkip: true, maxTicksLimit: 12 } },
        y: { position: 'left', grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 } } },
        y1: { position: 'right', grid: { display: false }, ticks: { color: textColor, font: { size: 10 } } },
      },
    },
  });
}

function renderBreakdownChart(breakdown) {
  const canvas = document.getElementById('anBreakdownChart');
  const legend = document.getElementById('anBreakdownLegend');
  if (!canvas) return;
  if (anBreakdownChart) { anBreakdownChart.destroy(); anBreakdownChart = null; }
  if (!breakdown || breakdown.length === 0) {
    if (legend) legend.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:13px;padding:12px 0;">No revenue in this period</div>';
    return;
  }
  const colors = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#64748b'];
  anBreakdownChart = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: breakdown.map((b) => b.label),
      datasets: [{ data: breakdown.map((b) => b.amount), backgroundColor: colors, borderWidth: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { display: false } } },
  });
  if (legend) {
    legend.innerHTML = breakdown.map((b, i) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:12px;">
        <span style="display:flex;align-items:center;gap:8px;color:var(--text-primary);"><span style="width:8px;height:8px;border-radius:50%;background:${colors[i % colors.length]};display:inline-block;"></span>${b.label}</span>
        <span style="color:var(--text-secondary);">₱${b.amount.toFixed(2)} · ${b.percent}%</span>
      </div>
    `).join('');
  }
}

function renderHourChart(hours) {
  const canvas = document.getElementById('anHourChart');
  if (!canvas) return;
  if (anHourChart) { anHourChart.destroy(); anHourChart = null; }
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  const textColor = isDark ? '#a7b0bd' : '#64748b';
  anHourChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: hours.map((h) => `${h.hour}:00`),
      datasets: [{ data: hours.map((h) => h.count), backgroundColor: '#2563eb', borderRadius: 3, maxBarThickness: 14 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor, font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 } } },
      },
    },
  });
}

function renderSessionAnalytics(sa) {
  const el = anEl('anSessionAnalytics');
  if (!el) return;
  el.innerHTML = `
    <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-user-plus" style="color:var(--text-muted);width:14px;"></i> <span>New Sessions</span></div><span class="zf3-list-value">${sa.newSessions}</span></div>
    <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-rotate" style="color:var(--text-muted);width:14px;"></i> <span>Returning Sessions</span></div><span class="zf3-list-value">${sa.returningSessions}</span></div>
    <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-clock" style="color:var(--text-muted);width:14px;"></i> <span>Avg. Session Duration</span></div><span class="zf3-list-value">${formatMins(Math.round(sa.avgSessionDurationSeconds / 60))}</span></div>
    <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-user-group" style="color:var(--text-muted);width:14px;"></i> <span>Repeat Users</span></div><span class="zf3-list-value">${sa.repeatUsers}</span></div>
  `;
}

// Live snapshot, not a period trend (this app doesn't store WAN health
// samples over time yet) - reuses the same wan-health/multi-wan
// endpoints Dashboard's WAN Status card already calls.
async function loadNetworkSnapshot() {
  const el = anEl('anNetworkSnapshot');
  if (!el) return;
  try {
    const data = await apiCall('GET', '/api/admin/network/wan-health');
    if (!data.success) { el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Unavailable</div>'; return; }
    const h = data.health;
    const scoreColor = h.score >= 80 ? 'var(--accent-green)' : h.score >= 40 ? 'var(--accent-orange)' : 'var(--accent-red)';
    el.innerHTML = `
      <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-signal" style="color:var(--text-muted);width:14px;"></i> <span>Health Score</span></div><span class="zf3-list-value" style="color:${scoreColor};">${h.score}/100</span></div>
      <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-gauge" style="color:var(--text-muted);width:14px;"></i> <span>Latency</span></div><span class="zf3-list-value">${h.avg_latency_ms != null ? h.avg_latency_ms + ' ms' : '--'}</span></div>
      <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-triangle-exclamation" style="color:var(--text-muted);width:14px;"></i> <span>Packet Loss</span></div><span class="zf3-list-value">${h.packet_loss_pct != null ? h.packet_loss_pct + '%' : '--'}</span></div>
    `;
  } catch (e) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Unavailable</div>';
  }
}

function renderTopUsers(users) {
  const el = document.getElementById('anTopUsers');
  if (!el) return;
  if (!users || users.length === 0) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px 0;font-size:13px;">No activity in this period</div>';
    return;
  }
  const max = Math.max(...users.map((u) => u.total));
  el.innerHTML = users.map((u, i) => `
    <div class="zf3-list-row">
      <div class="zf3-list-left">
        <div class="zf3-rank">${i + 1}</div>
        <span style="font-family:monospace;">${u.mac_address}</span>
      </div>
      <div class="zf3-bar-track"><div class="zf3-bar-fill" style="width:${Math.round((u.total / max) * 100)}%;"></div></div>
      <span class="zf3-list-value">₱${u.total}</span>
    </div>
  `).join('');
}

const PORTAL_CLICK_LABELS = {
  insert_coin: 'Insert Coin',
  premium: 'Premium (Boost)',
  convert: 'Convert to Premium',
  movies: 'Movies',
  wifi_rates: 'WiFi Rates',
  vouchers: 'Vouchers',
  free_claim: 'Claim Free Minutes',
  report_problem: 'Report a Problem',
};

function renderPortalClicks(clicks) {
  const el = document.getElementById('anPortalClicks');
  if (!el) return;
  if (!clicks || clicks.length === 0) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px 0;font-size:13px;">No portal clicks recorded in this period yet</div>';
    return;
  }
  const max = Math.max(...clicks.map((c) => c.count));
  el.innerHTML = clicks.map((c, i) => `
    <div class="zf3-list-row">
      <div class="zf3-list-left">
        <div class="zf3-rank">${i + 1}</div>
        <span>${PORTAL_CLICK_LABELS[c.event_type] || c.event_type}</span>
      </div>
      <div class="zf3-bar-track"><div class="zf3-bar-fill" style="width:${Math.round((c.count / max) * 100)}%;"></div></div>
      <span class="zf3-list-value">${c.count}</span>
    </div>
  `).join('');
}

// Exports whatever tab is showing, for the selected range.
function exportAnalyticsCsv() {
  if (anState.tab === 'sales') {
    if (typeof exportTransactionsCsv === 'function') exportTransactionsCsv();
    return;
  }
  if (!anLastData) return;
  const hasCompare = !!anLastData.compareSeries;
  const header = ['Date', 'Revenue', 'Sessions'];
  if (hasCompare) header.push('Compare Date', 'Compare Revenue', 'Compare Sessions');
  const rows = [header];
  anLastData.revenueSeries.forEach((s, i) => {
    const row = [s.date, s.revenue || 0, s.sessions || 0];
    if (hasCompare) {
      const c = anLastData.compareSeries[i];
      row.push(c ? c.date : '', c ? c.revenue || 0 : '', c ? c.sessions || 0 : '');
    }
    rows.push(row);
  });
  const csv = rows.map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `starkfi-analytics-${anLastData.period.from}-to-${anLastData.period.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
