async function loadSecurity() {
  try {
    const data = await apiCall('GET', '/api/admin/spam-settings');
    if (!data.success) return;
    document.getElementById('maxAttempts').value = data.spam_max_attempts || 3;
    document.getElementById('blockMinutes').value = data.spam_block_minutes || 1;
    // Bug: this used to read/write `max_mbps`, a setting the actual
    // bandwidth-shaping code (sessionService.js/networkService.js) never
    // reads. It uses enable_bandwidth_cap + bandwidth_cap_download_mbps.
    // Changing "Max Speed" here previously had zero real effect.
    setToggle('enableBandwidthCap', 'enableBandwidthCapLabel', data.enable_bandwidth_cap === '1');
    document.getElementById('maxMbps').value = data.bandwidth_cap_download_mbps || 5;
    document.getElementById('maxUploadMbps').value = data.bandwidth_cap_upload_mbps || 5;
    setToggle('enableBurst', 'enableBurstLabel', data.enable_bandwidth_burst === '1');
    document.getElementById('burstMbps').value = data.bandwidth_burst_mbps || 20;
    document.getElementById('burstSeconds').value = data.bandwidth_burst_seconds || 8;
    await loadQueueAlgorithmOption(data.mikrotik_aqm_type || 'auto');
  } catch(e) {
    console.error('Security error:', e);
  }
}

// The Queue Algorithm dropdown only makes sense on MikroTik routers (the
// router itself runs the smart queue), so it stays hidden everywhere else,
// mirroring the same network_mode check flyoutNav.js uses for its Router
// flyout trigger.
async function loadQueueAlgorithmOption(currentValue) {
  const group = document.getElementById('queueAlgorithmGroup');
  try {
    const settingsData = await apiCall('GET', '/api/admin/settings');
    const mode = settingsData.settings && settingsData.settings.network_mode;
    if (mode !== 'mikrotik') {
      group.style.display = 'none';
      return;
    }
    const select = document.getElementById('queueAlgorithm');
    const typesData = await apiCall('GET', '/api/admin/network/mikrotik/queue-types');
    select.innerHTML = '<option value="auto">Auto (recommended)</option>';
    if (typesData.success && Array.isArray(typesData.queueTypes)) {
      typesData.queueTypes
        .filter(t => t.kind === 'cake' || t.kind === 'fq-codel')
        .forEach(t => {
          const opt = document.createElement('option');
          opt.value = t.name;
          opt.textContent = `${t.name} (${t.kind})`;
          select.appendChild(opt);
        });
    }
    select.value = currentValue;
    if (select.value !== currentValue) {
      const opt = document.createElement('option');
      opt.value = currentValue;
      opt.textContent = currentValue;
      select.appendChild(opt);
      select.value = currentValue;
    }
    group.style.display = 'block';
  } catch(e) {
    group.style.display = 'none';
    console.error('Queue algorithm load error:', e);
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

  const burstEnabled = document.getElementById('enableBurst').checked;
  const burstMbps = parseInt(document.getElementById('burstMbps').value);
  const burstSeconds = parseInt(document.getElementById('burstSeconds').value);
  if (burstEnabled) {
    if (!burstMbps || !burstSeconds) {
      showToast('Please enter valid burst speed and duration', 'error');
      return;
    }
    if (burstMbps <= Math.max(maxMbps, maxUploadMbps)) {
      showToast('Burst speed must be higher than the download/upload cap', 'error');
      return;
    }
  }

  const queueAlgorithmEl = document.getElementById('queueAlgorithm');
  const queueAlgorithm = queueAlgorithmEl && queueAlgorithmEl.closest('#queueAlgorithmGroup').style.display !== 'none'
    ? queueAlgorithmEl.value
    : undefined;

  try {
    const data = await apiCall('POST', '/api/admin/spam-settings', {
      enable_bandwidth_cap: enabled ? '1' : '0',
      bandwidth_cap_download_mbps: maxMbps,
      bandwidth_cap_upload_mbps: maxUploadMbps,
      enable_bandwidth_burst: burstEnabled ? '1' : '0',
      bandwidth_burst_mbps: burstMbps || 20,
      bandwidth_burst_seconds: burstSeconds || 8,
      mikrotik_aqm_type: queueAlgorithm
    });
    if (data.success) showToast('Bandwidth settings saved!', 'success');
    else showToast('Failed to save', 'error');
  } catch(e) {
    showToast('Server error', 'error');
  }
}