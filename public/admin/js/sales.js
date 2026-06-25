let salesChart = null;

async function loadSales() {
  try {
    const data = await apiCall('GET', '/api/admin/sales');
    if (!data.success) return;

    // Update stat cards
    document.getElementById('salesTodayTotal').textContent =
      `₱${(data.today.total_income || 0).toFixed(2)}`;
    document.getElementById('salesTodayCount').textContent =
      `${data.today.transactions || 0} transactions`;
    document.getElementById('salesMinutes').textContent =
      `${Math.round(data.today.minutes_sold || 0)}`;

    const weekTotal = data.week.reduce((s, d) => s + (d.total || 0), 0);
    document.getElementById('salesWeekTotal').textContent = `₱${weekTotal.toFixed(2)}`;
    document.getElementById('salesMonthTotal').textContent = `₱${(weekTotal * 4).toFixed(2)}`;

    // Free claims card
    const freeClaimsEl = document.getElementById('salesFreeClaims');
    if (freeClaimsEl) {
      freeClaimsEl.textContent = `${data.today.free_claims || 0} claims`;
    }
    const freeMinutesEl = document.getElementById('salesFreeMinutes');
    if (freeMinutesEl) {
      freeMinutesEl.textContent = `${Math.round(data.today.free_minutes || 0)} mins given`;
    }

    // Build chart
    buildSalesChart(data.week);

    // Daily breakdown
    buildDailyBreakdown(data.week);

    // Transaction table
    buildTransactionTable(data.recent_transactions || []);

  } catch(e) {
    console.error('Sales error:', e);
  }
}

function buildSalesChart(weekData) {
  const canvas = document.getElementById('salesChart');
  if (!canvas) return;
  if (salesChart) { salesChart.destroy(); salesChart = null; }

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#888' : '#999';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

  const labels = [...weekData].reverse().map(d =>
    new Date(d.date).toLocaleDateString('en-PH', {
      weekday: 'short', month: 'short', day: 'numeric'
    })
  );
  const values = [...weekData].reverse().map(d => d.total || 0);

  salesChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Revenue (₱)',
        data: values,
        backgroundColor: 'rgba(0,200,83,0.7)',
        borderColor: '#00c853',
        borderWidth: 2,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `₱${c.parsed.y.toFixed(2)}` } }
      },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 11 } } },
        y: {
          grid: { color: gridColor },
          ticks: { color: textColor, callback: v => `₱${v}` },
          beginAtZero: true
        }
      }
    }
  });
}

function buildDailyBreakdown(weekData) {
  const el = document.getElementById('dailyBreakdown');
  if (!el) return;

  const maxVal = Math.max(...weekData.map(d => d.total || 0), 1);

  el.innerHTML = [...weekData].reverse().map(d => {
    const pct = Math.round(((d.total || 0) / maxVal) * 100);
    const date = new Date(d.date).toLocaleDateString('en-PH', {
      weekday: 'short', month: 'short', day: 'numeric'
    });
    return `
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="font-size:12px;color:var(--text-muted);width:100px;flex-shrink:0;">${date}</div>
        <div style="flex:1;background:var(--bg-primary);border-radius:4px;height:8px;overflow:hidden;">
          <div style="width:${pct}%;background:var(--accent-green);height:100%;border-radius:4px;transition:width 0.5s;"></div>
        </div>
        <div style="font-size:13px;font-weight:700;color:var(--text-primary);width:60px;text-align:right;">
          ₱${(d.total || 0).toFixed(0)}
        </div>
      </div>`;
  }).join('');
}

function buildTransactionTable(transactions) {
  const tbody = document.getElementById('salesTable');
  if (!tbody) return;

  if (!transactions.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">
          No transactions yet
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = transactions.map(t => {
    let typeBadge = '';
    if (t.type === 'coin') {
      typeBadge = '<span class="badge badge-blue">🪙 Coin</span>';
    } else if (t.type === 'promo') {
      typeBadge = '<span class="badge badge-orange">🎫 Promo</span>';
    } else if (t.type === 'free') {
      typeBadge = '<span class="badge badge-purple">🎁 Free</span>';
    }

    const coinValue = t.type === 'free'
      ? '<span style="color:var(--text-muted);">—</span>'
      : `<span class="badge badge-green">₱${t.coin_value}</span>`;

    return `
      <tr>
        <td>
          <span style="font-family:monospace;font-size:13px;color:var(--accent-red);font-weight:700;">
            ${t.voucher_code}
          </span>
        </td>
        <td>${coinValue}</td>
        <td style="font-weight:600;">${formatSalesMins(t.minutes_added)}</td>
        <td>${typeBadge}</td>
        <td style="font-size:13px;color:var(--text-muted);">
          ${new Date(t.created_at).toLocaleString()}
        </td>
      </tr>`;
  }).join('');
}

function formatSalesMins(mins) {
  if (mins >= 43200) return `${Math.round(mins/43200)} days`;
  if (mins >= 1440) return `${Math.round(mins/1440)} days`;
  if (mins >= 60) return `${Math.round(mins/60)} hrs`;
  return `${Math.round(mins)} mins`;
}