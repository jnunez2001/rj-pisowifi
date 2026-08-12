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
  const rangeEl = document.getElementById('dashboardDateRange');
  if (rangeEl) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 6);
    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    rangeEl.textContent = `${fmt(start)} - ${fmt(end)}`;
  }
  initChart();
  await loadSalesStats();
  await loadRecentTransactions();
  await loadTopSpenders();
  await loadNetworkLanes();
  await loadNetworkDevicesSummary();
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

// "Top Spenders (Today)" - mockup's "Top Users (By Data Usage)" slot.
// This app doesn't track per-client cumulative data usage, so real
// today's revenue per client (from the same transactions table
// loadSalesStats() already reads) fills the same "ranked list of top
// customers" role honestly instead of a fabricated GB figure.
async function loadTopSpenders() {
  const el = document.getElementById('topSpenders');
  if (!el) return;
  try {
    const data = await apiCall('GET', '/api/admin/dashboard/top-spenders-today');
    if (!data.success || !data.spenders || data.spenders.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px 0;font-size:13px;">No spenders yet today</div>';
      return;
    }
    const max = Math.max(...data.spenders.map(s => s.total));
    el.innerHTML = data.spenders.map((s, i) => `
      <div class="zf3-list-row">
        <div class="zf3-list-left">
          <div class="zf3-rank">${i + 1}</div>
          <div class="zf3-avatar"><i class="fas fa-user"></i></div>
          <span style="font-family:monospace;">${s.mac_address}</span>
        </div>
        <div class="zf3-bar-track"><div class="zf3-bar-fill" style="width:${Math.round((s.total / max) * 100)}%;"></div></div>
        <span class="zf3-list-value">₱${s.total}</span>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = '';
  }
}

// "Network Lanes" - mockup's "Top Access Points" slot. This app has no
// access-point concept in Standalone/Router Mode (that's MikroTik
// Controller Mode's Wireless/AP page, itself not built yet - see
// comingSoon.js's 'mikrotik-wireless' entry) - real configured physical
// ports/lanes (Network > Ports and Roles) fill the same "list of network
// hardware with live status" role instead.
async function loadNetworkLanes() {
  const el = document.getElementById('networkLanes');
  if (!el) return;
  try {
    const data = await apiCall('GET', '/api/admin/network/standalone/ports');
    const ports = (data.success && data.physical_ports) || [];
    if (ports.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px 0;font-size:13px;">No lanes configured yet</div>';
      return;
    }
    el.innerHTML = `<table class="zf3-table"><thead><tr><th>Interface</th><th>MAC</th><th>Status</th></tr></thead><tbody>` +
      ports.map(p => `
        <tr>
          <td>${p.name}</td>
          <td style="font-family:monospace;font-size:11px;color:var(--text-muted);">${p.mac || '--'}</td>
          <td><span class="badge ${p.status === 'up' ? 'badge-green' : 'badge-red'}">${p.status === 'up' ? 'Online' : p.status === 'down' ? 'Offline' : p.status}</span></td>
        </tr>
      `).join('') + `</tbody></table>`;
  } catch (e) {
    el.innerHTML = '';
  }
}

// "Network Devices" - mockup's device-inventory-with-online/offline-
// counts slot. This app doesn't categorize devices into Routers/APs/
// Switches/Controllers (that's Controller Mode device management, group
// 12d, not built) - real registered kiosks/coin-slot boards (vendos
// table, the same online-window logic devices.html already uses) fill
// the "hardware online/offline summary" role instead.
async function loadNetworkDevicesSummary() {
  try {
    const data = await apiCall('GET', '/api/admin/vendos');
    const vendos = (data.success && data.vendos) || [];
    const online = vendos.filter(v => isOnline(v.last_seen)).length;
    document.getElementById('ndTotal').textContent = vendos.length;
    document.getElementById('ndOnline').textContent = online;
    document.getElementById('ndOffline').textContent = vendos.length - online;
    const list = document.getElementById('ndList');
    if (list) {
      if (vendos.length === 0) {
        list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:8px 0;font-size:13px;">No registered kiosks yet</div>';
      } else {
        list.innerHTML = vendos.slice(0, 4).map(v => `
          <div class="zf3-list-row">
            <div class="zf3-list-left"><i class="fas fa-microchip" style="color:var(--text-muted);width:14px;"></i> <span>${v.name || v.mac_address || 'Kiosk #' + v.id}</span></div>
            <span class="badge ${isOnline(v.last_seen) ? 'badge-green' : 'badge-red'}">${isOnline(v.last_seen) ? 'Online' : 'Offline'}</span>
          </div>
        `).join('');
      }
    }
  } catch (e) {}
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
      // Download/Upload here reuse the same live throughput figures the
      // Bandwidth Usage stat card/chart already show (this box's total
      // live interface throughput) - real, not a fabricated per-lane
      // split (RouterOS/nft don't report that separately per-WAN today).
      const dl = document.getElementById('currentDownload');
      const ul = document.getElementById('currentUpload');
      lanes.push({
        name: primaryName,
        online: up,
        download: dl ? `${dl.textContent} Mbps` : '--',
        upload: ul ? `${ul.textContent} Mbps` : '--',
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
      <div class="zf3-wan-lane">
        <div class="zf3-wan-lane-head">
          <span>${l.name}</span>
          <span class="badge ${l.online ? 'badge-green' : 'badge-red'}"><span class="status-dot ${l.online ? 'online' : ''}"></span>${l.standby ? 'Standby' : l.online ? 'Online' : 'Offline'}</span>
        </div>
        ${l.latency !== undefined ? `
        <div class="zf3-wan-grid">
          ${l.download !== undefined ? `
          <div><div class="zf3-wan-item-label">Download</div><div class="zf3-wan-item-value">${l.download}</div></div>
          <div><div class="zf3-wan-item-label">Upload</div><div class="zf3-wan-item-value">${l.upload}</div></div>` : ''}
          <div><div class="zf3-wan-item-label">Latency</div><div class="zf3-wan-item-value">${l.latency}</div></div>
          <div><div class="zf3-wan-item-label">Packet Loss</div><div class="zf3-wan-item-value">${l.loss}</div></div>
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

    const todayIncome = data.today.total_income || 0;
    const todayTx = data.today.transactions || 0;
    const todayMinutes = Math.round(data.today.minutes_sold || 0);

    document.getElementById('todaySales').textContent = `₱${todayIncome.toFixed(2)}`;
    document.getElementById('todayTransactions').textContent = todayTx;
    document.getElementById('minutesSold').textContent = `${todayMinutes} mins`;
    // Hotspot Overview card mirrors the same real today-figures (separate
    // element ids from the stat cards above, so both can render without
    // duplicate-id conflicts).
    const hoTx = document.getElementById('hoTransactions');
    const hoMin = document.getElementById('hoMinutes');
    if (hoTx) hoTx.textContent = todayTx;
    if (hoMin) hoMin.textContent = `${todayMinutes} mins`;

    // Real "vs yesterday" revenue trend - data.week is ordered DESC by
    // date (today first, if any transactions happened today), so the
    // first row after today's own is yesterday's actual total. No
    // fabricated week-over-week % here (this app has no prior-7-days
    // query to compare against) - "vs yesterday" is the honest
    // comparison the data actually supports.
    const trendEl = document.getElementById('revenueTrend');
    if (trendEl && Array.isArray(data.week)) {
      const todayStr = new Date().toISOString().split('T')[0];
      const yesterday = data.week.find((d) => d.date !== todayStr);
      if (yesterday) {
        const diff = todayIncome - (yesterday.total || 0);
        const pct = yesterday.total ? Math.round((diff / yesterday.total) * 100) : null;
        if (pct !== null) {
          trendEl.innerHTML = `<span class="${diff >= 0 ? 'up' : 'down'}"><i class="fas fa-arrow-${diff >= 0 ? 'up' : 'down'}"></i> ${Math.abs(pct)}%</span> vs yesterday`;
        } else {
          trendEl.textContent = 'vs yesterday';
        }
      }
    }

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
      const count = data.active_count ?? data.count ?? 0;
      document.getElementById('activeSessions').textContent = count;
      const hoEl = document.getElementById('hoActiveUsers');
      if (hoEl) hoEl.textContent = count;
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
      <div class="zf3-activity-row">
        <div class="zf3-activity-dot" style="background:${dotColor[t.type] || 'var(--text-muted)'};"></div>
        <div style="min-width:0;">
          <div class="zf3-activity-text">${typeLabel[t.type] || 'Session'} <span style="font-weight:400;color:var(--text-muted);">₱${t.coin_value}</span></div>
          <div class="zf3-activity-meta">${t.voucher_code} · ${formatMins(t.minutes_added)} · ${new Date(t.created_at).toLocaleTimeString()}</div>
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