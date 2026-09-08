// ===== BANDWIDTH PROFILES PAGE =====
// Named, reusable speed presets (server/routes/admin.js's
// /api/admin/bandwidth-profiles) - previously had a backend and a nav
// link ("Bandwidth", page-id mikrotik-queues) but no page HTML/JS at all.

let bwProfilesAll = [];
let bwIsMikrotikMode = false;

async function loadBandwidthProfilesPage() {
  const tbody = document.getElementById('bwProfilesTable');
  if (!tbody) return;
  try {
    const settingsData = await apiCall('GET', '/api/admin/settings');
    bwIsMikrotikMode = !!(settingsData.settings && settingsData.settings.network_mode === 'mikrotik');
    const data = await apiCall('GET', '/api/admin/bandwidth-profiles');
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--accent-red);padding:24px;">${escapeHtml(data.message || 'Failed to load profiles')}</td></tr>`;
      return;
    }
    bwProfilesAll = data.profiles;
    renderBandwidthProfilesTable();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--accent-red);padding:24px;">Failed to load profiles. Refresh to try again.</td></tr>`;
  }
}

function renderBandwidthProfilesTable() {
  const tbody = document.getElementById('bwProfilesTable');
  if (!bwProfilesAll.length) {
    tbody.innerHTML = `
      <tr><td colspan="6">
        <div class="empty-state">
          <i class="fas fa-gauge-high"></i>
          <h3>No Bandwidth Profiles Yet</h3>
          <p>Create a named preset like "Premium 30/15" to hand out to vouchers instead of typing raw Mbps numbers each time.</p>
          <button class="btn btn-primary" onclick="openAddBandwidthProfile()" style="margin-top:12px;"><i class="fas fa-plus"></i> New Profile</button>
        </div>
      </td></tr>`;
    return;
  }
  tbody.innerHTML = bwProfilesAll.map(p => `
    <tr>
      <td data-label="Name" style="font-weight:700;">${escapeHtml(p.name)}</td>
      <td data-label="Download">${escapeHtml(String(p.download_mbps))} Mbps</td>
      <td data-label="Upload">${escapeHtml(String(p.upload_mbps))} Mbps</td>
      <td data-label="Burst">${p.burst_mbps ? escapeHtml(String(p.burst_mbps)) + ' Mbps' : '-'}</td>
      <td data-label="Queue Type">${escapeHtml(p.queue_type && p.queue_type !== 'auto' ? p.queue_type : 'Auto')}</td>
      <td class="table-stack-full" style="text-align:right;">
        <button class="btn btn-sm btn-danger btn-icon" onclick="deleteBandwidthProfile(${p.id}, '${escapeHtml(p.name)}')" title="Delete"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `).join('');
}

async function openAddBandwidthProfile() {
  document.getElementById('bwProfileName').value = '';
  document.getElementById('bwProfileDown').value = '';
  document.getElementById('bwProfileUp').value = '';
  document.getElementById('bwProfileBurst').value = '';
  await loadBwProfileQueueTypeOptions();
  document.getElementById('bwProfileModal').classList.add('show');
}

async function loadBwProfileQueueTypeOptions() {
  const group = document.getElementById('bwProfileQueueTypeGroup');
  if (!bwIsMikrotikMode) {
    group.style.display = 'none';
    return;
  }
  const select = document.getElementById('bwProfileQueueType');
  select.innerHTML = '<option value="auto">Auto (use global setting)</option>';
  try {
    const typesData = await apiCall('GET', '/api/admin/network/mikrotik/queue-types');
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
  } catch (e) {
    console.error('Queue type load error:', e);
  }
  group.style.display = 'block';
}

async function createBandwidthProfile() {
  const name = document.getElementById('bwProfileName').value.trim();
  const downloadMbps = document.getElementById('bwProfileDown').value;
  const uploadMbps = document.getElementById('bwProfileUp').value;
  const burstMbps = document.getElementById('bwProfileBurst').value;
  const queueTypeEl = document.getElementById('bwProfileQueueType');
  const queueType = bwIsMikrotikMode && queueTypeEl ? queueTypeEl.value : undefined;
  if (!name) return showToast('Enter a profile name.', 'error');
  if (!downloadMbps || !uploadMbps) return showToast('Download and upload speeds are required.', 'error');

  const btn = document.getElementById('bwProfileSaveBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
  try {
    const data = await apiCall('POST', '/api/admin/bandwidth-profiles', { name, downloadMbps, uploadMbps, burstMbps: burstMbps || undefined, queueType });
    if (data.success) {
      showToast('Bandwidth profile created!', 'success');
      closeModal('bwProfileModal');
      loadBandwidthProfilesPage();
    } else {
      showToast(data.message || 'Unable to save profile.', 'error');
    }
  } catch (e) {
    showToast('Unable to save profile.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Save Profile';
  }
}

async function deleteBandwidthProfile(id, name) {
  if (!confirm(`Delete "${name}"? Vouchers already using it will fall back to their own bandwidth settings.`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/bandwidth-profiles/${id}`);
    if (data.success) {
      showToast('Profile deleted.', 'success');
      loadBandwidthProfilesPage();
    } else {
      showToast(data.message || 'Unable to delete profile.', 'error');
    }
  } catch (e) {
    showToast('Unable to delete profile.', 'error');
  }
}
