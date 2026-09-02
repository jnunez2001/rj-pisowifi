// ===== LOGS PAGE =====
// Real merged feed - watchdog_events + network_config_versions, both
// already-existing tables. See GET /api/admin/logs (admin.js) for the
// merge/sort logic.
async function loadLogsPage() {
  const el = document.getElementById('logsBody');
  if (!el) return;
  try {
    const data = await apiCall('GET', '/api/admin/logs?limit=50');
    if (!data.success || !data.logs || data.logs.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No events recorded yet</div>';
      return;
    }
    const dotColor = { info: 'var(--text-muted)', warning: 'var(--accent-orange)', critical: 'var(--accent-red)' };
    el.innerHTML = data.logs.map((l) => `
      <div class="zf3-activity-row">
        <div class="zf3-activity-dot" style="background:${dotColor[l.level] || 'var(--text-muted)'};"></div>
        <div style="min-width:0;">
          <div class="zf3-activity-text">${l.message}</div>
          <div class="zf3-activity-meta">${l.detail ? l.detail + ' · ' : ''}${new Date(l.time).toLocaleString()}</div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">Could not load logs</div>';
  }
}

// Downloads the full merged log feed as CSV - for sending along with a
// support request when something needs debugging. Same authenticated-
// fetch-then-blob pattern as about.js's downloadSupportBundle().
async function exportLogs() {
  try {
    const res = await fetch(`${API}/logs/export?limit=1000`, {
      headers: { 'password': authToken }
    });
    if (res.status === 401) { handleAuthFailure(); return; }
    if (!res.ok) { showToast('Could not export logs.', 'error'); return; }
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `starkfi-logs-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Logs exported!');
  } catch (e) {
    showToast('Could not export logs.', 'error');
  }
}
