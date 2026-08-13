// ===== ACCESS POINTS PAGE (v1: manual registry + real reachability) =====
let apAll = [];
let apAllSites = [];
let apEditingId = null;
let apDetailId = null;

async function loadAccessPointsPage() {
  await loadSitesForAp();
  await loadApList();
}

async function loadSitesForAp() {
  try {
    const data = await apiCall('GET', '/api/admin/sites');
    apAllSites = (data.success && data.sites) ? data.sites : [];
  } catch (e) {
    apAllSites = [];
  }
}

async function loadApList() {
  const tbody = document.getElementById('apTable');
  if (!tbody) return;
  try {
    const data = await apiCall('GET', '/api/admin/access-points');
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--accent-red);padding:24px;">${data.message || 'Failed to load access points'}</td></tr>`;
      return;
    }
    apAll = data.accessPoints;
    renderApSummary();
    renderApTable();
  } catch (e) {
    console.error('Access points load error:', e);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--accent-red);padding:24px;">Failed to load access points. Refresh to try again.</td></tr>`;
  }
}

function renderApSummary() {
  const total = apAll.length;
  const online = apAll.filter(a => a.status === 'online').length;
  const offline = apAll.filter(a => a.status === 'offline').length;
  const unknown = total - online - offline;
  document.getElementById('apTotalCount').textContent = total;
  document.getElementById('apOnlineCount').textContent = online;
  document.getElementById('apOfflineCount').textContent = offline;
  document.getElementById('apUnknownCount').textContent = unknown;
}

function apStatusBadge(status) {
  if (status === 'online') return `<span class="badge badge-green"><span class="status-dot online"></span> Online</span>`;
  if (status === 'offline') return `<span class="badge badge-red">Offline</span>`;
  return `<span class="badge badge-blue">Not Checked Yet</span>`;
}

function renderApTable() {
  const tbody = document.getElementById('apTable');
  const summary = document.getElementById('apSummary');
  if (!tbody) return;

  const search = (document.getElementById('apSearch')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('apStatusFilter')?.value || '';

  let rows = apAll.filter(a => {
    if (statusFilter && a.status !== statusFilter) return false;
    if (search && !(a.name.toLowerCase().includes(search) || (a.ip_address || '').toLowerCase().includes(search) || (a.mac_address || '').toLowerCase().includes(search))) return false;
    return true;
  });

  if (!apAll.length) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          <i class="fas fa-wifi"></i>
          <h3>No Access Points Found</h3>
          <p>ZenFi has not been told about any access points yet.</p>
          <button class="btn btn-primary" onclick="openAddAp()"><i class="fas fa-plus"></i> Add AP Manually</button>
        </div>
      </td></tr>`;
    summary.textContent = 'Showing 0 of 0 access points';
    return;
  }

  if (!rows.length) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          <i class="fas fa-filter-circle-xmark"></i>
          <h3>No access points match your filters.</h3>
          <button class="btn btn-secondary" onclick="clearApFilters()">Clear Filters</button>
        </div>
      </td></tr>`;
    summary.textContent = `Showing 0 of ${apAll.length} access points`;
    return;
  }

  tbody.innerHTML = rows.map(a => `
    <tr style="cursor:pointer;" onclick="openApDetail(${a.id})">
      <td>
        <div style="font-weight:700;color:var(--text-primary);">${escapeHtml(a.name)}</div>
        <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(a.vendor || '')}${a.model ? ' · ' + escapeHtml(a.model) : ''}</div>
      </td>
      <td>${apStatusBadge(a.status)}</td>
      <td style="font-family:monospace;font-size:12px;">${escapeHtml(a.ip_address || '-')}</td>
      <td style="font-family:monospace;font-size:12px;">${escapeHtml(a.mac_address || '-')}</td>
      <td>${escapeHtml(a.site_name || '-')}</td>
      <td style="font-size:12px;">${a.last_seen_at ? new Date(a.last_seen_at.replace(' ', 'T') + 'Z').toLocaleString() : 'Never'}</td>
      <td onclick="event.stopPropagation();">
        <div style="display:flex;gap:6px;">
          <button class="btn btn-sm btn-secondary btn-icon" onclick="pingAp(${a.id})" title="Ping"><i class="fas fa-satellite-dish"></i></button>
          <button class="btn btn-sm btn-secondary btn-icon" onclick="openApDetail(${a.id})" title="View"><i class="fas fa-eye"></i></button>
          <button class="btn btn-sm btn-secondary btn-icon" onclick="openEditAp(${a.id})" title="Edit"><i class="fas fa-pen"></i></button>
          <button class="btn btn-sm btn-danger btn-icon" onclick="deleteAp(${a.id})" title="Remove"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>
  `).join('');

  summary.textContent = `Showing ${rows.length} of ${apAll.length} access points`;
}

function clearApFilters() {
  document.getElementById('apSearch').value = '';
  document.getElementById('apStatusFilter').value = '';
  renderApTable();
}

function populateApSiteSelect() {
  const select = document.getElementById('apSiteId');
  select.innerHTML = '<option value="">No site</option>' + apAllSites.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
}

function resetApForm() {
  apEditingId = null;
  document.getElementById('apModalTitle').textContent = 'Add Access Point';
  document.getElementById('apName').value = '';
  document.getElementById('apIp').value = '';
  document.getElementById('apMac').value = '';
  document.getElementById('apVendor').value = '';
  document.getElementById('apModel').value = '';
  populateApSiteSelect();
  document.getElementById('apNotes').value = '';
}

function openAddAp() {
  resetApForm();
  document.getElementById('apModal').classList.add('show');
}

function openEditAp(id) {
  const a = apAll.find(x => x.id === id);
  if (!a) return;
  resetApForm();
  apEditingId = id;
  document.getElementById('apModalTitle').textContent = 'Edit Access Point';
  document.getElementById('apName').value = a.name;
  document.getElementById('apIp').value = a.ip_address || '';
  document.getElementById('apMac').value = a.mac_address || '';
  document.getElementById('apVendor').value = a.vendor || '';
  document.getElementById('apModel').value = a.model || '';
  populateApSiteSelect();
  if (a.site_id) document.getElementById('apSiteId').value = a.site_id;
  document.getElementById('apNotes').value = a.notes || '';
  document.getElementById('apModal').classList.add('show');
}

async function saveAp() {
  const name = document.getElementById('apName').value.trim();
  if (!name) { showToast('AP name is required.', 'error'); return; }

  const payload = {
    name,
    ip_address: document.getElementById('apIp').value.trim(),
    mac_address: document.getElementById('apMac').value.trim(),
    vendor: document.getElementById('apVendor').value.trim(),
    model: document.getElementById('apModel').value.trim(),
    site_id: document.getElementById('apSiteId').value || null,
    notes: document.getElementById('apNotes').value.trim(),
  };

  const btn = document.getElementById('saveApBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

  try {
    const data = apEditingId
      ? await apiCall('PATCH', `/api/admin/access-points/${apEditingId}`, payload)
      : await apiCall('POST', '/api/admin/access-points', payload);

    if (data.success) {
      showToast(apEditingId ? 'Access point updated!' : 'Access point added!', 'success');
      closeModal('apModal');
      loadApList();
    } else {
      showToast(data.message || 'Unable to save access point.', 'error');
    }
  } catch (e) {
    showToast('Unable to save access point.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Save Access Point';
  }
}

async function pingAp(id) {
  try {
    const data = await apiCall('POST', `/api/admin/access-points/${id}/ping`);
    if (data.success) {
      showToast(data.accessPoint.status === 'online' ? 'AP is online.' : 'AP did not respond.', data.accessPoint.status === 'online' ? 'success' : 'warning');
      const idx = apAll.findIndex(a => a.id === id);
      if (idx !== -1) apAll[idx] = data.accessPoint;
      renderApSummary();
      renderApTable();
    } else {
      showToast(data.message || 'Unable to ping this AP.', 'error');
    }
  } catch (e) {
    showToast('Unable to ping this AP.', 'error');
  }
}

async function deleteAp(id) {
  const a = apAll.find(x => x.id === id);
  if (!confirm(`Remove access point "${a ? a.name : ''}"? This cannot be undone.`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/access-points/${id}`);
    if (data.success) {
      showToast('Access point removed.', 'success');
      loadApList();
    } else {
      showToast(data.message || 'Unable to remove access point.', 'error');
    }
  } catch (e) {
    showToast('Unable to remove access point.', 'error');
  }
}

// ===== DETAIL =====
function openApDetail(id) {
  const a = apAll.find(x => x.id === id);
  if (!a) return;
  apDetailId = id;
  renderApDetail(a);
  document.getElementById('apDetailModal').classList.add('show');
}

function renderApDetail(a) {
  document.getElementById('apDetailName').textContent = a.name;
  document.getElementById('apDetailSub').innerHTML = apStatusBadge(a.status);
  document.getElementById('apdIp').textContent = a.ip_address || '-';
  document.getElementById('apdMac').textContent = a.mac_address || '-';
  document.getElementById('apdVendor').textContent = `${a.vendor || '-'}${a.model ? ' ' + a.model : ''}`;
  document.getElementById('apdSite').textContent = a.site_name || '-';
  document.getElementById('apdLastSeen').textContent = a.last_seen_at ? new Date(a.last_seen_at.replace(' ', 'T') + 'Z').toLocaleString() : 'Never';
  document.getElementById('apdLatency').textContent = (a.last_latency_ms !== null && a.last_latency_ms !== undefined) ? `${a.last_latency_ms} ms` : '-';
  document.getElementById('apdNotes').textContent = a.notes || '';
}

async function pingApFromDetail() {
  const btn = document.getElementById('apdPingBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Pinging...';
  try {
    const data = await apiCall('POST', `/api/admin/access-points/${apDetailId}/ping`);
    if (data.success) {
      renderApDetail(data.accessPoint);
      const idx = apAll.findIndex(a => a.id === apDetailId);
      if (idx !== -1) apAll[idx] = data.accessPoint;
      renderApSummary();
      renderApTable();
      showToast(data.accessPoint.status === 'online' ? 'AP is online.' : 'AP did not respond.', data.accessPoint.status === 'online' ? 'success' : 'warning');
    } else {
      showToast(data.message || 'Unable to ping this AP.', 'error');
    }
  } catch (e) {
    showToast('Unable to ping this AP.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-satellite-dish"></i> Ping Now';
  }
}

function editApFromDetail() {
  closeModal('apDetailModal');
  openEditAp(apDetailId);
}

function removeApFromDetail() {
  closeModal('apDetailModal');
  deleteAp(apDetailId);
}
