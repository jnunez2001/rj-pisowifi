async function loadSecurity() {
  try {
    const data = await apiCall('GET', '/api/admin/spam-settings');
    if (!data.success) return;
    document.getElementById('maxAttempts').value = data.spam_max_attempts || 3;
    document.getElementById('blockMinutes').value = data.spam_block_minutes || 1;
    // Bug: this used to read/write `max_mbps`, a setting the actual
    // bandwidth-shaping code (sessionService.js/networkService.js) never
    // reads — it uses enable_bandwidth_cap + bandwidth_cap_download_mbps.
    // Changing "Max Speed" here previously had zero real effect.
    setToggle('enableBandwidthCap', 'enableBandwidthCapLabel', data.enable_bandwidth_cap === '1');
    document.getElementById('maxMbps').value = data.bandwidth_cap_download_mbps || 5;
    document.getElementById('maxUploadMbps').value = data.bandwidth_cap_upload_mbps || 5;
  } catch(e) {
    console.error('Security error:', e);
  }
}

async function saveSpamSettings() {
  const maxAttempts = parseInt(document.getElementById('maxAttempts').value);
  const blockMinutes = parseInt(document.getElementById('blockMinutes').value);

  if (!maxAttempts || !blockMinutes) {
    showToast('Please fill all fields', 'error');
    return;
  }

  try {
    const data = await apiCall('POST', '/api/admin/spam-settings', {
      spam_max_attempts: maxAttempts,
      spam_block_minutes: blockMinutes
    });
    if (data.success) showToast('Spam settings saved!', 'success');
    else showToast('Failed to save', 'error');
  } catch(e) {
    showToast('Server error', 'error');
  }
}

function setMbps(val) {
  document.getElementById('maxMbps').value = val;
}

async function saveBandwidthSettings() {
  const maxMbps = parseInt(document.getElementById('maxMbps').value);
  const maxUploadMbps = parseInt(document.getElementById('maxUploadMbps').value);
  if (!maxMbps || !maxUploadMbps) {
    showToast('Please enter valid Mbps for both download and upload', 'error');
    return;
  }
  const enabled = document.getElementById('enableBandwidthCap').checked;
  try {
    const data = await apiCall('POST', '/api/admin/spam-settings', {
      enable_bandwidth_cap: enabled ? '1' : '0',
      bandwidth_cap_download_mbps: maxMbps,
      bandwidth_cap_upload_mbps: maxUploadMbps
    });
    if (data.success) showToast('Bandwidth settings saved!', 'success');
    else showToast('Failed to save', 'error');
  } catch(e) {
    showToast('Server error', 'error');
  }
}