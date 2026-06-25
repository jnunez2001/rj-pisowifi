async function loadRates() {
  try {
    const data = await apiCall('GET', '/api/admin/rates');
    const tbody = document.getElementById('ratesTable');

    if (!data.success || !data.rates.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">No rates configured</td></tr>`;
      return;
    }

    tbody.innerHTML = data.rates.map(r => `
      <tr>
        <td>
          <span style="font-family:monospace;font-size:16px;font-weight:700;color:var(--accent-red);">
            ₱${r.coin_value}
          </span>
        </td>
        <td>
          <span class="badge badge-green">${formatRateTime(r.minutes)}</span>
        </td>
        <td>
          <span class="badge badge-orange">${formatRateTime(r.expiration_minutes)}</span>
        </td>
        <td style="color:var(--text-secondary);font-size:13px;">${r.label}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm btn-secondary btn-icon"
                    onclick="editRate(${r.id}, ${r.coin_value}, ${r.minutes}, ${r.expiration_minutes}, '${r.label}')"
                    title="Edit">
              <i class="fas fa-edit"></i>
            </button>
            <button class="btn btn-sm btn-danger btn-icon"
                    onclick="deleteRate(${r.id}, '${r.label}')"
                    title="Delete">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `).join('');

  } catch(e) {
    console.error('Rates error:', e);
  }
}

function formatRateTime(mins) {
  if (mins >= 43200) return `${Math.round(mins/43200)} days`;
  if (mins >= 1440) return `${Math.round(mins/1440)} days`;
  if (mins >= 60) return `${Math.round(mins/60)} hrs`;
  return `${mins} mins`;
}

function openAddRate() {
  document.getElementById('rateModalTitle').textContent = 'Add New Rate';
  document.getElementById('editRateId').value = '';
  document.getElementById('rateCoinValue').value = '';
  document.getElementById('rateMinutes').value = '';
  document.getElementById('rateExpiration').value = '';
  document.getElementById('rateLabel').value = '';
  document.getElementById('rateModal').classList.add('show');
}

function editRate(id, coinValue, minutes, expiration, label) {
  document.getElementById('rateModalTitle').textContent = 'Edit Rate';
  document.getElementById('editRateId').value = id;
  document.getElementById('rateCoinValue').value = coinValue;
  document.getElementById('rateMinutes').value = minutes;
  document.getElementById('rateExpiration').value = expiration;
  document.getElementById('rateLabel').value = label;
  document.getElementById('rateModal').classList.add('show');
}

async function saveRate() {
  const id = document.getElementById('editRateId').value;
  const coinValue = parseInt(document.getElementById('rateCoinValue').value);
  const minutes = parseFloat(document.getElementById('rateMinutes').value);
  const expiration = parseFloat(document.getElementById('rateExpiration').value);
  const label = document.getElementById('rateLabel').value.trim();

  if (!coinValue || !minutes || !expiration || !label) {
    showToast('Please fill all fields', 'error');
    return;
  }

  if (expiration < minutes) {
    showToast('Expiration must be ≥ access time', 'error');
    return;
  }

  try {
    let data;
    if (id) {
      data = await apiCall('PUT', `/api/admin/rates/${id}`, {
        coin_value: coinValue,
        minutes,
        expiration_minutes: expiration,
        label
      });
    } else {
      data = await apiCall('POST', '/api/admin/rates', {
        coin_value: coinValue,
        minutes,
        expiration_minutes: expiration,
        label
      });
    }

    if (data.success) {
      showToast(id ? 'Rate updated!' : 'Rate added!', 'success');
      closeModal('rateModal');
      loadRates();
    } else {
      showToast(data.message || 'Failed to save rate', 'error');
    }
  } catch(e) {
    showToast('Server error', 'error');
  }
}

async function deleteRate(id, label) {
  if (!confirm(`Delete rate "${label}"?`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/rates/${id}`);
    if (data.success) {
      showToast('Rate deleted', 'success');
      loadRates();
    } else {
      showToast(data.message || 'Failed to delete', 'error');
    }
  } catch(e) {
    showToast('Server error', 'error');
  }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}