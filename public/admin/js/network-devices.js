// ===== NETWORK DEVICES PAGE =====
let devAll = [];
let devGroups = [];
let devCurrentPage = 1;
const DEV_PAGE_SIZE = 25;

async function loadNetworkDevicesPage() {
  const tbody = document.getElementById('devTable');
  if (!tbody) return;
  if (document.getElementById('devAutoRefreshToggle')?.checked !== false) startDevAutoRefresh();
  try {
    const [devicesData, groupsData] = await Promise.all([
      apiCall('GET', '/api/admin/network-devices'),
      apiCall('GET', '/api/admin/network-devices/groups'),
    ]);
    if (!devicesData.success) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--accent-red);padding:24px;">${devicesData.message || 'Failed to load devices'}</td></tr>`;
      return;
    }
    devAll = devicesData.devices;
    devGroups = groupsData.success ? groupsData.groups : [];
    document.getElementById('devTotalCount').textContent = devicesData.summary.total;
    document.getElementById('devOnlineCount').textContent = devicesData.summary.online;
    document.getElementById('devOfflineCount').textContent = devicesData.summary.offline;
    populateDevTypeFilter();
    populateDevGroupFilter();
    renderDevicesTable();
    renderDevCharts();
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

function populateDevGroupFilter() {
  const select = document.getElementById('devGroupFilter');
  const current = select.value;
  select.innerHTML = '<option value="">All Groups</option>' + devGroups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
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
  const groupFilter = document.getElementById('devGroupFilter')?.value || '';

  const rows = devAll.filter((d) => {
    if (typeFilter && d.type !== typeFilter) return false;
    if (statusFilter && d.status !== statusFilter) return false;
    if (groupFilter && String(d.group_id || '') !== groupFilter) return false;
    if (search && !((d.name || '').toLowerCase().includes(search) || (d.ip || '').toLowerCase().includes(search) || (d.mac || '').toLowerCase().includes(search))) return false;
    return true;
  });

  if (!devAll.length) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          <i class="fas fa-diagram-project"></i>
          <h3>No Network Devices Found</h3>
          <p>StarkFi has not detected any network devices yet.</p>
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
    document.getElementById('devPageInfo').textContent = 'Page 1 of 1';
    document.getElementById('devPrevPage').disabled = true;
    document.getElementById('devNextPage').disabled = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / DEV_PAGE_SIZE));
  if (devCurrentPage > totalPages) devCurrentPage = totalPages;
  const pageRows = rows.slice((devCurrentPage - 1) * DEV_PAGE_SIZE, devCurrentPage * DEV_PAGE_SIZE);
  document.getElementById('devPageInfo').textContent = `Page ${devCurrentPage} of ${totalPages}`;
  document.getElementById('devPrevPage').disabled = devCurrentPage <= 1;
  document.getElementById('devNextPage').disabled = devCurrentPage >= totalPages;

  tbody.innerHTML = pageRows.map((d) => `
    <tr style="cursor:pointer;" onclick="openDevDetail('${d.mac}')">
      <td>
        <div style="font-weight:700;color:var(--text-primary);">${escapeHtml(d.name)}</div>
        <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(d.vendor || '')}${d.group_name ? ` &middot; ${escapeHtml(d.group_name)}` : ''}</div>
      </td>
      <td>${escapeHtml(d.type)}</td>
      <td>${devStatusBadge(d.status)}</td>
      <td style="font-family:monospace;font-size:12px;">${escapeHtml(d.ip || '-')}</td>
      <td style="font-family:monospace;font-size:12px;">${escapeHtml(d.mac)}</td>
      <td>${d.vlan_id ? `VLAN ${d.vlan_id}` : '-'}</td>
      <td>${devTrafficCell(d.traffic_bytes)}</td>
    </tr>
  `).join('');
  summary.textContent = `Showing ${pageRows.length} of ${rows.length} devices${rows.length !== devAll.length ? ` (${devAll.length} total)` : ''}`;
}

function changeDevPage(delta) {
  devCurrentPage += delta;
  renderDevicesTable();
}

// ===== DEVICE DETAIL =====
let devDetailMac = null;

function setDevDetailTab(tab, el) {
  document.querySelectorAll('#devDetailTabs .zf3-tab').forEach((t) => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('devDetailOverview').style.display = tab === 'overview' ? 'block' : 'none';
  document.getElementById('devDetailNetwork').style.display = tab === 'network' ? 'block' : 'none';
  document.getElementById('devDetailTraffic').style.display = tab === 'traffic' ? 'block' : 'none';
  document.getElementById('devDetailHistory').style.display = tab === 'history' ? 'block' : 'none';
  if (tab === 'history') loadDeviceHistory();
}

async function loadDeviceHistory() {
  const block = document.getElementById('devdHistoryBlock');
  if (!devDetailMac) return;
  block.innerHTML = `<div class="loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div>`;
  try {
    const data = await apiCall('GET', `/api/admin/network-devices/${devDetailMac}/history`);
    if (!data.success || !data.history.length) {
      block.innerHTML = `<p style="color:var(--text-muted);">No recorded events for this device yet.</p>`;
      return;
    }
    block.innerHTML = data.history.map((h) => `
      <div style="padding:8px 0;border-bottom:1px solid var(--border-color);">
        <div style="font-weight:600;">${escapeHtml(h.event_type.replace(/_/g, ' '))}</div>
        <div style="color:var(--text-muted);">${escapeHtml(h.details || '')}</div>
        <div style="color:var(--text-muted);font-size:11px;">${new Date(h.created_at + 'Z').toLocaleString()}</div>
      </div>
    `).join('');
  } catch (e) {
    block.innerHTML = `<p style="color:var(--accent-red);">Failed to load history.</p>`;
  }
}

function openDevDetail(mac) {
  const d = devAll.find((x) => x.mac === mac);
  if (!d) return;
  devDetailMac = mac;

  document.getElementById('devDetailName').textContent = d.name;
  document.getElementById('devDetailSub').textContent = d.mac;

  document.querySelectorAll('#devDetailTabs .zf3-tab').forEach((t) => t.classList.remove('active'));
  document.querySelector('#devDetailTabs .zf3-tab').classList.add('active');
  setDevDetailTab('overview', document.querySelector('#devDetailTabs .zf3-tab'));

  document.getElementById('devdType').textContent = d.type;
  document.getElementById('devdStatus').textContent = d.status === 'online' ? 'Online' : 'Offline';
  document.getElementById('devdVendor').textContent = d.vendor || 'Unknown';
  document.getElementById('devdMac').textContent = d.mac;

  const accessEl = document.getElementById('devdAccess');
  accessEl.textContent = d.is_blocked ? 'Blocked' : 'Allowed';
  accessEl.style.color = d.is_blocked ? 'var(--accent-red)' : 'var(--accent-green)';
  const blockBtn = document.getElementById('devdBlockBtn');
  blockBtn.innerHTML = d.is_blocked ? '<i class="fas fa-check"></i> Unblock' : '<i class="fas fa-ban"></i> Block';
  blockBtn.className = d.is_blocked ? 'btn btn-secondary' : 'btn btn-danger';

  const groupSelect = document.getElementById('devdGroupSelect');
  groupSelect.innerHTML = '<option value="">No group</option>' + devGroups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
  groupSelect.value = d.group_id || '';

  document.getElementById('devdIp').textContent = d.ip || 'Unavailable';
  document.getElementById('devdVlan').textContent = d.vlan_id ? `VLAN ${d.vlan_id}` : 'Not verified';

  const trafficBlock = document.getElementById('devdTrafficBlock');
  if (d.traffic_bytes !== null && d.traffic_bytes !== undefined) {
    trafficBlock.innerHTML = `
      <div class="zf3-wan-item-label">Total (this session)</div>
      <div class="zf3-wan-item-value">${devTrafficCell(d.traffic_bytes)}</div>
      <p style="color:var(--text-muted);font-size:12px;margin-top:8px;">Cumulative total since this device's current session started. Not a historical/per-period breakdown.</p>
    `;
  } else {
    trafficBlock.innerHTML = `
      <div class="empty-state" style="padding:16px;">
        <i class="fas fa-gauge-high"></i>
        <h3>Traffic not available</h3>
        <p>This device has no active shaped session right now, so there's no live traffic counter for it.</p>
      </div>
    `;
  }

  document.getElementById('devDetailModal').classList.add('show');
}

async function toggleDeviceBlock() {
  if (!devDetailMac) return;
  const d = devAll.find((x) => x.mac === devDetailMac);
  if (!d) return;
  const action = d.is_blocked ? 'unblock' : 'block';
  if (action === 'block' && !confirm(`Block "${d.name}" from the network? This takes effect immediately.`)) return;
  try {
    const data = await apiCall('POST', `/api/admin/network-devices/${devDetailMac}/${action}`);
    if (!data.success) {
      showToast(data.message || `Failed to ${action} device`, 'error');
      return;
    }
    showToast(action === 'block' ? 'Device blocked' : 'Device unblocked');
    await loadNetworkDevicesPage();
    openDevDetail(devDetailMac);
  } catch (e) {
    showToast(`Failed to ${action} device`, 'error');
  }
}

function openRenameDevice() {
  if (!devDetailMac) return;
  const d = devAll.find((x) => x.mac === devDetailMac);
  document.getElementById('renameDeviceName').value = d ? d.name : '';
  openModal('renameDeviceModal');
}

async function submitRenameDevice() {
  const name = document.getElementById('renameDeviceName').value.trim();
  if (!devDetailMac) return;
  try {
    // Reuses the existing Network > Devices "Name Your Devices" endpoint -
    // same client_labels table, so a rename here and a rename there stay
    // consistent instead of two separate naming systems.
    const data = await apiCall('POST', '/api/admin/network/client-labels', { mac_address: devDetailMac, label: name });
    if (!data.success) {
      showToast(data.message || 'Failed to rename device', 'error');
      return;
    }
    closeModal('renameDeviceModal');
    closeModal('devDetailModal');
    showToast('Device renamed');
    loadNetworkDevicesPage();
  } catch (e) {
    showToast('Failed to rename device', 'error');
  }
}

// ===== EXPORT =====
function exportDevicesCsv() {
  if (!devAll.length) {
    showToast('No devices to export', 'error');
    return;
  }
  const header = ['Device', 'Type', 'Status', 'IP', 'MAC', 'VLAN', 'Vendor', 'Traffic (bytes)'];
  const rows = devAll.map((d) => [
    d.name, d.type, d.status, d.ip || '', d.mac, d.vlan_id || '', d.vendor || '', d.traffic_bytes ?? '',
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `starkfi-network-devices-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== DEVICE GROUPS =====
function openManageGroups() {
  document.getElementById('newGroupName').value = '';
  renderGroupsList();
  openModal('manageGroupsModal');
}

function renderGroupsList() {
  const list = document.getElementById('groupsList');
  if (!devGroups.length) {
    list.innerHTML = `<p style="color:var(--text-muted);font-size:13px;">No groups yet. Add one above.</p>`;
    return;
  }
  list.innerHTML = devGroups.map((g) => {
    const count = devAll.filter((d) => d.group_id === g.id).length;
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-color);">
        <div>
          <div style="font-weight:600;">${escapeHtml(g.name)}</div>
          <div style="font-size:12px;color:var(--text-muted);">${count} device${count === 1 ? '' : 's'}</div>
        </div>
        <button class="btn btn-sm btn-danger" onclick="deleteDeviceGroup(${g.id}, '${escapeHtml(g.name)}')"><i class="fas fa-trash"></i></button>
      </div>
    `;
  }).join('');
}

async function submitCreateGroup() {
  const name = document.getElementById('newGroupName').value.trim();
  if (!name) {
    showToast('Enter a group name', 'error');
    return;
  }
  try {
    const data = await apiCall('POST', '/api/admin/network-devices/groups', { name });
    if (!data.success) {
      showToast(data.message || 'Failed to create group', 'error');
      return;
    }
    document.getElementById('newGroupName').value = '';
    await loadNetworkDevicesPage();
    renderGroupsList();
  } catch (e) {
    showToast('Failed to create group', 'error');
  }
}

async function deleteDeviceGroup(id, name) {
  if (!confirm(`Delete the "${name}" group? Devices in it will just become ungrouped.`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/network-devices/groups/${id}`);
    if (!data.success) {
      showToast(data.message || 'Failed to delete group', 'error');
      return;
    }
    await loadNetworkDevicesPage();
    renderGroupsList();
  } catch (e) {
    showToast('Failed to delete group', 'error');
  }
}

async function changeDeviceGroup() {
  if (!devDetailMac) return;
  const groupId = document.getElementById('devdGroupSelect').value || null;
  try {
    const data = await apiCall('POST', `/api/admin/network-devices/${devDetailMac}/group`, { group_id: groupId });
    if (!data.success) {
      showToast(data.message || 'Failed to update group', 'error');
      return;
    }
    showToast('Group updated');
    loadNetworkDevicesPage();
  } catch (e) {
    showToast('Failed to update group', 'error');
  }
}

// ===== AUTO REFRESH =====
// Polling, not a true real-time push (no websocket/SSE infrastructure
// exists elsewhere in this app to build that on) - same pattern the Vendo
// Devices page (devices.js) already uses. Matches the mockup's "Auto
// refresh: On" concept honestly: it's a periodic reload, not live push.
let devRefreshInterval = null;

function startDevAutoRefresh() {
  if (devRefreshInterval) clearInterval(devRefreshInterval);
  devRefreshInterval = setInterval(loadNetworkDevicesPage, 30000);
}

function toggleDevAutoRefresh() {
  const on = document.getElementById('devAutoRefreshToggle').checked;
  if (on) {
    startDevAutoRefresh();
  } else if (devRefreshInterval) {
    clearInterval(devRefreshInterval);
    devRefreshInterval = null;
  }
}

function destroyNetworkDevices() {
  if (devRefreshInterval) {
    clearInterval(devRefreshInterval);
    devRefreshInterval = null;
  }
  if (devTypeChart) { devTypeChart.destroy(); devTypeChart = null; }
  if (devVlanChart) { devVlanChart.destroy(); devVlanChart = null; }
}

// ===== CHARTS (real counts only - see analytics.js's renderBreakdownChart
// for the same donut+legend pattern this matches) =====
let devTypeChart = null;
let devVlanChart = null;
const DEV_CHART_COLORS = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#64748b', '#db2777'];

function renderDonutChart(canvasId, legendId, chartVar, entries) {
  const canvas = document.getElementById(canvasId);
  const legend = document.getElementById(legendId);
  if (!canvas) return null;
  if (chartVar) chartVar.destroy();
  if (!entries.length) {
    legend.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No devices yet</div>';
    return null;
  }
  const chart = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: entries.map((e) => e.label),
      datasets: [{ data: entries.map((e) => e.count), backgroundColor: DEV_CHART_COLORS, borderWidth: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { display: false } } },
  });
  legend.innerHTML = entries.map((e, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:12px;">
      <span style="display:flex;align-items:center;gap:8px;color:var(--text-primary);"><span style="width:8px;height:8px;border-radius:50%;background:${DEV_CHART_COLORS[i % DEV_CHART_COLORS.length]};display:inline-block;"></span>${escapeHtml(e.label)}</span>
      <span style="color:var(--text-secondary);">${e.count}</span>
    </div>
  `).join('');
  return chart;
}

function renderDevCharts() {
  const typeCounts = {};
  for (const d of devAll) typeCounts[d.type] = (typeCounts[d.type] || 0) + 1;
  const typeEntries = Object.entries(typeCounts).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  devTypeChart = renderDonutChart('devTypeChart', 'devTypeLegend', devTypeChart, typeEntries);

  const vlanCounts = {};
  let noVlanCount = 0;
  for (const d of devAll) {
    if (d.vlan_id) vlanCounts[`VLAN ${d.vlan_id}`] = (vlanCounts[`VLAN ${d.vlan_id}`] || 0) + 1;
    else noVlanCount++;
  }
  const vlanEntries = Object.entries(vlanCounts).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  if (noVlanCount) vlanEntries.push({ label: 'No VLAN detected', count: noVlanCount });
  devVlanChart = renderDonutChart('devVlanChart', 'devVlanLegend', devVlanChart, vlanEntries);
}
