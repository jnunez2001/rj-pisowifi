// ===== REPORTS PAGE =====
// Customer-submitted issues from the portal's "Report a Problem" button
// (public/portal/assets/js/portal.js's submitReport()). Backed by
// customer_reports table, see GET /api/admin/reports (admin.js).
let reportsFilter = 'open';
let reportsData = [];
let expandedReportId = null;
let reportThreadPollInterval = null;

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
      reportsData = [];
      el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No reports</div>';
      return;
    }
    reportsData = data.reports;
    el.innerHTML = data.reports.map(renderReportThread).join('');
    if (expandedReportId && data.reports.some((r) => r.id === expandedReportId)) {
      loadReportMessages(expandedReportId);
    }
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">Could not load reports</div>';
  }
}

function toggleReportThread(id) {
  clearInterval(reportThreadPollInterval);
  expandedReportId = expandedReportId === id ? null : id;
  const panel = document.getElementById(`reportPanel-${id}`);
  if (!panel) return;
  panel.style.display = expandedReportId === id ? 'block' : 'none';
  if (expandedReportId === id) {
    loadReportMessages(id);
    // Live-ish updates while a thread is open, so a customer's reply
    // shows up without the admin needing to refresh the whole page.
    reportThreadPollInterval = setInterval(() => loadReportMessages(id), 5000);
  }
}

function renderReportThread(r) {
  const initial = (r.name || '?').trim().charAt(0).toUpperCase() || '?';
  const categoryLabel = REPORT_CATEGORY_LABELS[r.category] || 'Other';
  const statusClass = r.status === 'open' ? 'status-open' : r.status === 'spam' ? 'status-spam' : 'status-resolved';
  const isCreditReport = r.category === 'credit_missed';

  return `
    <div class="report-thread ${statusClass}" style="cursor:pointer;" onclick="toggleReportThread(${r.id})">
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
          &middot; <i class="fas fa-comments"></i> View thread
        </div>
      </div>
    </div>
    <div id="reportPanel-${r.id}" class="report-panel" style="display:none;" onclick="event.stopPropagation()">
      <div id="reportMessages-${r.id}" class="report-messages"><div class="loading"><i class="fas fa-spinner fa-spin"></i></div></div>

      <div class="report-reply-row">
        <input type="text" id="reportReplyInput-${r.id}" placeholder="Reply to ${escapeHtml(r.name || 'customer')}..." onkeydown="if(event.key==='Enter') sendAdminReply(${r.id})">
        <button class="btn btn-primary" onclick="sendAdminReply(${r.id})"><i class="fas fa-paper-plane"></i></button>
      </div>

      ${isCreditReport && r.mac_address ? `
        <div class="report-credit-row">
          <span>Approve credit: ₱</span>
          <input type="number" id="reportCreditPesos-${r.id}" min="1" style="width:70px;" placeholder="amount">
          <button class="btn btn-secondary" onclick="approveReportCredit(${r.id})"><i class="fas fa-check-circle"></i> Approve &amp; add time</button>
        </div>
      ` : ''}

      <div class="report-actions">
        ${r.status !== 'resolved' ? `<button class="btn btn-secondary" onclick="resolveReport(${r.id})"><i class="fas fa-check"></i> Resolve</button>` : ''}
        ${r.status !== 'spam' ? `<button class="btn btn-secondary" onclick="markReportSpam(${r.id})"><i class="fas fa-ban"></i> Mark spam</button>` : ''}
        ${r.mac_address ? `<button class="btn btn-secondary" onclick="blockReportMac('${escapeHtml(r.mac_address)}')"><i class="fas fa-comment-slash"></i> Block chat</button>` : ''}
        ${r.mac_address ? `<button class="btn btn-secondary" onclick="viewCoinProof('${escapeHtml(r.mac_address)}')"><i class="fas fa-shield-halved"></i> Coin activity proof</button>` : ''}
        ${r.mac_address ? `<button class="btn btn-secondary" onclick="findSessionByMac('${escapeHtml(r.mac_address)}')"><i class="fas fa-magnifying-glass"></i> Find in Sessions</button>` : ''}
      </div>
    </div>
  `;
}

async function loadReportMessages(id) {
  const el = document.getElementById(`reportMessages-${id}`);
  if (!el) return;
  try {
    const data = await apiCall('GET', `/api/admin/reports/${id}/messages`);
    const report = reportsData.find((r) => r.id === id);
    const initialMsg = report ? `
      <div class="report-msg report-msg-customer">
        <div class="report-msg-bubble">${escapeHtml(report.message)}</div>
        <div class="report-msg-time">${new Date(report.created_at).toLocaleString()}</div>
      </div>` : '';
    const thread = (data.messages || []).map((m) => `
      <div class="report-msg report-msg-${m.sender}">
        <div class="report-msg-bubble">${escapeHtml(m.message)}</div>
        <div class="report-msg-time">${new Date(m.created_at).toLocaleString()}</div>
      </div>
    `).join('');
    el.innerHTML = initialMsg + thread;
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Could not load thread</div>';
  }
}

async function sendAdminReply(id) {
  const input = document.getElementById(`reportReplyInput-${id}`);
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  await apiCall('POST', `/api/admin/reports/${id}/reply`, { message });
  loadReportMessages(id);
}

async function approveReportCredit(id) {
  const input = document.getElementById(`reportCreditPesos-${id}`);
  const pesos = parseFloat(input.value);
  if (!pesos || pesos <= 0) return;
  if (!confirm(`Credit ₱${pesos} of time to this device's active session?`)) return;
  const data = await apiCall('POST', `/api/admin/reports/${id}/approve-credit`, { pesos });
  if (data.success) {
    loadReportMessages(id);
    loadReportsPage();
  } else {
    alert(data.message || 'Could not approve credit');
  }
}

async function viewCoinProof(mac) {
  const data = await apiCall('GET', `/api/admin/coin-pulse-log?mac=${encodeURIComponent(mac)}&hours=48`);
  const rows = data.pulses || [];
  const lines = rows.length
    ? rows.map((p) => `${new Date(p.received_at).toLocaleString()} - ₱${p.coin_value}`).join('\n')
    : 'No coin pulses received from this device in the last 48 hours - the hardware never sent a signal to the server in that window.';
  alert(`Coin activity proof for ${mac} (last 48h):\n\n${lines}`);
}

function findSessionByMac(mac) {
  navigateTo('sessions');
  setTimeout(() => {
    const input = document.getElementById('lsSearch');
    if (input) {
      input.value = mac;
      input.dispatchEvent(new Event('input'));
      if (typeof renderSessionsTable === 'function') renderSessionsTable();
    }
  }, 300);
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

function destroyReports() {
  clearInterval(reportThreadPollInterval);
}
