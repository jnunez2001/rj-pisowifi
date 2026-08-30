// ===== DEVICES PAGE =====

function timeAgo(dateStr) {
  const now = new Date();
  const then = new Date(dateStr.replace(' ', 'T') + 'Z'); // force UTC parsing
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function isOnline(lastSeen) {
  const then = new Date(lastSeen.replace(' ', 'T') + 'Z'); // force UTC parsing
  const diff = (new Date() - then) / 1000;
  return diff < 180; // online if seen within 3 minutes
}

async function loadFirmwareInfo() {
  try {
    const data = await apiCall('GET', '/api/admin/vendo/firmware');
    if (!data.success) return;
    document.getElementById('firmwareCurrentVersion').textContent = data.version || 'None uploaded yet';
    document.getElementById('firmwareUploadedAt').textContent = data.uploaded_at ? timeAgo(data.uploaded_at) : '--';

    document.getElementById('firmwareAutoUpdateToggle').checked = !!data.auto_update;

    const statusEl = document.getElementById('firmwareReleaseStatus');
    const releaseBtn = document.getElementById('releaseFirmwareBtn');
    if (!data.version) {
      statusEl.textContent = '--';
      releaseBtn.style.display = 'none';
    } else if (data.released) {
      statusEl.innerHTML = '<span class="badge badge-green">Live on fleet</span>';
      releaseBtn.style.display = 'none';
    } else {
      statusEl.innerHTML = '<span class="badge badge-orange">Staged - not yet released</span>';
      releaseBtn.style.display = 'inline-flex';
    }
  } catch (e) {
    console.error('Firmware info error:', e);
  }
  await loadBundledFirmwareInfo();
}

async function toggleFirmwareAutoUpdate() {
  const enabled = document.getElementById('firmwareAutoUpdateToggle').checked;
  try {
    const data = await apiCall('POST', '/api/admin/vendo/firmware/auto-update', { enabled });
    if (data.success) {
      showToast(enabled ? 'Auto-update enabled' : 'Auto-update disabled - pushes will stage until released', 'success');
      loadFirmwareInfo();
    } else {
      showToast(data.message || 'Failed to update setting', 'error');
      document.getElementById('firmwareAutoUpdateToggle').checked = !enabled;
    }
  } catch (e) {
    showToast('Server error', 'error');
    document.getElementById('firmwareAutoUpdateToggle').checked = !enabled;
  }
}

async function releaseFirmware() {
  const btn = document.getElementById('releaseFirmwareBtn');
  btn.disabled = true;
  try {
    const data = await apiCall('POST', '/api/admin/vendo/firmware/release');
    if (data.success) {
      showToast(`Released ${data.version} to the fleet`, 'success');
      loadFirmwareInfo();
    } else {
      showToast(data.message || 'Release failed', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  } finally {
    btn.disabled = false;
  }
}

// Bug found live: this used to update a <span> nested inside the button
// rather than owning the button's whole innerHTML - pushBundledFirmware()
// replaces the ENTIRE innerHTML while pushing ("Pushing..."), which
// destroys that span, so this then threw trying to update a now-gone
// element and left the button stuck on "Pushing..." forever. This
// function now always fully rebuilds the button's content itself instead
// of assuming any previous markup survived.
async function loadBundledFirmwareInfo() {
  const btn = document.getElementById('pushBundledFirmwareBtn');
  try {
    const data = await apiCall('GET', '/api/admin/vendo/firmware/bundled');
    if (!data.success || !data.esp8266) {
      btn.innerHTML = '<i class="fas fa-bolt"></i> Bundled firmware unavailable';
      btn.disabled = true;
      return;
    }
    const upToDate = data.currentVersion === data.esp8266.version;
    btn.disabled = upToDate;
    btn.innerHTML = upToDate
      ? `<i class="fas fa-check"></i> Already on ${data.esp8266.version}`
      : `<i class="fas fa-bolt"></i> Update to ${data.esp8266.version}`;
  } catch (e) {
    btn.innerHTML = '<i class="fas fa-bolt"></i> Bundled firmware unavailable';
    btn.disabled = true;
  }
}

async function pushBundledFirmware() {
  const btn = document.getElementById('pushBundledFirmwareBtn');
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Pushing...';
  try {
    const data = await apiCall('POST', '/api/admin/vendo/firmware/push-bundled');
    if (data.success) {
      showToast(data.message || 'Firmware pushed!', 'success');
      loadFirmwareInfo();
    } else {
      showToast(data.message || 'Push failed', 'error');
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  } catch (e) {
    showToast('Push failed', 'error');
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

async function uploadFirmware() {
  const fileInput = document.getElementById('firmwareFile');
  const version = document.getElementById('firmwareVersion').value.trim();
  const file = fileInput.files[0];

  if (!version) {
    showToast('Enter the firmware version first', 'error');
    return;
  }
  if (!file) {
    showToast('Select a .bin firmware file first', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('firmware', file);
  formData.append('version', version);

  try {
    const res = await fetch('/api/admin/vendo/firmware', {
      method: 'POST',
      headers: { 'password': authToken },
      body: formData
    });
    const data = await res.json();

    if (data.success) {
      showToast(data.message || 'Firmware pushed!', 'success');
      fileInput.value = '';
      loadFirmwareInfo();
    } else {
      showToast(data.message || 'Upload failed', 'error');
    }
  } catch (e) {
    showToast('Upload error', 'error');
  }
}

async function loadDevices() {
  startDevicesRefresh();
  loadFirmwareInfo();
  try {
    const data = await apiCall('GET', '/api/admin/vendos');
    const tbody = document.getElementById('devicesTable');
    if (!tbody) return;

    if (!data.success || !data.vendos.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align:center;color:var(--text-muted);padding:32px;">
            <i class="fas fa-microchip" style="font-size:32px;margin-bottom:12px;display:block;opacity:0.3;"></i>
            No devices registered yet.<br>
            <span style="font-size:12px;">Follow the steps on the right to add a device.</span>
          </td>
        </tr>`;

      document.getElementById('totalDevices').textContent = '0';
      document.getElementById('onlineDevices').textContent = '0';
      document.getElementById('offlineDevices').textContent = '0';
      return;
    }

    // Count online/offline
    let online = 0;
    let offline = 0;

    tbody.innerHTML = data.vendos.map(v => {
      const on = isOnline(v.last_seen);
      if (on) online++; else offline++;

      const statusBadge = on
        ? `<span class="badge badge-green">
             <i class="fas fa-circle" style="font-size:7px;margin-right:4px;color:var(--accent-green);"></i>Online
           </span>`
        : `<span class="badge badge-red">
             <i class="fas fa-circle" style="font-size:7px;margin-right:4px;color:var(--accent-red);"></i>Offline
           </span>`;

      const isCandidate = v.status === 'candidate';

      const ipLink = v.ip_address
        ? `<a href="http://${v.ip_address}" target="_blank"
              style="color:var(--accent-blue);text-decoration:none;font-family:monospace;font-size:13px;">
             ${v.ip_address}
           </a>`
        : '--';

      return `
        <tr${isCandidate ? ' style="background:var(--accent-yellow-light,#fff8e1);"' : ''}>
          <td data-label="Name">
            <div style="font-weight:700;">${v.name}</div>
            ${isCandidate ? '<span class="badge badge-orange" style="margin-top:4px;">New - needs approval</span>' : ''}
          </td>
          <td data-label="Role">
            <select class="form-control" style="width:auto;font-size:12px;padding:4px 8px;" onchange="changeVendoRole(${v.id}, this.value)" ${isCandidate ? 'disabled' : ''}>
              <option value="main" ${v.role === 'main' ? 'selected' : ''}>Main</option>
              <option value="sub" ${v.role === 'sub' ? 'selected' : ''}>Sub-vendo</option>
              <option value="standalone" ${(!v.role || v.role === 'standalone') ? 'selected' : ''}>Standalone</option>
            </select>
          </td>
          <td data-label="MAC Address" style="font-family:monospace;font-size:12px;color:var(--text-muted);">
            ${v.mac_address}
          </td>
          <td data-label="IP Address">${ipLink}</td>
          <td data-label="Firmware">
            <span class="badge badge-blue">${v.firmware || '--'}</span>
          </td>
          <td data-label="Status">${statusBadge}</td>
          <td data-label="Last Seen" style="font-size:13px;color:var(--text-muted);">
            ${timeAgo(v.last_seen)}
          </td>
          <td class="table-stack-full" style="text-align:right;">
            ${isCandidate ? `
              <button class="btn btn-sm btn-primary" onclick="adoptVendoDevice(${v.id}, '${escapeHtml(v.name)}')">
                <i class="fas fa-check"></i> Adopt
              </button>
            ` : `
              <button class="btn btn-sm btn-secondary" onclick="openVendoDetails(${v.id}, '${escapeHtml(v.name)}', '${escapeHtml(v.restart_schedule || '')}', '${escapeHtml(v.coinslot_purpose || 'wifi')}')" title="Device details">
                <i class="fas fa-gear"></i>
              </button>
              <button class="btn btn-sm btn-secondary" onclick="restartVendo(${v.id}, '${escapeHtml(v.name)}')" title="Restart device">
                <i class="fas fa-rotate"></i>
              </button>
            `}
            <button class="btn btn-sm btn-danger" onclick="removeVendo(${v.id}, '${escapeHtml(v.name)}')">
              <i class="fas fa-trash"></i>
            </button>
          </td>
        </tr>`;
    }).join('');

    // Update summary
    document.getElementById('totalDevices').textContent = data.vendos.length;
    document.getElementById('onlineDevices').textContent = online;
    document.getElementById('offlineDevices').textContent = offline;

  } catch(e) {
    console.error('Devices error:', e);
  }
}

async function changeVendoRole(id, role) {
  try {
    const data = await apiCall('PUT', `/api/admin/vendos/${id}/role`, { role });
    if (!data.success) {
      showToast(data.message || 'Failed to update role', 'error');
      loadDevices();
      return;
    }
    showToast('Role updated');
  } catch (e) {
    showToast('Failed to update role', 'error');
  }
}

async function adoptVendoDevice(id, name) {
  try {
    const data = await apiCall('POST', `/api/admin/vendos/${id}/adopt`);
    if (data.success) {
      showToast(`${name} adopted`, 'success');
      loadDevices();
    } else {
      showToast(data.message || 'Failed to adopt device', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  }
}

async function restartVendo(id, name) {
  if (!confirm(`Restart "${name}"? It'll be briefly unreachable for paying customers while it reboots.`)) return;
  try {
    const data = await apiCall('POST', `/api/admin/vendos/${id}/restart`);
    if (data.success) {
      showToast(`${name} is restarting`, 'success');
    } else {
      showToast(data.message || 'Failed to restart device', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  }
}

// ===== DEVICE DETAILS MODAL =====
let vdCurrentId = null;

function formatUptime(seconds) {
  if (seconds == null) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function openVendoDetails(id, name, restartSchedule, coinslotPurpose) {
  vdCurrentId = id;
  document.getElementById('vdName').value = name;
  document.getElementById('vdRestartSchedule').value = restartSchedule || '';
  document.getElementById('vdCoinslotPurpose').value = coinslotPurpose || 'wifi';
  document.getElementById('vdUptime').textContent = 'Loading...';
  document.getElementById('vdWifi').textContent = '--';
  document.getElementById('vdRelay').textContent = '--';
  document.getElementById('vdFirmware').textContent = '--';
  document.getElementById('vdMac').textContent = '--';
  document.getElementById('vdStaticIp').checked = false;
  document.getElementById('vdDeviceIp').value = '';
  document.getElementById('vdGateway').value = '';
  document.getElementById('vdSubnet').value = '';
  toggleVdStaticFields();
  document.getElementById('vendoDetailsModal').classList.add('show');
  refreshVendoHealth();
}

function toggleVdStaticFields() {
  document.getElementById('vdStaticFields').style.display =
    document.getElementById('vdStaticIp').checked ? 'block' : 'none';
}

async function refreshVendoHealth() {
  if (!vdCurrentId) return;
  document.getElementById('vdUptime').textContent = 'Loading...';
  try {
    const data = await apiCall('GET', `/api/admin/vendos/${vdCurrentId}/health`);
    if (!data.success) {
      showToast(data.message || 'Could not reach device', 'error');
      document.getElementById('vdUptime').textContent = 'Unreachable';
      return;
    }
    document.getElementById('vdUptime').textContent = formatUptime(data.uptime_seconds);
    document.getElementById('vdWifi').textContent = data.wifi ? 'Connected' : 'Disconnected';
    document.getElementById('vdRelay').textContent = data.relay ? 'Active' : 'Idle';
    document.getElementById('vdFirmware').textContent = data.firmware || '--';
    document.getElementById('vdMac').textContent = data.mac || '--';
    document.getElementById('vdStaticIp').checked = !!data.static_ip;
    document.getElementById('vdDeviceIp').value = data.device_ip || '';
    document.getElementById('vdGateway').value = data.gateway || '';
    document.getElementById('vdSubnet').value = data.subnet || '';
    toggleVdStaticFields();
  } catch (e) {
    document.getElementById('vdUptime').textContent = 'Unreachable';
  }
}

async function saveVendoName() {
  if (!vdCurrentId) return;
  const name = document.getElementById('vdName').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }
  try {
    const data = await apiCall('PATCH', `/api/admin/vendos/${vdCurrentId}`, { name });
    if (data.success) {
      showToast('Device renamed', 'success');
      loadDevices();
    } else {
      showToast(data.message || 'Failed to rename device', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  }
}

async function saveVendoNetwork() {
  if (!vdCurrentId) return;
  const staticIp = document.getElementById('vdStaticIp').checked;
  const deviceIp = document.getElementById('vdDeviceIp').value.trim();
  const gateway = document.getElementById('vdGateway').value.trim();
  const subnet = document.getElementById('vdSubnet').value.trim();

  if (staticIp && (!deviceIp || !gateway || !subnet)) {
    showToast('Device IP, gateway, and subnet are required for a static IP', 'error');
    return;
  }
  if (!confirm('Apply network settings and restart the device? A wrong static IP can make it unreachable until reset by hand.')) return;

  try {
    const data = await apiCall('POST', `/api/admin/vendos/${vdCurrentId}/network`, {
      static_ip: staticIp, device_ip: deviceIp, gateway, subnet
    });
    if (data.success) {
      showToast(data.message || 'Network settings applied', 'success');
    } else {
      showToast(data.message || 'Failed to apply network settings', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  }
}

async function saveVendoSchedule() {
  if (!vdCurrentId) return;
  const time = document.getElementById('vdRestartSchedule').value || null;
  try {
    const data = await apiCall('PUT', `/api/admin/vendos/${vdCurrentId}/restart-schedule`, { time });
    if (data.success) {
      showToast(data.message || 'Schedule saved', 'success');
      loadDevices();
    } else {
      showToast(data.message || 'Failed to save schedule', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  }
}

async function saveVendoCoinslotPurpose() {
  if (!vdCurrentId) return;
  const purpose = document.getElementById('vdCoinslotPurpose').value;
  try {
    const data = await apiCall('PATCH', `/api/admin/vendos/${vdCurrentId}/coinslot-purpose`, { purpose });
    if (data.success) {
      showToast(data.message || 'Coinslot purpose saved', 'success');
      loadDevices();
    } else {
      showToast(data.message || 'Failed to save coinslot purpose', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  }
}

async function removeVendo(id, name) {
  if (!confirm(`Remove "${name}" from the devices list? It will reappear on its own if it's still powered on and reaches the server.`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/vendos/${id}`);
    if (data.success) {
      showToast('Device removed', 'success');
      loadDevices();
    } else {
      showToast(data.message || 'Failed to remove device', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  }
}

// Auto refresh every 30 seconds.
// Bug: this ran forever from the moment the Devices page was ever visited
// once, since this script only ever loads once per admin session (not
// re-injected per navigateTo) - loadFirmwareInfo() kept firing on every
// other page, throwing "Cannot set properties of null" trying to update
// Devices-only DOM elements that no longer existed. Tracked and cleared on
// navigation, same destroy<Page> pattern as hotspot-dashboard.js.
let devicesRefreshInterval = null;

function startDevicesRefresh() {
  if (devicesRefreshInterval) clearInterval(devicesRefreshInterval);
  devicesRefreshInterval = setInterval(loadDevices, 30000);
}

function destroyDevices() {
  if (devicesRefreshInterval) { clearInterval(devicesRefreshInterval); devicesRefreshInterval = null; }
}