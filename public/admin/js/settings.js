// ===== SETTINGS PAGE =====

function updateToggleLabel(checkboxId, labelId) {
  const checkbox = document.getElementById(checkboxId);
  const label = document.getElementById(labelId);
  if (!checkbox || !label) return;
  label.textContent = checkbox.checked ? 'Enabled' : 'Disabled';
}

function setToggle(checkboxId, labelId, value) {
  const checkbox = document.getElementById(checkboxId);
  const label = document.getElementById(labelId);
  if (checkbox) checkbox.checked = !!value;
  if (label) label.textContent = value ? 'Enabled' : 'Disabled';
}

async function loadScheduledBackups() {
  const box = document.getElementById('scheduledBackupList');
  if (!box) return;
  try {
    const data = await apiCall('GET', '/api/admin/backup/scheduled/list');
    if (!data.success || !data.backups || data.backups.length === 0) {
      box.textContent = 'No automatic backup yet. The first one is taken shortly after the server starts, then nightly after that.';
      return;
    }
    const latest = data.backups[0];
    const sizeMb = (latest.sizeBytes / (1024 * 1024)).toFixed(1);
    box.innerHTML = `Latest: <strong>${new Date(latest.createdAt).toLocaleString()}</strong> (${sizeMb} MB) &middot; ${data.backups.length} kept`;
  } catch (e) {
    box.textContent = 'Could not load backup status.';
  }
}

async function loadDateTimeSettings() {
  const timeEl = document.getElementById('currentServerTime');
  const tzSelect = document.getElementById('serverTimezone');
  if (!timeEl || !tzSelect) return;
  try {
    const data = await apiCall('GET', '/api/admin/system/datetime');
    if (!data.success) {
      timeEl.textContent = 'Unavailable';
      return;
    }
    timeEl.textContent = new Date(data.current_time).toLocaleString();
    setToggle('ntpEnabled', 'ntpEnabledLabel', data.ntp_enabled);

    // Populate the real dropdown from the server's own valid timezone
    // list rather than trusting only the hardcoded Asia/Manila option in
    // the HTML - keeps the current value selectable even on an install
    // set to something else, without needing to ship/maintain the full
    // IANA list by hand in this file.
    if (Array.isArray(data.timezones) && data.timezones.length > 0) {
      const current = data.timezone;
      tzSelect.innerHTML = data.timezones.map((tz) =>
        `<option value="${tz}" ${tz === current ? 'selected' : ''}>${tz}</option>`
      ).join('');
    }
  } catch (e) {
    timeEl.textContent = 'Unavailable';
  }
}

async function saveDateTimeSettings() {
  const statusEl = document.getElementById('dateTimeStatus');
  const ntpEnabled = document.getElementById('ntpEnabled').checked;
  const timezone = document.getElementById('serverTimezone').value;
  try {
    const data = await apiCall('POST', '/api/admin/system/datetime', { ntp_enabled: ntpEnabled, timezone });
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.style.background = data.success ? 'var(--bg-primary)' : 'var(--bg-primary)';
      statusEl.style.color = data.success ? 'var(--accent-green)' : 'var(--accent-red)';
      statusEl.textContent = data.success ? 'Saved.' : (data.message || 'Could not save.');
    }
    if (data.success) loadDateTimeSettings();
  } catch (e) {
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.style.color = 'var(--accent-red)';
      statusEl.textContent = 'Server error.';
    }
  }
}

async function loadSettings() {
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    if (!data.success) return;
    const s = data.settings;
    loadScheduledBackups();
    loadTrustedDevices();
    loadRecoveryStatus();

    // Server IP Configuration
    currentNetworkMode = s.network_mode || 'standalone';
    updateDhcpControllerWarning();
    loadNetworkConfig();
    loadCurrentIp();

    // Date & Time
    loadDateTimeSettings();

    // Portal Addresses
    loadAdminHostname();
    loadPortalHostname();

    // Business Type
    document.getElementById('venueType').value = s.venue_type || 'piso_wifi';

    // Cafe Info
    document.getElementById('cafeName').value = s.cafe_name || '';
    document.getElementById('bannerText').value = s.banner_text || '';
    document.getElementById('currency').value = s.currency || '₱';
    document.getElementById('cafeAddress').value = s.cafe_address || '';
    document.getElementById('cafeContact').value = s.cafe_contact || '';

    // Admin Credentials
    document.getElementById('adminUsername').value = s.admin_username || 'admin';

    // Anti-Tethering Detection
    setToggle('tetheringDetection', 'tetheringDetectionLabel', s.enable_tethering_detection === '1');

    // Portal Settings, Session Settings, and Coin Slot Settings moved to
    // the Hotspot Settings tab (public/admin/js/hotspot-settings.js) - see
    // loadHotspotSettings() there.

  } catch(e) {
    console.error('Settings load error:', e);
  }
}

async function onVenueTypeChange() {
  const venueType = document.getElementById('venueType').value;
  try {
    const data = await apiCall('POST', '/api/admin/settings', { venue_type: venueType });
    if (data.success) {
      window.currentVenueType = venueType;
      showToast('Business type updated - nav labels will reflect this next time you open a menu.');
    } else {
      showToast(data.message || 'Failed to save.', 'error');
    }
  } catch (e) {
    showToast('Server error.', 'error');
  }
}

async function saveCafeSettings() {
  try {
    const data = await apiCall('POST', '/api/admin/settings', {
      cafe_name: document.getElementById('cafeName').value,
      banner_text: document.getElementById('bannerText').value,
      currency: document.getElementById('currency').value,
      cafe_address: document.getElementById('cafeAddress').value,
      cafe_contact: document.getElementById('cafeContact').value,
    });
    if (data.success) showToast('Site info saved!');
    else showToast(data.message || 'Failed to save.', 'error');
  } catch(e) { showToast('Server error.', 'error'); }
}

async function saveAdminSettings() {
  const username = document.getElementById('adminUsername').value.trim();
  const newPass = document.getElementById('newPassword').value;
  const confirmPass = document.getElementById('confirmPassword').value;

  if (!username) { showToast('Username cannot be empty.', 'error'); return; }
  if (newPass && newPass !== confirmPass) { showToast('Passwords do not match.', 'error'); return; }
  if (newPass && newPass.length < 6) { showToast('Password must be at least 6 characters.', 'error'); return; }

  const payload = { admin_username: username };
  if (newPass) payload.admin_password = newPass;

  try {
    const data = await apiCall('POST', '/api/admin/settings', payload);
    if (data.success) {
      showToast('Credentials saved! Logging out...');
      setTimeout(() => { sessionStorage.clear(); location.reload(); }, 1500);
    } else {
      showToast(data.message || 'Failed to save.', 'error');
    }
  } catch(e) { showToast('Server error.', 'error'); }
}

// savePortalSettings() and saveSessionSettings() moved to
// public/admin/js/hotspot-settings.js alongside the Portal/Session
// Settings cards they belong to.

async function saveTetheringDetectionSetting() {
  try {
    const data = await apiCall('POST', '/api/admin/settings', {
      enable_tethering_detection: document.getElementById('tetheringDetection').checked ? '1' : '0',
    });
    if (data.success) showToast('Saved!');
    else showToast(data.message || 'Failed to save.', 'error');
  } catch(e) { showToast('Server error.', 'error'); }
}

// saveCoinSettings() moved to public/admin/js/hotspot-settings.js
// alongside the Coin Slot Settings card it belongs to.

async function backupSystem() {
  try {
    const data = await apiCall('GET', '/api/admin/backup');
    if (!data.success) { showToast('Backup failed.', 'error'); return; }
    const json = JSON.stringify(data.backup, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().split('T')[0];
    const a = document.createElement('a');
    a.href = url;
    a.download = `rj-pisowifi-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup downloaded!');
  } catch(e) { showToast('Backup error.', 'error'); }
}

async function restoreSystem() {
  const fileInput = document.getElementById('restoreFile');
  const statusBox = document.getElementById('restoreStatus');
  if (!fileInput.files[0]) { showToast('Please select a backup file first.', 'error'); return; }
  const confirmed = confirm('This will overwrite your current settings, rates, promos, and transactions. Are you sure?');
  if (!confirmed) return;
  try {
    const text = await fileInput.files[0].text();
    const backup = JSON.parse(text);
    statusBox.style.display = 'block';
    statusBox.style.background = 'var(--bg-primary)';
    statusBox.style.color = 'var(--text-muted)';
    statusBox.textContent = 'Restoring... please wait.';
    const data = await apiCall('POST', '/api/admin/restore', { backup });
    if (data.success) {
      statusBox.style.background = '#d4edda';
      statusBox.style.color = '#155724';
      statusBox.innerHTML = '<i class="fas fa-check-circle"></i> Restore completed! Reloading in 3 seconds...';
      setTimeout(() => location.reload(), 3000);
    } else {
      statusBox.style.background = '#f8d7da';
      statusBox.style.color = '#721c24';
      statusBox.innerHTML = `<i class="fas fa-times-circle"></i> Restore failed: ${data.message}`;
    }
  } catch(e) {
    statusBox.style.display = 'block';
    statusBox.style.background = '#f8d7da';
    statusBox.style.color = '#721c24';
    statusBox.innerHTML = '<i class="fas fa-times-circle"></i> Invalid backup file.';
  }
}

// Network Configuration (DHCP/Static IP) moved to network.js

// ===== SAVED DEVICES + RECOVERY CODE =====
function escapeSettingsText(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function formatDeviceTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '-';
}

async function loadTrustedDevices() {
  const el = document.getElementById('trustedDevicesList');
  if (!el) return;
  try {
    const data = await apiCall('GET', '/api/admin/trusted-devices');
    if (!data.success) { el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Unavailable</div>'; return; }
    if (!data.devices.length) {
      el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:8px 0;">No saved devices</div>';
      return;
    }
    el.innerHTML = `
      <div class="table-wrapper">
        <table class="table-stack">
          <thead><tr><th>Device</th><th>IP</th><th>Last Used</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            ${data.devices.map((d) => `
              <tr>
                <td data-label="Device">${escapeSettingsText(d.label)}</td>
                <td data-label="IP" style="font-family:monospace;font-size:12px;">${escapeSettingsText(d.ip_address)}</td>
                <td data-label="Last Used" style="font-size:12px;color:var(--text-muted);">${formatDeviceTime(d.last_used_at)}</td>
                <td data-label="Expires" style="font-size:12px;color:var(--text-muted);">${formatDeviceTime(d.expires_at)}</td>
                <td><button class="btn btn-sm btn-danger" onclick="revokeTrustedDevice(${Number(d.id)})">Revoke</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Unavailable</div>';
  }
}

async function revokeTrustedDevice(id) {
  if (!confirm('Revoke this device? It will need the password to log in again.')) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/trusted-devices/${id}`);
    if (!data.success) { showToast(data.message || 'Could not revoke device.', 'error'); return; }
    showToast('Device revoked.');
    loadTrustedDevices();
  } catch (e) {
    showToast('Could not revoke device.', 'error');
  }
}

async function revokeAllTrustedDevices() {
  if (!confirm('Revoke every saved device? Each will need the password to log in again.')) return;
  try {
    const data = await apiCall('DELETE', '/api/admin/trusted-devices');
    if (!data.success) { showToast('Could not revoke devices.', 'error'); return; }
    showToast('All saved devices revoked.');
    loadTrustedDevices();
  } catch (e) {
    showToast('Could not revoke devices.', 'error');
  }
}

let recoveryCodeExists = false;

async function loadRecoveryStatus() {
  const label = document.getElementById('recoveryStatusLabel');
  const btn = document.getElementById('recoveryBtnLabel');
  if (!label) return;
  try {
    const data = await apiCall('GET', '/api/admin/recovery-code/status');
    recoveryCodeExists = !!(data.success && data.exists);
    if (recoveryCodeExists) {
      label.textContent = data.createdAt ? `Created ${new Date(data.createdAt).toLocaleDateString()}` : 'Set up';
      label.style.color = 'var(--accent-green)';
      btn.textContent = 'Generate New Recovery Code';
    } else {
      label.textContent = 'Not set up';
      label.style.color = 'var(--accent-orange)';
      btn.textContent = 'Generate Recovery Code';
    }
  } catch (e) {
    label.textContent = 'Unavailable';
  }
}

async function generateRecoveryCode() {
  const password = document.getElementById('recoveryPassword').value;
  if (!password) { showToast('Enter your current password first.', 'error'); return; }
  if (recoveryCodeExists && !confirm('This replaces your current recovery code. The old one will stop working.')) return;
  try {
    const data = await apiCall('POST', '/api/admin/recovery-code', { password });
    if (!data.success) { showToast(data.message || 'Could not generate a recovery code.', 'error'); return; }
    document.getElementById('recoveryPassword').value = '';
    document.getElementById('recoveryCodeValue').value = data.code;
    document.getElementById('recoveryCodeReveal').style.display = 'block';
    loadRecoveryStatus();
  } catch (e) {
    showToast('Could not generate a recovery code.', 'error');
  }
}

function copyRecoveryCode() {
  const input = document.getElementById('recoveryCodeValue');
  input.select();
  try {
    navigator.clipboard.writeText(input.value).then(() => showToast('Recovery code copied.'), () => document.execCommand('copy'));
  } catch (e) {
    document.execCommand('copy');
  }
}
