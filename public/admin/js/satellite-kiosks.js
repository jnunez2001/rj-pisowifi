// ===== SATELLITE KIOSKS PAGE =====

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}
function openModal(id) {
  document.getElementById(id).classList.add('show');
}

let renameKioskId = null;

async function loadSatelliteKiosks() {
  try {
    const data = await apiCall('GET', '/api/admin/satellite-kiosks');
    if (!data.success) return;

    const tbody = document.getElementById('kioskList');
    if (data.kiosks.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">
            No Satellite Kiosks registered yet. If you're running Main Kiosk only, you don't need one.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = data.kiosks.map(k => `
      <tr>
        <td style="font-weight:600;">${escapeHtml(k.name)}</td>
        <td>
          <span class="badge ${k.online ? 'badge-green' : 'badge-orange'}">
            <span class="status-dot ${k.online ? 'online' : ''}"></span>${k.online ? 'Online' : 'Offline'}
          </span>
        </td>
        <td style="color:var(--text-muted);font-size:13px;">
          ${k.last_seen ? new Date(k.last_seen + 'Z').toLocaleString() : 'Never'}
        </td>
        <td>
          <span class="badge badge-green">₱${k.today_revenue.toFixed(2)}</span>
          <span style="color:var(--text-muted);font-size:12px;">(${k.today_transactions})</span>
        </td>
        <td style="text-align:right;">
          <button class="btn btn-sm btn-secondary" onclick="openRenameKiosk(${k.id}, '${escapeHtml(k.name)}')" title="Rename">
            <i class="fas fa-pen"></i>
          </button>
          <button class="btn btn-sm btn-danger" onclick="confirmDeleteKiosk(${k.id}, '${escapeHtml(k.name)}')" title="Remove">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('Satellite kiosks load error:', e);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function submitAddKiosk() {
  const nameInput = document.getElementById('newKioskName');
  const name = nameInput.value.trim();
  if (!name) {
    showToast('Enter a name for this kiosk', 'error');
    return;
  }
  try {
    const data = await apiCall('POST', '/api/admin/satellite-kiosks', { name });
    if (!data.success) {
      showToast(data.message || 'Failed to add kiosk', 'error');
      return;
    }
    nameInput.value = '';
    closeModal('addKioskModal');

    document.getElementById('kioskKeyName').textContent = data.kiosk.name;
    document.getElementById('kioskKeyValue').value = data.kiosk.device_key;
    openModal('kioskKeyModal');

    loadSatelliteKiosks();
  } catch (e) {
    showToast('Failed to add kiosk', 'error');
  }
}

function copyKioskKey() {
  const input = document.getElementById('kioskKeyValue');
  input.select();
  navigator.clipboard?.writeText(input.value).then(() => {
    showToast('Copied to clipboard');
  }).catch(() => {
    document.execCommand('copy');
  });
}

function openRenameKiosk(id, name) {
  renameKioskId = id;
  document.getElementById('renameKioskName').value = name;
  openModal('renameKioskModal');
}

async function submitRenameKiosk() {
  const name = document.getElementById('renameKioskName').value.trim();
  if (!name || !renameKioskId) return;
  try {
    const data = await apiCall('PUT', `/api/admin/satellite-kiosks/${renameKioskId}`, { name });
    if (!data.success) {
      showToast(data.message || 'Failed to rename kiosk', 'error');
      return;
    }
    closeModal('renameKioskModal');
    showToast('Kiosk renamed');
    loadSatelliteKiosks();
  } catch (e) {
    showToast('Failed to rename kiosk', 'error');
  }
}

async function confirmDeleteKiosk(id, name) {
  if (!confirm(`Remove "${name}"? Its past revenue stays on record, but the kiosk will stop being recognized until re-paired.`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/satellite-kiosks/${id}`);
    if (!data.success) {
      showToast(data.message || 'Failed to remove kiosk', 'error');
      return;
    }
    showToast('Kiosk removed');
    loadSatelliteKiosks();
  } catch (e) {
    showToast('Failed to remove kiosk', 'error');
  }
}
