let revenueChart = null;
let startTime = Date.now();
let currentChartRange = 'weekly';
let networkChart = null;
let networkStatsInterval = null;
let uptimeInterval = null;

async function loadDashboard() {
  // Bug: initChart() used to run AFTER loadSalesStats(), so on every fresh
  // dashboard load, updateChartData()'s `if (revenueChart && ...)` guard
  // was always false (the chart didn't exist yet) — the revenue chart
  // always rendered as a flat zero line until an admin happened to click
  // one of the Daily/Weekly/Monthly buttons, easy to mistake for "no sales".
  const dateEl = document.getElementById('dashboardToday');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  initChart();
  await loadSalesStats();
  await loadRecentTransactions();
  await loadDashActiveSessions();
  await loadActiveSessionsCount();
  await loadSystemVersion();
  await loadSystemStatus();
  await loadWanStatus();
  // Bandwidth Usage chart is always visible now (matches the current
  // dashboard layout) - the old "Comprehensive View" toggle that used to
  // gate it is gone from the page; setDashboardMode(true) still does the
  // real init/polling work, just unconditionally.
  setDashboardMode(true);
}

// Internet/WAN status card - real data from wanHealthService.js (ping-
// based score/latency/loss) and multiWanService.js (primary/backup lane
// status, only meaningful once a second WAN lane is actually configured).
// Mockup shows a Primary/Backup lane layout with per-lane Online badge,
// Download/Upload/Uptime/Latency grid - restyled to that shape using only
// real fields wanHealthService.js/multiWanService.js actually return.
// No literal ISP name ("Converge"/"PLDT") is fabricated - real
// `lane_name` (operator-set in Network > Ports and Roles) is used if
// present, otherwise a generic "Primary"/"Backup" label.
async function loadWanStatus() {
  const body = document.getElementById('wanStatusBody');
  if (!body) return;
  try {
    const [healthRes, multiRes] = await Promise.all([
      apiCall('GET', '/api/admin/network/wan-health'),
      apiCall('GET', '/api/admin/network/multi-wan'),
    ]);
    const lanes = [];
    if (healthRes.success) {
      const h = healthRes.health;
      const up = !(h.interface && h.interface.link_state && h.interface.link_state !== 'up' && h.interface.link_state !== 'unknown');
      const primaryName = (multiRes.success && multiRes.status && multiRes.status.primary && multiRes.status.primary.lane_name) || 'Primary';
      lanes.push({
        name: primaryName,
        online: up,
        download: null,
        upload: null,
        latency: h.avg_latency_ms != null ? `${h.avg_latency_ms} ms` : '--',
        loss: h.packet_loss_pct != null ? `${h.packet_loss_pct}%` : '--',
      });
    }
    if (multiRes.success && multiRes.status && multiRes.status.backup) {
      const s = multiRes.status;
      lanes.push({
        name: s.backup.lane_name || 'Backup',
        online: s.currently_active !== undefined,
        standby: s.currently_active && s.currently_active !== 'backup',
      });
    }
    if (lanes.length === 0) {
      body.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">WAN status unavailable</div>';
      return;
    }
    body.innerHTML = lanes.map(l => `
      <div class="zf2-wan-lane">
        <div class="zf2-wan-lane-head">
          <span>${l.name}</span>
          <span class="badge ${l.online ? 'badge-green' : 'badge-red'}"><span class="status-dot ${l.online ? 'online' : ''}"></span>${l.standby ? 'Standby' : l.online ? 'Online' : 'Offline'}</span>
        </div>
        ${l.latency !== undefined ? `
        <div class="zf2-wan-grid">
          <div><div class="zf2-wan-item-label">Latency</div><div class="zf2-wan-item-value">${l.latency}</div></div>
          <div><div class="zf2-wan-item-label">Packet Loss</div><div class="zf2-wan-item-value">${l.loss}</div></div>
        </div>` : ''}
      </div>
    `).join('');
  } catch (e) {
    body.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Could not load WAN status</div>';
  }
}

// Comprehensive vs clean dashboard (Dashboard's own toggle, top right) -
// off by default. Only gates the Network Traffic graph for now; existing
// cards (sales, system status, transactions) stay visible either way so
// this can't accidentally hide something an owner already relies on.
async function loadDashboardMode() {
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    const comprehensive = data.success && data.settings.dashboard_comprehensive === '1';
    const toggle = document.getElementById('dashboardComprehensiveToggle');
    if (toggle) toggle.checked = comprehensive;
    setDashboardMode(comprehensive);
  } catch (e) {}
}

function setDashboardMode(comprehensive) {
  const card = document.getElementById('networkTrafficCard');
  if (card) card.style.display = comprehensive ? 'block' : 'none';
  if (comprehensive) {
    initNetworkChart();
    if (!networkStatsInterval) {
      pollNetworkStats();
      networkStatsInterval = setInterval(pollNetworkStats, 4000);
    }
  } else {
    destroyDashboard();
  }
}

async function toggleDashboardMode() {
  const comprehensive = document.getElementById('dashboardComprehensiveToggle').checked;
  setDashboardMode(comprehensive);
  try {
    await apiCall('POST', '/api/admin/settings', { dashboard_comprehensive: comprehensive ? '1' : '0' });
  } catch (e) {}
}

function initNetworkChart() {
  const canvas = document.getElementById('networkChart');
  if (!canvas || networkChart) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#888' : '#999';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

  networkChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Download (Mbps)',
          data: [],
          borderColor: '#1a9c63',
          backgroundColor: 'rgba(26,156,99,0.08)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 0
        },
        {
          label: 'Upload (Mbps)',
          data: [],
          borderColor: '#3d6d94',
          backgroundColor: 'rgba(61,109,148,0.08)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { display: true, labels: { color: textColor, boxWidth: 12 } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor, maxTicksLimit: 6 } },
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor } }
      }
    }
  });
}

const NETWORK_CHART_MAX_POINTS = 20;

async function pollNetworkStats() {
  try {
    const data = await apiCall('GET', '/api/admin/network-stats');
    if (!data.success) return;
    document.getElementById('currentDownload').textContent = data.download_mbps;
    document.getElementById('currentUpload').textContent = data.upload_mbps;

    if (!networkChart) return;
    const label = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    networkChart.data.labels.push(label);
    networkChart.data.datasets[0].data.push(data.download_mbps);
    networkChart.data.datasets[1].data.push(data.upload_mbps);
    if (networkChart.data.labels.length > NETWORK_CHART_MAX_POINTS) {
      networkChart.data.labels.shift();
      networkChart.data.datasets[0].data.shift();
      networkChart.data.datasets[1].data.shift();
    }
    networkChart.update('none');
  } catch (e) {}
}

function destroyDashboard() {
  if (networkStatsInterval) {
    clearInterval(networkStatsInterval);
    networkStatsInterval = null;
  }
  if (uptimeInterval) {
    clearInterval(uptimeInterval);
    uptimeInterval = null;
  }
  if (networkChart) {
    networkChart.destroy();
    networkChart = null;
  }
}

// Bug: "Server Uptime" ran its own client-side timer starting from page
// load, so every browser refresh reset it to 00:00:00 — it never reflected
// how long the actual server process had been running. "WiFi AP" was
// hardcoded HTML that always said Online no matter what. "Coin Slot" had
// an id in the markup but nothing anywhere ever wrote to it — permanently
// stuck at "Unknown".
async function loadSystemStatus() {
  try {
    const sysinfo = await apiCall('GET', '/api/admin/sysinfo');
    if (sysinfo.success) {
      startUptimeCounter(sysinfo.sysinfo.uptime_seconds || 0);

      const wifiEl = document.getElementById('wifiApStatus');
      if (wifiEl) {
        const status = sysinfo.sysinfo.wifi_ap_status;
        wifiEl.className = `badge ${status === 'up' ? 'badge-green' : status === 'down' ? 'badge-red' : 'badge-orange'}`;
        wifiEl.innerHTML = `<span class="status-dot ${status === 'up' ? 'online' : ''}"></span>${
          status === 'up' ? 'Online' : status === 'down' ? 'Offline' : 'Unknown'
        }`;
        // Detail explains WHAT was actually checked (a router port's link
        // state in External Router mode vs this server's own NIC in
        // Standalone) - a bare Unknown/Offline badge alone doesn't tell an
        // admin whether that's even the right thing being measured.
        const wifiRow = document.getElementById('wifiApRow');
        if (wifiRow && sysinfo.sysinfo.wifi_ap_detail) wifiRow.title = sysinfo.sysinfo.wifi_ap_detail;
      }

      // Coin Slot row: hidden entirely in Voucher Only mode (Settings >
      // Portal Settings > Payment Methods) - a red "Offline" badge there
      // reads as a hardware fault when the coin slot was never expected to
      // be in use in the first place.
      const coinRow = document.getElementById('coinSlotRow');
      if (coinRow) coinRow.style.display = sysinfo.sysinfo.payment_methods === 'voucher' ? 'none' : 'flex';
    }
  } catch(e) {}

  try {
    const vendos = await apiCall('GET', '/api/admin/vendos');
    const coinEl = document.getElementById('coinSlotStatus');
    if (coinEl) {
      if (vendos.success && vendos.vendos.length > 0) {
        // Reuses the same online/offline window as the Devices page.
        const on = vendos.vendos.some(v => isOnline(v.last_seen));
        coinEl.className = `badge ${on ? 'badge-green' : 'badge-red'}`;
        coinEl.textContent = on ? 'Online' : 'Offline';
      } else {
        coinEl.className = 'badge badge-orange';
        coinEl.textContent = 'Unknown';
      }
    }
  } catch(e) {}
}

async function loadSystemVersion() {
  try {
    const data = await apiCall('GET', '/api/admin/version');
    if (data.success) {
      const el = document.getElementById('systemVersion');
      if (el) el.textContent = `v${data.version}`;
    }
  } catch(e) {}
}

async function loadSalesStats() {
  try {
    const data = await apiCall('GET', `/api/admin/sales?range=${currentChartRange}`);
    if (!data.success) return;

    document.getElementById('todaySales').textContent =
      `₱${(data.today.total_income || 0).toFixed(2)}`;
    document.getElementById('todayTransactions').textContent =
      data.today.transactions || 0;
    document.getElementById('minutesSold').textContent =
      `${Math.round(data.today.minutes_sold || 0)} mins`;

    // Weekly/monthly totals no longer have their own stat cards (dashboard
    // rebuild per the shared mockup - Today's Revenue/Active Sessions/
    // Today's Transactions/Minutes Sold/Bandwidth Usage replaced the old
    // Today/Weekly/Monthly Sales row) - still computed here since
    // Revenue Analytics' chart range buttons below use the same
    // currentChartRange state, just no longer written to weeklySales/
    // monthlySales elements that don't exist in the page anymore.

    // Bug: the Daily/Weekly/Monthly buttons never changed what was charted
    // — every click re-rendered the same fixed 7-day view. data.chart is
    // now genuinely scoped to the selected range.
    if (revenueChart && data.chart) {
      updateChartData(data.chart, data.chart_format);
    }

  } catch(e) {
    console.error('Sales stats error:', e);
  }
}

async function loadActiveSessionsCount() {
  try {
    const data = await apiCall('GET', '/api/admin/sessions');
    if (data.success) {
      // Bug: this used to be `count` (all sessions, including paused —
      // internet blocked), but the card is labeled "Currently Connected".
      document.getElementById('activeSessions').textContent = data.active_count ?? data.count ?? 0;
    }
  } catch(e) {}
}

// Dashboard rebuild (mockup replica) - "Recent Activity" is now a
// timeline of colored-dot rows, not a table. #recentTransactions is a
// plain <div> in dashboard.html now, not a <tbody> - same real data
// (/api/admin/sales' recent_transactions), just restyled.
async function loadRecentTransactions() {
  try {
    const data = await apiCall('GET', '/api/admin/sales');
    if (!data.success) return;

    const container = document.getElementById('recentTransactions');
    if (!container) return;
    const transactions = data.recent_transactions || [];

    if (transactions.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No transactions yet</div>';
      return;
    }

    const dotColor = { coin: 'var(--accent-blue)', voucher: 'var(--accent-orange)', free: 'var(--accent-green)', promo: 'var(--accent-orange)' };
    const typeLabel = { coin: 'Coin Payment', voucher: 'Voucher Redeemed', free: 'Free Session', promo: 'Promo Redeemed' };

    container.innerHTML = transactions.slice(0, 6).map(t => `
      <div class="zf2-activity-row">
        <div class="zf2-activity-dot" style="background:${dotColor[t.type] || 'var(--text-muted)'};"></div>
        <div style="min-width:0;">
          <div class="zf2-activity-text">${typeLabel[t.type] || 'Session'} <span style="font-weight:400;color:var(--text-muted);">₱${t.coin_value}</span></div>
          <div class="zf2-activity-meta">${t.voucher_code} · ${formatMins(t.minutes_added)} · ${new Date(t.created_at).toLocaleTimeString()}</div>
        </div>
      </div>
    `).join('');

  } catch(e) {
    console.error('Transactions error:', e);
  }
}

// Active Sessions list (mockup's "Top Users" slot) - real top-5 by time
// remaining, not a data-usage total (this app doesn't track per-client
// cumulative usage yet, so that mockup metric isn't available - shows
// what IS real instead of a fabricated number in its place).
async function loadDashActiveSessions() {
  const container = document.getElementById('dashActiveSessions');
  if (!container) return;
  try {
    const data = await apiCall('GET', '/api/admin/sessions');
    if (!data.success) { container.innerHTML = ''; return; }
    const sessions = (data.sessions || []).filter(s => s.is_paused !== 1)
      .sort((a, b) => b.minutes_remaining - a.minutes_remaining)
      .slice(0, 5);
    if (sessions.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No active sessions</div>';
      return;
    }
    container.innerHTML = sessions.map(s => `
      <div class="zf2-list-row">
        <div class="zf2-list-left"><i class="fas fa-wifi" style="color:var(--accent-green);"></i> <span>${s.mac_address}</span></div>
        <span class="zf2-list-value">${s.minutes_remaining} min</span>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = '';
  }
}

function formatMins(mins) {
  if (mins >= 1440) return `${Math.round(mins/1440)} days`;
  if (mins >= 60) return `${Math.round(mins/60)} hrs`;
  return `${Math.round(mins)} mins`;
}

function startUptimeCounter(realUptimeSeconds) {
  // Seed startTime so it reflects the server's actual uptime, then keep
  // ticking locally every second for a live counter without re-polling.
  startTime = Date.now() - (realUptimeSeconds || 0) * 1000;
  updateUptime();
  if (uptimeInterval) clearInterval(uptimeInterval);
  uptimeInterval = setInterval(updateUptime, 1000);
}

function updateUptime() {
  const el = document.getElementById('uptime');
  if (!el) return;
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function initChart() {
  const canvas = document.getElementById('revenueChart');
  if (!canvas) return;

  if (revenueChart) {
    revenueChart.destroy();
    revenueChart = null;
  }

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#888' : '#999';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

  const ctx = canvas.getContext('2d');
  revenueChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      datasets: [{
        label: 'Revenue (₱)',
        data: [0, 0, 0, 0, 0, 0, 0],
        borderColor: '#1a9c63',
        backgroundColor: 'rgba(26,156,99,0.1)',
        borderWidth: 2.5,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#1a9c63',
        pointRadius: 4,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `₱${ctx.parsed.y.toFixed(2)}`
          }
        }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 12 } }
        },
        y: {
          grid: { color: gridColor },
          ticks: {
            color: textColor,
            font: { size: 12 },
            callback: val => `₱${val}`
          },
          beginAtZero: true
        }
      }
    }
  });
}

function updateChartData(chartData, format) {
  if (!revenueChart) return;

  // Bug: this always assumed date-string labels and always reversed, which
  // was only correct for the old fixed weekly view. The server now returns
  // chart data already in chronological order, and 'hour' labels (e.g.
  // "14:00" for the daily view) aren't Date-parseable strings.
  const labels = chartData.map(d =>
    format === 'hour' ? d.label : new Date(d.label).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' })
  );
  const values = chartData.map(d => d.total || 0);

  revenueChart.data.labels = labels;
  revenueChart.data.datasets[0].data = values;
  revenueChart.update();
}

function setChartRange(range) {
  ['Daily','Weekly','Monthly'].forEach(r => {
    const btn = document.getElementById(`btn${r}`);
    if (btn) btn.className = 'btn btn-sm btn-secondary';
  });
  const active = document.getElementById(`btn${range.charAt(0).toUpperCase() + range.slice(1)}`);
  if (active) active.className = 'btn btn-sm btn-primary';

  const subtitle = document.getElementById('chartRangeSubtitle');
  if (subtitle) {
    subtitle.textContent = range === 'daily' ? "Today's performance by hour"
      : range === 'monthly' ? 'Last 30 days performance'
      : 'Last 7 days performance';
  }

  // Bug: this used to just re-fetch and re-render the exact same fixed
  // weekly data regardless of which button was clicked.
  currentChartRange = range === 'daily' ? 'daily' : range === 'monthly' ? 'monthly' : 'weekly';
  loadSalesStats();
}