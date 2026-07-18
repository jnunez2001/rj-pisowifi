// ===== VOUCHERS PAGE =====

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

// Bug: a fully-used voucher (status 'used' - session ended normally) fell
// into the same "else" branch as a genuinely unknown status and got shown
// as "Expired", which is wrong - nothing about this schema tracks a
// pre-redemption expiry, so 'used' just means it was successfully
// consumed. Single source of truth for both the flat table and the group
// details modal so they never drift from each other.
function voucherStatusBadge(status) {
  if (status === 'unused') return { cls: 'badge-orange', label: '⏳ Unused' };
  if (status === 'active') return { cls: 'badge-green', label: '✅ Active' };
  if (status === 'used') return { cls: 'badge-blue', label: '✔️ Used' };
  return { cls: 'badge-red', label: '❌ Unknown' };
}

async function loadVouchers() {
  await loadPromos();
  await loadVoucherGroups();
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

// ===== SINGLE VOUCHER =====

async function loadPromos() {
  const tbody = document.getElementById('promosTable');
  try {
    const data = await apiCall('GET', '/api/admin/promos');

    // Bug: a real failure (rate-limited, server error) has `data.success
    // === false`, but this used to fall into the same branch as "no
    // vouchers yet" and show a misleading "No Vouchers, create one!"
    // message instead of the actual reason it failed.
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--accent-red);padding:24px;">${data.message || 'Failed to load vouchers'}</td></tr>`;
      return;
    }

    if (!data.promos.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6">
            <div class="empty-state">
              <i class="fas fa-ticket-alt"></i>
              <h3>No Vouchers</h3>
              <p>Create a voucher for a bulk package, or a batch below.</p>
            </div>
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = data.promos.map(p => {
      const minutes = p.duration_minutes || (p.duration_days * 1440);
      const badge = voucherStatusBadge(p.status);
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
            <span class="badge ${badge.cls}">${badge.label}</span>
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
    // Bug: this used to just console.error and leave the table stuck on
    // its initial "Loading..." row forever with no visible indication
    // anything had gone wrong.
    console.error('Vouchers error:', e);
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--accent-red);padding:24px;">Failed to load vouchers. Refresh to try again.</td></tr>`;
  }
}

function openCreateVoucher() {
  document.getElementById('promoDuration').value = '';
  document.getElementById('promoDurationUnit').value = 'days';
  document.getElementById('promoPrice').value = '';
  document.getElementById('promoDownloadMbps').value = '';
  document.getElementById('promoUploadMbps').value = '';
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
  const downloadMbps = document.getElementById('promoDownloadMbps').value.trim();
  const uploadMbps = document.getElementById('promoUploadMbps').value.trim();

  try {
    const data = await apiCall('POST', '/api/admin/promos', {
      duration_minutes: minutes,
      price,
      download_mbps: downloadMbps || null,
      upload_mbps: uploadMbps || null
    });

    if (data.success) {
      closeModal('promoModal');
      document.getElementById('generatedCode').textContent = data.code;
      document.getElementById('generatedDetails').textContent =
        `${formatDuration(minutes)} access • ₱${price}`;
      document.getElementById('showCodeModal').classList.add('show');
      loadPromos();
    } else {
      showToast(data.message || 'Failed to create voucher', 'error');
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
  if (!confirm(`Delete voucher ${code}?`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/promos/${id}`);
    if (data.success) {
      showToast('Voucher deleted', 'success');
      loadPromos();
    }
  } catch(e) {
    showToast('Server error', 'error');
  }
}

// ===== VOUCHER GROUPS (batch creation + printing) =====

function openCreateGroup() {
  document.getElementById('groupName').value = '';
  document.getElementById('groupQuantity').value = '';
  document.getElementById('groupPrice').value = '';
  document.getElementById('groupDuration').value = '';
  document.getElementById('groupDurationUnit').value = 'days';
  document.getElementById('groupCodeLength').value = 6;
  document.getElementById('groupCodeCharset').value = 'mixed';
  document.getElementById('groupCodeCase').value = 'upper';
  document.getElementById('groupCaption').value = '';
  document.getElementById('groupLogoFile').value = '';
  document.getElementById('groupModal').classList.add('show');
}

async function loadVoucherGroups() {
  const tbody = document.getElementById('voucherGroupsTable');
  if (!tbody) return;
  try {
    const data = await apiCall('GET', '/api/admin/vouchers/groups');

    // Bug: a real failure (rate-limited, server error) has
    // `data.success === false`, but this used to fall into the same
    // branch as "no groups yet" and show a misleading "create one!"
    // message instead of the actual reason it failed.
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--accent-red);padding:24px;">${data.message || 'Failed to load voucher groups'}</td></tr>`;
      return;
    }

    if (!data.groups.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6">
            <div class="empty-state">
              <i class="fas fa-layer-group"></i>
              <h3>No Voucher Groups</h3>
              <p>Create a batch of vouchers to print and hand out.</p>
            </div>
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = data.groups.map(g => `
      <tr>
        <td style="font-weight:700;">${g.name}</td>
        <td>${g.actual_count}</td>
        <td>
          <span class="badge badge-orange">${g.unused_count || 0} unused</span>
          <span class="badge badge-green" style="margin-left:4px;">${g.active_count || 0} active</span>
          <span class="badge badge-blue" style="margin-left:4px;">${g.used_count || 0} used</span>
        </td>
        <td><span class="badge badge-blue">${formatDuration(g.duration_minutes)}</span></td>
        <td><span class="badge badge-green">₱${g.price}</span></td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm btn-secondary btn-icon" onclick="viewVoucherGroup(${g.id})" title="View codes">
              <i class="fas fa-eye"></i>
            </button>
            <button class="btn btn-sm btn-secondary btn-icon" onclick="printVoucherGroup(${g.id})" title="Print">
              <i class="fas fa-print"></i>
            </button>
            <button class="btn btn-sm btn-danger btn-icon" onclick="deleteVoucherGroup(${g.id}, '${g.name.replace(/'/g, "\\'")}')" title="Delete">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch(e) {
    // Bug: this used to just console.error and leave the table stuck on
    // its initial "Loading..." row forever with no visible indication
    // anything had gone wrong.
    console.error('Voucher groups error:', e);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--accent-red);padding:24px;">Failed to load voucher groups. Refresh to try again.</td></tr>`;
  }
}

async function createVoucherGroup() {
  const name = document.getElementById('groupName').value.trim();
  const quantity = parseInt(document.getElementById('groupQuantity').value);
  const price = parseInt(document.getElementById('groupPrice').value);
  const duration = parseFloat(document.getElementById('groupDuration').value);
  const durationUnit = document.getElementById('groupDurationUnit').value;
  const codeLength = parseInt(document.getElementById('groupCodeLength').value);
  const codeCharset = document.getElementById('groupCodeCharset').value;
  const codeCase = document.getElementById('groupCodeCase').value;
  const caption = document.getElementById('groupCaption').value.trim();
  const logoFile = document.getElementById('groupLogoFile').files[0];

  if (!name || !quantity || !price || !duration) {
    showToast('Please fill all required fields', 'error');
    return;
  }

  const btn = document.getElementById('createGroupBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';

  try {
    let logoUrl = '';
    if (logoFile) {
      const formData = new FormData();
      formData.append('image', logoFile);
      const uploadRes = await fetch('/api/admin/upload/voucher', {
        method: 'POST',
        headers: { 'password': authToken },
        body: formData
      });
      const uploadData = await uploadRes.json();
      if (uploadData.success) logoUrl = uploadData.url;
      else showToast(uploadData.message || 'Logo upload failed, continuing without it', 'warning');
    }

    const durationMinutes = durationToMinutes(duration, durationUnit);
    const data = await apiCall('POST', '/api/admin/vouchers/groups', {
      name,
      quantity,
      duration_minutes: durationMinutes,
      price,
      code_length: codeLength,
      code_charset: codeCharset,
      code_case: codeCase,
      print_caption: caption,
      print_logo_url: logoUrl
    });

    if (data.success) {
      showToast(`Created ${data.codes.length} vouchers!`, 'success');
      closeModal('groupModal');
      loadVoucherGroups();
    } else {
      showToast(data.message || 'Failed to create voucher group', 'error');
    }
  } catch(e) {
    showToast('Server error', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-layer-group"></i> Create Group';
}

async function deleteVoucherGroup(id, name) {
  if (!confirm(`Delete voucher group "${name}"? This removes all its vouchers too.`)) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/vouchers/groups/${id}`);
    if (data.success) {
      showToast('Voucher group deleted', 'success');
      loadVoucherGroups();
    } else {
      showToast(data.message || 'Failed to delete', 'error');
    }
  } catch(e) {
    showToast('Server error', 'error');
  }
}

// Popup card listing every code in a group with its live status - lets an
// admin actually track a batch (who's used it, who hasn't) instead of only
// ever seeing aggregate counts on the groups table.
async function viewVoucherGroup(id) {
  try {
    const data = await apiCall('GET', `/api/admin/vouchers/groups/${id}`);
    if (!data.success) {
      showToast(data.message || 'Failed to load group', 'error');
      return;
    }
    const { group, vouchers } = data;

    document.getElementById('groupDetailsTitle').textContent = group.name;

    const unused = vouchers.filter(v => v.status === 'unused').length;
    const active = vouchers.filter(v => v.status === 'active').length;
    const used = vouchers.filter(v => v.status === 'used').length;
    document.getElementById('groupDetailsSummary').innerHTML = `
      <span class="badge badge-orange">${unused} unused</span>
      <span class="badge badge-green">${active} active</span>
      <span class="badge badge-blue">${used} used</span>
      <span class="badge badge-blue" style="margin-left:auto;">${formatDuration(group.duration_minutes)} &bull; ₱${group.price}</span>
    `;

    document.getElementById('groupDetailsTable').innerHTML = vouchers.map(v => {
      const badge = voucherStatusBadge(v.status);
      return `
        <tr>
          <td style="font-family:monospace;font-weight:700;color:var(--accent-red);letter-spacing:1px;">${v.code}</td>
          <td><span class="badge ${badge.cls}">${badge.label}</span></td>
          <td style="font-family:monospace;font-size:12px;color:var(--text-muted);">${v.mac_address || '--'}</td>
        </tr>`;
    }).join('');

    document.getElementById('groupDetailsModal').classList.add('show');
  } catch (e) {
    showToast('Server error', 'error');
  }
}

async function printVoucherGroup(id) {
  try {
    const data = await apiCall('GET', `/api/admin/vouchers/groups/${id}`);
    if (!data.success) {
      showToast(data.message || 'Failed to load group for printing', 'error');
      return;
    }
    const { group, vouchers } = data;
    const durationLabel = formatDuration(group.duration_minutes);

    const cardsHtml = vouchers.map(v => `
      <div class="voucher-card">
        ${group.print_logo_url ? `<img src="${group.print_logo_url}" class="voucher-logo">` : ''}
        <div class="voucher-code">${v.code}</div>
        <div class="voucher-details">${durationLabel} &bull; ₱${group.price}</div>
        ${group.print_caption ? `<div class="voucher-caption">${group.print_caption}</div>` : ''}
      </div>
    `).join('');

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      showToast('Please allow pop-ups to print vouchers', 'error');
      return;
    }
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>${group.name} - Voucher Print</title>
        <style>
          @page { size: A4; margin: 10mm; }
          body { font-family: Arial, sans-serif; margin: 0; }
          .voucher-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 6mm;
          }
          .voucher-card {
            border: 2px dashed #999;
            border-radius: 8px;
            padding: 12px 8px;
            text-align: center;
            page-break-inside: avoid;
          }
          .voucher-logo { max-width: 60px; max-height: 60px; margin-bottom: 6px; object-fit: contain; }
          .voucher-code {
            font-family: 'Courier New', monospace;
            font-size: 20px;
            font-weight: 900;
            letter-spacing: 2px;
            margin: 6px 0;
          }
          .voucher-details { font-size: 11px; color: #555; }
          .voucher-caption { font-size: 10px; color: #888; margin-top: 6px; }
        </style>
      </head>
      <body>
        <div class="voucher-grid">${cardsHtml}</div>
        <script>window.onload = () => window.print();<\/script>
      </body>
      </html>
    `);
    printWindow.document.close();
  } catch(e) {
    showToast('Failed to prepare print view', 'error');
  }
}

