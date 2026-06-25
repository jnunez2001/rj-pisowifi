// ===== PROMO VOUCHERS PAGE =====

function durationToMinutes(value, unit) {
  if (unit === 'minutes') return value;
  if (unit === 'hours') return value * 60;
  if (unit === 'days') return value * 1440;
  return value;
}

function formatDuration(minutes) {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hrs`;
  return `${minutes} mins`;
}

async function loadPromos() {
  try {
    const data = await apiCall('GET', '/api/admin/promos');
    const tbody = document.getElementById('promosTable');

    if (!data.success || !data.promos.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6">
            <div class="empty-state">
              <i class="fas fa-ticket-alt"></i>
              <h3>No Promo Vouchers</h3>
              <p>Create promo codes for bulk packages.</p>
            </div>
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = data.promos.map(p => {
      // Support both old duration_days and new duration_minutes
      const minutes = p.duration_minutes || (p.duration_days * 1440);
      return `
        <tr>
          <td>
            <span style="font-family:monospace;font-size:14px;font-weight:700;
                         color:var(--accent-red);letter-spacing:2px;">
              ${p.code}
            </span>
          </td>
          <td><span class="badge badge-blue">${formatDuration(minutes)}</span></td>
          <td><span class="badge badge-green">₱${p.price}</span></td>
          <td>
            <span class="badge ${
              p.status === 'unused' ? 'badge-orange' :
              p.status === 'active' ? 'badge-green' : 'badge-red'
            }">
              ${p.status === 'unused' ? '⏳ Unused' :
                p.status === 'active' ? '✅ Active' : '❌ Expired'}
            </span>
          </td>
          <td style="font-family:monospace;font-size:12px;color:var(--text-muted);">
            ${p.mac_address || '--'}
          </td>
          <td>
            <button class="btn btn-sm btn-danger btn-icon"
                    onclick="deletePromo(${p.id}, '${p.code}')"
                    title="Delete">
              <i class="fas fa-trash"></i>
            </button>
          </td>
        </tr>`;
    }).join('');

  } catch(e) {
    console.error('Promos error:', e);
  }
}

function openCreatePromo() {
  document.getElementById('promoDuration').value = '';
  document.getElementById('promoDurationUnit').value = 'days';
  document.getElementById('promoPrice').value = '';
  document.getElementById('promoModal').classList.add('show');
}

function setPromo(duration, unit, price) {
  document.getElementById('promoDuration').value = duration;
  document.getElementById('promoDurationUnit').value = unit;
  document.getElementById('promoPrice').value = price;
}

async function createPromo() {
  const duration = parseInt(document.getElementById('promoDuration').value);
  const unit = document.getElementById('promoDurationUnit').value;
  const price = parseInt(document.getElementById('promoPrice').value);

  if (!duration || !price) {
    showToast('Please fill all fields', 'error');
    return;
  }

  const minutes = durationToMinutes(duration, unit);

  try {
    const data = await apiCall('POST', '/api/admin/promos', {
      duration_minutes: minutes,
      price
    });

    if (data.success) {
      closeModal('promoModal');
      document.getElementById('generatedCode').textContent = data.code;
      document.getElementById('generatedDetails').textContent =
        `${formatDuration(minutes)} access • ₱${price}`;
      document.getElementById('showCodeModal').classList.add('show');
      loadPromos();
    } else {
      showToast(data.message || 'Failed to create promo', 'error');
    }
  } catch(e) {
    showToast('Server error', 'error');
  }
}

function copyCode() {
  const code = document.getElementById('generatedCode').textContent;
  navigator.clipboard.writeText(code).then(() => {
    showToast('Code copied to clipboard!', 'success');
  });
}

async function deletePromo(id, code) {
  if (!confirm(`Delete promo code ${code}?`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/promos/${id}`);
    if (data.success) {
      showToast('Promo deleted', 'success');
      loadPromos();
    }
  } catch(e) {
    showToast('Server error', 'error');
  }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}