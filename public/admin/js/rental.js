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
  const statusLabel = pc.status !== 'adopted' ? 'Not adopted' : (pc.locked ? 'Locked' : 'Unlocked');

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
    <div class="rental-pc-card">
      <div class="rental-pc-card-head">
        <div class="rental-pc-dot ${dotClass}"></div>
        <div class="rental-pc-name">${escapeHtmlRental(pc.name)}</div>
      </div>
      <div class="rental-pc-card-body">
        <div class="rental-pc-stat"><span>Status</span><b>${statusLabel}</b></div>
        <div class="rental-pc-stat"><span>Remaining</span><b>${formatRentalMinutes(pc.minutes_remaining)}</b></div>
        <div class="rental-pc-stat"><span>Today's Sales</span><b>₱${pc.today_sales || 0}</b></div>
        <div class="rental-pc-stat"><span>User</span><b>${escapeHtmlRental(pc.logged_in_user || 'GUEST')}</b></div>
        <div class="rental-pc-stat"><span>IP</span><b>${escapeHtmlRental(pc.ip_address || '--')}</b></div>
        <div class="rental-pc-stat"><span>MAC</span><b>${escapeHtmlRental(pc.mac_address)}</b></div>
      </div>
      <div class="rental-pc-actions">${actions}</div>
    </div>
  `;
}

function formatRentalMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes * 60));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
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
          <span>₱${r.coin_value} = ${formatRentalMinutes(r.minutes)} &middot; ${r.points} pts</span>
          <button class="btn btn-secondary" onclick="deleteRentalRate(${r.id})"><i class="fas fa-trash"></i></button>
        </div>
      `).join('')
    : '<div style="color:var(--text-muted);font-size:13px;">No rates yet</div>';
}

async function addRentalRate() {
  const coinValue = document.getElementById('rentalRateCoin').value;
  const minutes = document.getElementById('rentalRateMinutes').value;
  const points = document.getElementById('rentalRatePoints').value || 0;
  const data = await apiCall('POST', '/api/admin/rental/rates', { coin_value: coinValue, minutes, points });
  if (!data.success) {
    alert(data.message || 'Could not add rate');
    return;
  }
  document.getElementById('rentalRateCoin').value = '';
  document.getElementById('rentalRateMinutes').value = '';
  document.getElementById('rentalRatePoints').value = '';
  refreshRentalRates();
}

async function deleteRentalRate(id) {
  await apiCall('DELETE', `/api/admin/rental/rates/${id}`);
  refreshRentalRates();
}

// ===== MEMBERS =====
async function refreshRentalMembers() {
  const el = document.getElementById('rentalMembersList');
  if (!el) return;
  const data = await apiCall('GET', '/api/admin/rental/members');
  const members = data.members || [];
  el.innerHTML = members.length
    ? members.map((m) => `
        <div class="rental-pc-row">
          <div class="rental-pc-info">
            <div class="rental-pc-name">${escapeHtmlRental(m.name || m.username)} <span style="color:var(--text-muted);font-weight:400;">(@${escapeHtmlRental(m.username)})</span></div>
            <div class="rental-pc-meta">
              ${formatRentalMinutes(m.seconds / 60)} remaining &middot; ₱${m.credit_pesos} credit &middot; ${m.points} pts
            </div>
          </div>
          <div class="rental-pc-actions">
            <button class="btn btn-secondary" onclick="openRentalManageTime(${m.id},'${escapeHtmlRental(m.name || m.username)}')"><i class="fas fa-clock"></i> Manage Time</button>
            <button class="btn btn-secondary" onclick="openRentalRedeemModal(${m.id},'${escapeHtmlRental(m.name || m.username)}')"><i class="fas fa-star"></i> Redeem</button>
            <button class="btn btn-secondary" onclick="deleteRentalMember(${m.id})"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      `).join('')
    : '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No members yet</div>';
}

async function addRentalMember() {
  const username = document.getElementById('rentalMemberUsername').value.trim();
  const name = document.getElementById('rentalMemberName').value.trim();
  const password = document.getElementById('rentalMemberPassword').value;
  const data = await apiCall('POST', '/api/admin/rental/members', { username, name, password });
  if (!data.success) {
    alert(data.message || 'Could not add member');
    return;
  }
  document.getElementById('rentalMemberUsername').value = '';
  document.getElementById('rentalMemberName').value = '';
  document.getElementById('rentalMemberPassword').value = '';
  refreshRentalMembers();
}

async function deleteRentalMember(id) {
  if (!confirm('Remove this member and all their time/points?')) return;
  await apiCall('DELETE', `/api/admin/rental/members/${id}`);
  refreshRentalMembers();
}

async function openRentalManageTime(id, name) {
  const field = prompt(`Adjust which field for "${name}"? (seconds / credit_pesos / points)`, 'seconds');
  if (!field) return;
  const deltaInput = prompt('Amount to add (negative to remove). For time fields, enter seconds.');
  if (!deltaInput) return;
  const delta = parseInt(deltaInput, 10);
  if (!Number.isFinite(delta)) return;
  const data = await apiCall('POST', `/api/admin/rental/members/${id}/manage-time`, { field, delta });
  if (!data.success) alert(data.message || 'Could not update member');
  refreshRentalMembers();
}

// ===== REDEEM RATES + REDEEM (points economy) =====
let rentalRedeemRatesCache = [];

async function refreshRentalRedeemRates() {
  const el = document.getElementById('rentalRedeemRatesList');
  if (!el) return;
  const data = await apiCall('GET', '/api/admin/rental/redeem-rates');
  rentalRedeemRatesCache = data.rates || [];
  el.innerHTML = rentalRedeemRatesCache.length
    ? rentalRedeemRatesCache.map((r) => `
        <div class="rental-rate-row" style="padding:10px 18px;">
          <span>${r.points} pts = ${formatRentalMinutes(r.reward_seconds / 60)}</span>
          <button class="btn btn-secondary" onclick="deleteRentalRedeemRate(${r.id})"><i class="fas fa-trash"></i></button>
        </div>
      `).join('')
    : '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No redeem rates yet</div>';
}

async function addRentalRedeemRate() {
  const points = document.getElementById('rentalRedeemPoints').value;
  const minutes = document.getElementById('rentalRedeemMinutes').value;
  const rewardSeconds = Math.round(parseFloat(minutes) * 60);
  const data = await apiCall('POST', '/api/admin/rental/redeem-rates', { points, reward_seconds: rewardSeconds });
  if (!data.success) {
    alert(data.message || 'Could not add redeem rate');
    return;
  }
  document.getElementById('rentalRedeemPoints').value = '';
  document.getElementById('rentalRedeemMinutes').value = '';
  refreshRentalRedeemRates();
}

async function deleteRentalRedeemRate(id) {
  await apiCall('DELETE', `/api/admin/rental/redeem-rates/${id}`);
  refreshRentalRedeemRates();
}

let rentalRedeemTargetMemberId = null;

function openRentalRedeemModal(memberId, name) {
  rentalRedeemTargetMemberId = memberId;
  document.getElementById('rentalRedeemMemberTitle').textContent = `Redeem points - ${name}`;
  const select = document.getElementById('rentalRedeemRateSelect');
  select.innerHTML = rentalRedeemRatesCache.length
    ? rentalRedeemRatesCache.map((r) => `<option value="${r.id}">${r.points} pts = ${formatRentalMinutes(r.reward_seconds / 60)}</option>`).join('')
    : '<option value="">No redeem rates configured</option>';
  document.getElementById('rentalRedeemModal').classList.add('show');
}

function closeRentalRedeemModal() {
  document.getElementById('rentalRedeemModal').classList.remove('show');
}

async function confirmRentalRedeem() {
  const redeemRateId = document.getElementById('rentalRedeemRateSelect').value;
  if (!redeemRateId) return;
  const data = await apiCall('POST', `/api/admin/rental/members/${rentalRedeemTargetMemberId}/redeem`, { redeem_rate_id: redeemRateId });
  closeRentalRedeemModal();
  if (!data.success) alert(data.message || 'Could not redeem');
  refreshRentalMembers();
  refreshRentalRedemptions();
}

// ===== REDEEM HISTORY =====
async function refreshRentalRedemptions() {
  const el = document.getElementById('rentalRedemptionsList');
  if (!el) return;
  const data = await apiCall('GET', '/api/admin/rental/redemptions');
  const rows = data.redemptions || [];
  el.innerHTML = rows.length
    ? rows.map((r) => `
        <div class="rental-pc-row">
          <div class="rental-pc-info">
            <div class="rental-pc-name">${escapeHtmlRental(r.username)}</div>
            <div class="rental-pc-meta">${r.points_spent} pts &rarr; ${formatRentalMinutes(r.reward_seconds / 60)} &middot; ${r.remaining_points} pts remaining &middot; ${new Date(r.redeemed_at).toLocaleString()}</div>
          </div>
        </div>
      `).join('')
    : '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No redemptions yet</div>';
}

// ===== REPORTS =====
async function refreshRentalReports() {
  const el = document.getElementById('rentalReportsStats');
  if (!el) return;
  const data = await apiCall('GET', '/api/admin/rental/reports/summary');
  if (!data.success) return;
  const stats = [
    ['Today\'s Sales', data.today], ['Weekly Sales', data.weekly],
    ['Monthly Sales', data.monthly], ['Yearly Sales', data.yearly]
  ];
  el.innerHTML = stats.map(([label, value]) => `
    <div class="rental-stat-card">
      <div class="rental-stat-label">${label}</div>
      <div class="rental-stat-value">₱${value}</div>
    </div>
  `).join('');
}

// ===== SETTINGS =====
const RENTAL_SETTINGS_FIELDS = [
  'rental_shutdown_timer_secs', 'rental_insert_timer_secs', 'rental_max_attempt',
  'rental_max_attempt_lockout_secs', 'rental_create_account_min_credit',
  'rental_insert_beep_alert_on_secs', 'rental_speed_timer_secs', 'rental_minimum_transfer_time_minutes',
  'rental_enable_member_login', 'rental_enable_create_account', 'rental_enable_voucher',
  'rental_enable_transfer_time', 'rental_enable_auto_reset_guest_time_on_shutdown',
  'rental_enable_auto_close_apps', 'rental_enable_watch_tv', 'rental_enable_camera_recording',
  'rental_enable_spectate', 'rental_enable_pc_performance',
  'rental_antiabuse_enabled', 'rental_antiabuse_min_consume_minutes', 'rental_antiabuse_max_attempt',
  'rental_antiabuse_lock_minutes', 'rental_antiabuse_penalty_minutes',
  'rental_lock_announcement', 'rental_close_announcement',
  'rental_schedule_enabled', 'rental_schedule_open_time', 'rental_schedule_before_close_time',
  'rental_schedule_closed_time'
];

async function loadRentalSettings() {
  const data = await apiCall('GET', '/api/admin/settings');
  if (!data.success) return;
  RENTAL_SETTINGS_FIELDS.forEach((key) => {
    const el = document.getElementById(`rs_${key}`);
    if (el && data.settings[key] !== undefined) el.value = data.settings[key];
  });
  refreshRentalWhitelistApps();
  refreshRentalWallpapers();
  refreshRentalLogoPreview(data.settings.rental_logo_url);
}

async function saveRentalSettingsGroup(keys) {
  const updates = {};
  keys.forEach((key) => {
    const el = document.getElementById(`rs_${key}`);
    if (el) updates[key] = el.value;
  });
  const data = await apiCall('POST', '/api/admin/settings', updates);
  if (data.success) alert('Saved'); else alert(data.message || 'Could not save');
}

async function refreshRentalWhitelistApps() {
  const el = document.getElementById('rentalWhitelistAppsList');
  if (!el) return;
  const data = await apiCall('GET', '/api/admin/rental/whitelisted-apps');
  const apps = data.apps || [];
  el.innerHTML = apps.length
    ? apps.map((a) => `
        <div class="rental-rate-row">
          <span>${escapeHtmlRental(a.app_name)}</span>
          <button class="btn btn-secondary" onclick="deleteRentalWhitelistApp(${a.id})"><i class="fas fa-trash"></i></button>
        </div>
      `).join('')
    : '<div style="color:var(--text-muted);font-size:13px;">No whitelisted apps yet</div>';
}

async function addRentalWhitelistApp() {
  const input = document.getElementById('rentalWhitelistAppInput');
  const appName = input.value.trim();
  if (!appName) return;
  await apiCall('POST', '/api/admin/rental/whitelisted-apps', { app_name: appName });
  input.value = '';
  refreshRentalWhitelistApps();
}

async function deleteRentalWhitelistApp(id) {
  await apiCall('DELETE', `/api/admin/rental/whitelisted-apps/${id}`);
  refreshRentalWhitelistApps();
}

function refreshRentalLogoPreview(url) {
  const el = document.getElementById('rentalLogoPreview');
  if (!el) return;
  el.innerHTML = url ? `<img src="${url}" style="max-height:70px;">` : '<span style="color:var(--text-muted);font-size:12px;">No logo uploaded</span>';
}

async function uploadRentalLogo() {
  const file = document.getElementById('rentalLogoFile').files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetch('/api/admin/upload/rental_logo', { method: 'POST', headers: { password: authToken }, body: formData });
  const data = await res.json();
  if (data.success) refreshRentalLogoPreview(data.url);
  else alert(data.message || 'Upload failed');
}

async function refreshRentalWallpapers() {
  const el = document.getElementById('rentalWallpapersList');
  if (!el) return;
  const data = await apiCall('GET', '/api/admin/rental/wallpapers');
  const wallpapers = data.wallpapers || [];
  el.innerHTML = wallpapers.length
    ? wallpapers.map((w) => `
        <div class="rental-wallpaper-thumb">
          <img src="${w.image_path}">
          <button class="btn ${w.active ? 'btn-primary' : 'btn-secondary'}" onclick="activateRentalWallpaper(${w.id})">${w.active ? 'Active' : 'Set Active'}</button>
          <button class="btn btn-secondary" onclick="deleteRentalWallpaper(${w.id})"><i class="fas fa-trash"></i></button>
        </div>
      `).join('')
    : '<div style="color:var(--text-muted);font-size:13px;">No wallpapers yet</div>';
}

async function uploadRentalWallpaper() {
  const file = document.getElementById('rentalWallpaperFile').files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetch('/api/admin/upload/rental_wallpaper', { method: 'POST', headers: { password: authToken }, body: formData });
  const data = await res.json();
  if (data.success) refreshRentalWallpapers();
  else alert(data.message || 'Upload failed');
}

async function activateRentalWallpaper(id) {
  await apiCall('POST', `/api/admin/rental/wallpapers/${id}/activate`);
  refreshRentalWallpapers();
}

async function deleteRentalWallpaper(id) {
  await apiCall('DELETE', `/api/admin/rental/wallpapers/${id}`);
  refreshRentalWallpapers();
}

async function saveRentalAppPassword() {
  const current_password = document.getElementById('rentalAppPasswordCurrent').value;
  const new_password = document.getElementById('rentalAppPasswordNew').value;
  const data = await apiCall('POST', '/api/admin/rental/app-password', { current_password, new_password });
  if (data.success) {
    alert('App password updated');
    document.getElementById('rentalAppPasswordCurrent').value = '';
    document.getElementById('rentalAppPasswordNew').value = '';
  } else {
    alert(data.message || 'Could not update app password');
  }
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
