// ===== PLANS PAGE =====
let plAllPlans = [];
let plCurrentType = '';
let plEditingId = null;

async function loadPlansPage() {
  await loadPlansList();
  await loadCoinRatesForPlans();
}

// ===== COIN VENDO RATES (shown on this page per the operator's request -
// "where can I configure coin rates" kept landing here, not on the
// separate Rates page). Reuses the same /api/admin/rates endpoints
// rates.js already calls - this is the one real coin-to-minutes table
// the coin slot actually reads, Plans itself doesn't touch it. Distinct
// function/element names from rates.js (both scripts load on every admin
// page) so the two don't collide if Rates' own page is ever open in
// another tab session-wise - not strictly required since only one page
// is visible at a time, but keeps this addition self-contained. =====
let plCoinRateEditId = null;

// Coin rates are looked up by id when editing/deleting (not passed inline
// through onclick args) so a value like a quote in the label, or null
// speed fields, never has to survive round-tripping through an HTML
// attribute string.
let plCoinRates = [];

async function loadCoinRatesForPlans() {
  const tbody = document.getElementById('plansCoinRatesTable');
  if (!tbody) return;
  try {
    const data = await apiCall('GET', '/api/admin/rates');
    if (!data.success || !data.rates.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px;">No coin rates configured</td></tr>`;
      return;
    }
    plCoinRates = data.rates;
    tbody.innerHTML = data.rates.map(r => `
      <tr>
        <td>${escapeHtml(r.label)}</td>
        <td><span style="font-family:monospace;font-weight:700;color:var(--accent-red);">₱${r.coin_value}</span></td>
        <td>${r.minutes}</td>
        <td>${r.expiration_minutes}</td>
        <td>${r.download_mbps
          ? `<span class="badge badge-blue"><i class="fas fa-bolt"></i> Premium ${r.download_mbps}/${r.upload_mbps || r.download_mbps} Mbps</span>`
          : '<span style="color:var(--text-muted);">Normal</span>'}</td>
        <td style="text-align:right;">
          <button class="btn btn-sm btn-secondary" onclick="editCoinRate(${r.id})" title="Edit">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-sm btn-danger" onclick="deleteCoinRate(${r.id}, '${escapeHtml(r.label)}')" title="Delete">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('Coin rates error:', e);
  }
}

function openAddCoinRate() {
  plCoinRateEditId = null;
  document.getElementById('coinRateModalTitle').textContent = 'Add Coin Rate';
  document.getElementById('coinRateLabel').value = '';
  document.getElementById('coinRateValue').value = '';
  document.getElementById('coinRateMinutes').value = '';
  document.getElementById('coinRateExpiration').value = '';
  document.getElementById('coinRateDownload').value = '';
  document.getElementById('coinRateUpload').value = '';
  document.getElementById('coinRateModal').classList.add('show');
}

function editCoinRate(id) {
  const r = plCoinRates.find(x => x.id === id);
  if (!r) return;
  plCoinRateEditId = id;
  document.getElementById('coinRateModalTitle').textContent = 'Edit Coin Rate';
  document.getElementById('coinRateLabel').value = r.label;
  document.getElementById('coinRateValue').value = r.coin_value;
  document.getElementById('coinRateMinutes').value = r.minutes;
  document.getElementById('coinRateExpiration').value = r.expiration_minutes;
  document.getElementById('coinRateDownload').value = r.download_mbps || '';
  document.getElementById('coinRateUpload').value = r.upload_mbps || '';
  document.getElementById('coinRateModal').classList.add('show');
}

async function saveCoinRate() {
  const label = document.getElementById('coinRateLabel').value.trim();
  const coinValue = parseInt(document.getElementById('coinRateValue').value);
  const minutes = parseFloat(document.getElementById('coinRateMinutes').value);
  const expirationRaw = document.getElementById('coinRateExpiration').value;
  const expiration = expirationRaw ? parseFloat(expirationRaw) : minutes;
  const downloadRaw = document.getElementById('coinRateDownload').value;
  const uploadRaw = document.getElementById('coinRateUpload').value;
  const downloadMbps = downloadRaw ? parseFloat(downloadRaw) : null;
  const uploadMbps = uploadRaw ? parseFloat(uploadRaw) : downloadMbps;

  if (!label || !coinValue || !minutes) {
    showToast('Label, coin value, and minutes are required', 'error');
    return;
  }
  if (expiration < minutes) {
    showToast('Expiration must be ≥ minutes', 'error');
    return;
  }

  try {
    const body = {
      coin_value: coinValue, minutes, expiration_minutes: expiration, label,
      download_mbps: downloadMbps, upload_mbps: uploadMbps
    };
    const data = plCoinRateEditId
      ? await apiCall('PUT', `/api/admin/rates/${plCoinRateEditId}`, body)
      : await apiCall('POST', '/api/admin/rates', body);

    if (data.success) {
      showToast(plCoinRateEditId ? 'Rate updated!' : 'Rate added!', 'success');
      closeModal('coinRateModal');
      loadCoinRatesForPlans();
    } else {
      showToast(data.message || 'Failed to save rate', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  }
}

async function deleteCoinRate(id, label) {
  if (!confirm(`Delete coin rate "${label}"?`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/rates/${id}`);
    if (data.success) {
      showToast('Rate deleted', 'success');
      loadCoinRatesForPlans();
    } else {
      showToast(data.message || 'Failed to delete', 'error');
    }
  } catch (e) {
    showToast('Server error', 'error');
  }
}

async function loadPlansList() {
  const tbody = document.getElementById('plansTable');
  if (!tbody) return;
  try {
    const data = await apiCall('GET', '/api/admin/plans');
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--accent-red);padding:24px;">${data.message || 'Failed to load plans'}</td></tr>`;
      return;
    }
    plAllPlans = data.plans;
    renderPlansSummary();
    renderPlansTable();
  } catch (e) {
    console.error('Plans load error:', e);
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--accent-red);padding:24px;">Failed to load plans. Refresh to try again.</td></tr>`;
  }
}

function renderPlansSummary() {
  const total = plAllPlans.length;
  const active = plAllPlans.filter(p => p.status === 'active').length;
  const inactive = total - active;
  const usedToday = plAllPlans.reduce((sum, p) => sum + (p.used_today || 0), 0);
  document.getElementById('plansTotalCount').textContent = total;
  document.getElementById('plansActiveCount').textContent = active;
  document.getElementById('plansInactiveCount').textContent = inactive;
  document.getElementById('plansUsedTodayCount').textContent = usedToday.toLocaleString();
}

function setPlansTab(type, el) {
  plCurrentType = type;
  document.querySelectorAll('#plansTabs .zf3-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderPlansTable();
}

function formatSpeed(mbps) {
  return (mbps === null || mbps === undefined) ? 'No Limit' : `${mbps} Mbps`;
}

function formatDataLimit(mb) {
  if (mb === null || mb === undefined) return 'Unlimited';
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${mb} MB`;
}

function planTypeLabel(type) {
  return { time: 'Time', data: 'Data', unlimited: 'Unlimited', custom: 'Custom' }[type] || type;
}

function renderPlansTable() {
  const tbody = document.getElementById('plansTable');
  const summary = document.getElementById('plansSummary');
  if (!tbody) return;

  const search = (document.getElementById('plansSearch')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('plansStatusFilter')?.value || '';
  const typeFilter = document.getElementById('plansTypeFilter')?.value || '';
  const sort = document.getElementById('plansSort')?.value || 'order';

  let rows = plAllPlans.filter(p => {
    if (plCurrentType && p.type !== plCurrentType) return false;
    if (typeFilter && p.type !== typeFilter) return false;
    if (statusFilter && p.status !== statusFilter) return false;
    if (search && !(p.name.toLowerCase().includes(search) || (p.description || '').toLowerCase().includes(search))) return false;
    return true;
  });

  rows = rows.slice().sort((a, b) => {
    switch (sort) {
      case 'name_asc': return a.name.localeCompare(b.name);
      case 'name_desc': return b.name.localeCompare(a.name);
      case 'price_asc': return a.price - b.price;
      case 'price_desc': return b.price - a.price;
      case 'used': return (b.used_total || 0) - (a.used_total || 0);
      case 'created': return new Date(b.created_at) - new Date(a.created_at);
      default: return (a.display_order - b.display_order) || a.name.localeCompare(b.name);
    }
  });

  if (!plAllPlans.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9">
          <div class="empty-state">
            <i class="fas fa-layer-group"></i>
            <h3>No Plans Yet</h3>
            <p>Create your first internet access plan to start selling access through vouchers.</p>
            <button class="btn btn-primary" onclick="openCreatePlan()"><i class="fas fa-plus"></i> Create New Plan</button>
          </div>
        </td>
      </tr>`;
    summary.textContent = 'Showing 0 of 0 plans';
    return;
  }

  if (!rows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9">
          <div class="empty-state">
            <i class="fas fa-filter-circle-xmark"></i>
            <h3>No plans match your filters.</h3>
            <button class="btn btn-secondary" onclick="clearPlansFilters()">Clear Filters</button>
          </div>
        </td>
      </tr>`;
    summary.textContent = `Showing 0 of ${plAllPlans.length} plans`;
    return;
  }

  tbody.innerHTML = rows.map(p => {
    const durationLabel = p.duration_minutes ? formatDuration(p.duration_minutes) : '—';
    const validityLabel = p.validity_minutes ? formatDuration(p.validity_minutes) : (p.duration_minutes ? `Valid for ${formatDuration(p.duration_minutes)}` : '—');
    const statusBadge = p.status === 'active'
      ? `<span class="badge badge-green"><span class="status-dot online"></span> Active</span>`
      : `<span class="badge badge-red">Inactive</span>`;
    return `
      <tr>
        <td>
          <div style="font-weight:700;color:var(--text-primary);">${escapeHtml(p.name)}</div>
          <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(p.description || '')}</div>
        </td>
        <td><span class="badge badge-blue">${planTypeLabel(p.type)}</span></td>
        <td style="font-weight:700;">₱${Number(p.price).toFixed(2)}</td>
        <td>
          <div>${durationLabel}</div>
          <div style="font-size:11px;color:var(--text-muted);">${validityLabel}</div>
        </td>
        <td>
          <div><i class="fas fa-arrow-down" style="font-size:10px;color:var(--text-muted);"></i> ${formatSpeed(p.download_mbps)}</div>
          <div><i class="fas fa-arrow-up" style="font-size:10px;color:var(--text-muted);"></i> ${formatSpeed(p.upload_mbps)}</div>
        </td>
        <td>${formatDataLimit(p.data_limit_mb)}</td>
        <td>${(p.used_today || 0).toLocaleString()} sessions</td>
        <td>${statusBadge}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm btn-secondary btn-icon" onclick="viewPlan(${p.id})" title="View"><i class="fas fa-eye"></i></button>
            <button class="btn btn-sm btn-secondary btn-icon" onclick="editPlan(${p.id})" title="Edit"><i class="fas fa-pen"></i></button>
            <div class="dropdown-wrap" style="position:relative;display:inline-block;">
              <button class="btn btn-sm btn-secondary btn-icon" onclick="togglePlanMenu(${p.id})" title="More"><i class="fas fa-ellipsis-vertical"></i></button>
              <div class="dropdown-menu" id="planMenu${p.id}" style="display:none;position:absolute;right:0;top:100%;z-index:20;background:var(--bg-card);border:1px solid var(--border-color);border-radius:8px;box-shadow:var(--shadow-md);min-width:160px;padding:6px;">
                <div class="dropdown-item" onclick="duplicatePlan(${p.id})" style="padding:8px 10px;font-size:13px;cursor:pointer;border-radius:6px;"><i class="fas fa-copy" style="width:16px;"></i> Duplicate</div>
                ${p.status === 'active'
                  ? `<div class="dropdown-item" onclick="togglePlanStatus(${p.id}, 'deactivate')" style="padding:8px 10px;font-size:13px;cursor:pointer;border-radius:6px;"><i class="fas fa-circle-pause" style="width:16px;"></i> Deactivate</div>`
                  : `<div class="dropdown-item" onclick="togglePlanStatus(${p.id}, 'activate')" style="padding:8px 10px;font-size:13px;cursor:pointer;border-radius:6px;"><i class="fas fa-circle-play" style="width:16px;"></i> Activate</div>`}
                <div class="dropdown-item" onclick="deletePlan(${p.id})" style="padding:8px 10px;font-size:13px;cursor:pointer;border-radius:6px;color:var(--accent-red);"><i class="fas fa-trash" style="width:16px;"></i> Delete</div>
              </div>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  summary.textContent = `Showing ${rows.length} of ${plAllPlans.length} plans`;
}

function clearPlansFilters() {
  document.getElementById('plansSearch').value = '';
  document.getElementById('plansStatusFilter').value = '';
  document.getElementById('plansTypeFilter').value = '';
  plCurrentType = '';
  document.querySelectorAll('#plansTabs .zf3-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('#plansTabs .zf3-tab').classList.add('active');
  renderPlansTable();
}

let plOpenMenuId = null;
function togglePlanMenu(id) {
  if (plOpenMenuId !== null && plOpenMenuId !== id) {
    const prev = document.getElementById(`planMenu${plOpenMenuId}`);
    if (prev) prev.style.display = 'none';
  }
  const menu = document.getElementById(`planMenu${id}`);
  if (!menu) return;
  const isOpen = menu.style.display === 'block';
  menu.style.display = isOpen ? 'none' : 'block';
  plOpenMenuId = isOpen ? null : id;
}
document.addEventListener('click', (e) => {
  if (plOpenMenuId !== null && !e.target.closest('.dropdown-wrap')) {
    const menu = document.getElementById(`planMenu${plOpenMenuId}`);
    if (menu) menu.style.display = 'none';
    plOpenMenuId = null;
  }
});

function onPlanTypeChange() {
  const type = document.getElementById('planType').value;
  document.getElementById('planScheduleRow').style.display = type === 'custom' ? 'flex' : 'none';
}

function resetPlanForm() {
  plEditingId = null;
  document.getElementById('planModalTitle').textContent = 'Create Plan';
  document.getElementById('planName').value = '';
  document.getElementById('planDescription').value = '';
  document.getElementById('planType').value = 'time';
  document.getElementById('planStatus').value = 'active';
  document.getElementById('planPrice').value = '';
  document.getElementById('planDuration').value = '';
  document.getElementById('planValidity').value = '';
  document.getElementById('planDownload').value = '';
  document.getElementById('planUpload').value = '';
  document.getElementById('planDataLimit').value = '';
  document.getElementById('planDeviceLimit').value = 1;
  document.getElementById('planScheduleStart').value = '';
  document.getElementById('planScheduleEnd').value = '';
  document.getElementById('planChannelVoucher').checked = true;
  document.getElementById('planChannelPortal').checked = false;
  document.getElementById('planChannelCoinVendo').checked = false;
  document.getElementById('planChannelAccount').checked = false;
  document.getElementById('planUsageWarning').style.display = 'none';
  onPlanTypeChange();
}

function openCreatePlan() {
  resetPlanForm();
  document.getElementById('planModal').classList.add('show');
}

async function editPlan(id) {
  const plan = plAllPlans.find(p => p.id === id);
  if (!plan) return;
  resetPlanForm();
  plEditingId = id;
  document.getElementById('planModalTitle').textContent = 'Edit Plan';
  document.getElementById('planName').value = plan.name;
  document.getElementById('planDescription').value = plan.description || '';
  document.getElementById('planType').value = plan.type;
  document.getElementById('planStatus').value = plan.status;
  document.getElementById('planPrice').value = plan.price;
  document.getElementById('planDuration').value = plan.duration_minutes || '';
  document.getElementById('planValidity').value = plan.validity_minutes || '';
  document.getElementById('planDownload').value = plan.download_mbps ?? '';
  document.getElementById('planUpload').value = plan.upload_mbps ?? '';
  document.getElementById('planDataLimit').value = plan.data_limit_mb ?? '';
  document.getElementById('planDeviceLimit').value = plan.device_limit || 1;
  document.getElementById('planScheduleStart').value = plan.schedule_start || '';
  document.getElementById('planScheduleEnd').value = plan.schedule_end || '';
  document.getElementById('planChannelVoucher').checked = !!plan.channels.voucher;
  document.getElementById('planChannelPortal').checked = !!plan.channels.portal;
  document.getElementById('planChannelCoinVendo').checked = !!plan.channels.coin_vendo;
  document.getElementById('planChannelAccount').checked = !!plan.channels.account;
  onPlanTypeChange();

  try {
    const data = await apiCall('GET', `/api/admin/plans/${id}`);
    if (data.success && data.voucher_group_count > 0) {
      const warn = document.getElementById('planUsageWarning');
      warn.style.display = 'block';
      warn.innerHTML = `<i class="fas fa-info-circle"></i> This plan is currently referenced by ${data.voucher_group_count} voucher group(s). Changes here apply to newly issued vouchers, existing sessions are not affected.`;
    }
  } catch (e) {}

  document.getElementById('planModal').classList.add('show');
}

async function viewPlan(id) {
  editPlan(id);
}

async function savePlan() {
  const name = document.getElementById('planName').value.trim();
  const price = document.getElementById('planPrice').value;
  const type = document.getElementById('planType').value;

  if (!name) { showToast('Plan name is required.', 'error'); return; }
  if (price === '' || Number(price) < 0) { showToast('Please enter a valid price.', 'error'); return; }

  const payload = {
    name,
    description: document.getElementById('planDescription').value.trim(),
    type,
    status: document.getElementById('planStatus').value,
    price: Number(price),
    duration_minutes: document.getElementById('planDuration').value || null,
    validity_minutes: document.getElementById('planValidity').value || null,
    download_mbps: document.getElementById('planDownload').value || null,
    upload_mbps: document.getElementById('planUpload').value || null,
    data_limit_mb: document.getElementById('planDataLimit').value || null,
    device_limit: document.getElementById('planDeviceLimit').value || 1,
    schedule_start: type === 'custom' ? (document.getElementById('planScheduleStart').value || null) : null,
    schedule_end: type === 'custom' ? (document.getElementById('planScheduleEnd').value || null) : null,
    channels: {
      voucher: document.getElementById('planChannelVoucher').checked,
      portal: document.getElementById('planChannelPortal').checked,
      coin_vendo: document.getElementById('planChannelCoinVendo').checked,
      account: document.getElementById('planChannelAccount').checked,
    },
  };

  const btn = document.getElementById('savePlanBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

  try {
    const data = plEditingId
      ? await apiCall('PATCH', `/api/admin/plans/${plEditingId}`, payload)
      : await apiCall('POST', '/api/admin/plans', payload);

    if (data.success) {
      showToast(plEditingId ? 'Plan updated!' : 'Plan created!', 'success');
      closeModal('planModal');
      loadPlansList();
    } else {
      showToast(data.message || 'Unable to save plan. Please check the highlighted fields.', 'error');
    }
  } catch (e) {
    showToast('Unable to save plan. No changes were saved.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Save Plan';
  }
}

async function duplicatePlan(id) {
  togglePlanMenu(id);
  try {
    const data = await apiCall('POST', `/api/admin/plans/${id}/duplicate`);
    if (data.success) {
      showToast(`Duplicated as "${data.plan.name}" (inactive)`, 'success');
      loadPlansList();
    } else {
      showToast(data.message || 'Unable to duplicate plan.', 'error');
    }
  } catch (e) {
    showToast('Unable to duplicate plan.', 'error');
  }
}

async function togglePlanStatus(id, action) {
  togglePlanMenu(id);
  try {
    const data = await apiCall('POST', `/api/admin/plans/${id}/${action}`);
    if (data.success) {
      showToast(action === 'activate' ? 'Plan activated.' : 'Plan deactivated.', 'success');
      loadPlansList();
    } else {
      showToast(data.message || 'Unable to update plan status.', 'error');
    }
  } catch (e) {
    showToast('Unable to update plan status.', 'error');
  }
}

async function deletePlan(id) {
  togglePlanMenu(id);
  const plan = plAllPlans.find(p => p.id === id);
  if (!confirm(`Delete plan "${plan ? plan.name : ''}"? This cannot be undone.`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/plans/${id}`);
    if (data.success) {
      showToast('Plan deleted.', 'success');
      loadPlansList();
    } else {
      showToast(data.message || 'This plan cannot be deleted because it is referenced by existing vouchers. Deactivate it instead.', 'error');
    }
  } catch (e) {
    showToast('Unable to delete plan.', 'error');
  }
}
