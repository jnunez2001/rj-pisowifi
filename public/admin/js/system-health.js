// ===== SYSTEM HEALTH PAGE =====
// Real data only, all from services already built for other purposes:
// systemDiagnosticsService.js (the boot-time preflight check and its
// manual re-run endpoint), and telemetryService.js's hardware-metrics
// collector (os module + fs.statfsSync, no shelling out).
async function loadSystemHealth() {
  await Promise.all([loadPreflightChecks(), loadDiskSpace(), loadHardwareMetrics()]);
}

async function loadPreflightChecks() {
  const el = document.getElementById('shChecks');
  if (!el) return;
  try {
    const data = await apiCall('GET', '/api/admin/diagnostics/last-boot');
    const report = data.success ? data.report : null;
    if (!report) {
      el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">No boot report yet - restart the server to run one.</div>';
      return;
    }
    el.innerHTML = `
      <div style="margin-bottom:14px;font-size:13px;color:var(--text-secondary);">
        ${report.passCount}/${report.totalCount} checks passed
      </div>
    ` + report.results.map((r) => `
      <div class="zf3-list-row">
        <div class="zf3-list-left">
          <i class="fas ${r.pass ? 'fa-circle-check' : 'fa-circle-xmark'}" style="color:${r.pass ? 'var(--accent-green)' : 'var(--accent-red)'};width:14px;"></i>
          <span>${r.label}</span>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin:-4px 0 8px 24px;">${r.detail}</div>
    `).join('');
  } catch (e) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Could not load preflight checks</div>';
  }
}

async function loadDiskSpace() {
  const el = document.getElementById('shDisk');
  if (!el) return;
  try {
    const data = await apiCall('GET', '/api/admin/disk-space');
    if (!data.success || !data.checked) {
      el.innerHTML = `<div style="font-size:13px;color:var(--text-muted);">${(data && data.reason) || 'Not available on this platform'}</div>`;
      return;
    }
    const color = data.low ? 'var(--accent-red)' : 'var(--text-primary)';
    el.innerHTML = `
      <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-hard-drive" style="color:var(--text-muted);width:14px;"></i> <span>Available</span></div><span class="zf3-list-value" style="color:${color};">${data.availMb} MB</span></div>
      <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-chart-pie" style="color:var(--text-muted);width:14px;"></i> <span>Used</span></div><span class="zf3-list-value">${data.usePercent}%</span></div>
      ${data.low ? '<div style="font-size:12px;color:var(--accent-red);margin-top:8px;">Running low - see Settings &gt; Storage for retention options.</div>' : ''}
    `;
  } catch (e) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Could not load disk space</div>';
  }
}

async function loadHardwareMetrics() {
  const el = document.getElementById('shHardware');
  if (!el) return;
  try {
    const data = await apiCall('GET', '/api/admin/sysinfo');
    if (!data.success) { el.innerHTML = ''; return; }
    const s = data.sysinfo;
    el.innerHTML = `
      <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-microchip" style="color:var(--text-muted);width:14px;"></i> <span>CPU Usage</span></div><span class="zf3-list-value">${s.cpu_usage}%</span></div>
      <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-memory" style="color:var(--text-muted);width:14px;"></i> <span>Memory</span></div><span class="zf3-list-value">${s.mem_percent}%</span></div>
      <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-server" style="color:var(--text-muted);width:14px;"></i> <span>Platform</span></div><span class="zf3-list-value" style="font-size:12px;">${s.platform}</span></div>
    `;
  } catch (e) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Could not load hardware metrics</div>';
  }
}
