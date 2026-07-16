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
  } catch (e) {
    console.error('Firmware info error:', e);
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
      showToast('Firmware pushed! Vendos will update on their next check-in.', 'success');
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
  loadFirmwareInfo();
  loadTrustedDevices();
  try {
    const data = await apiCall('GET', '/api/admin/vendos');
    const tbody = document.getElementById('devicesTable');
    if (!tbody) return;

    if (!data.success || !data.vendos.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align:center;color:var(--text-muted);padding:32px;">
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
             <i class="fas fa-circle" style="font-size:7px;margin-right:4px;"></i>Online
           </span>`
        : `<span class="badge badge-red">
             <i class="fas fa-circle" style="font-size:7px;margin-right:4px;"></i>Offline
           </span>`;

      const ipLink = v.ip_address
        ? `<a href="http://${v.ip_address}" target="_blank"
              style="color:var(--accent-blue);text-decoration:none;font-family:monospace;font-size:13px;">
             ${v.ip_address}
           </a>`
        : '--';

      return `
        <tr>
          <td>
            <div style="font-weight:700;">${v.name}</div>
          </td>
          <td style="font-family:monospace;font-size:12px;color:var(--text-muted);">
            ${v.mac_address}
          </td>
          <td>${ipLink}</td>
          <td>
            <span class="badge badge-blue">${v.firmware || '--'}</span>
          </td>
          <td>${statusBadge}</td>
          <td style="font-size:13px;color:var(--text-muted);">
            ${timeAgo(v.last_seen)}
          </td>
          <td style="text-align:right;">
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

async function loadTrustedDevices() {
  try {
    const data = await apiCall('GET', '/api/admin/trusted-devices');
    const tbody = document.getElementById('trustedDevicesTable');
    if (!tbody) return;

    if (!data.success || !data.devices.length) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:20px;">No trusted devices yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.devices.map(d => `
      <tr>
        <td>${escapeHtml(d.label || '--')}</td>
        <td style="font-family:monospace;font-size:12px;color:var(--text-muted);">${escapeHtml(d.mac_address)}</td>
        <td style="text-align:right;">
          <button class="btn btn-sm btn-danger" onclick="removeTrustedDevice(${d.id})">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>`).join('');
  } catch (e) {
    console.error('Trusted devices error:', e);
  }
}

async function addTrustedDevice() {
  const mac = prompt('MAC address of the device to trust (e.g. AA:BB:CC:DD:EE:FF):');
  if (!mac) return;
  const label = prompt('Label for this device (e.g. "Coin slot ESP32"):') || '';

  try {
    const data = await apiCall('POST', '/api/admin/trusted-devices', { mac_address: mac.trim(), label: label.trim() });
    if (data.success) {
      showToast('Device trusted!', 'success');
      loadTrustedDevices();
    } else {
      showToast(data.message || 'Failed to add device', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  }
}

async function removeTrustedDevice(id) {
  if (!confirm('Remove this trusted device? It will need to pay like any other customer afterward.')) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/trusted-devices/${id}`);
    if (data.success) {
      showToast('Trusted device removed', 'success');
      loadTrustedDevices();
    } else {
      showToast(data.message || 'Failed to remove device', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  }
}

// Auto refresh every 30 seconds (loadDevices also refreshes trusted devices)
setInterval(loadDevices, 30000);