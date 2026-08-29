// ===== REPORTS PAGE =====
// Customer-submitted issues from the portal's "Report a Problem" button
// (public/portal/assets/js/portal.js's submitReport()). Backed by
// customer_reports table, see GET /api/admin/reports (admin.js).
let reportsFilter = 'open';

const REPORT_CATEGORY_LABELS = {
  slow_internet: 'Slow internet',
  credit_missed: 'Credit issue',
  other: 'Other'
};

function updateReportsFilterButtons() {
  const map = { open: 'reportsFilterOpen', '': 'reportsFilterAll', spam: 'reportsFilterSpam' };
  Object.entries(map).forEach(([status, id]) => {
    const btn = document.getElementById(id);
    if (btn) btn.style.outline = reportsFilter === status ? '2px solid var(--accent-blue, #3b82f6)' : 'none';
  });
}

function setReportsFilter(status) {
  reportsFilter = status;
  updateReportsFilterButtons();
  loadReportsPage();
}

async function loadReportsPage() {
  const el = document.getElementById('reportsBody');
  if (!el) return;
  updateReportsFilterButtons();

  // Operator-adjustable daily report cap (settings.max_reports_per_mac),
  // enforced server-side in portal.js's POST /report.
  try {
    const settingsData = await apiCall('GET', '/api/admin/settings');
    const input = document.getElementById('maxReportsPerMac');
    if (input && settingsData.success) {
      input.value = settingsData.settings.max_reports_per_mac || '5';
    }
  } catch (e) {}

  try {
    const qs = reportsFilter ? `?status=${reportsFilter}` : '';
    const data = await apiCall('GET', `/api/admin/reports${qs}`);
    if (!data.success || !data.reports || data.reports.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No reports</div>';
      return;
    }
    el.innerHTML = data.reports.map(renderReportThread).join('');
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">Could not load reports</div>';
  }
}

function renderReportThread(r) {
  const initial = (r.name || '?').trim().charAt(0).toUpperCase() || '?';
  const categoryLabel = REPORT_CATEGORY_LABELS[r.category] || 'Other';
  const statusClass = r.status === 'open' ? 'status-open' : r.status === 'spam' ? 'status-spam' : 'status-resolved';

  let actions = '';
  if (r.status !== 'resolved') {
    actions += `<button class="btn btn-secondary" onclick="resolveReport(${r.id})"><i class="fas fa-check"></i> Resolve</button>`;
  }
  if (r.status !== 'spam') {
    actions += `<button class="btn btn-secondary" onclick="markReportSpam(${r.id})"><i class="fas fa-ban"></i> Mark spam</button>`;
  }
  if (r.mac_address) {
    actions += `<button class="btn btn-secondary" onclick="blockReportMac('${escapeHtml(r.mac_address)}')"><i class="fas fa-comment-slash"></i> Block chat</button>`;
  }

  return `
    <div class="report-thread ${statusClass}">
      <div class="report-avatar">${escapeHtml(initial)}</div>
      <div class="report-body">
        <div class="report-top-row">
          <span class="report-name">${escapeHtml(r.name || 'Anonymous')}</span>
          <span class="report-category-pill">${categoryLabel}</span>
          <span class="report-time">${new Date(r.created_at).toLocaleString()}</span>
        </div>
        <div class="report-bubble" title="${escapeHtml(r.message)}">${escapeHtml(truncateMessage(r.message))}</div>
        <div class="report-meta-line">
          ${r.voucher_code ? escapeHtml(r.voucher_code) + ' &middot; ' : ''}${r.mac_address ? escapeHtml(r.mac_address) : ''}
          ${r.status === 'resolved' ? ' &middot; Resolved' : ''}
          ${r.status === 'spam' ? ' &middot; Marked spam' : ''}
        </div>
        <div class="report-actions">${actions}</div>
      </div>
    </div>
  `;
}

async function resolveReport(id) {
  await apiCall('POST', `/api/admin/reports/${id}/resolve`);
  loadReportsPage();
}

async function markReportSpam(id) {
  await apiCall('POST', `/api/admin/reports/${id}/spam`);
  loadReportsPage();
}

async function blockReportMac(mac) {
  if (!confirm(`Block ${mac} from sending any more reports? Their WiFi access is not affected.`)) return;
  await apiCall('POST', '/api/admin/reports/block-mac', { mac });
  loadReportsPage();
}

async function saveMaxReportsPerMac() {
  const input = document.getElementById('maxReportsPerMac');
  const value = parseInt(input.value, 10);
  if (!value || value < 1) return;
  await apiCall('POST', '/api/admin/settings', { max_reports_per_mac: String(value) });
}

function truncateMessage(msg) {
  const str = String(msg || '');
  return str.length > 140 ? str.slice(0, 140) + '...' : str;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
