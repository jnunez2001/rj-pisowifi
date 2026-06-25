let selectedVoucher = null;
let sessionsRefreshInterval = null;

async function loadSessions() {
  try {
    const data = await apiCall('GET', '/api/admin/sessions');
    const tbody = document.getElementById('sessionsTable');
    const summary = document.getElementById('sessionSummary');

    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px;">Error loading sessions</td></tr>`;
      return;
    }

    const sessions = data.sessions || [];
    summary.textContent = `${sessions.length} client${sessions.length !== 1 ? 's' : ''} connected`;
    document.getElementById('sessionCount').textContent = sessions.length;

    if (sessions.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6">
            <div class="empty-state">
              <i class="fas fa-users" style="color:var(--text-muted)"></i>
              <h3>No Active Sessions</h3>
              <p>No clients connected right now.</p>
            </div>
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = sessions.map(s => {
      const remaining = s.minutes_remaining;
      const isLow = remaining < 5;
      const isPaused = s.is_paused === 1;

      return `
        <tr>
          <td>
            <span style="font-family:monospace;font-size:13px;color:var(--accent-red);font-weight:700;">
              ${s.voucher_code}
            </span>
          </td>
          <td style="font-family:monospace;font-size:12px;color:var(--text-muted);">
            ${s.mac_address}
          </td>
          <td>
            <span style="font-weight:700;color:${isLow ? 'var(--accent-red)' : 'var(--accent-green)'};">
              ${formatSessionTime(remaining)}
            </span>
            ${isLow ? '<span class="badge badge-red" style="margin-left:6px;">Low</span>' : ''}
          </td>
          <td style="font-size:13px;color:var(--text-muted);">
            ${new Date(s.hard_expires_at).toLocaleTimeString()}
          </td>
          <td>
            ${isPaused
              ? '<span class="badge badge-orange"><i class="fas fa-pause"></i> Paused</span>'
              : '<span class="badge badge-green"><i class="fas fa-circle"></i> Active</span>'
            }
          </td>
          <td>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-sm btn-primary btn-icon"
                      onclick="openAddTime('${s.voucher_code}')"
                      title="Add Time">
                <i class="fas fa-plus"></i>
              </button>
              <button class="btn btn-sm btn-danger btn-icon"
                      onclick="cutSession('${s.voucher_code}')"
                      title="Cut Session">
                <i class="fas fa-times"></i>
              </button>
            </div>
          </td>
        </tr>`;
    }).join('');

  } catch(e) {
    console.error('Sessions error:', e);
  }
}

function formatSessionTime(minutes) {
  const total = Math.max(0, Math.floor(minutes * 60));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function openAddTime(voucherCode) {
  selectedVoucher = voucherCode;
  document.getElementById('addTimeVoucher').textContent = voucherCode;
  document.getElementById('addTimeMinutes').value = '';
  document.getElementById('addTimeModal').classList.add('show');
}

function setMinutes(mins) {
  document.getElementById('addTimeMinutes').value = mins;
}

async function confirmAddTime() {
  const minutes = parseInt(document.getElementById('addTimeMinutes').value);
  if (!minutes || minutes < 1) {
    showToast('Please enter valid minutes', 'error');
    return;
  }

  try {
    const data = await apiCall(
      'POST',
      `/api/admin/session/${selectedVoucher}/addtime`,
      { minutes }
    );

    if (data.success) {
      showToast(`Added ${minutes} minutes to ${selectedVoucher}`, 'success');
      closeModal('addTimeModal');
      loadSessions();
    } else {
      showToast(data.message || 'Failed to add time', 'error');
    }
  } catch(e) {
    showToast('Server error', 'error');
  }
}

async function cutSession(voucherCode) {
  if (!confirm(`Cut session ${voucherCode}? This will disconnect the client immediately.`)) return;

  try {
    const data = await apiCall('DELETE', `/api/admin/session/${voucherCode}`);
    if (data.success) {
      showToast(`Session ${voucherCode} terminated`, 'success');
      loadSessions();
    } else {
      showToast(data.message || 'Failed to cut session', 'error');
    }
  } catch(e) {
    showToast('Server error', 'error');
  }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}