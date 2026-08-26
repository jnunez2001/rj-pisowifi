// ===== ROUTERS PAGE (fleet registry) =====
let rtAllRouters = [];
let rtAllSites = [];
let rtEditingId = null;
let rtDetailId = null;
let rtSelfRouter = null; // this box's own real gateway, from /api/admin/routers/self

async function loadRoutersPage() {
  await loadSitesForRouters();
  await loadSelfRouter();
  await loadRoutersList();
}

async function loadSelfRouter() {
  try {
    const data = await apiCall('GET', '/api/admin/routers/self');
    rtSelfRouter = (data.success && data.active) ? data : null;
  } catch (e) {
    rtSelfRouter = null;
  }
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
  const selfCount = rtSelfRouter ? 1 : 0;
  const total = rtAllRouters.length + selfCount;
  const online = rtAllRouters.filter(r => r.status === 'online').length + selfCount;
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

function selfRouterRowHtml() {
  if (!rtSelfRouter) return '';
  return `
    <tr style="cursor:pointer;" onclick="openSelfRouterDetail()">
      <td data-label="Router">
        <div style="font-weight:700;color:var(--text-primary);"><i class="fas fa-star" style="color:var(--accent-blue);font-size:11px;margin-right:4px;"></i> StarkFi Router</div>
        <div style="font-size:11px;color:var(--text-muted);">This box's own gateway</div>
      </td>
      <td data-label="Status">${routerStatusBadge('online')}</td>
      <td data-label="Mode"><span class="badge badge-blue">Router</span></td>
      <td data-label="Site">-</td>
      <td data-label="Host" style="font-family:monospace;font-size:12px;">localhost</td>
      <td data-label="Uptime">${formatUptimeSeconds(rtSelfRouter.uptime_seconds)}</td>
      <td data-label="CPU / RAM">${rtSelfRouter.cpu_percent ?? '-'}% / ${rtSelfRouter.memory_percent ?? '-'}%</td>
      <td class="table-stack-full"><button class="btn btn-sm btn-secondary btn-icon" onclick="event.stopPropagation();openSelfRouterDetail();" title="View"><i class="fas fa-eye"></i></button></td>
    </tr>`;
}

function renderRoutersTable() {
  const tbody = document.getElementById('routersTable');
  const summary = document.getElementById('routersSummary');
  if (!tbody) return;

  const search = (document.getElementById('routersSearch')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('routersStatusFilter')?.value || '';
  const modeFilter = document.getElementById('routersModeFilter')?.value || '';

  const showSelf = rtSelfRouter
    && (!modeFilter || modeFilter === 'router')
    && (!statusFilter || statusFilter === 'online')
    && (!search || 'starkfi router'.includes(search));

  let rows = rtAllRouters.filter(r => {
    if (modeFilter === 'router') return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (modeFilter && r.mode !== modeFilter) return false;
    if (search && !(r.name.toLowerCase().includes(search) || (r.model || '').toLowerCase().includes(search) || (r.host || '').toLowerCase().includes(search))) return false;
    return true;
  });

  const totalCount = rtAllRouters.length + (rtSelfRouter ? 1 : 0);
  const shownCount = rows.length + (showSelf ? 1 : 0);

  if (!totalCount) {
    tbody.innerHTML = `
      <tr><td colspan="8">
        <div class="empty-state">
          <i class="fas fa-router"></i>
          <h3>No Routers Yet</h3>
          <p>Use StarkFi as your router, or connect an existing MikroTik router.</p>
          <button class="btn btn-primary" onclick="openAddRouter()"><i class="fas fa-plus"></i> Add Router</button>
        </div>
      </td></tr>`;
    summary.textContent = 'Showing 0 of 0 routers';
    return;
  }

  if (!shownCount) {
    tbody.innerHTML = `
      <tr><td colspan="8">
        <div class="empty-state">
          <i class="fas fa-filter-circle-xmark"></i>
          <h3>No routers match your filters.</h3>
          <button class="btn btn-secondary" onclick="clearRoutersFilters()">Clear Filters</button>
        </div>
      </td></tr>`;
    summary.textContent = `Showing 0 of ${totalCount} routers`;
    return;
  }

  tbody.innerHTML = (showSelf ? selfRouterRowHtml() : '') + rows.map(r => `
    <tr style="cursor:pointer;" onclick="openRouterDetail(${r.id})">
      <td data-label="Router">
        <div style="font-weight:700;color:var(--text-primary);">${escapeHtml(r.name)}</div>
        <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(r.manufacturer)}${r.model ? ' · ' + escapeHtml(r.model) : ''}</div>
      </td>
      <td data-label="Status">${routerStatusBadge(r.status)}</td>
      <td data-label="Mode"><span class="badge badge-blue">Controller</span></td>
      <td data-label="Site">${escapeHtml(r.site_name || '-')}</td>
      <td data-label="Host" style="font-family:monospace;font-size:12px;">${escapeHtml(r.host || '-')}</td>
      <td data-label="Uptime">${formatUptimeSeconds(r.uptime_seconds)}</td>
      <td data-label="CPU / RAM">${r.cpu_percent !== null && r.cpu_percent !== undefined ? r.cpu_percent + '%' : '-'} / ${r.memory_percent !== null && r.memory_percent !== undefined ? r.memory_percent + '%' : '-'}</td>
      <td class="table-stack-full" onclick="event.stopPropagation();">
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-secondary btn-icon" onclick="openRouterDetail(${r.id})" title="View"><i class="fas fa-eye"></i></button>
          <button class="btn btn-sm btn-secondary btn-icon" onclick="openEditRouter(${r.id})" title="Edit"><i class="fas fa-pen"></i></button>
          <button class="btn btn-sm btn-danger btn-icon" onclick="deleteRouter(${r.id})" title="Remove"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>
  `).join('');

  summary.textContent = `Showing ${shownCount} of ${totalCount} routers`;
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

// New router: show the "how do you want to run your network?" picker
// first (StarkFi Router vs Existing Router), matching the product's actual
// recommended path. Editing an existing fleet entry always means an
// external Controller-mode device, so it skips straight to the connect
// form.
function openAddRouter() {
  resetRouterForm();
  document.getElementById('routerModalTitle').textContent = 'Add Router';
  document.getElementById('routerDeploymentPicker').style.display = 'block';
  document.getElementById('routerConnectForm').style.display = 'none';
  document.getElementById('routerModal').classList.add('show');
}

function showControllerConnectForm() {
  document.getElementById('routerModalTitle').textContent = 'Connect Existing Router';
  document.getElementById('routerDeploymentPicker').style.display = 'none';
  document.getElementById('routerConnectForm').style.display = 'block';
}

// Real action, not a label: flips this box's own network_mode setting to
// 'standalone' - the same setting the existing Network page's Router Mode
// switch uses - so StarkFi genuinely becomes the gateway (WAN/DHCP/DNS/NAT/
// firewall/hotspot, all real, pre-existing engine). Does not create a
// fleet row; the StarkFi Router entry in the table comes from
// /api/admin/routers/self reading this same setting back.
async function useZenfiAsRouter() {
  if (rtSelfRouter) {
    showToast('StarkFi is already running as your router.', 'info');
    closeModal('routerModal');
    return;
  }
  try {
    const data = await apiCall('POST', '/api/admin/settings', { network_mode: 'standalone' });
    if (data.success) {
      showToast('StarkFi is now your router.', 'success');
      closeModal('routerModal');
      loadRoutersPage();
    } else {
      showToast(data.message || 'Unable to switch to Router Mode.', 'error');
    }
  } catch (e) {
    showToast('Unable to switch to Router Mode.', 'error');
  }
}

function openEditRouter(id) {
  const r = rtAllRouters.find(x => x.id === id);
  if (!r) return;
  resetRouterForm();
  rtEditingId = id;
  document.getElementById('routerModalTitle').textContent = 'Edit Router';
  document.getElementById('routerDeploymentPicker').style.display = 'none';
  document.getElementById('routerConnectForm').style.display = 'block';
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
  return {
    name: document.getElementById('routerName').value.trim(),
    manufacturer: document.getElementById('routerManufacturer').value,
    model: document.getElementById('routerModel').value.trim(),
    mode: 'controller',
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
  if (tab === 'more') loadRouterMoreTab();
}

// Closes this modal before leaving, so the destination page doesn't render
// underneath an open overlay the user has to close manually afterward.
function goToPageFromRouterDetail(page) {
  closeModal('routerDetailModal');
  navigateTo(page);
}

let rmMoreLoaded = false;
function setRouterMoreSubtab(name, el) {
  document.querySelectorAll('#routerMoreSubtabs .zf3-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.rm-subtab-panel').forEach(p => p.style.display = 'none');
  const panelId = 'rm' + name.charAt(0).toUpperCase() + name.slice(1);
  const panel = document.getElementById(panelId);
  if (panel) panel.style.display = 'block';
}

// The "More" tab now holds the REAL Network Mode / MikroTik Connection /
// Router Console / Router Setup / Network Power cards (moved here from
// network.html, which keeps only the mode-agnostic cards). This is the
// same loader that used to run on network.html's own page-load
// (loadNetworkPage() no longer calls it - see network.js) - it fetches
// current settings, fills in every one of those fields, and (via
// showRouterModeCards()) triggers loadIspPlan/loadRouterPorts/
// loadRouterStatus/loadMikrotikNetworkPowerSummaries for whichever mode
// is actually active.
async function loadRouterMoreTab() {
  if (rmMoreLoaded) return;
  rmMoreLoaded = true;
  loadNetworkModeSettings();
  loadRouterMoreLogs();
}

async function loadRouterMoreLogs() {
  const el = document.getElementById('rmLogsBody');
  try {
    const data = await apiCall('GET', '/api/admin/logs?limit=15');
    if (!data.success) throw new Error(data.message || 'Failed to load');
    const events = data.events || data.logs || [];
    if (events.length === 0) {
      el.innerHTML = '<p style="font-size:13px;color:var(--text-muted);">No recent log events.</p>';
      return;
    }
    el.innerHTML = '<div class="table-wrapper"><table class="table-stack"><thead><tr><th>Time</th><th>Level</th><th>Message</th></tr></thead><tbody>' +
      events.map((e) => `<tr><td>${escapeHtml(e.time || '-')}</td><td>${escapeHtml(e.level || '-')}</td><td>${escapeHtml(e.message || '-')}${e.detail ? ' - ' + escapeHtml(e.detail) : ''}</td></tr>`).join('') +
      '</tbody></table></div>';
  } catch (e) {
    el.innerHTML = '<div class="alert alert-error">' + escapeHtml(e.message || 'Failed to load logs.') + '</div>';
  }
}

function openSelfRouterDetail() {
  if (!rtSelfRouter) return;
  document.getElementById('srUptime').textContent = formatUptimeSeconds(rtSelfRouter.uptime_seconds);
  document.getElementById('srCpu').textContent = (rtSelfRouter.cpu_percent ?? '-') + '%';
  document.getElementById('srMem').textContent = (rtSelfRouter.memory_percent ?? '-') + '%';

  const wan = rtSelfRouter.wan;
  const grid = document.getElementById('srWanGrid');
  if (wan && wan.ping_status) {
    grid.innerHTML = `
      <div><div class="zf3-wan-item-label">Status</div><div class="zf3-wan-item-value">${escapeHtml(wan.ping_status)}</div></div>
      <div><div class="zf3-wan-item-label">Latency</div><div class="zf3-wan-item-value">${wan.avg_latency_ms !== null && wan.avg_latency_ms !== undefined ? wan.avg_latency_ms + ' ms' : '-'}</div></div>
      <div><div class="zf3-wan-item-label">Packet Loss</div><div class="zf3-wan-item-value">${wan.packet_loss_pct !== null && wan.packet_loss_pct !== undefined ? wan.packet_loss_pct + '%' : '-'}</div></div>
    `;
  } else {
    grid.innerHTML = '<div><div class="zf3-wan-item-label">Status</div><div class="zf3-wan-item-value">Not available</div></div>';
  }

  document.getElementById('selfRouterModal').classList.add('show');
}

function openRouterDetail(id) {
  const r = rtAllRouters.find(x => x.id === id);
  if (!r) return;
  rtDetailId = id;
  rmMoreLoaded = false;
  renderRouterDetail(r);
  document.querySelectorAll('#routerDetailTabs .zf3-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('#routerDetailTabs .zf3-tab').classList.add('active');
  document.getElementById('routerDetailOverview').style.display = 'block';
  document.getElementById('routerDetailInterfaces').style.display = 'none';
  document.getElementById('routerDetailMore').style.display = 'none';
  document.getElementById('routerDetailModal').classList.add('show');
  loadOverviewLiveStatus();
}

// Live Status lives on Overview now (moved out of the "More" tab), which
// loads before loadNetworkModeSettings() ever runs (that only fires once
// the More tab is opened) - fetch the mode here directly instead of relying
// on currentNetworkMode already being set.
async function loadOverviewLiveStatus() {
  const card = document.getElementById('routerStatusCard');
  if (!card) return;
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    if (!data.success) return;
    const mode = data.settings.network_mode || 'standalone';
    card.style.display = mode === 'mikrotik' ? 'block' : 'none';
    if (mode === 'mikrotik') loadRouterStatus();
  } catch (e) {}
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
        <td data-label="Interface" style="font-weight:600;">${escapeHtml(i.name)}</td>
        <td data-label="Type">${escapeHtml(i.type || '-')}</td>
        <td data-label="Status">${i.disabled ? '<span class="badge badge-red">Disabled</span>' : (i.online ? '<span class="badge badge-green"><span class="status-dot online"></span> Online</span>' : '<span class="badge badge-red">Offline</span>')}</td>
        <td data-label="RX (since router boot)">${i.rx_bytes !== null ? formatBytes(i.rx_bytes) : '-'}</td>
        <td data-label="TX (since router boot)">${i.tx_bytes !== null ? formatBytes(i.tx_bytes) : '-'}</td>
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
