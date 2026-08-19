let hsRevenueChart = null;
let hsAccessTypeDonut = null;
let hsSessionActivityChart = null;
let hsCurrentChartRange = 'weekly';

function hsEscapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadHotspotDashboard() {
  hsInitChart();
  hsInitSessionActivityChart();
  await hsLoadKiosks();
  hsRenderOfflineKioskAlert();
  await hsLoadSalesStats();
  await hsLoadRecentTransactions();
  await hsLoadActiveSessionsCount();
  await hsLoadSystemStatus();
  // Must run LAST - hsRenderOfflineKioskAlert() above can set the offline
  // alert banner back to visible (display:flex) if stale kiosk records
  // exist, which would silently undo an earlier suppression. Applying the
  // venue-type hide/suppress after everything else guarantees nothing
  // later in this sequence can override it.
  hsApplyVenueTypeCards();
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

  // hsRenderOfflineKioskAlert() (called later in loadHotspotDashboard via
  // hsLoadKiosks) would otherwise show a permanently-offline kiosk
  // warning for coin-slot hardware that was never supposed to exist on a
  // cafe/coworking venue - suppress it the same way the row itself is
  // hidden, rather than leaving a confusing false alarm on the dashboard.
  if (!isPisoWifi) {
    const alertEl = document.getElementById('hsOfflineKioskAlert');
    if (alertEl) alertEl.style.display = 'none';
  }
}

function destroyHotspotDashboard() {
  if (hsRevenueChart) { hsRevenueChart.destroy(); hsRevenueChart = null; }
  if (hsAccessTypeDonut) { hsAccessTypeDonut.destroy(); hsAccessTypeDonut = null; }
  if (hsSessionActivityChart) { hsSessionActivityChart.destroy(); hsSessionActivityChart = null; }
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

// Main Kiosk vs Satellite Kiosks (combined) now come from real kiosk_id
// tagging (see docs/tabs/satellite-kiosks.md) instead of one undifferentiated
// "Coins" bucket. Satellite Kiosks only appears at all if the operator has
// at least one registered (hsKiosksCache), regardless of whether it sold
// anything today - progressive disclosure, not "hide on zero revenue."
const HS_SOURCE_CONFIG = [
  { key: 'main_kiosk', label: 'Main Kiosk', icon: 'fa-coins', color: '#0c8f6d' },
  { key: 'satellite_kiosks', label: 'Satellite Kiosks', icon: 'fa-tower-broadcast', color: '#1a9c63' },
  { key: 'voucher', label: 'Vouchers', icon: 'fa-ticket', color: '#8a6d3d' },
  { key: 'promo', label: 'Promos', icon: 'fa-gift', color: '#3d6d94' },
  { key: 'free', label: 'Free Claims', icon: 'fa-hand-holding-heart', color: '#9e9e9e' },
];

let hsKiosksCache = [];
let hsKioskBreakdownOpen = false;

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

async function hsLoadSalesStats() {
  try {
    const data = await apiCall('GET', `/api/admin/sales?range=${hsCurrentChartRange}`);
    if (!data.success) return;

    const t = data.today;
    document.getElementById('hsTodaySales').textContent = `₱${(t.total_income || 0).toFixed(2)}`;
    document.getElementById('hsMinutesSold').textContent = formatDurationShort(t.minutes_sold || 0);

    const weekTotal = data.week.reduce((sum, d) => sum + (d.total || 0), 0);
    document.getElementById('hsWeeklySales').textContent = `₱${weekTotal.toFixed(2)}`;
    document.getElementById('hsMonthlySales').textContent = `₱${(data.month?.total_income || 0).toFixed(2)}`;

    // Revenue by Source - amounts/counts sourced directly from the same
    // /api/admin/sales response Sales Report already uses, not a separate
    // query, so this can never drift out of sync with the official totals.
    const sourceData = {
      main_kiosk: { amount: t.main_kiosk_income || 0, count: t.main_kiosk_transactions || 0 },
      satellite_kiosks: { amount: t.satellite_kiosk_income || 0, count: t.satellite_kiosk_transactions || 0 },
      voucher: { amount: t.voucher_income || 0, count: t.voucher_transactions || 0 },
      promo: { amount: t.promo_income || 0, count: t.promo_transactions || 0 },
      free: { amount: 0, count: t.free_claims || 0 },
    };
    const grandTotal = t.total_income || 0;
    const totalTransactions = (t.coin_transactions || 0) + (t.voucher_transactions || 0) + (t.promo_transactions || 0) + (t.free_claims || 0);

    // Satellite Kiosks only shows up at all if the operator has at least
    // one registered - progressive disclosure, same rule as everywhere
    // else in this app. Main Kiosk always shows (every install has one).
    const visibleConfig = HS_SOURCE_CONFIG.filter(cfg =>
      cfg.key !== 'satellite_kiosks' || hsKiosksCache.length > 0
    );

    const sourceRows = visibleConfig.map(cfg => {
      const d = sourceData[cfg.key];
      const pct = grandTotal > 0 ? (d.amount / grandTotal * 100) : 0;
      const viewByKiosk = cfg.key === 'satellite_kiosks'
        ? ` <a href="#" onclick="hsToggleKioskBreakdown(event)" style="font-size:11px;color:var(--brand-teal);margin-left:6px;">${hsKioskBreakdownOpen ? 'Hide' : 'View by Kiosk'}</a>`
        : '';
      return `
        <tr>
          <td data-label="Source"><i class="fas ${cfg.icon}" style="margin-right:8px;color:${cfg.color};"></i>${cfg.label}${viewByKiosk}</td>
          <td data-label="Amount"><span class="badge badge-green">₱${d.amount.toFixed(2)}</span></td>
          <td data-label="Transactions">${d.count}</td>
          <td data-label="% of Total">${d.amount > 0 ? pct.toFixed(1) + '%' : '—'}</td>
        </tr>`;
    }).join('');

    const breakdownRow = hsKioskBreakdownOpen && hsKiosksCache.length > 0
      ? `<tr><td colspan="4" style="padding:0;">${hsRenderKioskBreakdown()}</td></tr>`
      : '';

    document.getElementById('revenueBySource').innerHTML = sourceRows + breakdownRow;

    // Donut - same three categories, non-zero slices only (Chart.js draws
    // an empty ring if every value is 0, which is the honest "no sales
    // yet today" state, not a bug).
    const donutLabels = [];
    const donutValues = [];
    const donutColors = [];
    visibleConfig.forEach(cfg => {
      const amount = sourceData[cfg.key].amount;
      if (amount > 0) {
        donutLabels.push(cfg.label);
        donutValues.push(amount);
        donutColors.push(cfg.color);
      }
    });
    hsUpdateDonut(donutLabels, donutValues, donutColors, grandTotal);

    const legend = visibleConfig.map(cfg => {
      const d = sourceData[cfg.key];
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;">
          <span style="display:flex;align-items:center;gap:6px;color:var(--text-muted);font-weight:600;">
            <span style="width:9px;height:9px;border-radius:50%;background:${cfg.color};display:inline-block;"></span>
            ${cfg.label}
          </span>
          <span style="font-weight:700;color:var(--text-primary);">₱${d.amount.toFixed(2)} <span style="color:var(--text-muted);font-weight:500;">(${d.count})</span></span>
        </div>`;
    }).join('');
    document.getElementById('accessTypeLegend').innerHTML = legend;

    document.getElementById('hsAvgPerTransaction').textContent =
      totalTransactions > 0 ? `₱${(grandTotal / totalTransactions).toFixed(2)}` : '₱0';

    const durationEl = document.getElementById('hsAvgSessionDuration');
    if (durationEl) {
      const durSec = t.avg_session_duration_seconds || 0;
      durationEl.textContent = (t.sessions_ended_today || 0) === 0 ? 'No data yet'
        : durSec < 60 ? `${durSec} sec`
        : hsFormatMins(Math.round(durSec / 60));
    }

    if (hsRevenueChart && data.chart) {
      hsUpdateChartData(data.chart, data.chart_format);
    }
    if (hsSessionActivityChart && data.session_activity) {
      hsUpdateSessionActivityChart(data.session_activity, data.chart_format);
    }
  } catch (e) {
    console.error('Hotspot dashboard sales stats error:', e);
  }
}

function hsRenderKioskBreakdown() {
  const rows = hsKiosksCache.map(k => `
    <div style="display:flex;justify-content:space-between;padding:6px 12px;font-size:12px;">
      <span style="color:var(--text-primary);">${hsEscapeHtml(k.name)}</span>
      <span style="color:var(--text-muted);">₱${k.today_revenue.toFixed(2)} <span style="opacity:0.7;">(${k.today_transactions})</span></span>
    </div>`).join('');
  return `<div style="background:var(--bg-hover);border-radius:6px;margin:4px 0;padding:4px 0;">${rows}</div>`;
}

function hsToggleKioskBreakdown(e) {
  e.preventDefault();
  hsKioskBreakdownOpen = !hsKioskBreakdownOpen;
  hsLoadSalesStats();
}

async function hsLoadRecentTransactions() {
  try {
    const data = await apiCall('GET', '/api/admin/sales');
    if (!data.success) return;

    const tbody = document.getElementById('hsRecentTransactions');
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
    const sourceLabel = (t) => {
      if (t.type === 'voucher') return '🎟️ Voucher';
      if (t.type === 'promo') return '🎫 Promo';
      if (t.type === 'free') return '🎁 Free';
      return t.kiosk_name ? `📡 ${hsEscapeHtml(t.kiosk_name)}` : '🪙 Main Kiosk';
    };
    tbody.innerHTML = transactions.slice(0, 10).map(t => `
      <tr>
        <td data-label="Session ID">
          <span style="font-family:monospace;font-size:13px;color:var(--accent-red);font-weight:700;">
            ${t.voucher_code}
          </span>
        </td>
        <td data-label="Amount">
          <span class="badge badge-green">₱${t.coin_value}</span>
        </td>
        <td data-label="Time Added">${hsFormatMins(t.minutes_added)}</td>
        <td data-label="Source">
          <span class="badge badge-blue">${sourceLabel(t)}</span>
        </td>
        <td data-label="Time" style="color:var(--text-muted);font-size:13px;">
          ${new Date(t.created_at).toLocaleTimeString()}
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('Hotspot dashboard transactions error:', e);
  }
}

function hsFormatMins(mins) {
  if (mins >= 1440) return `${Math.round(mins / 1440)} days`;
  if (mins >= 60) return `${Math.round(mins / 60)} hrs`;
  return `${Math.round(mins)} mins`;
}

function hsInitChart() {
  const canvas = document.getElementById('hsRevenueChart');
  if (!canvas) return;

  if (hsRevenueChart) { hsRevenueChart.destroy(); hsRevenueChart = null; }

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#888' : '#999';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

  hsRevenueChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      datasets: [{
        label: 'Revenue (₱)',
        data: [0, 0, 0, 0, 0, 0, 0],
        borderColor: '#0c8f6d',
        backgroundColor: 'rgba(12,143,109,0.1)',
        borderWidth: 2.5,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#0c8f6d',
        pointRadius: 4,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `₱${ctx.parsed.y.toFixed(2)}` } }
      },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 12 } } },
        y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 12 }, callback: val => `₱${val}` }, beginAtZero: true }
      }
    }
  });
}

function hsUpdateChartData(chartData, format) {
  if (!hsRevenueChart) return;
  const labels = chartData.map(d =>
    format === 'hour' ? d.label : new Date(d.label).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' })
  );
  const values = chartData.map(d => d.total || 0);
  hsRevenueChart.data.labels = labels;
  hsRevenueChart.data.datasets[0].data = values;
  hsRevenueChart.update();
}

function hsUpdateDonut(labels, values, colors, total) {
  const canvas = document.getElementById('accessTypeDonut');
  if (!canvas) return;

  document.getElementById('accessTypeDonutTotal').textContent = `₱${total.toFixed(2)}`;

  // No sales yet today - draw one flat gray ring instead of an empty
  // canvas, same "honest empty state" the rest of the redesign uses.
  const hasData = values.length > 0;
  const drawLabels = hasData ? labels : ['No sales yet'];
  const drawValues = hasData ? values : [1];
  const drawColors = hasData ? colors : ['rgba(150,150,150,0.2)'];

  if (hsAccessTypeDonut) {
    hsAccessTypeDonut.data.labels = drawLabels;
    hsAccessTypeDonut.data.datasets[0].data = drawValues;
    hsAccessTypeDonut.data.datasets[0].backgroundColor = drawColors;
    hsAccessTypeDonut.update();
    return;
  }

  hsAccessTypeDonut = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: drawLabels,
      datasets: [{ data: drawValues, backgroundColor: drawColors, borderWidth: 0 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: hasData,
          callbacks: { label: ctx => `${ctx.label}: ₱${ctx.parsed.toFixed(2)}` }
        }
      }
    }
  });
}

function hsInitSessionActivityChart() {
  const canvas = document.getElementById('hsSessionActivityChart');
  if (!canvas) return;

  if (hsSessionActivityChart) { hsSessionActivityChart.destroy(); hsSessionActivityChart = null; }

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#888' : '#999';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

  hsSessionActivityChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: 'New', data: [], backgroundColor: '#0c8f6d', borderRadius: 4, stack: 'clients' },
        { label: 'Returning', data: [], backgroundColor: '#9e9e9e', borderRadius: 4, stack: 'clients' }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: textColor, font: { size: 12 } } },
        y: { stacked: true, grid: { color: gridColor }, ticks: { color: textColor, font: { size: 12 }, precision: 0 }, beginAtZero: true }
      }
    }
  });
}

function hsUpdateSessionActivityChart(activity, format) {
  if (!hsSessionActivityChart) return;
  const labels = activity.map(d =>
    format === 'hour' ? d.label : new Date(d.label).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' })
  );
  hsSessionActivityChart.data.labels = labels;
  hsSessionActivityChart.data.datasets[0].data = activity.map(d => d.new);
  hsSessionActivityChart.data.datasets[1].data = activity.map(d => d.returning);
  hsSessionActivityChart.update();
}

function setHsChartRange(range) {
  ['Daily', 'Weekly', 'Monthly'].forEach(r => {
    const btn = document.getElementById(`hsBtn${r}`);
    if (btn) btn.className = 'btn btn-sm btn-secondary';
  });
  const active = document.getElementById(`hsBtn${range.charAt(0).toUpperCase() + range.slice(1)}`);
  if (active) active.className = 'btn btn-sm btn-primary';

  const subtitle = document.getElementById('hsChartRangeSubtitle');
  if (subtitle) {
    subtitle.textContent = range === 'daily' ? "Today's performance by hour"
      : range === 'monthly' ? 'Last 30 days performance'
      : 'Last 7 days performance';
  }

  hsCurrentChartRange = range === 'daily' ? 'daily' : range === 'monthly' ? 'monthly' : 'weekly';
  hsLoadSalesStats();
}
