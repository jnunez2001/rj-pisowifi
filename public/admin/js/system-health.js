// ===== SYSTEM HEALTH PAGE =====
// Real data only, all from services already built for other purposes:
// systemDiagnosticsService.js (the boot-time preflight check and its
// manual re-run endpoint), and telemetryService.js's hardware-metrics
// collector (os module + fs.statfsSync, no shelling out).
async function loadSystemHealth() {
  initNetworkChart();
  if (!networkStatsInterval) {
    pollNetworkStats();
    networkStatsInterval = setInterval(pollNetworkStats, 4000);
  }
  await Promise.all([loadPreflightChecks(), loadDiskSpace(), loadHardwareMetrics()]);
}

function destroySystemHealth() {
  if (networkStatsInterval) {
    clearInterval(networkStatsInterval);
    networkStatsInterval = null;
  }
  if (networkChart) {
    networkChart.destroy();
    networkChart = null;
  }
  if (shUptimeInterval) {
    clearInterval(shUptimeInterval);
    shUptimeInterval = null;
  }
}

// Small horizontal gauge bar (used for CPU/Memory/Disk) - green under 70%,
// orange 70-89%, red 90%+. Same "don't fabricate, just visualize the real
// number better" goal as the rest of this page.
function shGaugeColor(pct) {
  if (pct >= 90) return 'var(--accent-red)';
  if (pct >= 70) return 'var(--accent-orange)';
  return 'var(--accent-green)';
}

function shGaugeBar(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  return `<div style="flex:1;background:var(--bg-primary);border-radius:4px;height:8px;overflow:hidden;min-width:60px;">
    <div style="width:${clamped}%;background:${shGaugeColor(clamped)};height:100%;border-radius:4px;transition:width 0.5s;"></div>
  </div>`;
}

// ===== BANDWIDTH USAGE (moved here from the Dashboard) =====
let networkChart = null;
let networkStatsInterval = null;
const NETWORK_CHART_MAX_POINTS = 20;

function updateNetworkChartEmptyState() {
  const empty = document.getElementById('networkChartEmpty');
  const canvas = document.getElementById('networkChart');
  if (!empty || !canvas || !networkChart) return;
  const hasData = networkChart.data.datasets.some(ds => ds.data.some(v => v > 0));
  empty.style.display = hasData ? 'none' : 'flex';
  canvas.style.visibility = hasData ? 'visible' : 'hidden';
}

function initNetworkChart() {
  const canvas = document.getElementById('networkChart');
  if (!canvas || networkChart) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#888' : '#999';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

  networkChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Download (Mbps)',
          data: [],
          borderColor: '#1a9c63',
          backgroundColor: 'rgba(26,156,99,0.08)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 0
        },
        {
          label: 'Upload (Mbps)',
          data: [],
          borderColor: '#3d6d94',
          backgroundColor: 'rgba(61,109,148,0.08)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: true, labels: { color: textColor, boxWidth: 12 } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor, maxTicksLimit: 6 } },
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor } }
      }
    }
  });
  updateNetworkChartEmptyState();
}

async function pollNetworkStats() {
  try {
    const data = await apiCall('GET', '/api/admin/network-stats');
    if (!data.success) return;
    document.getElementById('currentDownload').textContent = data.download_mbps;
    document.getElementById('currentUpload').textContent = data.upload_mbps;

    if (!networkChart) return;
    const label = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    networkChart.data.labels.push(label);
    networkChart.data.datasets[0].data.push(data.download_mbps);
    networkChart.data.datasets[1].data.push(data.upload_mbps);
    if (networkChart.data.labels.length > NETWORK_CHART_MAX_POINTS) {
      networkChart.data.labels.shift();
      networkChart.data.datasets[0].data.shift();
      networkChart.data.datasets[1].data.shift();
    }
    networkChart.update('none');
    updateNetworkChartEmptyState();
  } catch (e) {}
}

async function loadPreflightChecks() {
  const el = document.getElementById('shChecks');
  if (!el) return;
  try {
    const data = await apiCall('GET', '/api/admin/diagnostics/last-boot');
    const report = data.success ? data.report : null;
    const scoreEl = document.getElementById('shHealthScore');
    const trendEl = document.getElementById('shHealthTrend');
    if (!report) {
      el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">No boot report yet - restart the server to run one.</div>';
      if (scoreEl) scoreEl.textContent = '--';
      if (trendEl) trendEl.textContent = 'No boot report yet';
      return;
    }
    if (scoreEl) {
      const allPassed = report.passCount === report.totalCount;
      scoreEl.textContent = `${report.passCount}/${report.totalCount}`;
      scoreEl.style.color = allPassed ? 'var(--accent-green)' : 'var(--accent-orange)';
    }
    if (trendEl) {
      const allPassed = report.passCount === report.totalCount;
      trendEl.innerHTML = allPassed
        ? '<i class="fas fa-circle-check" style="color:var(--accent-green);"></i> All checks passed'
        : `<i class="fas fa-triangle-exclamation" style="color:var(--accent-orange);"></i> ${report.totalCount - report.passCount} check(s) failing`;
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
      <div style="display:flex;align-items:center;gap:10px;margin:-8px 0 12px 24px;">${shGaugeBar(data.usePercent)}</div>
      ${data.low ? '<div style="font-size:12px;color:var(--accent-red);margin-top:8px;">Running low - see Settings &gt; Storage for retention options.</div>' : ''}
    `;
  } catch (e) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Could not load disk space</div>';
  }
}

let shUptimeInterval = null;
let shUptimeBaseMs = null; // Date.now() minus the server's own real uptime, so the tile can tick locally between polls instead of sitting frozen for 30s+.

function shFormatUptime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function shTickUptime() {
  const el = document.getElementById('shUptime');
  if (!el || shUptimeBaseMs === null) return;
  el.textContent = shFormatUptime((Date.now() - shUptimeBaseMs) / 1000);
}

async function loadHardwareMetrics() {
  const el = document.getElementById('shHardware');
  if (!el) return;
  try {
    const data = await apiCall('GET', '/api/admin/sysinfo');
    if (!data.success) { el.innerHTML = ''; return; }
    const s = data.sysinfo;

    shUptimeBaseMs = Date.now() - (s.uptime_seconds || 0) * 1000;
    shTickUptime();
    if (!shUptimeInterval) shUptimeInterval = setInterval(shTickUptime, 60000);

    const memBigEl = document.getElementById('shMemPercentBig');
    if (memBigEl) memBigEl.textContent = s.mem_percent;
    const memTrendEl = document.getElementById('shMemTrend');
    if (memTrendEl) {
      const usedGb = (s.used_mem / (1024 ** 3)).toFixed(1);
      const totalGb = (s.total_mem / (1024 ** 3)).toFixed(1);
      memTrendEl.textContent = `${usedGb} GB of ${totalGb} GB`;
    }

    const perCore = Array.isArray(s.cpu_usage_per_core) ? s.cpu_usage_per_core : [];
    const perCoreRows = perCore.map((pct, i) => `
      <div style="display:flex;align-items:center;gap:10px;margin:2px 0 2px 24px;">
        <span style="font-size:11px;color:var(--text-muted);width:44px;flex-shrink:0;">Core ${i + 1}</span>
        ${shGaugeBar(pct)}
        <span style="font-size:11px;color:var(--text-secondary);width:32px;text-align:right;flex-shrink:0;">${Math.round(pct)}%</span>
      </div>`).join('');

    el.innerHTML = `
      <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-microchip" style="color:var(--text-muted);width:14px;"></i> <span>CPU Usage</span></div><span class="zf3-list-value">${s.cpu_usage}% avg</span></div>
      ${perCoreRows || `<div style="display:flex;align-items:center;gap:10px;margin:-8px 0 12px 24px;">${shGaugeBar(s.cpu_usage)}</div>`}
      <div class="zf3-list-row" style="margin-top:12px;"><div class="zf3-list-left"><i class="fas fa-memory" style="color:var(--text-muted);width:14px;"></i> <span>Memory</span></div><span class="zf3-list-value">${s.mem_percent}%</span></div>
      <div style="display:flex;align-items:center;gap:10px;margin:-8px 0 12px 24px;">${shGaugeBar(s.mem_percent)}</div>
      <div class="zf3-list-row"><div class="zf3-list-left"><i class="fas fa-server" style="color:var(--text-muted);width:14px;"></i> <span>Platform</span></div><span class="zf3-list-value" style="font-size:12px;">${s.platform}</span></div>
    `;
  } catch (e) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Could not load hardware metrics</div>';
  }
}
