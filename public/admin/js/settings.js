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
    load2faStatus();

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

    // Portal Settings
    document.getElementById('welcomeMessage').value = s.welcome_message || '';
    document.getElementById('disconnectMessage').value = s.disconnect_message || '';
    document.getElementById('redirectUrl').value = s.redirect_url || '';
    setToggle('showVoucher', 'showVoucherLabel', s.show_voucher === '1');
    document.getElementById('paymentMethods').value = s.payment_methods || 'both';

    // Session Settings
    setToggle('allowPause', 'allowPauseLabel', s.allow_pause === '1');
    document.getElementById('maxPauseMinutes').value = s.max_pause_minutes || 30;
    document.getElementById('maxPauses').value = s.max_pauses || 0;
    setToggle('autoPauseIdle', 'autoPauseIdleLabel', s.enable_auto_pause_idle === '1');
    document.getElementById('autoPauseIdleMinutes').value = s.auto_pause_idle_minutes || 10;
    document.getElementById('gracePeriodMinutes').value = s.grace_period_minutes || 0;
    document.getElementById('wifiSpeedTimerMs').value = s.wifi_speed_timer_ms || 1000;
    setToggle('allowPremiumToRegularConvert', 'allowPremiumToRegularConvertLabel', s.allow_premium_to_regular_convert === '1');

    // Anti-Tethering Detection
    setToggle('tetheringDetection', 'tetheringDetectionLabel', s.enable_tethering_detection === '1');

    // Coin Slot Settings
    document.getElementById('coinWaitMs').value = s.coin_wait_ms || 1500;
    document.getElementById('minCoins').value = s.min_coins || 1;

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

async function savePortalSettings() {
  try {
    const data = await apiCall('POST', '/api/admin/settings', {
      welcome_message: document.getElementById('welcomeMessage').value,
      disconnect_message: document.getElementById('disconnectMessage').value,
      redirect_url: document.getElementById('redirectUrl').value,
      show_voucher: document.getElementById('showVoucher').checked ? '1' : '0',
      payment_methods: document.getElementById('paymentMethods').value,
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
      max_pauses: document.getElementById('maxPauses').value,
      enable_auto_pause_idle: document.getElementById('autoPauseIdle').checked ? '1' : '0',
      auto_pause_idle_minutes: document.getElementById('autoPauseIdleMinutes').value,
      grace_period_minutes: document.getElementById('gracePeriodMinutes').value,
      wifi_speed_timer_ms: document.getElementById('wifiSpeedTimerMs').value,
      allow_premium_to_regular_convert: document.getElementById('allowPremiumToRegularConvert').checked ? '1' : '0',
    });
    if (data.success) showToast('Session settings saved!');
    else showToast(data.message || 'Failed to save.', 'error');
  } catch(e) { showToast('Server error.', 'error'); }
}

async function saveTetheringDetectionSetting() {
  try {
    const data = await apiCall('POST', '/api/admin/settings', {
      enable_tethering_detection: document.getElementById('tetheringDetection').checked ? '1' : '0',
    });
    if (data.success) showToast('Saved!');
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

// Network Configuration (DHCP/Static IP) moved to network.js

// ===== 2FA (TOTP) =====
function show2faState(state) {
  document.getElementById('twoFaOffState').style.display = state === 'off' ? 'block' : 'none';
  document.getElementById('twoFaSetupState').style.display = state === 'setup' ? 'block' : 'none';
  document.getElementById('twoFaOnState').style.display = state === 'on' ? 'block' : 'none';
}

async function load2faStatus() {
  try {
    const data = await apiCall('GET', '/api/admin/2fa/status');
    const label = document.getElementById('twoFaStatusLabel');
    if (data.success && data.enabled) {
      label.textContent = 'Enabled';
      label.style.color = 'var(--accent-green)';
      show2faState('on');
    } else {
      label.textContent = 'Disabled';
      label.style.color = 'var(--text-muted)';
      show2faState('off');
    }
  } catch (e) {
    // Non-fatal - leave the off-state showing, matches other settings
    // cards' quiet-failure pattern.
  }
}

async function start2faSetup() {
  try {
    const data = await apiCall('POST', '/api/admin/2fa/setup');
    if (!data.success) { showToast('Could not start 2FA setup.', 'error'); return; }
    document.getElementById('twoFaSecretDisplay').value = data.secret;
    document.getElementById('twoFaConfirmToken').value = '';
    show2faState('setup');
  } catch (e) {
    showToast('Could not start 2FA setup.', 'error');
  }
}

function cancel2faSetup() {
  show2faState('off');
}

async function confirm2faSetup() {
  const token = document.getElementById('twoFaConfirmToken').value.trim();
  if (!/^\d{6}$/.test(token)) {
    showToast('Enter the 6-digit code from your authenticator app.', 'error');
    return;
  }
  try {
    const data = await apiCall('POST', '/api/admin/2fa/confirm', { token });
    if (!data.success) { showToast(data.message || 'That code doesn\'t match.', 'error'); return; }
    showToast('2FA is now enabled!');
    load2faStatus();
  } catch (e) {
    showToast('Could not confirm 2FA setup.', 'error');
  }
}

async function disable2fa() {
  const password = document.getElementById('twoFaDisablePassword').value;
  if (!password) { showToast('Enter your current password first.', 'error'); return; }
  if (!confirm('Disable 2FA on this account? Anyone with just the password will be able to log in.')) return;
  try {
    const data = await apiCall('POST', '/api/admin/2fa/disable', { password });
    if (!data.success) { showToast(data.message || 'Incorrect password.', 'error'); return; }
    showToast('2FA disabled.');
    document.getElementById('twoFaDisablePassword').value = '';
    load2faStatus();
  } catch (e) {
    showToast('Could not disable 2FA.', 'error');
  }
}