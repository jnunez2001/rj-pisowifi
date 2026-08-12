// ===== ROUTERS PAGE (fleet registry) =====
let rtAllRouters = [];
let rtAllSites = [];
let rtEditingId = null;
let rtDetailId = null;

async function loadRoutersPage() {
  await loadSitesForRouters();
  await loadRoutersList();
}

async function loadSitesForRouters() {
  try {
    const data = await apiCall('GET', '/api/admin/sites');
    rtAllSites = (data.success && data.sites) ? data.sites : [];
  } catch (e) {
    rtAllSites = [];
  }
}

async function loadRoutersList() {
  const tbody = document.getElementById('routersTable');
  if (!tbody) return;
  try {
    const data = await apiCall('GET', '/api/admin/routers');
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--accent-red);padding:24px;">${data.message || 'Failed to load routers'}</td></tr>`;
      return;
    }
    rtAllRouters = data.routers;
    renderRoutersSummary();
    renderRoutersTable();
  } catch (e) {
    console.error('Routers load error:', e);
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--accent-red);padding:24px;">Failed to load routers. Refresh to try again.</td></tr>`;
  }
}

function renderRoutersSummary() {
  const total = rtAllRouters.length;
  const online = rtAllRouters.filter(r => r.status === 'online').length;
  const offline = total - online;
  document.getElementById('routersTotalCount').textContent = total;
  document.getElementById('routersOnlineCount').textContent = online;
  document.getElementById('routersOfflineCount').textContent = offline;
  document.getElementById('routersSiteCount').textContent = rtAllSites.length;
}

function routerStatusBadge(status) {
  const map = {
    online: { cls: 'badge-green', dot: 'online', label: 'Online' },
    offline: { cls: 'badge-red', dot: 'offline', label: 'Offline' },
    unreachable: { cls: 'badge-red', dot: 'offline', label: 'Unreachable' },
    connecting: { cls: 'badge-blue', dot: '', label: 'Connecting' },
    warning: { cls: 'badge-orange', dot: '', label: 'Warning' },
    configuration_required: { cls: 'badge-orange', dot: '', label: 'Configuration Required' },
  };
  const s = map[status] || { cls: 'badge-blue', dot: '', label: status };
  const dot = s.dot ? `<span class="status-dot ${s.dot}"></span> ` : '';
  return `<span class="badge ${s.cls}">${dot}${s.label}</span>`;
}

function formatUptimeSeconds(sec) {
  if (sec === null || sec === undefined) return '-';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderRoutersTable() {
  const tbody = document.getElementById('routersTable');
  const summary = document.getElementById('routersSummary');
  if (!tbody) return;

  const search = (document.getElementById('routersSearch')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('routersStatusFilter')?.value || '';
  const modeFilter = document.getElementById('routersModeFilter')?.value || '';

  let rows = rtAllRouters.filter(r => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (modeFilter && r.mode !== modeFilter) return false;
    if (search && !(r.name.toLowerCase().includes(search) || (r.model || '').toLowerCase().includes(search) || (r.host || '').toLowerCase().includes(search))) return false;
    return true;
  });

  if (!rtAllRouters.length) {
    tbody.innerHTML = `
      <tr><td colspan="8">
        <div class="empty-state">
          <i class="fas fa-router"></i>
          <h3>No Routers Yet</h3>
          <p>Connect an existing MikroTik router to start monitoring and managing it.</p>
          <button class="btn btn-primary" onclick="openAddRouter()"><i class="fas fa-plus"></i> Add Router</button>
        </div>
      </td></tr>`;
    summary.textContent = 'Showing 0 of 0 routers';
    return;
  }

  if (!rows.length) {
    tbody.innerHTML = `
      <tr><td colspan="8">
        <div class="empty-state">
          <i class="fas fa-filter-circle-xmark"></i>
          <h3>No routers match your filters.</h3>
          <button class="btn btn-secondary" onclick="clearRoutersFilters()">Clear Filters</button>
        </div>
      </td></tr>`;
    summary.textContent = `Showing 0 of ${rtAllRouters.length} routers`;
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr style="cursor:pointer;" onclick="openRouterDetail(${r.id})">
      <td>
        <div style="font-weight:700;color:var(--text-primary);">${escapeHtml(r.name)}</div>
        <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(r.manufacturer)}${r.model ? ' · ' + escapeHtml(r.model) : ''}</div>
      </td>
      <td>${routerStatusBadge(r.status)}</td>
      <td><span class="badge badge-blue">${r.mode === 'controller' ? 'Controller' : 'Standalone'}</span></td>
      <td>${escapeHtml(r.site_name || '-')}</td>
      <td style="font-family:monospace;font-size:12px;">${escapeHtml(r.host || '-')}</td>
      <td>${formatUptimeSeconds(r.uptime_seconds)}</td>
      <td>${r.cpu_percent !== null && r.cpu_percent !== undefined ? r.cpu_percent + '%' : '-'} / ${r.memory_percent !== null && r.memory_percent !== undefined ? r.memory_percent + '%' : '-'}</td>
      <td onclick="event.stopPropagation();">
        <div style="display:flex;gap:6px;">
          <button class="btn btn-sm btn-secondary btn-icon" onclick="openRouterDetail(${r.id})" title="View"><i class="fas fa-eye"></i></button>
          <button class="btn btn-sm btn-secondary btn-icon" onclick="openEditRouter(${r.id})" title="Edit"><i class="fas fa-pen"></i></button>
          <button class="btn btn-sm btn-danger btn-icon" onclick="deleteRouter(${r.id})" title="Remove"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>
  `).join('');

  summary.textContent = `Showing ${rows.length} of ${rtAllRouters.length} routers`;
}

function clearRoutersFilters() {
  document.getElementById('routersSearch').value = '';
  document.getElementById('routersStatusFilter').value = '';
  document.getElementById('routersModeFilter').value = '';
  renderRoutersTable();
}

function populateRouterSiteSelect() {
  const select = document.getElementById('routerSiteId');
  select.innerHTML = rtAllSites.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
}

function resetRouterForm() {
  rtEditingId = null;
  document.getElementById('routerModalTitle').textContent = 'Add Router';
  document.getElementById('routerModeController').checked = true;
  document.getElementById('routerManufacturer').value = 'mikrotik';
  document.getElementById('routerModel').value = '';
  document.getElementById('routerName').value = '';
  populateRouterSiteSelect();
  document.getElementById('routerHost').value = '';
  document.getElementById('routerPort').value = '';
  document.getElementById('routerUsername').value = 'admin';
  document.getElementById('routerPassword').value = '';
  document.getElementById('routerPassword').placeholder = 'Router API password';
  document.getElementById('routerSsl').checked = false;
  document.getElementById('routerTestResult').style.display = 'none';
}

function openAddRouter() {
  resetRouterForm();
  document.getElementById('routerModal').classList.add('show');
}

function openEditRouter(id) {
  const r = rtAllRouters.find(x => x.id === id);
  if (!r) return;
  resetRouterForm();
  rtEditingId = id;
  document.getElementById('routerModalTitle').textContent = 'Edit Router';
  document.getElementById('routerModeController').checked = r.mode === 'controller';
  document.getElementById('routerModeStandalone').checked = r.mode === 'standalone';
  document.getElementById('routerManufacturer').value = r.manufacturer;
  document.getElementById('routerModel').value = r.model || '';
  document.getElementById('routerName').value = r.name;
  populateRouterSiteSelect();
  if (r.site_id) document.getElementById('routerSiteId').value = r.site_id;
  document.getElementById('routerHost').value = r.host || '';
  document.getElementById('routerPort').value = r.port || '';
  document.getElementById('routerUsername').value = r.username || '';
  document.getElementById('routerPassword').placeholder = r.has_password ? 'Leave blank to keep current password' : 'Router API password';
  document.getElementById('routerSsl').checked = r.ssl;
  document.getElementById('routerModal').classList.add('show');
}

function currentRouterFormPayload() {
  const mode = document.querySelector('input[name="routerMode"]:checked').value;
  return {
    name: document.getElementById('routerName').value.trim(),
    manufacturer: document.getElementById('routerManufacturer').value,
    model: document.getElementById('routerModel').value.trim(),
    mode,
    site_id: document.getElementById('routerSiteId').value || null,
    host: document.getElementById('routerHost').value.trim(),
    port: document.getElementById('routerPort').value || null,
    ssl: document.getElementById('routerSsl').checked,
    username: document.getElementById('routerUsername').value.trim(),
    password: document.getElementById('routerPassword').value || undefined,
  };
}

async function saveRouter() {
  const payload = currentRouterFormPayload();
  if (!payload.name) { showToast('Router name is required.', 'error'); return; }

  const btn = document.getElementById('saveRouterBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

  try {
    const data = rtEditingId
      ? await apiCall('PATCH', `/api/admin/routers/${rtEditingId}`, payload)
      : await apiCall('POST', '/api/admin/routers', payload);

    if (data.success) {
      showToast(rtEditingId ? 'Router updated!' : 'Router added!', 'success');
      closeModal('routerModal');
      loadRoutersList();
    } else {
      showToast(data.message || 'Unable to save router.', 'error');
    }
  } catch (e) {
    showToast('Unable to save router.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Save Router';
  }
}

async function testRouterConnectionInModal() {
  const resultBox = document.getElementById('routerTestResult');
  const btn = document.getElementById('testRouterBtn');

  if (!rtEditingId) {
    resultBox.style.display = 'block';
    resultBox.className = 'alert alert-info';
    resultBox.innerHTML = '<i class="fas fa-info-circle"></i> Save the router first, then test the connection.';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';
  resultBox.style.display = 'none';

  try {
    const data = await apiCall('POST', `/api/admin/routers/${rtEditingId}/test-connection`);
    resultBox.style.display = 'block';
    if (data.success) {
      resultBox.className = 'alert alert-success';
      resultBox.innerHTML = `<i class="fas fa-check-circle"></i> Connected! RouterOS ${escapeHtml(data.router.firmware_version || '')}, uptime ${formatUptimeSeconds(data.router.uptime_seconds)}.`;
      loadRoutersList();
    } else {
      resultBox.className = 'alert alert-error';
      resultBox.innerHTML = `<i class="fas fa-times-circle"></i> ${escapeHtml(data.message || 'Connection failed.')}`;
    }
  } catch (e) {
    resultBox.style.display = 'block';
    resultBox.className = 'alert alert-error';
    resultBox.innerHTML = '<i class="fas fa-times-circle"></i> Connection failed.';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-plug-circle-bolt"></i> Test Connection';
  }
}

async function deleteRouter(id) {
  const r = rtAllRouters.find(x => x.id === id);
  if (!confirm(`Remove router "${r ? r.name : ''}"? This cannot be undone.`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/routers/${id}`);
    if (data.success) {
      showToast('Router removed.', 'success');
      loadRoutersList();
    } else {
      showToast(data.message || 'Unable to remove router.', 'error');
    }
  } catch (e) {
    showToast('Unable to remove router.', 'error');
  }
}

// ===== ROUTER DETAIL =====
function setRouterDetailTab(tab, el) {
  document.querySelectorAll('#routerDetailTabs .zf3-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('routerDetailOverview').style.display = tab === 'overview' ? 'block' : 'none';
  document.getElementById('routerDetailInterfaces').style.display = tab === 'interfaces' ? 'block' : 'none';
  document.getElementById('routerDetailMore').style.display = tab === 'more' ? 'block' : 'none';
  if (tab === 'interfaces') loadRouterInterfaces(rtDetailId);
}

function openRouterDetail(id) {
  const r = rtAllRouters.find(x => x.id === id);
  if (!r) return;
  rtDetailId = id;
  renderRouterDetail(r);
  document.querySelectorAll('#routerDetailTabs .zf3-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('#routerDetailTabs .zf3-tab').classList.add('active');
  document.getElementById('routerDetailOverview').style.display = 'block';
  document.getElementById('routerDetailInterfaces').style.display = 'none';
  document.getElementById('routerDetailMore').style.display = 'none';
  document.getElementById('routerDetailModal').classList.add('show');
}

function renderRouterDetail(r) {
  document.getElementById('routerDetailName').textContent = r.name;
  document.getElementById('routerDetailSub').innerHTML = `${escapeHtml(r.manufacturer)}${r.model ? ' ' + escapeHtml(r.model) : ''} ${routerStatusBadge(r.status)}`;
  document.getElementById('rdUptime').textContent = formatUptimeSeconds(r.uptime_seconds);
  document.getElementById('rdCpu').textContent = (r.cpu_percent !== null && r.cpu_percent !== undefined) ? r.cpu_percent + '%' : '-';
  document.getElementById('rdMem').textContent = (r.memory_percent !== null && r.memory_percent !== undefined) ? r.memory_percent + '%' : '-';
  document.getElementById('rdModel').textContent = `${r.manufacturer}${r.model ? ' ' + r.model : ''}`;
  document.getElementById('rdMode').textContent = r.mode === 'controller' ? 'Controller Mode' : 'Standalone Mode';
  document.getElementById('rdHost').textContent = r.host || '-';
  document.getElementById('rdVersion').textContent = r.firmware_version || '-';
  document.getElementById('rdLastSeen').textContent = r.last_seen_at ? new Date(r.last_seen_at.replace(' ', 'T') + 'Z').toLocaleString() : 'Never';
  document.getElementById('rdSite').textContent = r.site_name || '-';
  const errBox = document.getElementById('rdError');
  if (r.last_error) {
    errBox.style.display = 'block';
    errBox.textContent = r.last_error;
  } else {
    errBox.style.display = 'none';
  }
}

async function testRouterConnectionInDetail() {
  const btn = document.getElementById('rdTestBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';
  try {
    const data = await apiCall('POST', `/api/admin/routers/${rtDetailId}/test-connection`);
    if (data.success) {
      showToast('Connected!', 'success');
      renderRouterDetail(data.router);
      const idx = rtAllRouters.findIndex(x => x.id === rtDetailId);
      if (idx !== -1) rtAllRouters[idx] = data.router;
      renderRoutersSummary();
      renderRoutersTable();
    } else {
      showToast(data.message || 'Connection failed.', 'error');
      loadRoutersList().then(() => {
        const r = rtAllRouters.find(x => x.id === rtDetailId);
        if (r) renderRouterDetail(r);
      });
    }
  } catch (e) {
    showToast('Connection failed.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-plug-circle-bolt"></i> Test Connection';
  }
}

async function loadRouterInterfaces(id) {
  const tbody = document.getElementById('rdInterfacesTable');
  tbody.innerHTML = '<tr><td colspan="5"><div class="loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div></td></tr>';
  try {
    const data = await apiCall('GET', `/api/admin/routers/${id}/interfaces`);
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--accent-red);padding:20px;">${escapeHtml(data.message || 'Unable to load interfaces.')}</td></tr>`;
      return;
    }
    if (!data.interfaces.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px;">No interfaces reported.</td></tr>';
      return;
    }
    tbody.innerHTML = data.interfaces.map(i => `
      <tr>
        <td style="font-weight:600;">${escapeHtml(i.name)}</td>
        <td>${escapeHtml(i.type || '-')}</td>
        <td>${i.disabled ? '<span class="badge badge-red">Disabled</span>' : (i.online ? '<span class="badge badge-green"><span class="status-dot online"></span> Online</span>' : '<span class="badge badge-red">Offline</span>')}</td>
        <td>${i.rx_bytes !== null ? formatBytes(i.rx_bytes) : '-'}</td>
        <td>${i.tx_bytes !== null ? formatBytes(i.tx_bytes) : '-'}</td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--accent-red);padding:20px;">Unable to load interfaces.</td></tr>';
  }
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function removeRouterFromDetail() {
  closeModal('routerDetailModal');
  deleteRouter(rtDetailId);
}
