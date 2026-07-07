// ===== PROMOS PAGE =====

async function loadPromosPage() {
  await loadFreeMinutesSettings();
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
