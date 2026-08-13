// ===== NETWORK DEVICES PAGE =====
let devAll = [];

async function loadNetworkDevicesPage() {
  const tbody = document.getElementById('devTable');
  if (!tbody) return;
  try {
    const data = await apiCall('GET', '/api/admin/network-devices');
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--accent-red);padding:24px;">${data.message || 'Failed to load devices'}</td></tr>`;
      return;
    }
    devAll = data.devices;
    document.getElementById('devTotalCount').textContent = data.summary.total;
    document.getElementById('devOnlineCount').textContent = data.summary.online;
    document.getElementById('devOfflineCount').textContent = data.summary.offline;
    populateDevTypeFilter();
    renderDevicesTable();
  } catch (e) {
    console.error('Network devices load error:', e);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--accent-red);padding:24px;">Failed to load devices. Refresh to try again.</td></tr>`;
  }
}

function populateDevTypeFilter() {
  const select = document.getElementById('devTypeFilter');
  const current = select.value;
  const types = [...new Set(devAll.map((d) => d.type))].sort();
  select.innerHTML = '<option value="">All Types</option>' + types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  select.value = current;
}

function devStatusBadge(status) {
  if (status === 'online') return `<span class="badge badge-green"><span class="status-dot online"></span> Online</span>`;
  return `<span class="badge badge-red">Offline</span>`;
}

// Real traffic (from a live tc class or MikroTik queue) shown as a
// human-readable total; anything without an active shaped session has no
// traffic source at all and shows an honest em dash, never a fabricated 0.
function devTrafficCell(bytes) {
  if (bytes === null || bytes === undefined) return '<span style="color:var(--text-muted);">&mdash;</span>';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function renderDevicesTable() {
  const tbody = document.getElementById('devTable');
  const summary = document.getElementById('devSummary');
  if (!tbody) return;

  const search = (document.getElementById('devSearch')?.value || '').toLowerCase().trim();
  const typeFilter = document.getElementById('devTypeFilter')?.value || '';
  const statusFilter = document.getElementById('devStatusFilter')?.value || '';

  const rows = devAll.filter((d) => {
    if (typeFilter && d.type !== typeFilter) return false;
    if (statusFilter && d.status !== statusFilter) return false;
    if (search && !((d.name || '').toLowerCase().includes(search) || (d.ip || '').toLowerCase().includes(search) || (d.mac || '').toLowerCase().includes(search))) return false;
    return true;
  });

  if (!devAll.length) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          <i class="fas fa-diagram-project"></i>
          <h3>No Network Devices Found</h3>
          <p>ZenFi has not detected any network devices yet.</p>
        </div>
      </td></tr>`;
    summary.textContent = 'Showing 0 of 0 devices';
    return;
  }

  if (!rows.length) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          <i class="fas fa-filter-circle-xmark"></i>
          <h3>No devices match your filters.</h3>
        </div>
      </td></tr>`;
    summary.textContent = `Showing 0 of ${devAll.length} devices`;
    return;
  }

  tbody.innerHTML = rows.map((d) => `
    <tr>
      <td>
        <div style="font-weight:700;color:var(--text-primary);">${escapeHtml(d.name)}</div>
        <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(d.vendor || '')}</div>
      </td>
      <td>${escapeHtml(d.type)}</td>
      <td>${devStatusBadge(d.status)}</td>
      <td style="font-family:monospace;font-size:12px;">${escapeHtml(d.ip || '-')}</td>
      <td style="font-family:monospace;font-size:12px;">${escapeHtml(d.mac)}</td>
      <td>${d.vlan_id ? `VLAN ${d.vlan_id}` : '-'}</td>
      <td>${devTrafficCell(d.traffic_bytes)}</td>
    </tr>
  `).join('');
  summary.textContent = `Showing ${rows.length} of ${devAll.length} devices`;
}
