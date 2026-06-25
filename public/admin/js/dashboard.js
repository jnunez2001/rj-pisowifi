let revenueChart = null;
let startTime = Date.now();

async function loadDashboard() {
  await loadSalesStats();
  await loadRecentTransactions();
  await loadActiveSessionsCount();
  await loadSystemVersion();
  initChart();
  startUptimeCounter();
}

async function loadSystemVersion() {
  try {
    const data = await apiCall('GET', '/api/admin/check-update');
    if (data.success) {
      const el = document.getElementById('systemVersion');
      if (el) el.textContent = `v${data.current_version}`;
    }
  } catch(e) {}
}

async function loadSalesStats() {
  try {
    const data = await apiCall('GET', '/api/admin/sales');
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

    // Monthly (approximate from week data)
    document.getElementById('monthlySales').textContent =
      `₱${(weekTotal * 4).toFixed(2)}`;

    // Update chart
    if (revenueChart && data.week) {
      updateChartData(data.week);
    }

  } catch(e) {
    console.error('Sales stats error:', e);
  }
}

async function loadActiveSessionsCount() {
  try {
    const data = await apiCall('GET', '/api/admin/sessions');
    if (data.success) {
      document.getElementById('activeSessions').textContent = data.count || 0;
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

function startUptimeCounter() {
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

function updateChartData(weekData) {
  if (!revenueChart) return;

  const labels = weekData.map(d => {
    const date = new Date(d.date);
    return date.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
  }).reverse();

  const values = weekData.map(d => d.total || 0).reverse();

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
  loadSalesStats();
}