// ===== MIKROTIK BANDWIDTH / QUEUES PAGE =====
// Real page replacing the old "Coming Soon" placeholder for
// mikrotik-queues. Lets an operator see and manage the router's
// smart-queue (AQM) algorithm without opening WinBox: the global
// algorithm setting (mikrotik_aqm_type, shared with the Security page's
// dropdown), the list of defined Queue Types, a form to create new ones,
// and a read-only view of every active Simple Queue.

let mqQueueTypesAll = [];

async function loadMikrotikQueuesPage() {
  await Promise.all([
    loadMqGlobalAlgorithm(),
    loadMqQueueTypes(),
    loadMqSimpleQueues()
  ]);
}

async function loadMqGlobalAlgorithm() {
  try {
    const settingsData = await apiCall('GET', '/api/admin/settings');
    const current = (settingsData.settings && settingsData.settings.mikrotik_aqm_type) || 'auto';
    populateMqAlgorithmSelect(document.getElementById('mqGlobalAlgorithm'), current);
  } catch (e) {
    console.error('Global queue algorithm load error:', e);
  }
}

function populateMqAlgorithmSelect(select, currentValue) {
  if (!select) return;
  select.innerHTML = '<option value="auto">Auto (recommended)</option>';
  mqQueueTypesAll
    .filter(t => t.kind === 'cake' || t.kind === 'fq-codel')
    .forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = `${t.name} (${t.kind})`;
      select.appendChild(opt);
    });
  select.value = currentValue;
  if (select.value !== currentValue) {
    const opt = document.createElement('option');
    opt.value = currentValue;
    opt.textContent = currentValue;
    select.appendChild(opt);
    select.value = currentValue;
  }
}

async function saveMqGlobalAlgorithm() {
  const value = document.getElementById('mqGlobalAlgorithm').value;
  try {
    const data = await apiCall('POST', '/api/admin/spam-settings', { mikrotik_aqm_type: value });
    if (data.success) showToast('Queue algorithm saved!', 'success');
    else showToast(data.message || 'Failed to save', 'error');
  } catch (e) {
    showToast('Server error', 'error');
  }
}

async function loadMqQueueTypes() {
  const tbody = document.getElementById('mqQueueTypesTable');
  try {
    const data = await apiCall('GET', '/api/admin/network/mikrotik/queue-types');
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--accent-red);padding:24px;">${escapeHtml(data.message || 'Failed to load queue types')}</td></tr>`;
      return;
    }
    mqQueueTypesAll = data.queueTypes || [];
    if (!mqQueueTypesAll.length) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:24px;">No queue types found on the router.</td></tr>`;
    } else {
      tbody.innerHTML = mqQueueTypesAll.map(t => `
        <tr>
          <td data-label="Name" style="font-weight:700;">${escapeHtml(t.name)}${t.is_default ? ' <span style="color:var(--text-muted);font-weight:400;">(default)</span>' : ''}</td>
          <td data-label="Kind">${escapeHtml(t.kind || '-')}</td>
          <td data-label="Parameters">${escapeHtml(describeMqQueueTypeParams(t))}</td>
        </tr>
      `).join('');
    }
    // Refresh the algorithm dropdown now that the type list is known, and
    // re-select whatever value it already had.
    const currentGlobal = document.getElementById('mqGlobalAlgorithm').value;
    populateMqAlgorithmSelect(document.getElementById('mqGlobalAlgorithm'), currentGlobal);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--accent-red);padding:24px;">Failed to reach router. Refresh to try again.</td></tr>`;
  }
}

function describeMqQueueTypeParams(t) {
  if (t.kind === 'cake') {
    return `rtt=${t.cake_rtt || '-'} diffserv=${t.cake_diffserv || '-'} flowmode=${t.cake_flowmode || '-'}`;
  }
  if (t.kind === 'fq-codel') {
    return `target=${t.fq_codel_target || '-'} interval=${t.fq_codel_interval || '-'} limit=${t.fq_codel_limit || '-'} flows=${t.fq_codel_flows || '-'}`;
  }
  return '-';
}

async function loadMqSimpleQueues() {
  const tbody = document.getElementById('mqSimpleQueuesTable');
  try {
    const data = await apiCall('GET', '/api/admin/network/mikrotik/queues');
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--accent-red);padding:24px;">${escapeHtml(data.message || 'Failed to load queues')}</td></tr>`;
      return;
    }
    const queues = data.queues || [];
    if (!queues.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">No active Simple Queues on the router.</td></tr>`;
      return;
    }
    tbody.innerHTML = queues.map(q => `
      <tr>
        <td data-label="Name" style="font-weight:700;">${escapeHtml(q.name || '-')}</td>
        <td data-label="Target">${escapeHtml(q.target || '-')}</td>
        <td data-label="Parent">${escapeHtml(q.parent || 'none')}</td>
        <td data-label="Queue (Up/Down)">${escapeHtml(q.queue_upload || '-')} / ${escapeHtml(q.queue_download || '-')}</td>
        <td data-label="Max Limit">${escapeHtml(q.max_limit || '-')}</td>
        <td data-label="Priority">${escapeHtml(q.priority || '-')}</td>
        <td data-label="Status">${q.disabled ? '<span style="color:var(--accent-red);">Disabled</span>' : '<span style="color:var(--accent-green);">Active</span>'}</td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--accent-red);padding:24px;">Failed to reach router. Refresh to try again.</td></tr>`;
  }
}

function openAddQueueType() {
  document.getElementById('mqNewName').value = '';
  document.getElementById('mqNewKind').value = 'fq-codel';
  document.getElementById('mqCakeRtt').value = '';
  document.getElementById('mqCakeDiffserv').value = '';
  document.getElementById('mqCakeFlowmode').value = '';
  document.getElementById('mqFqTarget').value = '';
  document.getElementById('mqFqInterval').value = '';
  document.getElementById('mqFqLimit').value = '';
  document.getElementById('mqFqFlows').value = '';
  toggleMqKindFields();
  document.getElementById('mqQueueTypeModal').classList.add('show');
}

function toggleMqKindFields() {
  const kind = document.getElementById('mqNewKind').value;
  document.getElementById('mqCakeFields').style.display = kind === 'cake' ? 'block' : 'none';
  document.getElementById('mqFqCodelFields').style.display = kind === 'fq-codel' ? 'block' : 'none';
}

async function createMqQueueType() {
  const name = document.getElementById('mqNewName').value.trim();
  const kind = document.getElementById('mqNewKind').value;
  if (!name) return showToast('Enter a queue type name.', 'error');

  const payload = { name, kind };
  if (kind === 'cake') {
    payload.cakeRtt = document.getElementById('mqCakeRtt').value.trim() || undefined;
    payload.cakeDiffserv = document.getElementById('mqCakeDiffserv').value.trim() || undefined;
    payload.cakeFlowmode = document.getElementById('mqCakeFlowmode').value.trim() || undefined;
  } else {
    payload.fqCodelTarget = document.getElementById('mqFqTarget').value.trim() || undefined;
    payload.fqCodelInterval = document.getElementById('mqFqInterval').value.trim() || undefined;
    payload.fqCodelLimit = document.getElementById('mqFqLimit').value || undefined;
    payload.fqCodelFlows = document.getElementById('mqFqFlows').value || undefined;
  }

  const btn = document.getElementById('mqQueueTypeSaveBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
  try {
    const data = await apiCall('POST', '/api/admin/network/mikrotik/queue-types', payload);
    if (data.success) {
      showToast('Queue type created!', 'success');
      closeModal('mqQueueTypeModal');
      loadMikrotikQueuesPage();
    } else {
      showToast(data.message || 'Unable to create queue type.', 'error');
    }
  } catch (e) {
    showToast('Unable to create queue type.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Create';
  }
}
