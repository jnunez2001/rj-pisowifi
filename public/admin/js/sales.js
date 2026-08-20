let salesChart = null;

function escapeSalesHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

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
      formatDurationShort(data.today.minutes_sold || 0);

    const weekTotal = data.week.reduce((s, d) => s + (d.total || 0), 0);
    document.getElementById('salesWeekTotal').textContent = `₱${weekTotal.toFixed(2)}`;
    // Bug: this used to be weekTotal * 4, a rough guess, not real data.
    // The server now computes an actual month-to-date total.
    document.getElementById('salesMonthTotal').textContent = `₱${(data.month?.total_income || 0).toFixed(2)}`;

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

    initReconciliationDefaults();
    loadReconciliationHistory();

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
        backgroundColor: 'rgba(26,156,99,0.7)',
        borderColor: '#1a9c63',
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
    // t.kiosk_name comes from /api/admin/sales' LEFT JOIN against
    // satellite_kiosks (added for the Hotspot Dashboard's Revenue by
    // Source) - shows the specific kiosk a coin credit came from instead
    // of a generic "Coin" label once more than one source exists, same
    // fix already applied there, kept consistent here.
    let typeBadge = '';
    if (t.type === 'coin') {
      typeBadge = t.kiosk_name
        ? `<span class="badge badge-blue">📡 ${escapeSalesHtml(t.kiosk_name)}</span>`
        : '<span class="badge badge-blue">🪙 Main Kiosk</span>';
    } else if (t.type === 'voucher') {
      typeBadge = '<span class="badge badge-orange">🎟️ Voucher</span>';
    } else if (t.type === 'promo') {
      typeBadge = '<span class="badge badge-orange">🎫 Promo</span>';
    } else if (t.type === 'free') {
      typeBadge = '<span class="badge badge-purple">🎁 Free</span>';
    }

    const coinValue = t.type === 'free'
      ? '<span style="color:var(--text-muted);">--</span>'
      : `<span class="badge badge-green">₱${t.coin_value}</span>`;

    return `
      <tr>
        <td data-label="Session ID">
          <span style="font-family:monospace;font-size:13px;color:var(--accent-red);font-weight:700;">
            ${t.voucher_code}
          </span>
        </td>
        <td data-label="Amount">${coinValue}</td>
        <td data-label="Time Added" style="font-weight:600;">${formatSalesMins(t.minutes_added)}</td>
        <td data-label="Type">${typeBadge}</td>
        <td data-label="Date & Time" style="font-size:13px;color:var(--text-muted);">
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

// Improvement: the only way to get transaction data out of this system was
// the full JSON backup (settings + rates + promos + everything else mixed
// together), no quick way for an admin to open sales in Excel/Sheets for
// bookkeeping. Exports the complete history (not just the 20-row preview).
function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

async function exportTransactionsCsv() {
  try {
    const data = await apiCall('GET', '/api/admin/transactions/export');
    if (!data.success) { showToast('Export failed.', 'error'); return; }

    const rows = [['Voucher Code', 'Amount (₱)', 'Minutes Added', 'Type', 'Date & Time']];
    data.transactions.forEach(t => {
      rows.push([t.voucher_code, t.coin_value, t.minutes_added, t.type, t.created_at]);
    });

    const csv = rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().split('T')[0];
    const a = document.createElement('a');
    a.href = url;
    a.download = `rj-pisowifi-transactions-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${data.transactions.length} transactions!`, 'success');
  } catch (e) {
    showToast('Export error.', 'error');
  }
}

// ===== CASH RECONCILIATION =====
// Compares an operator's own physical coin count for a period against
// what the system logged as credited (transactions.coin_value, type
// 'coin' only, real cash never came from a voucher/promo/free session)
// over that same window. Doesn't try to explain a mismatch on its own,
// just gives the operator a real number and a saved record to point back
// to instead of an unexplained gap when counting coins against the books.

function toLocalDatetimeInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function initReconciliationDefaults() {
  const startEl = document.getElementById('reconPeriodStart');
  const endEl = document.getElementById('reconPeriodEnd');
  if (!startEl || !endEl || startEl.value || endEl.value) return;
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  startEl.value = toLocalDatetimeInputValue(startOfDay);
  endEl.value = toLocalDatetimeInputValue(now);
}

async function submitCashReconciliation() {
  const periodStartLocal = document.getElementById('reconPeriodStart').value;
  const periodEndLocal = document.getElementById('reconPeriodEnd').value;
  const physicalAmount = document.getElementById('reconPhysicalAmount').value;
  const notes = document.getElementById('reconNotes').value;

  if (!periodStartLocal || !periodEndLocal) {
    showToast('Pick a period start and end.', 'error');
    return;
  }
  if (physicalAmount === '' || isNaN(parseFloat(physicalAmount))) {
    showToast('Enter how many pesos you physically counted.', 'error');
    return;
  }

  // datetime-local inputs have no timezone info, sent as local wall-clock
  // time, matches how created_at is stored (SQLite CURRENT_TIMESTAMP, no
  // zone marker) so a plain string comparison on the server lines up with
  // what the operator actually meant by the period they picked.
  const periodStart = periodStartLocal.replace('T', ' ') + ':00';
  const periodEnd = periodEndLocal.replace('T', ' ') + ':59';

  try {
    const data = await apiCall('POST', '/api/admin/cash-reconciliation', {
      period_start: periodStart,
      period_end: periodEnd,
      physical_amount: parseFloat(physicalAmount),
      notes,
    });
    if (!data.success) {
      showToast(data.message || 'Could not save reconciliation.', 'error');
      return;
    }
    renderReconciliationResult(data.record);
    document.getElementById('reconNotes').value = '';
    loadReconciliationHistory();
    showToast('Reconciliation saved.', 'success');
  } catch (e) {
    showToast('Could not save reconciliation.', 'error');
  }
}

function renderReconciliationResult(record) {
  const wrap = document.getElementById('reconResult');
  if (!wrap) return;
  wrap.style.display = 'block';
  document.getElementById('reconSystemAmount').textContent = `₱${Number(record.system_amount).toFixed(2)}`;
  document.getElementById('reconPhysicalDisplay').textContent = `₱${Number(record.physical_amount).toFixed(2)}`;

  const diff = Number(record.difference);
  const diffEl = document.getElementById('reconDifference');
  diffEl.textContent = `${diff > 0 ? '+' : ''}₱${diff.toFixed(2)}`;
  diffEl.style.color = diff === 0 ? 'var(--accent-green)' : (diff > 0 ? 'var(--accent-blue)' : 'var(--accent-red)');

  const msgEl = document.getElementById('reconMessage');
  if (diff === 0) {
    msgEl.textContent = 'Matches exactly. No discrepancy for this period.';
  } else if (diff > 0) {
    msgEl.textContent = `You counted ₱${diff.toFixed(2)} more than the system logged. Could be a coin the system missed, or simply more cash than transactions on file.`;
  } else {
    msgEl.textContent = `The system logged ₱${Math.abs(diff).toFixed(2)} more than you counted. Worth checking this period's coin-inserted log entries (bell icon, or Logs page) against what's actually in the box.`;
  }
}

async function loadReconciliationHistory() {
  const tbody = document.getElementById('reconHistoryTable');
  if (!tbody) return;
  try {
    const data = await apiCall('GET', '/api/admin/cash-reconciliation?limit=20');
    if (!data.success || !data.records || data.records.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px;">No reconciliations saved yet.</td></tr>';
      return;
    }
    tbody.innerHTML = data.records.map((r) => {
      const diff = Number(r.difference);
      const diffColor = diff === 0 ? 'var(--accent-green)' : (diff > 0 ? 'var(--accent-blue)' : 'var(--accent-red)');
      return `
        <tr>
          <td data-label="Period" style="font-size:12px;">${r.period_start.slice(0, 16)} to ${r.period_end.slice(0, 16)}</td>
          <td data-label="System Logged">₱${Number(r.system_amount).toFixed(2)}</td>
          <td data-label="Physical Count">₱${Number(r.physical_amount).toFixed(2)}</td>
          <td data-label="Difference" style="color:${diffColor};font-weight:700;">${diff > 0 ? '+' : ''}₱${diff.toFixed(2)}</td>
          <td data-label="Notes" style="font-size:12px;color:var(--text-secondary);">${escapeSalesHtml(r.notes || '-')}</td>
          <td data-label="Saved" style="font-size:12px;color:var(--text-muted);">${r.created_at}</td>
        </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px;">Could not load reconciliation history.</td></tr>';
  }
}