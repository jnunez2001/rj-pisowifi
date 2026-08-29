// ===== PC RENTAL PAGE =====
// Rental PCs (windows-rental-client polls server/routes/rental.js for
// lock state) and their pricing. See server/routes/admin.js's /rental/*
// routes and server/routes/coin.js's 'pc_rental' pending-coin mode.
let rentalPollInterval = null;
let rentalCoinPollInterval = null;
let rentalCoinTargetMac = null;

async function loadRentalPage() {
  await refreshRentalPcs();
  await refreshRentalRates();
  clearInterval(rentalPollInterval);
  rentalPollInterval = setInterval(refreshRentalPcs, 5000);
}

async function refreshRentalPcs() {
  const el = document.getElementById('rentalPcsList');
  if (!el) { clearInterval(rentalPollInterval); return; }
  try {
    const data = await apiCall('GET', '/api/admin/rental/pcs');
    if (!data.success || !data.pcs || data.pcs.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No rental PCs yet - run the Windows client on a PC to have it appear here.</div>';
      return;
    }
    el.innerHTML = data.pcs.map(renderRentalPcRow).join('');
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">Could not load rental PCs</div>';
  }
}

function renderRentalPcRow(pc) {
  const dotClass = pc.status !== 'adopted' ? 'candidate' : (pc.locked ? 'locked' : 'unlocked');
  const statusLabel = pc.status !== 'adopted' ? 'Not adopted' : (pc.locked ? 'Locked' : `Unlocked - ${pc.minutes_remaining} min left`);

  let actions = '';
  if (pc.status !== 'adopted') {
    actions += `<button class="btn btn-secondary" onclick="adoptRentalPc(${pc.id})"><i class="fas fa-check"></i> Adopt</button>`;
  } else {
    actions += `<button class="btn btn-secondary" onclick="openRentalAddTime(${pc.id},'${escapeHtmlRental(pc.name)}')"><i class="fas fa-clock"></i> Add Time</button>`;
    actions += `<button class="btn btn-secondary" onclick="openRentalCoin(${pc.id},'${escapeHtmlRental(pc.mac_address)}','${escapeHtmlRental(pc.name)}')"><i class="fas fa-coins"></i> Insert Coin</button>`;
    if (pc.is_paused) {
      actions += `<button class="btn btn-secondary" onclick="unlockRentalPc(${pc.id})"><i class="fas fa-unlock"></i> Unlock</button>`;
    } else {
      actions += `<button class="btn btn-secondary" onclick="lockRentalPc(${pc.id})"><i class="fas fa-lock"></i> Lock</button>`;
    }
  }
  actions += `<button class="btn btn-secondary" onclick="deleteRentalPc(${pc.id})"><i class="fas fa-trash"></i></button>`;

  return `
    <div class="rental-pc-row">
      <div class="rental-pc-dot ${dotClass}"></div>
      <div class="rental-pc-info">
        <div class="rental-pc-name">${escapeHtmlRental(pc.name)}</div>
        <div class="rental-pc-meta">${escapeHtmlRental(pc.mac_address)} &middot; ${statusLabel}</div>
      </div>
      <div class="rental-pc-actions">${actions}</div>
    </div>
  `;
}

async function adoptRentalPc(id) {
  await apiCall('POST', `/api/admin/rental/pcs/${id}/adopt`);
  refreshRentalPcs();
}

async function lockRentalPc(id) {
  await apiCall('POST', `/api/admin/rental/pcs/${id}/lock`);
  refreshRentalPcs();
}

async function unlockRentalPc(id) {
  await apiCall('POST', `/api/admin/rental/pcs/${id}/unlock`);
  refreshRentalPcs();
}

async function deleteRentalPc(id) {
  if (!confirm('Remove this rental PC? It can re-register on its next check-in as a new candidate.')) return;
  await apiCall('DELETE', `/api/admin/rental/pcs/${id}`);
  refreshRentalPcs();
}

async function openRentalAddTime(id, name) {
  const minutes = prompt(`Add how many minutes to "${name}"? (negative to remove)`);
  if (!minutes) return;
  const m = parseFloat(minutes);
  if (!Number.isFinite(m) || m === 0) return;
  const data = await apiCall('POST', `/api/admin/rental/pcs/${id}/addtime`, { minutes: m });
  if (!data.success) alert(data.message || 'Could not add time');
  refreshRentalPcs();
}

// ===== INSERT COIN (shared box) =====
async function openRentalCoin(id, mac, name) {
  rentalCoinTargetMac = mac;
  document.getElementById('rentalCoinTitle').textContent = `Insert coins - ${name}`;
  document.getElementById('rentalCoinTotal').textContent = '0';
  document.getElementById('rentalCoinModal').classList.add('show');

  const data = await apiCall('POST', '/api/coin/pending', { mac, mode: 'pc_rental' });
  if (!data.success) {
    alert(data.message || 'Could not start coin insertion');
    cancelRentalCoin();
    return;
  }

  clearInterval(rentalCoinPollInterval);
  rentalCoinPollInterval = setInterval(async () => {
    try {
      const res = await apiCall('GET', `/api/coin/pending/${encodeURIComponent(mac)}`);
      document.getElementById('rentalCoinTotal').textContent = res.total || 0;
      if (!res.pending) {
        clearInterval(rentalCoinPollInterval);
        document.getElementById('rentalCoinModal').classList.remove('show');
        refreshRentalPcs();
      }
    } catch (e) {}
  }, 2000);
}

async function finishRentalCoin() {
  clearInterval(rentalCoinPollInterval);
  const data = await apiCall('POST', '/api/coin/finalize', { mac: rentalCoinTargetMac });
  document.getElementById('rentalCoinModal').classList.remove('show');
  if (!data.success) {
    alert(data.message || `Not enough was inserted (needed ₱${data.needed || ''}).`);
  }
  refreshRentalPcs();
}

function cancelRentalCoin() {
  clearInterval(rentalCoinPollInterval);
  document.getElementById('rentalCoinModal').classList.remove('show');
}

// ===== RATES =====
async function refreshRentalRates() {
  const el = document.getElementById('rentalRatesList');
  if (!el) return;
  const data = await apiCall('GET', '/api/admin/rental/rates');
  const rates = data.rates || [];
  el.innerHTML = rates.length
    ? rates.map((r) => `
        <div class="rental-rate-row">
          <span>₱${r.coin_value} = ${r.minutes} min</span>
          <button class="btn btn-secondary" onclick="deleteRentalRate(${r.id})"><i class="fas fa-trash"></i></button>
        </div>
      `).join('')
    : '<div style="color:var(--text-muted);font-size:13px;">No rates yet</div>';
}

async function addRentalRate() {
  const coinValue = document.getElementById('rentalRateCoin').value;
  const minutes = document.getElementById('rentalRateMinutes').value;
  const data = await apiCall('POST', '/api/admin/rental/rates', { coin_value: coinValue, minutes });
  if (!data.success) {
    alert(data.message || 'Could not add rate');
    return;
  }
  document.getElementById('rentalRateCoin').value = '';
  document.getElementById('rentalRateMinutes').value = '';
  refreshRentalRates();
}

async function deleteRentalRate(id) {
  await apiCall('DELETE', `/api/admin/rental/rates/${id}`);
  refreshRentalRates();
}

function destroyRental() {
  clearInterval(rentalPollInterval);
  clearInterval(rentalCoinPollInterval);
}

function escapeHtmlRental(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
