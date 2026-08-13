// ===== MIKROTIK NETWORK POWER PANELS =====
// UI for the MikroTik VLAN/DHCP/Roles/Firewall-Zone/Port-Forward backend
// (server/services/mikrotikService.js, routes in admin.js) - the backend
// for all of this already existed with no frontend at all before this file.
// Loaded only from network.html's mikrotik-mode section (showRouterModeCards).

async function loadMikrotikNetworkPowerSummaries() {
  try {
    const [vlans, dhcp, roles, zones, forwards] = await Promise.all([
      apiCall('GET', '/api/admin/network/mikrotik/vlans'),
      apiCall('GET', '/api/admin/network/mikrotik/dhcp'),
      apiCall('GET', '/api/admin/network/mikrotik/roles'),
      apiCall('GET', '/api/admin/network/mikrotik/firewall-zones'),
      apiCall('GET', '/api/admin/network/mikrotik/port-forwards'),
    ]);
    setMtNavSub('mtVlanNavSub', vlans, 'vlans', 'VLAN');
    setMtNavSub('mtDhcpNavSub', dhcp, 'servers', 'DHCP server');
    setMtNavSub('mtRolesNavSub', roles, 'roles', 'interface');
    setMtNavSub('mtZonesNavSub', zones, 'policies', 'policy');
    setMtNavSub('mtForwardsNavSub', forwards, 'forwards', 'forward');
  } catch (e) {
    // Best-effort summaries only - each modal re-fetches its own data on open.
  }
}

function setMtNavSub(elId, data, listKey, singular) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!data || !data.success) { el.textContent = 'Unable to reach router'; return; }
  const list = data[listKey] || [];
  el.textContent = list.length === 0 ? `No ${singular}s configured` : `${list.length} ${singular}${list.length > 1 ? 's' : ''}`;
}

// ===== VLANS =====

function openMtVlanModal() {
  document.getElementById('mtVlanModal').classList.add('show');
  populateMtVlanParentOptions();
  loadMtVlans();
}

async function populateMtVlanParentOptions() {
  const select = document.getElementById('mtVlanParent');
  try {
    const data = await apiCall('GET', '/api/admin/router/ports');
    const ports = (data.success && data.physical_ports) ? data.physical_ports : [];
    select.innerHTML = ports.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('') || '<option value="">No ports found</option>';
  } catch (e) {
    select.innerHTML = '<option value="">No ports found</option>';
  }
}

async function loadMtVlans() {
  const tbody = document.getElementById('mtVlanTableBody');
  try {
    const data = await apiCall('GET', '/api/admin/network/mikrotik/vlans');
    if (!data.success) throw new Error(data.message);
    if (!data.vlans.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No VLANs configured.</td></tr>';
      return;
    }
    tbody.innerHTML = data.vlans.map(v => `
      <tr>
        <td>${escapeHtml(v.name || v.interface_name || '')}</td>
        <td>${escapeHtml(String(v.vlan_id))}</td>
        <td>${escapeHtml(v.parent_interface || v.interface || '')}</td>
        <td>${escapeHtml(v.ip_address || '-')}</td>
        <td style="text-align:right;">
          <button class="btn btn-sm btn-danger" onclick="deleteMtVlan('${escapeHtml(v['.id'] || v.id)}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--accent-red);">${escapeHtml(e.message || 'Failed to reach router.')}</td></tr>`;
  }
}

async function createMtVlan() {
  const parentInterface = document.getElementById('mtVlanParent').value;
  const vlanId = document.getElementById('mtVlanId').value;
  const name = document.getElementById('mtVlanName').value.trim();
  const ipAddress = document.getElementById('mtVlanIp').value.trim();
  if (!parentInterface) return showToast('Select a parent interface.', 'error');
  if (!vlanId) return showToast('Enter a VLAN ID.', 'error');

  const btn = document.getElementById('mtVlanAddBtn');
  btn.disabled = true;
  try {
    const data = await apiCall('POST', '/api/admin/network/mikrotik/vlans', { parentInterface, vlanId, name, ipAddress });
    if (data.success) {
      showToast('VLAN created!');
      document.getElementById('mtVlanId').value = '';
      document.getElementById('mtVlanName').value = '';
      document.getElementById('mtVlanIp').value = '';
      await loadMtVlans();
      loadMikrotikNetworkPowerSummaries();
    } else {
      showToast(data.message || 'Failed to create VLAN.', 'error');
    }
  } catch (e) {
    showToast('Server error, please try again.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteMtVlan(id) {
  if (!confirm('Delete this VLAN from the router? This takes effect immediately.')) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/network/mikrotik/vlans/${encodeURIComponent(id)}`);
    if (data.success) {
      showToast('VLAN deleted.');
      await loadMtVlans();
      loadMikrotikNetworkPowerSummaries();
    } else {
      showToast(data.message || 'Failed to delete VLAN.', 'error');
    }
  } catch (e) {
    showToast('Server error, please try again.', 'error');
  }
}

// ===== DHCP SERVERS =====

function openMtDhcpModal() {
  document.getElementById('mtDhcpModal').classList.add('show');
  populateMtDhcpInterfaceOptions();
  loadMtDhcp();
}

async function populateMtDhcpInterfaceOptions() {
  const select = document.getElementById('mtDhcpInterface');
  try {
    const [ports, vlans] = await Promise.all([
      apiCall('GET', '/api/admin/router/ports'),
      apiCall('GET', '/api/admin/network/mikrotik/vlans'),
    ]);
    const opts = [];
    if (ports.success) (ports.physical_ports || []).forEach(p => opts.push(p.name));
    if (vlans.success) (vlans.vlans || []).forEach(v => opts.push(v.name || v.interface_name));
    select.innerHTML = opts.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('') || '<option value="">No interfaces found</option>';
  } catch (e) {
    select.innerHTML = '<option value="">No interfaces found</option>';
  }
}

async function loadMtDhcp() {
  const tbody = document.getElementById('mtDhcpTableBody');
  try {
    const data = await apiCall('GET', '/api/admin/network/mikrotik/dhcp');
    if (!data.success) throw new Error(data.message);
    if (!data.servers.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">No DHCP servers configured.</td></tr>';
      return;
    }
    tbody.innerHTML = data.servers.map(s => `
      <tr>
        <td>${escapeHtml(s.interface || '')}</td>
        <td>${escapeHtml(s.name || '')}</td>
        <td>${escapeHtml(s.network || '')}</td>
        <td>${escapeHtml(s.pool_range || s.pool || '')}</td>
        <td>${escapeHtml(s.gateway || '')}</td>
        <td style="text-align:right;">
          <button class="btn btn-sm btn-danger" onclick="deleteMtDhcp('${escapeHtml(s['.id'] || s.id)}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--accent-red);">${escapeHtml(e.message || 'Failed to reach router.')}</td></tr>`;
  }
}

async function createMtDhcp() {
  const interfaceName = document.getElementById('mtDhcpInterface').value;
  const name = document.getElementById('mtDhcpName').value.trim();
  const network = document.getElementById('mtDhcpNetwork').value.trim();
  const gateway = document.getElementById('mtDhcpGateway').value.trim();
  const poolRange = document.getElementById('mtDhcpPool').value.trim();
  const dnsServers = document.getElementById('mtDhcpDns').value.trim();
  if (!interfaceName) return showToast('Select an interface.', 'error');
  if (!network || !gateway || !poolRange) return showToast('Network, gateway, and pool range are all required.', 'error');

  const btn = document.getElementById('mtDhcpAddBtn');
  btn.disabled = true;
  try {
    const data = await apiCall('POST', '/api/admin/network/mikrotik/dhcp', { interfaceName, poolRange, network, gateway, dnsServers, name });
    if (data.success) {
      showToast('DHCP server created!');
      document.getElementById('mtDhcpName').value = '';
      document.getElementById('mtDhcpNetwork').value = '';
      document.getElementById('mtDhcpGateway').value = '';
      document.getElementById('mtDhcpPool').value = '';
      document.getElementById('mtDhcpDns').value = '';
      await loadMtDhcp();
      loadMikrotikNetworkPowerSummaries();
    } else {
      showToast(data.message || 'Failed to create DHCP server.', 'error');
    }
  } catch (e) {
    showToast('Server error, please try again.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteMtDhcp(id) {
  if (!confirm('Delete this DHCP server from the router? Connected clients on it will stop getting addresses.')) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/network/mikrotik/dhcp/${encodeURIComponent(id)}`);
    if (data.success) {
      showToast('DHCP server deleted.');
      await loadMtDhcp();
      loadMikrotikNetworkPowerSummaries();
    } else {
      showToast(data.message || 'Failed to delete DHCP server.', 'error');
    }
  } catch (e) {
    showToast('Server error, please try again.', 'error');
  }
}

// ===== PORT / INTERFACE ROLES =====

function openMtRolesModal() {
  document.getElementById('mtRolesModal').classList.add('show');
  loadMtRoles();
}

async function loadMtRoles() {
  const tbody = document.getElementById('mtRolesTableBody');
  try {
    const data = await apiCall('GET', '/api/admin/network/mikrotik/roles');
    if (!data.success) throw new Error(data.message);
    if (!data.roles.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">No interfaces found.</td></tr>';
      return;
    }
    tbody.innerHTML = data.roles.map(r => `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td style="font-family:monospace;font-size:12px;color:var(--text-muted);">${escapeHtml(r.mac || '-')}</td>
        <td><span class="badge ${r.running ? 'badge-green' : 'badge-red'}">${r.running ? 'Up' : 'Down'}</span></td>
        <td>
          <select class="form-control" style="width:auto;font-size:12px;padding:4px 8px;" onchange="setMtRole('${escapeHtml(r.name)}', this.value, this)">
            <option value="unused" ${r.role === 'unused' ? 'selected' : ''}>Unused</option>
            <option value="wan" ${r.role === 'wan' ? 'selected' : ''}>WAN</option>
            <option value="lan" ${r.role === 'lan' ? 'selected' : ''}>LAN</option>
            <option value="guest" ${r.role === 'guest' ? 'selected' : ''}>Guest</option>
          </select>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--accent-red);">${escapeHtml(e.message || 'Failed to reach router.')}</td></tr>`;
  }
}

async function setMtRole(interfaceName, role, selectEl, confirmed) {
  selectEl.disabled = true;
  try {
    const body = { interfaceName, role };
    if (confirmed) body.confirmed = true;
    const data = await apiCall('POST', '/api/admin/network/mikrotik/roles', body);
    if (data.success) {
      showToast(`${interfaceName} set to ${role}.`);
      loadMikrotikNetworkPowerSummaries();
    } else if (data.requiresConfirmation) {
      const reasons = (data.reasons || []).map(r => `• ${r}`).join('\n');
      if (confirm(`${data.message}\n\n${reasons}\n\nApply anyway?`)) {
        selectEl.disabled = false;
        return setMtRole(interfaceName, role, selectEl, true);
      }
      showToast('Role change cancelled.', 'warning');
      await loadMtRoles();
    } else {
      showToast(data.message || 'Failed to set role.', 'error') ;
      if (data.rolledBack) showToast('Rolled back to the previous role.', 'warning');
      await loadMtRoles();
    }
  } catch (e) {
    showToast('Server error, please try again.', 'error');
    await loadMtRoles();
  } finally {
    selectEl.disabled = false;
  }
}

// ===== FIREWALL ZONES =====

function openMtZonesModal() {
  document.getElementById('mtZonesModal').classList.add('show');
  loadMtZones();
}

async function loadMtZones() {
  const tbody = document.getElementById('mtZonesTableBody');
  try {
    const data = await apiCall('GET', '/api/admin/network/mikrotik/firewall-zones');
    if (!data.success) throw new Error(data.message);
    if (!data.policies.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">No zone policies yet.</td></tr>';
      return;
    }
    tbody.innerHTML = data.policies.map(p => `
      <tr>
        <td>${escapeHtml((p.from_zone || '').toUpperCase())}</td>
        <td>${escapeHtml((p.to_zone || '').toUpperCase())}</td>
        <td><span class="badge ${p.action === 'accept' ? 'badge-green' : 'badge-red'}">${escapeHtml(p.action)}</span></td>
        <td style="text-align:right;">
          <button class="btn btn-sm btn-danger" onclick="deleteMtZone('${escapeHtml(p['.id'] || p.id)}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--accent-red);">${escapeHtml(e.message || 'Failed to reach router.')}</td></tr>`;
  }
}

async function createMtZone() {
  const fromZone = document.getElementById('mtZoneFrom').value;
  const toZone = document.getElementById('mtZoneTo').value;
  const action = document.getElementById('mtZoneAction').value;
  const btn = document.getElementById('mtZoneAddBtn');
  btn.disabled = true;
  try {
    const data = await apiCall('POST', '/api/admin/network/mikrotik/firewall-zones', { fromZone, toZone, action });
    if (data.success) {
      showToast('Zone policy created!');
      await loadMtZones();
      loadMikrotikNetworkPowerSummaries();
    } else {
      showToast(data.message || 'Failed to create policy.', 'error');
    }
  } catch (e) {
    showToast('Server error, please try again.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteMtZone(id) {
  if (!confirm('Delete this firewall zone policy?')) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/network/mikrotik/firewall-zones/${encodeURIComponent(id)}`);
    if (data.success) {
      showToast('Policy deleted.');
      await loadMtZones();
      loadMikrotikNetworkPowerSummaries();
    } else {
      showToast(data.message || 'Failed to delete policy.', 'error');
    }
  } catch (e) {
    showToast('Server error, please try again.', 'error');
  }
}

// ===== PORT FORWARDS =====

function openMtForwardsModal() {
  document.getElementById('mtForwardsModal').classList.add('show');
  loadMtForwards();
}

async function loadMtForwards() {
  const tbody = document.getElementById('mtForwardsTableBody');
  try {
    const data = await apiCall('GET', '/api/admin/network/mikrotik/port-forwards');
    if (!data.success) throw new Error(data.message);
    if (!data.forwards.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">No port forwards yet.</td></tr>';
      return;
    }
    tbody.innerHTML = data.forwards.map(f => `
      <tr>
        <td>${escapeHtml((f.protocol || '').toUpperCase())}</td>
        <td>${escapeHtml(String(f.external_port))}</td>
        <td>${escapeHtml(f.internal_ip)}:${escapeHtml(String(f.internal_port))}</td>
        <td style="text-align:right;">
          <button class="btn btn-sm btn-danger" onclick="deleteMtForward('${escapeHtml(f['.id'] || f.id)}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--accent-red);">${escapeHtml(e.message || 'Failed to reach router.')}</td></tr>`;
  }
}

async function createMtForward() {
  const protocol = document.getElementById('mtFwdProtocol').value;
  const externalPort = document.getElementById('mtFwdExternalPort').value;
  const internalIp = document.getElementById('mtFwdInternalIp').value.trim();
  const internalPort = document.getElementById('mtFwdInternalPort').value;
  if (!externalPort || !internalIp || !internalPort) return showToast('All fields are required.', 'error');

  const btn = document.getElementById('mtFwdAddBtn');
  btn.disabled = true;
  try {
    const data = await apiCall('POST', '/api/admin/network/mikrotik/port-forwards', { protocol, externalPort, internalIp, internalPort });
    if (data.success) {
      showToast('Port forward added!');
      document.getElementById('mtFwdExternalPort').value = '';
      document.getElementById('mtFwdInternalIp').value = '';
      document.getElementById('mtFwdInternalPort').value = '';
      await loadMtForwards();
      loadMikrotikNetworkPowerSummaries();
    } else {
      showToast(data.message || 'Failed to add port forward.', 'error');
    }
  } catch (e) {
    showToast('Server error, please try again.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteMtForward(id) {
  if (!confirm('Delete this port forward?')) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/network/mikrotik/port-forwards/${encodeURIComponent(id)}`);
    if (data.success) {
      showToast('Port forward deleted.');
      await loadMtForwards();
      loadMikrotikNetworkPowerSummaries();
    } else {
      showToast(data.message || 'Failed to delete forward.', 'error');
    }
  } catch (e) {
    showToast('Server error, please try again.', 'error');
  }
}

// ===== DNS SERVERS (both modes) =====

async function loadDnsServers() {
  try {
    const data = await apiCall('GET', '/api/admin/network/dns');
    if (!data.success) return;
    document.getElementById('dnsPrimary').value = data.dns1 || '';
    document.getElementById('dnsSecondary').value = data.dns2 || '';
  } catch (e) {
    // leave fields blank on failure - form still usable
  }
}

async function saveDnsServers() {
  const dns1 = document.getElementById('dnsPrimary').value.trim();
  const dns2 = document.getElementById('dnsSecondary').value.trim();
  if (!dns1) return showToast('Primary DNS is required.', 'error');

  const btn = document.getElementById('dnsSaveBtn');
  btn.disabled = true;
  try {
    const data = await apiCall('POST', '/api/admin/network/dns', { dns1, dns2 });
    if (data.success && data.routerPushFailed) {
      showToast(data.message || 'Saved, but could not reach the router right now.', 'warning');
    } else if (data.success) {
      showToast('DNS servers saved!');
    } else {
      showToast(data.message || 'Failed to save DNS settings.', 'error');
    }
  } catch (e) {
    showToast('Server error, please try again.', 'error');
  } finally {
    btn.disabled = false;
  }
}
