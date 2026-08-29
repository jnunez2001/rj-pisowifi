// ===== REPORTS PAGE =====
// Customer-submitted issues from the portal's "Report a Problem" button
// (public/portal/assets/js/portal.js's submitReport()). Backed by
// customer_reports table, see GET /api/admin/reports (admin.js).
let reportsFilter = 'open';

function updateReportsFilterButtons() {
  const openBtn = document.getElementById('reportsFilterOpen');
  const allBtn = document.getElementById('reportsFilterAll');
  if (openBtn) openBtn.style.outline = reportsFilter === 'open' ? '2px solid var(--accent-blue, #3b82f6)' : 'none';
  if (allBtn) allBtn.style.outline = reportsFilter === '' ? '2px solid var(--accent-blue, #3b82f6)' : 'none';
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
  try {
    const qs = reportsFilter ? `?status=${reportsFilter}` : '';
    const data = await apiCall('GET', `/api/admin/reports${qs}`);
    if (!data.success || !data.reports || data.reports.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No reports</div>';
      return;
    }
    el.innerHTML = data.reports.map((r) => `
      <div class="zf3-activity-row">
        <div class="zf3-activity-dot" style="background:${r.status === 'open' ? 'var(--accent-orange)' : 'var(--text-muted)'};"></div>
        <div style="min-width:0;flex:1;">
          <div class="zf3-activity-text">${escapeHtml(r.message)}</div>
          <div class="zf3-activity-meta">
            ${r.voucher_code ? escapeHtml(r.voucher_code) + ' · ' : ''}${r.mac_address ? escapeHtml(r.mac_address) + ' · ' : ''}${new Date(r.created_at).toLocaleString()}
          </div>
        </div>
        ${r.status === 'open'
          ? `<button class="btn btn-secondary" onclick="resolveReport(${r.id})">Mark resolved</button>`
          : '<span style="color:var(--text-muted);font-size:12px;">Resolved</span>'}
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">Could not load reports</div>';
  }
}

async function resolveReport(id) {
  await apiCall('POST', `/api/admin/reports/${id}/resolve`);
  loadReportsPage();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
