// ===== PROMOS PAGE =====

async function loadPromosPage() {
  await loadFreeMinutesSettings();
  await loadHappyHourSettings();
}

async function loadFreeMinutesSettings() {
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    if (!data.success) return;
    setToggle('freeMinutesEnabled', 'freeMinutesEnabledLabel', data.settings.free_minutes_enabled === '1');
    document.getElementById('freeMinutesAmount').value = data.settings.free_minutes_amount || 5;
  } catch(e) {
    console.error('Free minutes load error:', e);
  }
}

async function saveFreeMinutesSettings() {
  try {
    const data = await apiCall('POST', '/api/admin/settings', {
      free_minutes_enabled: document.getElementById('freeMinutesEnabled').checked ? '1' : '0',
      free_minutes_amount: document.getElementById('freeMinutesAmount').value,
    });
    if (data.success) showToast('Free minutes settings saved!');
    else showToast(data.message || 'Failed to save.', 'error');
  } catch(e) { showToast('Server error.', 'error'); }
}

async function loadHappyHourSettings() {
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    if (!data.success) return;
    const s = data.settings;
    setToggle('happyHourEnabled', 'happyHourEnabledLabel', s.happy_hour_enabled === '1');
    document.getElementById('happyHourMultiplier').value = s.happy_hour_multiplier || '2';
    document.getElementById('happyHourStart').value = s.happy_hour_start || '14:00';
    document.getElementById('happyHourEnd').value = s.happy_hour_end || '17:00';
    document.getElementById('happyHourMessage').value = s.happy_hour_message || '';
    const activeDays = new Set(String(s.happy_hour_days || '').split(',').map((d) => d.trim()).filter(Boolean));
    document.querySelectorAll('.happyHourDay').forEach((el) => {
      el.checked = activeDays.has(el.value);
    });
  } catch(e) {
    console.error('Happy Hour load error:', e);
  }
}

async function saveHappyHourSettings() {
  const multiplier = parseFloat(document.getElementById('happyHourMultiplier').value);
  if (!Number.isFinite(multiplier) || multiplier <= 1) {
    showToast('Multiplier must be a number greater than 1', 'error');
    return;
  }
  const start = document.getElementById('happyHourStart').value;
  const end = document.getElementById('happyHourEnd').value;
  if (start && end && start >= end) {
    showToast('End time must be later than start time (overnight windows are not supported)', 'error');
    return;
  }
  const days = Array.from(document.querySelectorAll('.happyHourDay:checked')).map((el) => el.value).join(',');
  try {
    const data = await apiCall('POST', '/api/admin/settings', {
      happy_hour_enabled: document.getElementById('happyHourEnabled').checked ? '1' : '0',
      happy_hour_multiplier: String(multiplier),
      happy_hour_start: start,
      happy_hour_end: end,
      happy_hour_days: days,
      happy_hour_message: document.getElementById('happyHourMessage').value,
    });
    if (data.success) showToast('Happy Hour settings saved!');
    else showToast(data.message || 'Failed to save.', 'error');
  } catch(e) { showToast('Server error.', 'error'); }
}
