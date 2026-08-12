// ===== ALERTS PAGE =====
// Derived from real, already-running checks (watchdog self-heal, WAN
// health scoring, disk space) - see GET /api/admin/alerts (admin.js).
// No alert here is synthetic or stored on its own; it's recomputed live
// each time this loads.
async function loadAlertsPage() {
  const el = document.getElementById('alertsBody');
  if (!el) return;
  try {
    const data = await apiCall('GET', '/api/admin/alerts');
    if (!data.success || !data.alerts || data.alerts.length === 0) {
      el.innerHTML = `
        <div style="text-align:center;color:var(--text-muted);padding:32px 24px;">
          <i class="fas fa-circle-check" style="font-size:22px;color:var(--accent-green);margin-bottom:10px;display:block;"></i>
          No active alerts - everything checked out clean.
        </div>`;
      return;
    }
    const iconColor = { critical: 'var(--accent-red)', warning: 'var(--accent-orange)' };
    el.innerHTML = data.alerts.map((a) => `
      <div class="zf3-activity-row">
        <div class="zf3-activity-dot" style="background:${iconColor[a.severity] || 'var(--accent-orange)'};"></div>
        <div style="min-width:0;">
          <div class="zf3-activity-text">${a.title}</div>
          <div class="zf3-activity-meta">${a.detail} · ${new Date(a.time).toLocaleString()}</div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">Could not load alerts</div>';
  }
}
