// ===== NETWORK PAGE =====

async function loadNetworkPage() {
  await loadNetworkModeSettings();
  await loadInterfaces();
  await loadVlans();
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
    document.getElementById('mikrotikFields').style.display = mode === 'mikrotik' ? 'block' : 'none';
    updateNetworkModeCards(mode);
  } catch(e) {
    console.error('Network mode load error:', e);
  }
}

function onNetworkModeChange() {
  const mode = document.querySelector('input[name="networkMode"]:checked').value;
  document.getElementById('mikrotikFields').style.display = mode === 'mikrotik' ? 'block' : 'none';
  updateNetworkModeCards(mode);
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
