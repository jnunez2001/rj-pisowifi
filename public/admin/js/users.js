// ===== USERS PAGE (Accounts / Guests / Devices) =====
// Real data only. Accounts tab is an honest placeholder - this app has
// no customer-account/authentication system at all, only the single
// admin login. Guests and Devices are both real: Guests reuses live
// `sessions` + historical `session_history`, joined to `transactions`
// for real source attribution (GET /api/admin/users/guests). Devices
// aggregates every real MAC address this box has ever recorded across
// transactions/session_history (GET /api/admin/users/devices), with
// friendly names from the existing client_labels feature.
let usersGuestsData = null;
let usersDevicesData = null;
let usersRefreshInterval = null;

async function loadUsersPage() {
  await Promise.all([loadGuestsData(), loadDevicesData()]);
  if (!usersRefreshInterval) {
    usersRefreshInterval = setInterval(() => { loadGuestsData(); loadDevicesData(); }, 10000);
  }
}

function destroyUsersPage() {
  if (usersRefreshInterval) { clearInterval(usersRefreshInterval); usersRefreshInterval = null; }
}

function switchUsersTab(tab) {
  ['accounts', 'guests', 'devices'].forEach((t) => {
    document.getElementById(`usersTab${t.charAt(0).toUpperCase() + t.slice(1)}`).classList.toggle('active', t === tab);
    document.getElementById(`users${t.charAt(0).toUpperCase() + t.slice(1)}Panel`).style.display = t === tab ? 'block' : 'none';
  });
}

async function loadGuestsData() {
  try {
    const data = await apiCall('GET', '/api/admin/users/guests?days=7');
    if (!data.success) return;
    usersGuestsData = data;
    document.getElementById('usersGuestsCount').textContent = data.kpi.activeNow;
    document.getElementById('guestsTotalSessions').textContent = data.kpi.totalSessionsPeriod;
    document.getElementById('guestsActiveNow').textContent = data.kpi.activeNow;
    document.getElementById('guestsRevenue').textContent = `₱${data.kpi.totalRevenuePeriod.toFixed(2)}`;
    renderGuestsTable();
  } catch (e) {
    console.error('Guests load error:', e);
  }
}

function sourceLabel(type) {
  if (type === 'coin') return 'Coin Vendo';
  if (type === 'voucher') return 'Voucher';
  if (type === 'promo') return 'Promo';
  if (type === 'free') return 'Free Access';
  return 'Unknown';
}

function renderGuestsTable() {
  if (!usersGuestsData) return;
  const tbody = document.getElementById('guestsTable');
  const search = (document.getElementById('guestsSearch')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('guestsStatusFilter')?.value || '';
  const sourceFilter = document.getElementById('guestsSourceFilter')?.value || '';

  const activeRows = usersGuestsData.active.map((s) => ({ ...s, status: 'active' }));
  const recentRows = usersGuestsData.recent.map((s) => ({ ...s, status: 'ended' }));
  let rows = activeRows.concat(recentRows);

  rows = rows.filter((r) => {
    if (search) {
      const hay = `${r.voucher_code} ${r.mac_address} ${r.ip_address || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (statusFilter && r.status !== statusFilter) return false;
    if (sourceFilter && r.source_type !== sourceFilter) return false;
    return true;
  });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">No guest sessions found</td></tr>';
    return;
  }

  tbody.innerHTML = rows.slice(0, 100).map((r) => {
    const isActive = r.status === 'active';
    return `
      <tr>
        <td><span style="font-family:monospace;font-size:13px;font-weight:700;color:var(--text-primary);">${r.voucher_code}</span></td>
        <td style="font-family:monospace;font-size:12px;color:var(--text-secondary);">${r.mac_address}</td>
        <td style="font-size:13px;color:var(--text-secondary);">${sourceLabel(r.source_type)}${r.coin_value ? ` · ₱${r.coin_value}` : ''}</td>
        <td style="font-size:12px;color:var(--text-muted);">${parseSqlDate(r.created_at || r.started_at).toLocaleString()}</td>
        <td style="font-size:13px;color:var(--text-secondary);">${isActive ? formatSessionTime(r.minutes_remaining) : formatMins(Math.round((r.duration_seconds || 0) / 60))}</td>
        <td>${isActive ? '<span class="badge badge-green"><span class="status-dot online"></span>Active</span>' : '<span class="badge badge-orange">Ended</span>'}</td>
        <td>${isActive ? `<button class="btn btn-sm btn-secondary" onclick="navigateTo('sessions')">View in Live Sessions</button>` : '--'}</td>
      </tr>`;
  }).join('');
}

async function loadDevicesData() {
  try {
    const data = await apiCall('GET', '/api/admin/users/devices?days=30');
    if (!data.success) return;
    usersDevicesData = data.devices;
    document.getElementById('usersDevicesCount').textContent = data.devices.length;
    renderDevicesTable();
  } catch (e) {
    console.error('Devices load error:', e);
  }
}

function renderDevicesTable() {
  if (!usersDevicesData) return;
  const tbody = document.getElementById('devicesTable');
  const search = (document.getElementById('devicesSearch')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('devicesStatusFilter')?.value || '';

  let rows = usersDevicesData.filter((d) => {
    if (search) {
      const hay = `${d.mac_address} ${d.label || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (statusFilter === 'online' && !d.online) return false;
    if (statusFilter === 'offline' && d.online) return false;
    return true;
  });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">No devices found</td></tr>';
    return;
  }

  tbody.innerHTML = rows.slice(0, 100).map((d) => `
    <tr>
      <td>
        <span style="font-size:13px;font-weight:600;color:var(--text-primary);">${d.label || 'Unnamed device'}</span>
        ${d.trusted ? '<span class="badge badge-blue" style="margin-left:6px;">Trusted</span>' : ''}
      </td>
      <td style="font-family:monospace;font-size:12px;color:var(--text-secondary);">${d.mac_address}</td>
      <td style="font-size:12px;color:var(--text-muted);">${parseSqlDate(d.first_seen).toLocaleDateString()}</td>
      <td style="font-size:12px;color:var(--text-muted);">${parseSqlDate(d.last_seen).toLocaleString()}</td>
      <td style="font-size:13px;color:var(--text-secondary);">${d.session_count}</td>
      <td>${d.online ? '<span class="badge badge-green"><span class="status-dot online"></span>Online</span>' : '<span class="badge badge-orange">Offline</span>'}</td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="renameDevice('${d.mac_address}', '${(d.label || '').replace(/'/g, "\\'")}')" title="Rename"><i class="fas fa-pen"></i></button>
      </td>
    </tr>
  `).join('');
}

async function renameDevice(mac, currentLabel) {
  const label = prompt('Device name for ' + mac, currentLabel || '');
  if (label === null) return;
  try {
    const data = await apiCall('POST', '/api/admin/network/client-labels', { mac_address: mac, label });
    if (data.success) { showToast('Device renamed', 'success'); loadDevicesData(); }
    else showToast(data.message || 'Failed to rename device', 'error');
  } catch (e) { showToast('Server error', 'error'); }
}

function exportUsersCsv() {
  if (!usersDevicesData) return;
  const rows = [['MAC Address', 'Label', 'First Seen', 'Last Seen', 'Sessions', 'Online']];
  usersDevicesData.forEach((d) => rows.push([d.mac_address, d.label || '', d.first_seen, d.last_seen, d.session_count, d.online ? 'Yes' : 'No']));
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zenfi-devices-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
