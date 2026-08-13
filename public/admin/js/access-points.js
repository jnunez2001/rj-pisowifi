// ===== ACCESS POINTS PAGE =====
// Discovery-first: real passive scan (ARP/DHCP) surfaces candidates for
// approval, real ICMP ping drives reachability status. No vendor adapter
// exists yet, so management/config features are honestly absent rather
// than faked - see the empty states in the Network detail tab.
let apAll = [];
let apAllSites = [];
let apEditingId = null;
let apDetailId = null;
let apCandidates = [];
let apLastScannedAt = null;

async function loadAccessPointsPage() {
  await loadSitesForAp();
  await loadScanStatus();
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

async function loadScanStatus() {
  try {
    const data = await apiCall('GET', '/api/admin/access-points/scan/status');
    apLastScannedAt = (data.success && data.last_scanned_at) ? data.last_scanned_at : null;
  } catch (e) {
    apLastScannedAt = null;
  }
}

async function loadApList() {
  const tbody = document.getElementById('apTable');
  if (!tbody) return;
  try {
    const data = await apiCall('GET', '/api/admin/access-points');
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--accent-red);padding:24px;">${data.message || 'Failed to load access points'}</td></tr>`;
      return;
    }
    apAll = data.accessPoints;
    renderApSummary();
    populateApFilterOptions();
    renderApTable();
  } catch (e) {
    console.error('Access points load error:', e);
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--accent-red);padding:24px;">Failed to load access points. Refresh to try again.</td></tr>`;
  }
}

function renderApSummary() {
  const total = apAll.length;
  const online = apAll.filter(a => a.status === 'online').length;
  document.getElementById('apTotalCount').textContent = total;
  document.getElementById('apOnlineCount').textContent = online;
  // Clients/Throughput stay honestly unavailable - no vendor adapter
  // exists to report real per-AP client counts or throughput.
}

function populateApFilterOptions() {
  const vendorSelect = document.getElementById('apVendorFilter');
  const currentVendor = vendorSelect.value;
  const vendors = [...new Set(apAll.map(a => a.vendor).filter(Boolean))].sort();
  vendorSelect.innerHTML = '<option value="">All Vendors</option>' + vendors.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  vendorSelect.value = currentVendor;

  const siteSelect = document.getElementById('apSiteFilter');
  const currentSite = siteSelect.value;
  siteSelect.innerHTML = '<option value="">All Sites</option>' + apAllSites.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  siteSelect.value = currentSite;
}

function apStatusBadge(status) {
  if (status === 'online') return `<span class="badge badge-green"><span class="status-dot online"></span> Online</span>`;
  if (status === 'offline') return `<span class="badge badge-red">Offline</span>`;
  return `<span class="badge badge-blue">Not Checked Yet</span>`;
}

function apManagementBadge(state) {
  if (state === 'pending') return `<span class="badge badge-orange">Pending</span>`;
  return `<span class="badge badge-blue">Unmanaged</span>`;
}

function apVlanCell(a) {
  if (!a.vlan_id) return '-';
  return `<span title="${escapeHtml(a.vlan_evidence || '')}">VLAN ${a.vlan_id}</span>`;
}

function renderApTable() {
  const tbody = document.getElementById('apTable');
  const summary = document.getElementById('apSummary');
  if (!tbody) return;

  const search = (document.getElementById('apSearch')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('apStatusFilter')?.value || '';
  const vendorFilter = document.getElementById('apVendorFilter')?.value || '';
  const siteFilter = document.getElementById('apSiteFilter')?.value || '';

  let rows = apAll.filter(a => {
    if (statusFilter && a.status !== statusFilter) return false;
    if (vendorFilter && a.vendor !== vendorFilter) return false;
    if (siteFilter && String(a.site_id) !== siteFilter) return false;
    if (search && !(a.name.toLowerCase().includes(search) || (a.ip_address || '').toLowerCase().includes(search) || (a.mac_address || '').toLowerCase().includes(search))) return false;
    return true;
  });

  if (!apAll.length) {
    const alreadyScanned = !!apLastScannedAt;
    tbody.innerHTML = alreadyScanned ? `
      <tr><td colspan="9">
        <div class="empty-state">
          <i class="fas fa-wifi"></i>
          <h3>No Access Points Found</h3>
          <p>ZenFi scanned the network but did not identify any candidate devices.</p>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:16px;">
            <button class="btn btn-primary" onclick="scanForAps()"><i class="fas fa-satellite-dish"></i> Scan Again</button>
            <button class="btn btn-secondary" onclick="openAddAp()"><i class="fas fa-plus"></i> Add AP Manually</button>
          </div>
        </div>
      </td></tr>` : `
      <tr><td colspan="9">
        <div class="empty-state">
          <i class="fas fa-wifi"></i>
          <h3>No Access Points Discovered Yet</h3>
          <p>ZenFi hasn't scanned this network for access points yet.</p>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:16px;">
            <button class="btn btn-primary" onclick="scanForAps()"><i class="fas fa-satellite-dish"></i> Scan Network</button>
            <button class="btn btn-secondary" onclick="openAddAp()"><i class="fas fa-plus"></i> Add AP Manually</button>
          </div>
        </div>
      </td></tr>`;
    summary.textContent = 'Showing 0 of 0 access points';
    return;
  }

  if (!rows.length) {
    tbody.innerHTML = `
      <tr><td colspan="9">
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
      <td>${apVlanCell(a)}</td>
      <td>${escapeHtml(a.site_name || '-')}</td>
      <td>${apManagementBadge(a.management_state)}</td>
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
  document.getElementById('apVendorFilter').value = '';
  document.getElementById('apSiteFilter').value = '';
  renderApTable();
}

// ===== SCAN / DISCOVERY =====
async function scanForAps() {
  const btn = document.getElementById('scanApBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning...';
  try {
    const data = await apiCall('POST', '/api/admin/access-points/scan');
    if (data.success) {
      apCandidates = data.candidates;
      apLastScannedAt = new Date().toISOString();
      renderApCandidates();
      if (apCandidates.length) {
        showToast(`Found ${apCandidates.length} device(s) not yet registered.`, 'success');
      } else {
        showToast('Scan complete. No new devices found.', 'info');
      }
      renderApTable();
    } else {
      showToast(data.message || 'Scan failed.', 'error');
    }
  } catch (e) {
    showToast('Scan failed.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-satellite-dish"></i> Scan Network';
  }
}

function renderApCandidates() {
  const card = document.getElementById('apCandidatesCard');
  const list = document.getElementById('apCandidatesList');
  if (!apCandidates.length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  list.innerHTML = apCandidates.map((c, i) => `
    <div class="zf3-list-row" style="border-top:1px solid var(--border-color);padding:10px 0;">
      <div class="zf3-list-left" style="flex-direction:column;align-items:flex-start;gap:2px;">
        <div style="font-weight:700;">${escapeHtml(c.hostname || c.ip)}</div>
        <div style="font-size:11px;color:var(--text-muted);font-family:monospace;">${escapeHtml(c.ip)} &middot; ${escapeHtml(c.mac)}</div>
        <div style="font-size:11px;color:var(--text-muted);">
          ${c.vendor ? `Vendor: ${escapeHtml(c.vendor)}` : 'Vendor: Unknown'}
          ${c.vlan_id ? ` &middot; VLAN ${c.vlan_id} detected` : ''}
          &middot; via ${escapeHtml(c.discovered_via)}
        </div>
      </div>
      <button class="btn btn-sm btn-primary" onclick="addCandidateAsAp(${i})"><i class="fas fa-plus"></i> Add as AP</button>
    </div>
  `).join('');
}

function dismissApCandidates() {
  apCandidates = [];
  document.getElementById('apCandidatesCard').style.display = 'none';
}

async function addCandidateAsAp(index) {
  const c = apCandidates[index];
  if (!c) return;
  try {
    const data = await apiCall('POST', '/api/admin/access-points', {
      name: c.hostname || c.vendor || c.ip,
      ip_address: c.ip,
      mac_address: c.mac,
      vendor: c.vendor || '',
      hostname: c.hostname || '',
      vlan_id: c.vlan_id,
      vlan_evidence: c.vlan_evidence,
      discovered_via: c.discovered_via,
    });
    if (data.success) {
      showToast(`Added "${data.accessPoint.name}".`, 'success');
      apCandidates.splice(index, 1);
      renderApCandidates();
      loadApList();
    } else {
      showToast(data.message || 'Unable to add this device.', 'error');
    }
  } catch (e) {
    showToast('Unable to add this device.', 'error');
  }
}

// ===== MANUAL ADD / EDIT =====
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
function setApDetailTab(tab, el) {
  document.querySelectorAll('#apDetailTabs .zf3-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('apDetailOverview').style.display = tab === 'overview' ? 'block' : 'none';
  document.getElementById('apDetailNetwork').style.display = tab === 'network' ? 'block' : 'none';
}

function openApDetail(id) {
  const a = apAll.find(x => x.id === id);
  if (!a) return;
  apDetailId = id;
  renderApDetail(a);
  document.querySelectorAll('#apDetailTabs .zf3-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('#apDetailTabs .zf3-tab').classList.add('active');
  document.getElementById('apDetailOverview').style.display = 'block';
  document.getElementById('apDetailNetwork').style.display = 'none';
  document.getElementById('apDetailModal').classList.add('show');
}

function renderApDetail(a) {
  document.getElementById('apDetailName').textContent = a.name;
  document.getElementById('apDetailSub').innerHTML = apStatusBadge(a.status);
  document.getElementById('apdIp').textContent = a.ip_address || '-';
  document.getElementById('apdMac').textContent = a.mac_address || '-';
  document.getElementById('apdVendor').textContent = `${a.vendor || '-'}${a.model ? ' ' + a.model : ''}`;
  document.getElementById('apdHostname').textContent = a.hostname || '-';
  document.getElementById('apdSite').textContent = a.site_name || '-';
  document.getElementById('apdLastSeen').textContent = a.last_seen_at ? new Date(a.last_seen_at.replace(' ', 'T') + 'Z').toLocaleString() : 'Never';
  document.getElementById('apdLatency').textContent = (a.last_latency_ms !== null && a.last_latency_ms !== undefined) ? `${a.last_latency_ms} ms` : '-';
  document.getElementById('apdManagement').innerHTML = apManagementBadge(a.management_state);
  document.getElementById('apdNotes').textContent = a.notes || '';

  const vlanBlock = document.getElementById('apdVlanBlock');
  if (a.vlan_id) {
    vlanBlock.innerHTML = `
      <div style="font-weight:700;margin-bottom:4px;">VLAN ${a.vlan_id}</div>
      <div style="color:var(--text-muted);">${escapeHtml(a.vlan_evidence || 'Detected from network evidence.')}</div>
      <div style="color:var(--text-muted);margin-top:8px;font-size:12px;">This is evidence from this box's own network, not a read of the switch's full VLAN configuration.</div>
    `;
  } else {
    vlanBlock.innerHTML = `<span style="color:var(--text-muted);">No VLAN evidence detected for this device.</span>`;
  }
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
