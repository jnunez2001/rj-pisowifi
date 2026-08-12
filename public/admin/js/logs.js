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
