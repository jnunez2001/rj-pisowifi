// ===== NETWORK DEVICES PAGE =====
let devAll = [];
let devGroups = [];

async function loadNetworkDevicesPage() {
  const tbody = document.getElementById('devTable');
  if (!tbody) return;
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
  summary.textContent = `Showing ${rows.length} of ${devAll.length} devices`;
}

// ===== DEVICE DETAIL =====
let devDetailMac = null;

function setDevDetailTab(tab, el) {
  document.querySelectorAll('#devDetailTabs .zf3-tab').forEach((t) => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('devDetailOverview').style.display = tab === 'overview' ? 'block' : 'none';
  document.getElementById('devDetailNetwork').style.display = tab === 'network' ? 'block' : 'none';
  document.getElementById('devDetailTraffic').style.display = tab === 'traffic' ? 'block' : 'none';
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
  a.download = `zenfi-network-devices-${new Date().toISOString().slice(0, 10)}.csv`;
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
