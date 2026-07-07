let revenueChart = null;
let startTime = Date.now();
let currentChartRange = 'weekly';

async function loadDashboard() {
  // Bug: initChart() used to run AFTER loadSalesStats(), so on every fresh
  // dashboard load, updateChartData()'s `if (revenueChart && ...)` guard
  // was always false (the chart didn't exist yet) — the revenue chart
  // always rendered as a flat zero line until an admin happened to click
  // one of the Daily/Weekly/Monthly buttons, easy to mistake for "no sales".
  initChart();
  await loadSalesStats();
  await loadRecentTransactions();
  await loadActiveSessionsCount();
  await loadSystemVersion();
  await loadSystemStatus();
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
      }
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

    // Weekly total
    const weekTotal = data.week.reduce((sum, d) => sum + (d.total || 0), 0);
    document.getElementById('weeklySales').textContent = `₱${weekTotal.toFixed(2)}`;

    // Bug: this used to be weekTotal * 4, a rough guess, not real data.
    // The server now computes an actual month-to-date total.
    document.getElementById('monthlySales').textContent =
      `₱${(data.month?.total_income || 0).toFixed(2)}`;

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

async function loadRecentTransactions() {
  try {
    const data = await apiCall('GET', '/api/admin/sales');
    if (!data.success) return;

    const tbody = document.getElementById('recentTransactions');
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

    tbody.innerHTML = transactions.slice(0, 10).map(t => `
      <tr>
        <td>
          <span style="font-family:monospace;font-size:13px;color:var(--accent-red);font-weight:700;">
            ${t.voucher_code}
          </span>
        </td>
        <td>
          <span class="badge badge-green">₱${t.coin_value}</span>
        </td>
        <td>${formatMins(t.minutes_added)}</td>
        <td>
          <span class="badge ${t.type === 'coin' ? 'badge-blue' : 'badge-orange'}">
            ${t.type === 'coin' ? '🪙 Coin' : '🎫 Promo'}
          </span>
        </td>
        <td style="color:var(--text-muted);font-size:13px;">
          ${new Date(t.created_at).toLocaleTimeString()}
        </td>
      </tr>
    `).join('');

  } catch(e) {
    console.error('Transactions error:', e);
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
  setInterval(updateUptime, 1000);
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
        borderColor: '#00c853',
        backgroundColor: 'rgba(0,200,83,0.1)',
        borderWidth: 2.5,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#00c853',
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