// ===== LIVE SESSIONS PAGE =====
// Real data only: sessions table has mac_address/ip_address/
// minutes_remaining/is_paused/hard_expires_at/created_at/redeemed_code/
// download_mbps/upload_mbps - no AP association, no device name/type
// exist anywhere in this app, so those columns from the original spec
// are not rendered here (see sessions.html's own comments). "Duration"
// and "Time Remaining" are live-computed client-side from real
// timestamps, not simulated. Data Used (data_used_bytes, from GET
// /api/admin/sessions) is per-PISO-WIFI-SESSION, not per-device like
// Network Devices' own traffic column - best-effort per network mode,
// null (rendered as "--") when there's genuinely no queue/class to read
// from rather than a fabricated number (see admin.js's /sessions route).
let selectedVoucher = null;
let sessionsRefreshInterval = null;
let lsAllSessions = [];
let lsSelected = new Set();
let lsLastLoadedAt = null;
let lsPendingDisconnect = null; // voucher_code, or 'BULK'

async function loadSessions() {
  try {
    const data = await apiCall('GET', '/api/admin/sessions');
    if (!data.success) {
      document.getElementById('sessionsTable').innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:24px;">Error loading sessions</td></tr>`;
      return;
    }
    lsAllSessions = data.sessions || [];
    lsLastLoadedAt = Date.now();
    renderKpis();
    renderSessionsTable();
    updateLiveIndicator();
  } catch (e) {
    console.error('Sessions error:', e);
  }

  // Bug found on real hardware (kept from the earlier version of this
  // file): sessionsRefreshInterval was declared but nothing ever set it -
  // the table only loaded once per page visit. Polls every 5s while this
  // page is open, cleared by destroySessions().
  if (!sessionsRefreshInterval) {
    sessionsRefreshInterval = setInterval(loadSessions, 5000);
  }
  if (!lsIndicatorInterval) {
    lsIndicatorInterval = setInterval(updateLiveIndicator, 1000);
  }
}

let lsIndicatorInterval = null;

function updateLiveIndicator() {
  const el = document.getElementById('sessionsLiveIndicator');
  if (!el || !lsLastLoadedAt) return;
  const secs = Math.floor((Date.now() - lsLastLoadedAt) / 1000);
  const text = secs < 3 ? 'Live · updated just now' : `Live · updated ${secs}s ago`;
  el.innerHTML = `<span class="status-dot online"></span> ${text}`;
}

function destroySessions() {
  if (sessionsRefreshInterval) { clearInterval(sessionsRefreshInterval); sessionsRefreshInterval = null; }
  if (lsIndicatorInterval) { clearInterval(lsIndicatorInterval); lsIndicatorInterval = null; }
  lsSelected.clear();
}

function formatSessionTime(minutes) {
  const total = Math.max(0, Math.floor(minutes * 60));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// created_at is a naive SQLite CURRENT_TIMESTAMP string ("2026-08-12
// 15:43:12", no timezone - needs the space->T+Z treatment to parse as
// UTC, same convention devices.js's isOnline() already uses). expires_at/
// hard_expires_at are written by sessionService.js via .toISOString(),
// already full ISO strings with a trailing Z - appending another Z to
// those produced "Invalid Date" (a real bug caught live: the two
// timestamp columns on the same `sessions` row use different formats).
function parseSqlDate(value) {
  // Bug found live: a null/undefined value (a device record missing
  // first_seen/last_seen) threw here since `.includes` doesn't exist on
  // null - uncaught, this broke the Users > Devices tab's render mid-map,
  // leaving its "Loading..." spinner stuck forever with no error shown.
  if (!value) return null;
  return value.includes('T') ? new Date(value) : new Date(value.replace(' ', 'T') + 'Z');
}

function formatElapsed(createdAt) {
  const secs = Math.max(0, Math.floor((Date.now() - parseSqlDate(createdAt)) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

function formatDataUsed(bytes) {
  if (bytes === null || bytes === undefined) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Data-type Plan sessions (data_limit_mb set at credit time) get a real
// used/remaining readout against their cap, tracked in the DB
// (data_used_bytes - see timerService.js's 30s tick) rather than a live
// queue/class query, since that's the only value that survives MikroTik's
// per-tick queue recreation. Every other session just shows the live
// traffic snapshot (live_traffic_bytes) as a general activity indicator -
// informational only, no cap to measure it against.
function renderDataUsageCell(s) {
  if (s.data_limit_mb) {
    const limitBytes = s.data_limit_mb * 1024 * 1024;
    const used = s.data_used_bytes || 0;
    const pct = Math.min(100, Math.round((used / limitBytes) * 100));
    return `
      <div>${formatDataUsed(used)} / ${formatDataUsed(limitBytes)}</div>
      <div style="background:var(--border-color);border-radius:4px;height:4px;margin:4px 0;overflow:hidden;">
        <div style="background:${pct >= 90 ? 'var(--accent-red)' : 'var(--brand-teal)'};height:100%;width:${pct}%;"></div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);">${formatDataUsed(s.data_remaining_bytes)} left</div>
    `;
  }
  return formatDataUsed(s.live_traffic_bytes);
}

function renderKpis() {
  const active = lsAllSessions.filter((s) => s.is_paused !== 1);
  const paused = lsAllSessions.filter((s) => s.is_paused === 1);
  const uniqueMacs = new Set(lsAllSessions.map((s) => s.mac_address));
  document.getElementById('lsActiveSessions').textContent = active.length;
  document.getElementById('lsUniqueUsers').textContent = uniqueMacs.size;
  document.getElementById('lsPaused').textContent = paused.length;
  loadBandwidthKpis();
}

// Bug found live (code review): this used to read #currentDownload/
// #currentUpload, elements that only exist on the Dashboard page's HTML.
// Since each admin page is fetched independently into #pageContent, those
// elements are never in the DOM while Live Sessions is open, so the
// Downloading/Uploading KPI cards silently showed 0 Mbps always. Polls the
// same real endpoint dashboard.js's pollNetworkStats() uses instead of
// depending on another page's DOM.
// Note this is the WHOLE gated interface's live throughput (this app's
// own MikroTik API polling, DHCP/ARP/management chatter, anything else on
// that wire), not a sum of tracked sessions' traffic - can show a nonzero
// number even with 0 active sessions, which is real and expected, not a
// bug (see the card's own "Whole gated port, not just sessions" subtext).
async function loadBandwidthKpis() {
  try {
    const data = await apiCall('GET', '/api/admin/network-stats');
    if (!data.success) return;
    document.getElementById('lsDownload').textContent = data.download_mbps;
    document.getElementById('lsUpload').textContent = data.upload_mbps;
  } catch (e) {}
}

function sessionStatus(s) {
  if (s.is_paused === 1) return 'paused';
  // Paid time remaining doesn't mean the device is actually here right
  // now (walked away, or a MAC-duplicated device that never really
  // connected) - s.online comes from the same real ARP-presence check
  // Network Devices uses, not from minutes_remaining/is_paused.
  if (s.online === false) return 'away';
  if (s.minutes_remaining < 5) return 'expiring';
  return 'active';
}

function renderSessionsTable() {
  const tbody = document.getElementById('sessionsTable');
  const search = (document.getElementById('lsSearch')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('lsStatusFilter')?.value || '';
  const typeFilter = document.getElementById('lsTypeFilter')?.value || '';

  let rows = lsAllSessions.filter((s) => {
    if (search) {
      const hay = `${s.voucher_code} ${s.mac_address} ${s.ip_address || ''} ${s.redeemed_code || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (statusFilter && sessionStatus(s) !== statusFilter) return false;
    if (typeFilter === 'voucher' && !s.redeemed_code) return false;
    if (typeFilter === 'coin' && s.redeemed_code) return false;
    return true;
  });

  document.getElementById('sessionSummary').textContent = `Showing ${rows.length} of ${lsAllSessions.length} session(s)`;
  document.getElementById('lsTotalCount').textContent = lsAllSessions.length;
  document.getElementById('lsDisconnectAllBtn').style.display = lsAllSessions.length > 0 ? 'inline-flex' : 'none';

  if (lsAllSessions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><i class="fas fa-wifi" style="color:var(--text-muted)"></i><h3>No Active Sessions</h3><p>Your hotspot is ready for new connections.</p></div></td></tr>`;
    return;
  }
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:24px;">No sessions found. <a href="#" onclick="clearSessionFilters();return false;" style="color:var(--brand-teal);">Clear filters</a></td></tr>`;
    return;
  }

  const statusBadge = {
    active: '<span class="badge badge-green"><span class="status-dot online"></span>Active</span>',
    expiring: '<span class="badge badge-orange">Expiring Soon</span>',
    paused: '<span class="badge badge-orange"><i class="fas fa-pause"></i> Paused</span>',
    away: '<span class="badge badge-gray" title="Paid time remaining, but not currently connected"><span class="status-dot offline"></span>Away</span>'
  };

  tbody.innerHTML = rows.map((s) => {
    const status = sessionStatus(s);
    const isPaused = s.is_paused === 1;
    return `
      <tr>
        <td class="table-stack-full"><input type="checkbox" class="ls-row-check" data-voucher="${s.voucher_code}" onchange="toggleRowSelect('${s.voucher_code}', this.checked)" ${lsSelected.has(s.voucher_code) ? 'checked' : ''}></td>
        <td data-label="Session ID">
          <span style="font-family:monospace;font-size:13px;color:var(--text-primary);font-weight:700;">${s.voucher_code}</span>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Start: ${parseSqlDate(s.created_at).toLocaleTimeString()}</div>
        </td>
        <td data-label="MAC Address">
          ${s.display_name
            ? `<div style="font-size:13px;color:var(--text-primary);">${escapeHtml(s.display_name)}</div>`
            : `<div style="font-family:monospace;font-size:12px;color:var(--text-secondary);">${s.mac_address}</div>`}
        </td>
        <td data-label="IP Address" style="font-size:13px;color:var(--text-secondary);">${s.ip_address || '--'}</td>
        <td data-label="Plan">
          ${s.redeemed_code ? `<span style="font-size:13px;color:var(--text-primary);">Voucher</span><div style="font-size:11px;color:var(--text-muted);">${s.redeemed_code}</div>` : '<span style="font-size:13px;color:var(--text-primary);">Coin Session</span>'}
          <div style="font-size:11px;color:var(--text-muted);">Expires: ${parseSqlDate(s.hard_expires_at).toLocaleTimeString()}</div>
        </td>
        <td data-label="Duration" style="font-size:13px;color:var(--text-secondary);">${formatElapsed(s.created_at)}</td>
        <td data-label="Time Remaining">
          <span style="font-weight:700;color:${status === 'expiring' ? 'var(--accent-red)' : 'var(--text-primary)'};">${formatSessionTime(s.minutes_remaining)}</span>
        </td>
        <td data-label="Rate Limit" style="font-size:12px;color:var(--text-secondary);">
          ${s.download_mbps ? `${s.download_mbps} Mbps ↓<br>${s.upload_mbps || s.download_mbps} Mbps ↑` : 'Global default'}
        </td>
        <td data-label="Data Used" style="font-size:12px;color:var(--text-secondary);">${renderDataUsageCell(s)}</td>
        <td data-label="Status">${statusBadge[status]}</td>
        <td class="table-stack-full">
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-sm btn-secondary btn-icon" onclick="openAddTime('${s.voucher_code}')" title="Add/Reduce Time"><i class="fas fa-clock"></i></button>
            ${isPaused
              ? `<button class="btn btn-sm btn-secondary btn-icon" onclick="adminResumeSession('${s.voucher_code}')" title="Resume"><i class="fas fa-play"></i></button>`
              : `<button class="btn btn-sm btn-secondary btn-icon" onclick="adminPauseSession('${s.voucher_code}')" title="Pause"><i class="fas fa-pause"></i></button>`
            }
            <button class="btn btn-sm btn-danger btn-icon" onclick="confirmDisconnectOne('${s.voucher_code}')" title="Disconnect"><i class="fas fa-plug-circle-xmark"></i></button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

function clearSessionFilters() {
  document.getElementById('lsSearch').value = '';
  document.getElementById('lsStatusFilter').value = '';
  document.getElementById('lsTypeFilter').value = '';
  renderSessionsTable();
}

function toggleRowSelect(voucherCode, checked) {
  if (checked) lsSelected.add(voucherCode); else lsSelected.delete(voucherCode);
  updateBulkBar();
}

function toggleSelectAll(checkbox) {
  document.querySelectorAll('.ls-row-check').forEach((el) => {
    el.checked = checkbox.checked;
    if (checkbox.checked) lsSelected.add(el.dataset.voucher); else lsSelected.delete(el.dataset.voucher);
  });
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('lsBulkBar');
  document.getElementById('lsSelectedCount').textContent = lsSelected.size;
  bar.style.display = lsSelected.size > 0 ? 'flex' : 'none';
}

async function bulkAddTime() {
  if (lsSelected.size === 0) return;
  selectedVoucher = 'BULK';
  document.getElementById('addTimeContext').innerHTML = `Adjusting time for <strong>${lsSelected.size} selected session(s)</strong>`;
  document.getElementById('addTimeMinutes').value = '';
  document.getElementById('addTimeModal').classList.add('show');
}

function bulkDisconnect() {
  if (lsSelected.size === 0) return;
  lsPendingDisconnect = 'BULK';
  document.getElementById('disconnectPluralS').textContent = lsSelected.size > 1 ? 's' : '';
  document.getElementById('disconnectConfirmText').textContent = `This will disconnect ${lsSelected.size} selected session(s) immediately. This action cannot be undone.`;
  document.getElementById('disconnectConfirmModal').classList.add('show');
}

function confirmDisconnectOne(voucherCode) {
  lsPendingDisconnect = voucherCode;
  document.getElementById('disconnectPluralS').textContent = '';
  document.getElementById('disconnectConfirmText').textContent = `${voucherCode} will lose internet access immediately. This action cannot be undone.`;
  document.getElementById('disconnectConfirmModal').classList.add('show');
}

async function executeDisconnectConfirm() {
  closeModal('disconnectConfirmModal');
  if (lsPendingDisconnect === 'BULK') {
    const targets = Array.from(lsSelected);
    for (const code of targets) {
      try { await apiCall('DELETE', `/api/admin/session/${code}`); } catch (e) {}
    }
    lsSelected.clear();
    showToast(`Disconnected ${targets.length} session(s)`, 'success');
    loadSessions();
  } else if (lsPendingDisconnect) {
    await cutSession(lsPendingDisconnect);
  }
  lsPendingDisconnect = null;
}

function confirmDisconnectAll() {
  document.getElementById('disconnectAllCount').textContent = lsAllSessions.length;
  document.getElementById('disconnectAllModal').classList.add('show');
}

async function executeDisconnectAll() {
  closeModal('disconnectAllModal');
  const targets = lsAllSessions.map((s) => s.voucher_code);
  for (const code of targets) {
    try { await apiCall('DELETE', `/api/admin/session/${code}`); } catch (e) {}
  }
  showToast(`Disconnected ${targets.length} session(s)`, 'success');
  loadSessions();
}

function openAddTime(voucherCode) {
  selectedVoucher = voucherCode;
  document.getElementById('addTimeContext').innerHTML = `Adjusting time for: <strong id="addTimeVoucher" style="color:var(--text-primary);font-family:monospace;">${voucherCode}</strong>`;
  document.getElementById('addTimeMinutes').value = '';
  document.getElementById('addTimeModal').classList.add('show');
}

function setMinutes(mins) {
  document.getElementById('addTimeMinutes').value = mins;
}

async function confirmAddTime() {
  const minutes = parseInt(document.getElementById('addTimeMinutes').value);
  if (!Number.isFinite(minutes) || minutes === 0) {
    showToast('Enter a non-zero number of minutes', 'error');
    return;
  }

  const targets = selectedVoucher === 'BULK' ? Array.from(lsSelected) : [selectedVoucher];
  let okCount = 0;
  for (const code of targets) {
    try {
      const data = await apiCall('POST', `/api/admin/session/${code}/addtime`, { minutes });
      if (data.success) okCount++;
    } catch (e) {}
  }
  showToast(`${minutes > 0 ? 'Added' : 'Removed'} ${Math.abs(minutes)} minutes for ${okCount} session(s)`, okCount > 0 ? 'success' : 'error');
  closeModal('addTimeModal');
  if (selectedVoucher === 'BULK') lsSelected.clear();
  loadSessions();
}

async function adminPauseSession(voucherCode) {
  try {
    const data = await apiCall('POST', `/api/admin/session/${voucherCode}/pause`);
    if (data.success) { showToast(`Paused ${voucherCode}`, 'success'); loadSessions(); }
    else showToast(data.message || 'Failed to pause session', 'error');
  } catch (e) { showToast('Server error', 'error'); }
}

async function adminResumeSession(voucherCode) {
  try {
    const data = await apiCall('POST', `/api/admin/session/${voucherCode}/resume`);
    if (data.success) { showToast(`Resumed ${voucherCode}`, 'success'); loadSessions(); }
    else showToast(data.message || 'Failed to resume session', 'error');
  } catch (e) { showToast('Server error', 'error'); }
}

async function cutSession(voucherCode) {
  try {
    const data = await apiCall('DELETE', `/api/admin/session/${voucherCode}`);
    if (data.success) { showToast(`Session ${voucherCode} disconnected`, 'success'); loadSessions(); }
    else showToast(data.message || 'Failed to disconnect session', 'error');
  } catch (e) { showToast('Server error', 'error'); }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}
