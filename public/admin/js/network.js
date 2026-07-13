// ===== NETWORK PAGE =====

// ===== ROUTER MODE: ISP PLAN =====

async function loadIspPlan() {
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    if (data.success) {
      document.getElementById('ispPlanMbps').value = data.settings.isp_plan_mbps || '0';
    }
  } catch(e) {
    console.error('ISP plan load error:', e);
  }
}

async function saveIspPlan() {
  const mbps = document.getElementById('ispPlanMbps').value;
  try {
    const data = await apiCall('POST', '/api/admin/settings', { isp_plan_mbps: mbps });
    if (data.success) {
      showToast('Internet plan saved!');
      await loadRouterPorts();
    } else {
      showToast(data.message || 'Failed to save.', 'error');
    }
  } catch(e) { showToast('Server error.', 'error'); }
}

// ===== ROUTER MODE: PORTAL ADDRESS =====

async function loadPortalHostname() {
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    if (data.success) {
      document.getElementById('portalHostname').value = data.settings.portal_hostname || '';
    }
  } catch(e) {
    console.error('Portal hostname load error:', e);
  }
}

async function savePortalHostname() {
  const hostname = document.getElementById('portalHostname').value.trim();
  try {
    const data = await apiCall('POST', '/api/admin/settings', { portal_hostname: hostname });
    if (data.success) {
      showToast(hostname ? 'Portal address saved! Run Configure to apply it.' : 'Portal address cleared.');
    } else {
      showToast(data.message || 'Failed to save.', 'error');
    }
  } catch(e) { showToast('Server error.', 'error'); }
}

// ===== ROUTER MODE: PORTS AND ROLES =====
//
// A physical port can carry more than one lane: one untagged lane plus any
// number of VLAN-tagged lanes sharing the same wire (e.g. a server tagging
// its own traffic VLAN 13, and a nearby port set to treat anything
// arriving on it as VLAN 13 too, so a plain untagged AP joins that same
// lane without needing any VLAN awareness itself). cachedLanes is a flat
// list of lane definitions; cachedPhysicalPorts is the live-scanned port
// list they're grouped under for display.

let cachedPhysicalPorts = [];
let cachedLanes = [];

async function loadRouterPorts() {
  const el = document.getElementById('routerPortsList');
  const totalEl = document.getElementById('routerPortsTotal');
  try {
    const data = await apiCall('GET', '/api/admin/router/ports');
    if (!data.success) throw new Error(data.message);
    cachedPhysicalPorts = data.physical_ports;

    // bridge_with_id is a real database id - translate it into a
    // port_name/vlan_id pair so the UI can identify a lane by its content
    // even before it's saved (a brand-new lane has no id yet).
    const byId = {};
    for (const l of data.lanes) byId[l.id] = l;
    cachedLanes = data.lanes.map((l) => {
      const target = l.bridge_with_id ? byId[l.bridge_with_id] : null;
      return {
        port_name: l.port_name,
        vlan_id: l.vlan_id || 0,
        role: l.role,
        lane_name: l.lane_name,
        speed_mbps: l.speed_mbps,
        burst_mbps: l.burst_mbps,
        isolate_clients: l.isolate_clients,
        bridge_with_port: target ? target.port_name : '',
        bridge_with_vlan: target ? (target.vlan_id || 0) : 0,
      };
    });

    if (cachedPhysicalPorts.length === 0) {
      el.innerHTML = '<div style="color:var(--text-muted);">No ports detected. Check the connection above.</div>';
      totalEl.textContent = '';
      return;
    }

    renderPortsAndLanes();

    const plan = data.isp_plan_mbps || 0;
    const guaranteed = data.guaranteed_total_mbps || 0;
    const over = plan > 0 && guaranteed > plan;
    totalEl.textContent = `Guaranteed total: ${guaranteed} of ${plan || '?'} Mbps` + (over ? ' — over your plan!' : (plan > 0 ? ' — within plan' : ''));
    totalEl.style.color = over ? 'var(--accent-red)' : 'var(--accent-green)';

  } catch(e) {
    el.innerHTML = '<div style="color:var(--accent-red);">Failed to reach router: ' + (e.message || 'unknown error') + '</div>';
  }
}

// Every physical port always shows at least its untagged lane, even if
// nothing's been set for it yet - VLAN-tagged lanes are opt-in extras
// added with "Add VLAN lane".
function ensureUntaggedLanes() {
  for (const port of cachedPhysicalPorts) {
    if (!cachedLanes.some((l) => l.port_name === port.name && !l.vlan_id)) {
      cachedLanes.push({ port_name: port.name, vlan_id: 0, role: 'unused', lane_name: '', speed_mbps: 0, burst_mbps: 0, isolate_clients: true, bridge_with_port: '', bridge_with_vlan: 0 });
    }
  }
}

function renderPortsAndLanes() {
  ensureUntaggedLanes();
  document.getElementById('routerPortsList').innerHTML = cachedPhysicalPorts.map((port) => renderPortCard(port)).join('');
}

function renderPortCard(port) {
  const indices = cachedLanes.map((l, i) => i).filter((i) => cachedLanes[i].port_name === port.name);
  const untaggedIndex = indices.find((i) => !cachedLanes[i].vlan_id);
  const vlanIndices = indices.filter((i) => cachedLanes[i].vlan_id).sort((a, b) => cachedLanes[a].vlan_id - cachedLanes[b].vlan_id);

  const runningBadge = port.running
    ? '<span class="badge badge-green"><i class="fas fa-circle" style="font-size:8px;"></i> up</span>'
    : '<span class="badge badge-red"><i class="fas fa-circle" style="font-size:8px;"></i> down</span>';

  let html = `
    <div style="border:1px solid var(--border-color);border-radius:8px;padding:12px;margin-bottom:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <strong>${port.name}</strong>
          <span style="font-size:12px;color:var(--text-muted);margin-left:8px;">${port.mac}</span>
          ${runningBadge}
        </div>
        <button type="button" class="btn btn-sm btn-secondary" onclick="addVlanLane('${port.name}')">
          <i class="fas fa-plus"></i> Add VLAN lane
        </button>
      </div>`;
  html += renderLaneBlock(untaggedIndex);
  for (const i of vlanIndices) html += renderLaneBlock(i);
  html += `</div>`;
  return html;
}

function renderLaneBlock(i) {
  const l = cachedLanes[i];
  const roleOptions = ['wan', 'gated', 'open', 'unused'].map((r) =>
    `<option value="${r}" ${l.role === r ? 'selected' : ''}>${roleLabel(r)}</option>`
  ).join('');

  // Valid "combine with" targets: other lanes already set to Gated/Open,
  // not themselves already combined into someone else's lane. A lane that
  // joins another one inherits it entirely (name/speed/isolation), so its
  // own fields are hidden below rather than left showing stale values.
  const combineCandidates = cachedLanes
    .map((other, j) => ({ other, j }))
    .filter(({ other, j }) => j !== i && (other.role === 'gated' || other.role === 'open') && !other.bridge_with_port);
  const isJoined = !!l.bridge_with_port;

  let extra = '';
  if (l.role === 'gated' || l.role === 'open') {
    const combineOptions = combineCandidates.map(({ other, j }) => {
      const selected = l.bridge_with_port === other.port_name && (l.bridge_with_vlan || 0) === (other.vlan_id || 0);
      const label = (other.lane_name || other.port_name) + (other.vlan_id ? ` (VLAN ${other.vlan_id})` : '');
      return `<option value="${j}" ${selected ? 'selected' : ''}>${label}</option>`;
    }).join('');

    extra += `
    <div style="margin-top:8px;">
      <label class="form-label">Combine with another lane</label>
      <select class="form-control" id="laneBridge_${i}" onchange="onLaneChange(${i})" ${combineCandidates.length === 0 ? 'disabled' : ''}>
        <option value="">Not combined, this is its own lane</option>
        ${combineOptions}
      </select>
    </div>`;

    if (isJoined) {
      const primary = cachedLanes.find((c) => c.port_name === l.bridge_with_port && (c.vlan_id || 0) === (l.bridge_with_vlan || 0));
      extra += `<p style="font-size:13px;color:var(--text-muted);margin-top:8px;">Combined into <strong>${(primary && primary.lane_name) || l.bridge_with_port}</strong>'s lane. It uses that lane's name, speed, and settings.</p>`;
    } else {
      extra += `
    <div class="form-row" style="margin-top:8px;">
      <div class="form-group">
        <label class="form-label">Lane Name</label>
        <input type="text" class="form-control" id="laneName_${i}" value="${l.lane_name || ''}" placeholder="e.g. WiFi rental">
      </div>
      <div class="form-group">
        <label class="form-label">Guaranteed Mbps</label>
        <input type="number" class="form-control" id="laneSpeed_${i}" value="${l.speed_mbps || 0}" min="0">
      </div>
      <div class="form-group">
        <label class="form-label">Burst Mbps</label>
        <input type="number" class="form-control" id="laneBurst_${i}" value="${l.burst_mbps || 0}" min="0">
      </div>
    </div>
    ${l.role === 'gated' ? `
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-top:6px;">
      <input type="checkbox" id="laneIsolate_${i}" style="width:auto;" ${l.isolate_clients ? 'checked' : ''}>
      Keep customers isolated from each other
    </label>` : ''}`;
    }
  }

  const header = l.vlan_id
    ? `<span style="font-size:13px;font-weight:600;">VLAN ${l.vlan_id}</span> <button type="button" class="btn btn-sm btn-danger" style="margin-left:8px;" onclick="removeVlanLane(${i})"><i class="fas fa-trash"></i></button>`
    : `<span style="font-size:13px;font-weight:600;color:var(--text-muted);">Untagged</span>`;

  return `
    <div style="border-top:1px solid var(--border-color);padding-top:8px;margin-top:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        ${header}
        <select class="form-control" style="width:auto;" id="laneRole_${i}" onchange="onLaneChange(${i})">
          ${roleOptions}
        </select>
      </div>
      <div id="laneExtra_${i}">${extra}</div>
    </div>
  `;
}

function roleLabel(r) {
  return { wan: 'WAN', gated: 'Gated', open: 'Open', unused: 'Unused' }[r] || r;
}

// Snapshots whatever's currently typed into every lane's fields back into
// cachedLanes before a full re-render, so changing one lane's role doesn't
// discard values already entered for the others.
function syncLanesFromDom() {
  cachedLanes.forEach((l, i) => {
    const roleEl = document.getElementById(`laneRole_${i}`);
    if (roleEl) l.role = roleEl.value;
    const laneNameEl = document.getElementById(`laneName_${i}`);
    if (laneNameEl) l.lane_name = laneNameEl.value;
    const speedEl = document.getElementById(`laneSpeed_${i}`);
    if (speedEl) l.speed_mbps = parseInt(speedEl.value, 10) || 0;
    const burstEl = document.getElementById(`laneBurst_${i}`);
    if (burstEl) l.burst_mbps = parseInt(burstEl.value, 10) || 0;
    const isolateEl = document.getElementById(`laneIsolate_${i}`);
    if (isolateEl) l.isolate_clients = isolateEl.checked;
    const bridgeEl = document.getElementById(`laneBridge_${i}`);
    if (bridgeEl) {
      if (bridgeEl.value === '') {
        l.bridge_with_port = '';
        l.bridge_with_vlan = 0;
      } else {
        const target = cachedLanes[parseInt(bridgeEl.value, 10)];
        l.bridge_with_port = target.port_name;
        l.bridge_with_vlan = target.vlan_id || 0;
      }
    }
  });
}

function onLaneChange(i) {
  syncLanesFromDom();
  cachedLanes[i].role = document.getElementById(`laneRole_${i}`).value;
  renderPortsAndLanes();
}

// Lets an admin get creative with their own wiring: any port can carry an
// extra tagged lane on top of its untagged one, not just a single
// hardcoded scenario.
function addVlanLane(portName) {
  const vlanId = parseInt(prompt(`VLAN ID for this new lane on ${portName} (1-4094):`), 10);
  if (!vlanId || vlanId < 1 || vlanId > 4094) {
    if (!isNaN(vlanId)) showToast('VLAN ID must be between 1 and 4094.', 'error');
    return;
  }
  if (cachedLanes.some((l) => l.port_name === portName && l.vlan_id === vlanId)) {
    showToast('That VLAN ID already exists on this port.', 'error');
    return;
  }
  syncLanesFromDom();
  cachedLanes.push({ port_name: portName, vlan_id: vlanId, role: 'unused', lane_name: '', speed_mbps: 0, burst_mbps: 0, isolate_clients: true, bridge_with_port: '', bridge_with_vlan: 0 });
  renderPortsAndLanes();
}

function removeVlanLane(i) {
  syncLanesFromDom();
  const removed = cachedLanes[i];
  // Clear any other lane's "combine with" pointing at the one being
  // removed, so nothing is left referencing a lane that no longer exists.
  cachedLanes.forEach((l) => {
    if (l.bridge_with_port === removed.port_name && (l.bridge_with_vlan || 0) === (removed.vlan_id || 0)) {
      l.bridge_with_port = '';
      l.bridge_with_vlan = 0;
    }
  });
  cachedLanes.splice(i, 1);
  renderPortsAndLanes();
}

async function saveRouterPorts() {
  syncLanesFromDom();
  const lanes = cachedLanes.map((l) => ({
    port_name: l.port_name,
    vlan_id: l.vlan_id || 0,
    role: l.role,
    lane_name: l.lane_name || '',
    speed_mbps: l.speed_mbps || 0,
    burst_mbps: l.burst_mbps || 0,
    isolate_clients: l.isolate_clients !== false,
    bridge_with_port: l.bridge_with_port || '',
    bridge_with_vlan: l.bridge_with_vlan || 0,
  }));
  try {
    const data = await apiCall('POST', '/api/admin/router/ports', { lanes });
    if (data.success) {
      showToast('Port roles saved!');
      await loadRouterPorts();
    } else {
      showToast(data.message || 'Failed to save.', 'error');
    }
  } catch(e) { showToast('Server error.', 'error'); }
}

// ===== ROUTER MODE: LIVE STATUS =====

async function loadRouterStatus() {
  const el = document.getElementById('routerStatusGrid');
  try {
    const data = await apiCall('GET', '/api/admin/router/status');
    if (!data.success) throw new Error(data.message);
    const s = data.status;
    el.innerHTML = `
      <div><div style="font-size:12px;color:var(--text-muted);">Model</div><div>${s.model}</div></div>
      <div><div style="font-size:12px;color:var(--text-muted);">RouterOS</div><div>${s.routerosVersion}</div></div>
      <div><div style="font-size:12px;color:var(--text-muted);">Uptime</div><div>${s.uptime}</div></div>
      <div><div style="font-size:12px;color:var(--text-muted);">Active Devices</div><div>${s.activeDevices}</div></div>
      <div><div style="font-size:12px;color:var(--text-muted);">CPU Load</div><div>${s.cpuLoad}%</div></div>
      <div><div style="font-size:12px;color:var(--text-muted);">Identity</div><div>${s.identity || '-'}</div></div>
    `;
  } catch(e) {
    el.innerHTML = '<div style="color:var(--accent-red);">Failed to reach router.</div>';
  }
}

// ===== ROUTER MODE: PROVISION =====

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function previewProvisioning() {
  const el = document.getElementById('provisionResult');
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Building preview...</div>';
  try {
    const data = await apiCall('GET', '/api/admin/router/provision/preview');
    if (!data.success) throw new Error(data.message);

    let html = '';
    if (data.warnings && data.warnings.length) {
      html += '<div style="background:#fff8e1;border:1px solid #ffa000;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:#e65100;">' +
        data.warnings.map(w => `<div><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(w)}</div>`).join('') +
        '</div>';
    }
    html += '<div style="font-size:13px;font-weight:700;margin-bottom:6px;">Will run these ' + data.steps.length + ' steps:</div>';
    html += '<ol style="font-size:13px;padding-left:20px;">' +
      data.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('') +
      '</ol>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = '<div style="color:var(--accent-red);">Failed to build preview: ' + escapeHtml(e.message || 'unknown error') + '</div>';
  }
}

async function applyProvisioning() {
  if (!confirm('This pushes real changes to your router right now (after backing up its current config first). Continue?')) return;
  const el = document.getElementById('provisionResult');
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Configuring router...</div>';
  try {
    const data = await apiCall('POST', '/api/admin/router/provision/apply');
    renderProvisionLog(data, data.success);
    if (data.success) {
      showToast('Router configured!');
      await loadNetworkModeSettings();
      await loadRouterStatus();
    } else {
      showToast(data.message || 'Provisioning failed.', 'error');
    }
  } catch(e) {
    el.innerHTML = '<div style="color:var(--accent-red);">Server error: ' + escapeHtml(e.message || 'unknown error') + '</div>';
  }
}

function renderProvisionLog(data, success) {
  const el = document.getElementById('provisionResult');
  let html = '';
  if (!success) {
    html += `<div style="color:var(--accent-red);font-weight:700;margin-bottom:8px;">${escapeHtml(data.message || 'Provisioning failed')}</div>`;
  }
  if (data.backedUp) {
    html += '<div style="font-size:13px;color:var(--accent-green);margin-bottom:8px;"><i class="fas fa-check"></i> Router config backed up before changes were applied.</div>';
  }
  if (data.log && data.log.length) {
    html += '<ol style="font-size:13px;padding-left:20px;">' +
      data.log.map(l => `<li style="color:${l.ok ? 'inherit' : 'var(--accent-red)'};">${l.ok ? '<i class="fas fa-check" style="color:var(--accent-green);"></i>' : '<i class="fas fa-times"></i>'} ${escapeHtml(l.step)}${l.detail && !l.ok ? ' — ' + escapeHtml(l.detail) : ''}</li>`).join('') +
      '</ol>';
  }
  el.innerHTML = html;
}

async function loadNetworkPage() {
  await loadNetworkModeSettings();
  await loadInterfaces();
  await loadVlans();
}

function showRouterModeCards(show) {
  ['ispPlanCard', 'portalAddressCard', 'routerPortsCard', 'routerProvisionCard', 'routerStatusCard'].forEach(id => {
    document.getElementById(id).style.display = show ? 'block' : 'none';
  });
  if (show) {
    loadIspPlan();
    loadPortalHostname();
    loadRouterPorts();
    loadRouterStatus();
  }
}

async function loadNetworkModeSettings() {
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    if (!data.success) return;
    const s = data.settings;
    const mode = s.network_mode || 'standalone';
    document.getElementById('modeStandalone').checked = mode !== 'mikrotik';
    document.getElementById('modeMikrotik').checked = mode === 'mikrotik';
    document.getElementById('mikrotikIp').value = s.mikrotik_ip || '';
    document.getElementById('mikrotikUser').value = s.mikrotik_user || 'admin';
    document.getElementById('mikrotikPass').value = s.mikrotik_pass || '';
    document.getElementById('mikrotikInterface').value = s.mikrotik_interface || 'ether1';
    document.getElementById('mikrotikSsl').checked = s.mikrotik_ssl === '1';
    document.getElementById('mikrotikFields').style.display = mode === 'mikrotik' ? 'block' : 'none';
    updateNetworkModeCards(mode);
    showRouterModeCards(mode === 'mikrotik');
    if (mode === 'mikrotik') await loadLocalInterfaces(s.server_lan_mac || '');
  } catch(e) {
    console.error('Network mode load error:', e);
  }
}

// Bug fix: the DHCP reservation that keeps this server's address fixed on
// the gated lane used to guess which of this machine's network connections
// to use (first non-internal one Node reported) — on a machine with more
// than one connection (e.g. this project's own two-VM laptop setup), that
// could reserve the wrong device's address. The admin now picks explicitly.
async function loadLocalInterfaces(savedMac) {
  const select = document.getElementById('serverLanMac');
  const group = document.getElementById('serverLanMacGroup');
  try {
    const data = await apiCall('GET', '/api/admin/router/local-interfaces');
    if (!data.success) throw new Error(data.message);

    // Only show the picker when there's genuine ambiguity — one detected
    // connection means there's nothing to choose, so stay out of the way.
    if (data.interfaces.length <= 1) {
      group.style.display = 'none';
      return;
    }

    group.style.display = 'block';
    select.innerHTML = '<option value="">Not selected — pick one below</option>' +
      data.interfaces.map(i => `<option value="${i.mac}" ${i.mac === savedMac ? 'selected' : ''}>${i.name} — ${i.address} (${i.mac})</option>`).join('');
  } catch(e) {
    group.style.display = 'block';
    select.innerHTML = '<option value="">Failed to load</option>';
  }
}

function onNetworkModeChange() {
  const mode = document.querySelector('input[name="networkMode"]:checked').value;
  document.getElementById('mikrotikFields').style.display = mode === 'mikrotik' ? 'block' : 'none';
  updateNetworkModeCards(mode);
  showRouterModeCards(mode === 'mikrotik');
  if (mode === 'mikrotik') loadLocalInterfaces('');
}

async function testMikrotikConnection() {
  const statusEl = document.getElementById('mikrotikConnStatus');
  statusEl.textContent = 'Testing...';
  statusEl.style.color = 'var(--text-muted)';
  try {
    const data = await apiCall('POST', '/api/admin/router/test-connection');
    if (data.success) {
      statusEl.textContent = '✓ Connected';
      statusEl.style.color = 'var(--accent-green)';
    } else {
      statusEl.textContent = '✗ ' + (data.message || 'Failed');
      statusEl.style.color = 'var(--accent-red)';
    }
  } catch(e) {
    statusEl.textContent = '✗ Server error';
    statusEl.style.color = 'var(--accent-red)';
  }
}

function updateNetworkModeCards(mode) {
  const standaloneCard = document.getElementById('modeStandaloneCard');
  const mikrotikCard = document.getElementById('modeMikrotikCard');
  if (!standaloneCard || !mikrotikCard) return;
  standaloneCard.style.borderColor = mode !== 'mikrotik' ? 'var(--accent-green)' : 'var(--border-color)';
  mikrotikCard.style.borderColor = mode === 'mikrotik' ? 'var(--accent-blue)' : 'var(--border-color)';
}

async function saveNetworkSettings() {
  const mode = document.querySelector('input[name="networkMode"]:checked').value;
  try {
    const data = await apiCall('POST', '/api/admin/settings', {
      network_mode: mode,
      mikrotik_ip: document.getElementById('mikrotikIp').value,
      mikrotik_user: document.getElementById('mikrotikUser').value,
      mikrotik_pass: document.getElementById('mikrotikPass').value,
      mikrotik_interface: document.getElementById('mikrotikInterface').value,
      mikrotik_ssl: document.getElementById('mikrotikSsl').checked ? '1' : '0',
      server_lan_mac: document.getElementById('serverLanMac').value,
    });
    if (data.success) showToast('Network settings saved!');
    else showToast(data.message || 'Failed to save.', 'error');
  } catch(e) { showToast('Server error.', 'error'); }
}

// ===== INTERFACES =====

let cachedInterfaces = [];

async function loadInterfaces() {
  const el = document.getElementById('interfacesList');
  try {
    const data = await apiCall('GET', '/api/admin/network/interfaces');
    if (!data.success) throw new Error(data.message);
    cachedInterfaces = data.interfaces;
    if (data.interfaces.length === 0) {
      el.innerHTML = '<div style="color:var(--text-muted);">No interfaces detected.</div>';
      return;
    }
    el.innerHTML = data.interfaces.map(i => `
      <div style="background:var(--bg-primary);border:1px solid var(--border-color);border-radius:8px;padding:12px 16px;min-width:180px;">
        <div style="font-weight:700;">${i.name}</div>
        <div style="font-size:12px;color:var(--text-muted);">MAC: ${i.mac || 'n/a'}</div>
        <span class="badge ${i.status === 'up' ? 'badge-green' : 'badge-red'}" style="margin-top:6px;display:inline-block;">
          <i class="fas fa-circle" style="font-size:8px;"></i> ${i.status}
        </span>
      </div>
    `).join('');
    populateVlanBaseInterfaceOptions();
  } catch(e) {
    el.innerHTML = '<div style="color:var(--accent-red);">Failed to load interfaces.</div>';
  }
}

function populateVlanBaseInterfaceOptions() {
  const select = document.getElementById('vlanBaseInterface');
  if (!select) return;
  select.innerHTML = cachedInterfaces.map(i =>
    `<option value="${i.name}">${i.name} (${i.status})</option>`
  ).join('');
}

// ===== VLAN MANAGEMENT =====

async function loadVlans() {
  const tbody = document.getElementById('vlansTableBody');
  try {
    const data = await apiCall('GET', '/api/admin/network/vlans');
    if (!data.success) throw new Error(data.message);
    if (data.vlans.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);">No VLANs configured.</td></tr>';
      return;
    }
    tbody.innerHTML = data.vlans.map(v => `
      <tr>
        <td>${v.interface_name}</td>
        <td>${v.vlan_id}</td>
        <td>${v.base_interface}</td>
        <td>${v.mode === 'wan' ? 'WAN' : 'LAN'}</td>
        <td>${v.protocol.toUpperCase()}</td>
        <td>${v.protocol === 'static' ? (v.static_ip || '') : (v.mode === 'lan' ? '10.0.0.1' : 'auto')}</td>
        <td>
          <span class="badge ${v.status === 'up' ? 'badge-green' : 'badge-red'}">
            <i class="fas fa-circle" style="font-size:8px;"></i> ${v.status}
          </span>
        </td>
        <td style="text-align:right;">
          <button class="btn btn-sm btn-danger" onclick="deleteVlan(${v.id}, '${v.interface_name}')">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>
    `).join('');
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--accent-red);">Failed to load VLANs.</td></tr>';
  }
}

function openCreateVlanModal() {
  populateVlanBaseInterfaceOptions();
  document.getElementById('vlanIdInput').value = '';
  document.getElementById('vlanMode').value = 'lan';
  document.getElementById('vlanProtocol').value = 'dhcp';
  document.getElementById('vlanStaticIp').value = '';
  document.getElementById('vlanStaticGateway').value = '';
  document.getElementById('vlanStaticNetmask').value = '';
  onVlanModeChange();
  onVlanProtocolChange();
  document.getElementById('createVlanModal').classList.add('show');
}

function onVlanModeChange() {
  const mode = document.getElementById('vlanMode').value;
  document.getElementById('vlanModeHint').textContent = mode === 'wan'
    ? 'Use this VLAN to connect to the internet (ISP uses VLAN tagging).'
    : "Use this VLAN for the access point's customer-facing WiFi traffic.";
}

function onVlanProtocolChange() {
  const proto = document.getElementById('vlanProtocol').value;
  document.getElementById('vlanStaticFields').style.display = proto === 'static' ? 'block' : 'none';
}

async function createVlan() {
  const base_interface = document.getElementById('vlanBaseInterface').value;
  const vlan_id = document.getElementById('vlanIdInput').value;
  const mode = document.getElementById('vlanMode').value;
  const protocol = document.getElementById('vlanProtocol').value;

  if (!base_interface) return showToast('Select a base interface.', 'error');
  if (!vlan_id) return showToast('Enter a VLAN ID.', 'error');

  const body = { base_interface, vlan_id, mode, protocol };
  if (protocol === 'static') {
    body.static_ip = document.getElementById('vlanStaticIp').value;
    body.static_gateway = document.getElementById('vlanStaticGateway').value;
    body.static_netmask = document.getElementById('vlanStaticNetmask').value;
    if (!body.static_ip || !body.static_gateway || !body.static_netmask) {
      return showToast('Static IP, gateway, and netmask are all required.', 'error');
    }
  }

  const btn = document.getElementById('createVlanBtn');
  btn.disabled = true;
  try {
    const data = await apiCall('POST', '/api/admin/network/vlans', body);
    if (data.success) {
      showToast('VLAN created! Applying network changes...');
      closeModal('createVlanModal');
      await loadVlans();
    } else {
      showToast(data.message || 'Failed to create VLAN.', 'error');
    }
  } catch(e) {
    showToast('Server error.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteVlan(id, ifName) {
  if (!confirm(`Delete VLAN ${ifName}? This takes effect immediately.`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/network/vlans/${id}`);
    if (data.success) {
      showToast('VLAN deleted.');
      await loadVlans();
    } else {
      showToast(data.message || 'Failed to delete VLAN.', 'error');
    }
  } catch(e) {
    showToast('Server error.', 'error');
  }
}
