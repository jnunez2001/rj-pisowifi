// ===== HOTSPOT SETTINGS PAGE =====
// Portal Settings, Session Settings, and Coin Slot Settings - moved here
// from the general Settings page (public/admin/js/settings.js) so
// real hotspot/captive-portal behavior isn't scattered across an
// unrelated tab. Same settings-table keys, same save endpoint
// (POST /api/admin/settings) - only the admin UI location changed.

async function loadHotspotSettings() {
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    if (!data.success) return;
    const s = data.settings;

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
    setToggle('enableOutageCompensation', 'enableOutageCompensationLabel', s.enable_outage_compensation === '1');
    document.getElementById('gracePeriodMinutes').value = s.grace_period_minutes || 0;
    document.getElementById('wifiSpeedTimerMs').value = s.wifi_speed_timer_ms || 1000;
    setToggle('enablePremium', 'enablePremiumLabel', s.enable_premium === '1');
    setToggle('allowPremiumToRegularConvert', 'allowPremiumToRegularConvertLabel', s.allow_premium_to_regular_convert === '1');

    // Coin Slot Settings
    document.getElementById('coinWaitMs').value = s.coin_wait_ms || 1500;
    document.getElementById('minCoins').value = s.min_coins || 1;
  } catch (e) {
    console.error('Hotspot settings load error:', e);
  }
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
      enable_outage_compensation: document.getElementById('enableOutageCompensation').checked ? '1' : '0',
      grace_period_minutes: document.getElementById('gracePeriodMinutes').value,
      wifi_speed_timer_ms: document.getElementById('wifiSpeedTimerMs').value,
      enable_premium: document.getElementById('enablePremium').checked ? '1' : '0',
      allow_premium_to_regular_convert: document.getElementById('allowPremiumToRegularConvert').checked ? '1' : '0',
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
