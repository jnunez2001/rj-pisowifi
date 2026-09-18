// ===== SALES REPORT (a tab inside the Analytics page) =====
// Uses the same date range + compare selector as the Overview tab
// (anState / anBuildQuery in analytics.js). Data comes from
// GET /api/admin/analytics/sales-report; the standalone Sales Report page
// this used to drive has been retired.
let salesChart = null;
let salesRequestSeq = 0;

function escapeSalesHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function destroySalesChart() {
  if (salesChart) { salesChart.destroy(); salesChart = null; }
}

async function loadSales(query) {
  if (!query) {
    const built = anBuildQuery();
    if (built.error) return;
    query = built.query;
  }
  const seq = ++salesRequestSeq;
  try {
    const data = await apiCall('GET', `/api/admin/analytics/sales-report?${query}`);
    if (seq !== salesRequestSeq) return; // a newer selection superseded this one
    if (!data.success) {
      if (typeof anShowError === 'function') anShowError(data.message || 'Could not load the sales report.');
      return;
    }
    anApplyResolved(data.period, data.compare);
    renderSalesCards(data.totals, data.compare);
    buildSalesChart(data.daily);
    buildDailyBreakdown(data.daily);
    buildTransactionTable(data.transactions || []);

    const note = document.getElementById('salesTruncatedNote');
    if (note) {
      if (data.truncated) {
        note.textContent = `Showing the most recent ${data.transactionLimit} of ${data.transactionCount} transactions. Export CSV for the full list.`;
        note.style.display = '';
      } else {
        note.style.display = 'none';
      }
    }

    initReconciliationDefaults();
    loadReconciliationHistory();
  } catch (e) {
    console.error('Sales error:', e);
    if (seq === salesRequestSeq && typeof anShowError === 'function') anShowError('Could not load the sales report.');
  }
}

function renderSalesCards(totals, compare) {
  document.getElementById('salesRevenue').textContent = `\u20B1${totals.revenue.value.toFixed(2)}`;
  document.getElementById('salesRevenueTrend').innerHTML = trendHtml(totals.revenue.changePercent, compare);

  document.getElementById('salesTransactions').textContent = totals.transactions.value;
  document.getElementById('salesTransactionsTrend').innerHTML = trendHtml(totals.transactions.changePercent, compare);

  document.getElementById('salesMinutes').textContent = formatDurationShort(totals.minutesSold.value || 0);
  document.getElementById('salesMinutesTrend').innerHTML = trendHtml(totals.minutesSold.changePercent, compare);

  document.getElementById('salesFreeClaims').textContent = totals.freeClaims.value;
  document.getElementById('salesFreeClaimsTrend').innerHTML = trendHtml(totals.freeClaims.changePercent, compare);
}

function buildSalesChart(daily) {
  const canvas = document.getElementById('salesChart');
  if (!canvas) return;
  destroySalesChart();

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#a7b0bd' : '#64748b';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

  salesChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: daily.map((d) => anFmtDate(d.date, false)),
      datasets: [{
        label: 'Revenue (\u20B1)',
        data: daily.map((d) => d.total || 0),
        backgroundColor: '#2563eb',
        borderRadius: 4,
        maxBarThickness: 28,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? anFmtDate(daily[items[0].dataIndex].date, true) : ''),
            label: (c) => `\u20B1${c.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor, font: { size: 10 }, autoSkip: true, maxTicksLimit: 12 } },
        y: { grid: { color: gridColor }, ticks: { color: textColor, callback: (v) => `\u20B1${v}` }, beginAtZero: true },
      },
    },
  });
}

function buildDailyBreakdown(daily) {
  const el = document.getElementById('dailyBreakdown');
  if (!el) return;

  const maxVal = Math.max(...daily.map((d) => d.total || 0), 1);

  el.innerHTML = [...daily].reverse().map((d) => {
    const pct = Math.round(((d.total || 0) / maxVal) * 100);
    return `
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="font-size:12px;color:var(--text-muted);width:100px;flex-shrink:0;">${anFmtDate(d.date, false)}</div>
        <div style="flex:1;background:var(--bg-primary);border-radius:4px;height:8px;overflow:hidden;">
          <div style="width:${pct}%;background:var(--accent-green);height:100%;border-radius:4px;transition:width 0.5s;"></div>
        </div>
        <div style="font-size:13px;font-weight:700;color:var(--text-primary);width:70px;text-align:right;">
          \u20B1${(d.total || 0).toFixed(0)}
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
          No transactions in this range
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = transactions.map((t) => {
    // t.kiosk_name comes from a LEFT JOIN against satellite_kiosks: shows
    // the specific kiosk a coin credit came from instead of a generic
    // label once more than one source exists.
    let typeLabel;
    if (t.type === 'coin') typeLabel = t.kiosk_name ? escapeSalesHtml(t.kiosk_name) : 'Main Kiosk';
    else if (t.type === 'voucher') typeLabel = 'Voucher';
    else if (t.type === 'promo') typeLabel = 'Promo';
    else if (t.type === 'free') typeLabel = 'Free';
    else typeLabel = escapeSalesHtml(t.type || '');

    const amount = t.type === 'free'
      ? '<span style="color:var(--text-muted);">--</span>'
      : `\u20B1${t.coin_value}`;

    return `
      <tr>
        <td data-label="Session ID">
          <span style="font-family:monospace;font-size:13px;font-weight:700;">${escapeSalesHtml(t.voucher_code)}</span>
        </td>
        <td data-label="Amount">${amount}</td>
        <td data-label="Time Added" style="font-weight:600;">${formatSalesMins(t.minutes_added)}</td>
        <td data-label="Type">${typeLabel}</td>
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

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Exports every transaction in the selected range (not just the rows shown
// in the table, which is capped).
async function exportTransactionsCsv() {
  const range = anState.resolved;
  if (!range) { showToast('Load the report first.', 'error'); return; }
  try {
    const data = await apiCall('GET', `/api/admin/transactions/export?from=${range.from}&to=${range.to}`);
    if (!data.success) { showToast(data.message || 'Export failed.', 'error'); return; }

    const rows = [['Voucher Code', 'Amount (PHP)', 'Minutes Added', 'Type', 'Date & Time']];
    data.transactions.forEach((t) => {
      rows.push([t.voucher_code, t.coin_value, t.minutes_added, t.type, t.created_at]);
    });

    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `starkfi-transactions-${range.from}-to-${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${data.transactions.length} transactions.`, 'success');
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