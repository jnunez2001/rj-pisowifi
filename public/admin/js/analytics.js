// ===== ANALYTICS PAGE =====
// Single aggregation call (GET /api/admin/analytics/summary?days=N),
// real data only. Two widgets from the original spec are NOT built here
// on purpose: Traffic Analytics (total GB down/up) and Top Access Points
// - this app has no per-session bandwidth-volume accounting and no
// access-point concept in Standalone/Router Mode, so there is nothing
// real to show. Rendering them as zero would look like a real
// measurement rather than "not tracked" - see the /analytics/summary
// route's own comment for the full reasoning.
let anRevenueSessionChart = null;
let anBreakdownChart = null;
let anHourChart = null;
let anLastData = null;

async function loadAnalytics() {
  const days = parseInt(document.getElementById('analyticsRangeSelect')?.value || '7', 10);
  try {
    const data = await apiCall('GET', `/api/admin/analytics/summary?days=${days}`);
    if (!data.success) return;
    anLastData = data;

    renderAnalyticsKpis(data.kpi);
    renderRevenueSessionChart(data.revenueSeries);
    renderBreakdownChart(data.revenueBreakdown);
    renderHourChart(data.sessionsByHour);
    renderSessionAnalytics(data.sessionAnalytics);
    renderTopUsers(data.topUsers);
    renderPortalClicks(data.portalClicks);
  } catch (e) {
    console.error('Analytics load error:', e);
  }
  loadNetworkSnapshot();
}

function destroyAnalytics() {
  if (anRevenueSessionChart) { anRevenueSessionChart.destroy(); anRevenueSessionChart = null; }
  if (anBreakdownChart) { anBreakdownChart.destroy(); anBreakdownChart = null; }
  if (anHourChart) { anHourChart.destroy(); anHourChart = null; }
}

function trendHtml(changePercent) {
  if (!changePercent) return 'vs previous period';
  const up = changePercent >= 0;
  return `<span class="${up ? 'up' : 'down'}"><i class="fas fa-arrow-${up ? 'up' : 'down'}"></i> ${Math.abs(changePercent)}%</span> vs previous period`;
}

function renderAnalyticsKpis(kpi) {
  document.getElementById('anRevenue').textContent = `₱${kpi.revenue.value.toFixed(2)}`;
  document.getElementById('anRevenueTrend').innerHTML = trendHtml(kpi.revenue.changePercent);

  document.getElementById('anSessions').textContent = kpi.sessions.value;
  document.getElementById('anSessionsTrend').innerHTML = trendHtml(kpi.sessions.changePercent);

  document.getElementById('anUsers').textContent = kpi.users.value;
  document.getElementById('anUsersTrend').innerHTML = trendHtml(kpi.users.changePercent);

  document.getElementById('anAvgDuration').textContent = formatMins(Math.round(kpi.avgSessionDurationSeconds.value / 60));
  document.getElementById('anAvgDurationTrend').innerHTML = trendHtml(kpi.avgSessionDurationSeconds.changePercent);

  document.getElementById('anRevenuePerUser').textContent = `₱${kpi.avgRevenuePerUser.value.toFixed(2)}`;
  document.getElementById('anRevenuePerUserTrend').innerHTML = trendHtml(kpi.avgRevenuePerUser.changePercent);
}

function renderRevenueSessionChart(series) {
  const canvas = document.getElementById('anRevenueSessionChart');
  if (!canvas) return;
  if (anRevenueSessionChart) { anRevenueSessionChart.destroy(); anRevenueSessionChart = null; }
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  const textColor = isDark ? '#a7b0bd' : '#64748b';
  anRevenueSessionChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: series.map((s) => s.date),
      datasets: [
        {
          label: 'Revenue (₱)',
          data: series.map((s) => s.revenue || 0),
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.08)',
          borderWidth: 2,
          pointRadius: 3,
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
          pointRadius: 3,
          tension: 0.3,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { color: textColor, boxWidth: 10, font: { size: 11 } } } },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 } } },
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
  const el = document.getElementById('anSessionAnalytics');
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
  const el = document.getElementById('anNetworkSnapshot');
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

function exportAnalyticsCsv() {
  if (!anLastData) return;
  const rows = [['Date', 'Revenue', 'Sessions']];
  anLastData.revenueSeries.forEach((s) => rows.push([s.date, s.revenue || 0, s.sessions || 0]));
  const csv = rows.map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `starkfi-analytics-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
