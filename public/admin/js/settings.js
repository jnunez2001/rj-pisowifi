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

async function loadSettings() {
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    if (!data.success) return;
    const s = data.settings;

    // Cafe Info
    document.getElementById('cafeName').value = s.cafe_name || '';
    document.getElementById('bannerText').value = s.banner_text || '';
    document.getElementById('currency').value = s.currency || '₱';
    document.getElementById('cafeAddress').value = s.cafe_address || '';
    document.getElementById('cafeContact').value = s.cafe_contact || '';

    // Admin Credentials
    document.getElementById('adminUsername').value = s.admin_username || 'admin';

    // Portal Settings
    document.getElementById('welcomeMessage').value = s.welcome_message || '';
    document.getElementById('disconnectMessage').value = s.disconnect_message || '';
    document.getElementById('redirectUrl').value = s.redirect_url || '';
    setToggle('showVoucher', 'showVoucherLabel', s.show_voucher === '1');

    // Session Settings
    setToggle('allowPause', 'allowPauseLabel', s.allow_pause === '1');
    document.getElementById('maxPauseMinutes').value = s.max_pause_minutes || 30;
    document.getElementById('gracePeriodMinutes').value = s.grace_period_minutes || 0;

    // Coin Slot Settings
    document.getElementById('coinWaitMs').value = s.coin_wait_ms || 1500;
    document.getElementById('minCoins').value = s.min_coins || 1;

    // Network config
    await loadNetworkConfig();
    setTimeout(loadCurrentIp, 500);

  } catch(e) {
    console.error('Settings load error:', e);
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
    if (data.success) showToast('Cafe info saved!');
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

async function savePortalSettings() {
  try {
    const data = await apiCall('POST', '/api/admin/settings', {
      welcome_message: document.getElementById('welcomeMessage').value,
      disconnect_message: document.getElementById('disconnectMessage').value,
      redirect_url: document.getElementById('redirectUrl').value,
      show_voucher: document.getElementById('showVoucher').checked ? '1' : '0',
    });
    if (data.success) showToast('Portal settings saved!');
    else showToast(data.message || 'Failed to save.', 'error');
  } catch(e) { showToast('Server error.', 'error'); }
}

async function saveSessionSettings() {
  try {
    const data = await apiCall('POST', '/api/admin/settings', {
      allow_pause: document.getElementById('allowPause').checked ? '1' : '0',
      max_pause_minutes: document.getElementById('maxPauseMinutes').value,
      grace_period_minutes: document.getElementById('gracePeriodMinutes').value,
    });
    if (data.success) showToast('Session settings saved!');
    else showToast(data.message || 'Failed to save.', 'error');
  } catch(e) { showToast('Server error.', 'error'); }
}

async function saveCoinSettings() {
  try {
    const data = await apiCall('POST', '/api/admin/settings', {
      coin_wait_ms: document.getElementById('coinWaitMs').value,
      min_coins: document.getElementById('minCoins').value,
    });
    if (data.success) showToast('Coin slot settings saved!');
    else showToast(data.message || 'Failed to save.', 'error');
  } catch(e) { showToast('Server error.', 'error'); }
}

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

// ===== NETWORK CONFIGURATION =====

async function loadNetworkConfig() {
  try {
    const data = await apiCall('GET', '/api/admin/network');
    if (!data.success) return;
    document.getElementById('networkType').value = data.type || 'dhcp';
    document.getElementById('staticIp').value = data.ip || '';
    document.getElementById('staticGateway').value = data.gateway || '';
    document.getElementById('staticDns').value = data.dns || '8.8.8.8';
    const subnetEl = document.getElementById('staticSubnet');
    if (subnetEl) subnetEl.value = data.subnet || '24';
    onNetworkTypeChange();
  } catch(e) {
    console.error('Network config load error:', e);
  }
}

async function loadCurrentIp() {
  try {
    const data = await apiCall('GET', '/api/admin/sysinfo');
    if (!data.success) return;
    const ip = data.sysinfo.ip_address || 'Unknown';
    const gateway = data.sysinfo.gateway || '';
    document.getElementById('currentIpDisplay').textContent = ip;
    document.getElementById('currentIpField').value = ip;
    document.getElementById('staticGateway').value = gateway;
    if (!document.getElementById('staticIp').value) {
      document.getElementById('staticIp').value = ip;
    }
  } catch(e) {
    console.error('IP load error:', e);
  }
}

function onNetworkTypeChange() {
  const type = document.getElementById('networkType').value;
  const staticFields = document.getElementById('staticIpFields');
  if (staticFields) {
    staticFields.style.display = type === 'static' ? 'block' : 'none';
  }
}

async function saveNetworkConfig() {
  const type = document.getElementById('networkType').value;
  const btn = document.getElementById('saveNetworkBtn');
  const status = document.getElementById('networkStatus');

  if (type === 'static') {
    const ip = document.getElementById('staticIp').value.trim();
    const gateway = document.getElementById('staticGateway').value.trim();
    if (!ip) { showToast('Please enter a static IP address.', 'error'); return; }
    if (!gateway) { showToast('Gateway not detected.', 'error'); return; }
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ip)) { showToast('Invalid IP address format.', 'error'); return; }
  }

  const confirmed = confirm(
    type === 'static'
      ? 'Apply static IP? Make sure the IP is not in your router\'s DHCP range.'
      : 'Switch to DHCP? The server will get a new IP from your router.'
  );
  if (!confirmed) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applying...';
  status.style.display = 'block';
  status.style.background = 'var(--bg-primary)';
  status.style.color = 'var(--text-muted)';
  status.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applying network settings...';

  try {
    const payload = {
      type,
      ip: document.getElementById('staticIp').value.trim(),
      gateway: document.getElementById('staticGateway').value.trim(),
      dns: document.getElementById('staticDns').value.trim() || '8.8.8.8',
      subnet: document.getElementById('staticSubnet').value || '24'
    };

    const data = await apiCall('POST', '/api/admin/network', payload);

    if (data.success) {
      status.style.background = 'var(--card-green-bg)';
      status.style.color = 'var(--card-green-text)';
      if (type === 'dhcp') {
        status.innerHTML = '<i class="fas fa-check-circle"></i> Switched to DHCP! Check your router for the new IP.';
      } else {
        const ip = document.getElementById('staticIp').value.trim();
        status.innerHTML = `<i class="fas fa-check-circle"></i> Static IP set to ${ip}! Use this IP to access the admin panel.`;
      }
      showToast('Network settings applied!');
      setTimeout(() => loadCurrentIp(), 3000);
    } else {
      status.style.background = 'var(--card-red-bg)';
      status.style.color = 'var(--card-red-text)';
      status.innerHTML = `<i class="fas fa-times-circle"></i> ${data.message}`;
      showToast('Failed to apply.', 'error');
    }
  } catch(e) {
    status.style.background = 'var(--card-red-bg)';
    status.style.color = 'var(--card-red-text)';
    status.innerHTML = '<i class="fas fa-times-circle"></i> Server error applying network settings.';
    showToast('Server error.', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-save"></i> Apply Network Settings';
}