// ===== MAIN KIOSK COIN SLOT (Direct GPIO) SETTINGS =====
// Reads/writes the coinslot_gpio_* settings keys coinslotGpio.js already
// reads at boot - no dedicated backend route needed, the generic
// GET/POST /api/admin/settings already covers arbitrary keys.

let gpioSettingsCache = {};
let gpioHardwareAvailable = null; // null = not checked yet, don't assume either way

async function loadGpioCompatBanner() {
  try {
    const data = await apiCall('GET', '/api/admin/hardware/gpio-capability');
    const banner = document.getElementById('gpioCompatBanner');
    if (!data.success) return;
    gpioHardwareAvailable = data.available;
    if (!banner) return;
    if (data.available) {
      banner.style.display = 'none';
    } else {
      document.getElementById('gpioCompatMessage').textContent = data.reason || 'This hardware doesn\'t support direct-GPIO wiring.';
      banner.style.display = 'flex';
    }
    // Hardware capability just arrived after the settings-driven status
    // badge already rendered once (parallel loads) - re-render with it.
    if (gpioSettingsCache.coinslot_gpio_mode !== undefined) renderGpioStatus(gpioSettingsCache);
  } catch (e) {}
}

async function loadCoinSlotGpio() {
  loadGpioCompatBanner();
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    if (!data.success) return;
    gpioSettingsCache = data.settings;
    const s = gpioSettingsCache;

    document.getElementById('gpioMode').value = s.coinslot_gpio_mode === 'direct_gpio' ? 'direct_gpio' : 'disabled';
    document.getElementById('gpioPhpPerPulse').value = s.coinslot_gpio_php_per_pulse || 1;
    document.getElementById('gpioActiveWindow').value = s.coinslot_gpio_active_window_seconds || 60;

    document.getElementById('gpioChip').value = s.coinslot_gpio_chip || '';
    document.getElementById('gpioLine').value = s.coinslot_gpio_line || '';
    document.getElementById('gpioEdge').value = s.coinslot_gpio_edge || 'falling';
    document.getElementById('gpioDebounceMs').value = s.coinslot_gpio_debounce_ms || 5;
    document.getElementById('gpioInhibitChip').value = s.coinslot_gpio_inhibit_chip || '';
    document.getElementById('gpioInhibitLine').value = s.coinslot_gpio_inhibit_line || '';
    document.getElementById('gpioInhibitActiveHigh').checked = gpioBoolSetting(s.coinslot_gpio_inhibit_active_high, true);

    document.getElementById('gpioStatusLedChip').value = s.coinslot_gpio_status_led_chip || '';
    document.getElementById('gpioStatusLedLine').value = s.coinslot_gpio_status_led_line || '';
    document.getElementById('gpioErrorLedChip').value = s.coinslot_gpio_error_led_chip || '';
    document.getElementById('gpioErrorLedLine').value = s.coinslot_gpio_error_led_line || '';
    document.getElementById('gpioStatusLedActiveHigh').checked = gpioBoolSetting(s.coinslot_gpio_status_led_active_high, true);
    document.getElementById('gpioErrorLedActiveHigh').checked = gpioBoolSetting(s.coinslot_gpio_error_led_active_high, true);

    document.getElementById('gpioBurstMax').value = s.coinslot_gpio_burst_max || 3;
    document.getElementById('gpioBurstWindowMs').value = s.coinslot_gpio_burst_window_ms || 200;
    document.getElementById('gpioMinPulseMs').value = s.coinslot_gpio_min_pulse_ms || 5;
    document.getElementById('gpioMaxEmptyOpens').value = s.coinslot_gpio_max_empty_opens ?? 10;
    document.getElementById('gpioEmptyOpenWindowSeconds').value = s.coinslot_gpio_empty_open_window_seconds || 300;
    document.getElementById('gpioEmptyOpenCooldownSeconds').value = s.coinslot_gpio_empty_open_cooldown_seconds || 30;
    document.getElementById('gpioBusyLock').checked = gpioBoolSetting(s.coinslot_gpio_busy_lock, true);

    renderGpioStatus(s);
  } catch (e) {
    console.error('Coin slot GPIO load error:', e);
  }
}

function gpioBoolSetting(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'high'].includes(String(raw).trim().toLowerCase());
}

// Mirrors coinslotGpio.js's own resolveMode()/enabled logic so this badge
// reflects what the backend will actually do, not just what's typed in
// the form (e.g. Enabled with no chip/line set is still Inactive).
function renderGpioStatus(s) {
  const mode = s.coinslot_gpio_mode === 'direct_gpio' ? 'direct_gpio' : 'disabled';
  const chip = (s.coinslot_gpio_chip || '').trim();
  const line = (s.coinslot_gpio_line || '').trim();
  const hardwareConfigured = !!(chip && line);
  // gpioHardwareAvailable is null until the capability check returns - treat
  // that as "assume fine" rather than flashing a false negative, then
  // re-render (see loadGpioCompatBanner) once the real answer arrives.
  const hardwareCapable = gpioHardwareAvailable !== false;
  const active = mode === 'direct_gpio' && hardwareConfigured && hardwareCapable;

  const listenerEl = document.getElementById('gpioListenerStatus');
  listenerEl.className = `badge ${active ? 'badge-green' : 'badge-orange'}`;
  listenerEl.textContent = active
    ? 'Active'
    : gpioHardwareAvailable === false
      ? 'Not supported on this hardware'
      : mode === 'direct_gpio'
        ? 'Waiting for hardware config'
        : 'Inactive';

  const hwEl = document.getElementById('gpioHardwareStatus');
  hwEl.className = `badge ${hardwareConfigured ? 'badge-green' : 'badge-orange'}`;
  hwEl.textContent = hardwareConfigured ? 'Yes' : 'Not set';
}

async function saveGpioSettings(keys, successMessage) {
  const payload = {};
  keys.forEach(k => { payload[k.key] = k.value; });
  try {
    const data = await apiCall('POST', '/api/admin/settings', payload);
    if (data.success) {
      showToast(successMessage);
      loadCoinSlotGpio();
    } else {
      showToast(data.message || 'Failed to save', 'error');
    }
  } catch (e) {
    showToast('Failed to save', 'error');
  }
}

function saveGpioModeRate() {
  saveGpioSettings([
    { key: 'coinslot_gpio_mode', value: document.getElementById('gpioMode').value },
    { key: 'coinslot_gpio_php_per_pulse', value: document.getElementById('gpioPhpPerPulse').value },
    { key: 'coinslot_gpio_active_window_seconds', value: document.getElementById('gpioActiveWindow').value },
  ], 'Mode and rate saved. Chip and Line changes need a server restart, this is rate only.');
}

function saveGpioHardware() {
  saveGpioSettings([
    { key: 'coinslot_gpio_chip', value: document.getElementById('gpioChip').value.trim() },
    { key: 'coinslot_gpio_line', value: document.getElementById('gpioLine').value.trim() },
    { key: 'coinslot_gpio_edge', value: document.getElementById('gpioEdge').value },
    { key: 'coinslot_gpio_debounce_ms', value: document.getElementById('gpioDebounceMs').value },
    { key: 'coinslot_gpio_inhibit_chip', value: document.getElementById('gpioInhibitChip').value.trim() },
    { key: 'coinslot_gpio_inhibit_line', value: document.getElementById('gpioInhibitLine').value.trim() },
    { key: 'coinslot_gpio_inhibit_active_high', value: document.getElementById('gpioInhibitActiveHigh').checked ? '1' : '0' },
  ], 'Hardware settings saved. Restart the server for chip/line changes to take effect.');
}

function saveGpioLeds() {
  saveGpioSettings([
    { key: 'coinslot_gpio_status_led_chip', value: document.getElementById('gpioStatusLedChip').value.trim() },
    { key: 'coinslot_gpio_status_led_line', value: document.getElementById('gpioStatusLedLine').value.trim() },
    { key: 'coinslot_gpio_error_led_chip', value: document.getElementById('gpioErrorLedChip').value.trim() },
    { key: 'coinslot_gpio_error_led_line', value: document.getElementById('gpioErrorLedLine').value.trim() },
    { key: 'coinslot_gpio_status_led_active_high', value: document.getElementById('gpioStatusLedActiveHigh').checked ? '1' : '0' },
    { key: 'coinslot_gpio_error_led_active_high', value: document.getElementById('gpioErrorLedActiveHigh').checked ? '1' : '0' },
  ], 'LED settings saved. Restart the server for changes to take effect.');
}

function saveGpioAntiFraud() {
  saveGpioSettings([
    { key: 'coinslot_gpio_burst_max', value: document.getElementById('gpioBurstMax').value },
    { key: 'coinslot_gpio_burst_window_ms', value: document.getElementById('gpioBurstWindowMs').value },
    { key: 'coinslot_gpio_min_pulse_ms', value: document.getElementById('gpioMinPulseMs').value },
    { key: 'coinslot_gpio_max_empty_opens', value: document.getElementById('gpioMaxEmptyOpens').value },
    { key: 'coinslot_gpio_empty_open_window_seconds', value: document.getElementById('gpioEmptyOpenWindowSeconds').value },
    { key: 'coinslot_gpio_empty_open_cooldown_seconds', value: document.getElementById('gpioEmptyOpenCooldownSeconds').value },
    { key: 'coinslot_gpio_busy_lock', value: document.getElementById('gpioBusyLock').checked ? '1' : '0' },
  ], 'Anti-fraud settings saved.');
}
