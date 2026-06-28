const SERVER = '';
let currentSession = null;
let timerInterval = null;
let pollInterval = null;
let soundEnabled = true;
let blockCountdown = null;
let isBlocked = false;
let detectedMac = '';

// ===== PORTAL SETTINGS =====
let portalSettings = {
  welcome_message: 'Welcome! Insert a coin to get started.',
  disconnect_message: 'Your session has ended. Thank you!',
  show_voucher: '0',
  redirect_url: '',
  allow_pause: '1',
  max_pause_minutes: '30',
  grace_period_minutes: '0'
};

// ===== COIN MODAL TIMER =====
let coinTimerInterval = null;
let coinTimeLeft = 30;
const COIN_TIMER_DURATION = 30;
const CIRCUMFERENCE = 314;

function startCoinTimer() {
  coinTimeLeft = COIN_TIMER_DURATION;
  updateCoinTimerUI();
  if (coinTimerInterval) clearInterval(coinTimerInterval);
  coinTimerInterval = setInterval(() => {
    coinTimeLeft--;
    updateCoinTimerUI();
    if (coinTimeLeft <= 0) {
      clearInterval(coinTimerInterval);
      closeCoinModal();
    }
  }, 1000);
}

function resetCoinTimer() {
  coinTimeLeft = COIN_TIMER_DURATION;
  updateCoinTimerUI();
}

function stopCoinTimer() {
  if (coinTimerInterval) {
    clearInterval(coinTimerInterval);
    coinTimerInterval = null;
  }
}

function updateCoinTimerUI() {
  const numEl = document.getElementById('coinTimerNum');
  const arc = document.getElementById('timerArc');
  if (!numEl || !arc) return;
  numEl.textContent = coinTimeLeft;
  const progress = coinTimeLeft / COIN_TIMER_DURATION;
  const offset = CIRCUMFERENCE * (1 - progress);
  arc.style.strokeDashoffset = offset;
  arc.className = 'timer-arc';
  if (coinTimeLeft <= 5) arc.classList.add('danger');
  else if (coinTimeLeft <= 10) arc.classList.add('warning');
}

// ===== SOUNDS =====
const sounds = {
  insert: document.getElementById('soundInsert'),
  success: document.getElementById('soundSuccess'),
  coin: document.getElementById('soundCoin')
};

function playSound(type) {
  if (!soundEnabled) return;
  try {
    const s = sounds[type];
    if (s) { s.currentTime = 0; s.play().catch(() => {}); }
  } catch(e) {}
}

function stopSound(type) {
  try {
    const s = sounds[type];
    if (s) { s.pause(); s.currentTime = 0; }
  } catch(e) {}
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  const btn = document.getElementById('soundBtn');
  btn.innerHTML = soundEnabled
    ? '<i class="fas fa-volume-up"></i>'
    : '<i class="fas fa-volume-mute"></i>';
  btn.style.color = soundEnabled ? '#888' : '#e94560';
  if (!soundEnabled) stopSound('insert');
}

// ===== MAC DETECTION =====
async function detectDevice() {
  // First check URL params (legacy/nodogsplash support)
  const params = new URLSearchParams(window.location.search);
  const urlMac = params.get('mac');
  if (urlMac) {
    detectedMac = urlMac;
    return urlMac;
  }

  // Auto-detect MAC from server using client IP
  try {
    const res = await fetch('/api/portal/detect');
    const data = await res.json();
    if (data.success && data.mac) {
      detectedMac = data.mac;
      return data.mac;
    }
  } catch(e) {
    console.error('MAC detection failed:', e);
  }

  return null;
}

// ===== HELPERS =====
function getMac() {
  const params = new URLSearchParams(window.location.search);
  return params.get('mac') || detectedMac || '';
}

function formatTime(minutes) {
  const total = Math.max(0, Math.floor(minutes * 60));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function formatSeconds(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function formatExpiry(dateStr) {
  if (!dateStr) return '--';
  return new Date(dateStr).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit'
  });
}

function formatMinutes(mins) {
  if (mins >= 43200) return `${Math.round(mins/43200)} days`;
  if (mins >= 1440) return `${Math.round(mins/1440)} days`;
  if (mins >= 60) return `${Math.round(mins/60)} hrs`;
  return `${mins} mins`;
}

// ===== SPAM BLOCK =====
function showBlockUI(seconds) {
  isBlocked = true;
  const spamBlock = document.getElementById('spamBlock');
  const insertBtn = document.getElementById('insertBtn');
  spamBlock.style.display = 'block';
  if (insertBtn) insertBtn.disabled = true;

  if (blockCountdown) clearInterval(blockCountdown);
  let remaining = seconds;
  document.getElementById('blockTimer').textContent = formatSeconds(remaining);

  blockCountdown = setInterval(() => {
    remaining--;
    document.getElementById('blockTimer').textContent = formatSeconds(remaining);
    if (remaining <= 0) {
      clearInterval(blockCountdown);
      isBlocked = false;
      spamBlock.style.display = 'none';
      if (insertBtn) insertBtn.disabled = false;
    }
  }, 1000);
}

// ===== COIN MODAL =====
async function activateVendoRelay() {
  const ip = portalSettings.vendo_ip;
  if (!ip) return;
  try {
    await fetch(`http://${ip}/relay/on`, { method: 'POST' });
    console.log('Relay activated');
  } catch(e) {
    console.log('Relay call failed — ESP32 may be offline');
  }
}

async function deactivateVendoRelay() {
  const ip = portalSettings.vendo_ip;
  if (!ip) return;
  try {
    await fetch(`http://${ip}/relay/off`, { method: 'POST' });
    console.log('Relay deactivated');
  } catch(e) {}
}

function handleInsertCoin() {
  if (isBlocked) return;
  playSound('insert');
  document.getElementById('coinModal').classList.add('show');
  startCoinTimer();
  activateVendoRelay();
}

function closeCoinModal() {
  stopSound('insert');
  stopCoinTimer();
  document.getElementById('coinModal').classList.remove('show');
}

// ===== APPLY PORTAL SETTINGS TO UI =====
function applyPortalSettings() {
  const voucherBox = document.getElementById('voucherBox');
  if (currentSession && currentSession.active) {
    voucherBox.style.display = portalSettings.show_voucher === '1' ? 'block' : 'none';
  }
  const pauseBtn = document.getElementById('pauseBtn');
  if (pauseBtn) {
    pauseBtn.style.display = portalSettings.allow_pause === '1' ? 'block' : 'none';
  }
}

// ===== UI UPDATE =====
function updateUI(session) {
  const prev = currentSession;
  currentSession = session;

  const badge = document.getElementById('statusBadge');
  const timeDisplay = document.getElementById('timeDisplay');
  const voucherBox = document.getElementById('voucherBox');
  const voucherCode = document.getElementById('voucherCode');
  const expiryDisplay = document.getElementById('expiryDisplay');
  const sessionDisplay = document.getElementById('sessionDisplay');
  const expiryWarning = document.getElementById('expiryWarning');
  const welcomeMsg = document.getElementById('welcomeMsg');

  if (timerInterval) clearInterval(timerInterval);

  if (!session || !session.active) {
    badge.className = 'status-badge disconnected';
    badge.innerHTML = '<i class="fas fa-times-circle"></i><span>DISCONNECTED</span>';
    timeDisplay.className = 'time empty';
    timeDisplay.textContent = '--:--:--';
    voucherBox.style.display = 'none';
    expiryDisplay.textContent = '--';
    sessionDisplay.textContent = '--';
    document.getElementById('creditsDisplay').textContent = '₱0';
    expiryWarning.style.display = 'none';
    document.getElementById('sectionDisconnected').style.display = 'block';
    document.getElementById('sectionConnected').style.display = 'none';
    document.getElementById('sectionPaused').style.display = 'none';

    if (welcomeMsg) {
      if (prev && prev.active) {
        welcomeMsg.textContent = portalSettings.disconnect_message;
        welcomeMsg.style.color = '#e94560';
      } else {
        welcomeMsg.textContent = portalSettings.welcome_message;
        welcomeMsg.style.color = '#888';
      }
      welcomeMsg.style.display = 'block';
    }

  } else if (session.is_paused) {
    badge.className = 'status-badge paused';
    badge.innerHTML = '<i class="fas fa-pause-circle"></i><span>PAUSED</span>';
    timeDisplay.className = 'time paused';
    timeDisplay.textContent = formatTime(session.minutes_remaining);
    voucherBox.style.display = portalSettings.show_voucher === '1' ? 'block' : 'none';
    voucherCode.textContent = session.voucher_code;
    expiryDisplay.textContent = formatExpiry(session.hard_expires_at);
    sessionDisplay.textContent = session.voucher_code.replace('RJ-','');
    if (welcomeMsg) welcomeMsg.style.display = 'none';
    document.getElementById('sectionDisconnected').style.display = 'none';
    document.getElementById('sectionConnected').style.display = 'none';
    document.getElementById('sectionPaused').style.display = 'block';

  } else {
    if (!prev || !prev.active) {
      playSound('success');
      if (document.getElementById('coinModal').classList.contains('show')) {
        closeCoinModal();
      }
      deactivateVendoRelay();
      if (portalSettings.redirect_url) {
        setTimeout(() => {
          window.location.href = portalSettings.redirect_url;
        }, 2000);
      }
    } else if (prev.voucher_code === session.voucher_code &&
               session.minutes_remaining > prev.minutes_remaining) {
      playSound('coin');
      if (document.getElementById('coinModal').classList.contains('show')) {
        resetCoinTimer();
      }
    }

    badge.className = 'status-badge connected';
    badge.innerHTML = '<i class="fas fa-check-circle"></i><span>CONNECTED</span>';
    timeDisplay.className = 'time';
    voucherBox.style.display = portalSettings.show_voucher === '1' ? 'block' : 'none';
    voucherCode.textContent = session.voucher_code;
    expiryDisplay.textContent = formatExpiry(session.hard_expires_at);
    sessionDisplay.textContent = session.voucher_code.replace('RJ-','');
    if (welcomeMsg) welcomeMsg.style.display = 'none';

    const pauseBtn = document.getElementById('pauseBtn');
    if (pauseBtn) {
      pauseBtn.style.display = portalSettings.allow_pause === '1' ? 'block' : 'none';
    }

    document.getElementById('sectionDisconnected').style.display = 'none';
    document.getElementById('sectionConnected').style.display = 'block';
    document.getElementById('sectionPaused').style.display = 'none';

    let remaining = session.minutes_remaining;
    timeDisplay.textContent = formatTime(remaining);

    timerInterval = setInterval(() => {
      remaining -= 1/60;
      if (remaining <= 0) {
        clearInterval(timerInterval);
        timeDisplay.textContent = '00:00:00';
        setTimeout(checkSession, 2000);
      } else {
        timeDisplay.textContent = formatTime(remaining);
        expiryWarning.style.display = remaining < 5 ? 'block' : 'none';
      }
    }, 1000);
  }
}

// ===== SESSION CHECK =====
async function checkSession() {
  const mac = getMac();
  if (!mac) { updateUI(null); return; }
  try {
    const res = await fetch(`${SERVER}/api/session/mac/${encodeURIComponent(mac)}`);
    const data = await res.json();
    updateUI(data.active ? data : null);

    if (!isBlocked) {
      const spamRes = await fetch(`${SERVER}/api/coin/status/${encodeURIComponent(mac)}`);
      const spamData = await spamRes.json();
      if (spamData.blocked && spamData.remaining > 0) {
        showBlockUI(spamData.remaining);
      }
    }
  } catch(e) { console.error(e); }
}

// ===== LOAD SETTINGS =====
async function loadSettings() {
  try {
    const res = await fetch(`${SERVER}/api/portal/rates`);
    const data = await res.json();
    if (!data.success) return;

    portalSettings.welcome_message = data.welcome_message || portalSettings.welcome_message;
    portalSettings.disconnect_message = data.disconnect_message || portalSettings.disconnect_message;
    portalSettings.show_voucher = data.show_voucher || '0';
    portalSettings.redirect_url = data.redirect_url || '';
    portalSettings.allow_pause = data.allow_pause || '1';
    portalSettings.max_pause_minutes = data.max_pause_minutes || '30';
    portalSettings.grace_period_minutes = data.grace_period_minutes || '0';
    portalSettings.vendo_ip = data.vendo_ip || '';

    document.getElementById('cafeName').textContent = data.cafe_name.toUpperCase();
    document.title = data.cafe_name;

    if (data.banner_text) {
      document.getElementById('bannerText').textContent = data.banner_text;
    }
    if (data.logo_url) {
      const logo = document.getElementById('bannerLogo');
      logo.src = data.logo_url;
      logo.style.display = 'block';
    }
    if (data.banner_url) {
      const bg = document.getElementById('bannerBg');
      bg.src = data.banner_url;
      bg.style.display = 'block';
    }

    const welcomeMsg = document.getElementById('welcomeMsg');
    if (welcomeMsg) {
      welcomeMsg.textContent = portalSettings.welcome_message;
      welcomeMsg.style.display = 'block';
    }

    buildRatesUI(data.rates);
  } catch(e) { console.error(e); }
}

// ===== RATES UI =====
function buildRatesUI(rates) {
  let html = '';
  rates.forEach(r => {
    const expLabel = r.expiration_minutes >= 1440
      ? `${Math.round(r.expiration_minutes/1440)} day expiry`
      : r.expiration_minutes >= 60
        ? `${Math.round(r.expiration_minutes/60)}hr expiry`
        : `${r.expiration_minutes}min expiry`;

    html += `
      <div class="rate-item">
        <div class="rate-left">
          <div class="rate-icon"><i class="fas fa-coins"></i></div>
          <div>
            <div class="rate-price">₱${r.coin_value}</div>
            <div class="rate-label">${expLabel}</div>
          </div>
        </div>
        <div>
          <div class="rate-time">${formatMinutes(r.minutes)}</div>
          <div class="rate-expiry">Valid ${expLabel}</div>
        </div>
      </div>`;
  });
  document.getElementById('ratesList').innerHTML = html;
  document.getElementById('coinRatesList').innerHTML = html;
}

// ===== MODALS =====
function showRates() {
  document.getElementById('ratesModal').classList.add('show');
}

function showVoucherInput() {
  const row = document.getElementById('voucherInputRow');
  row.style.display = row.style.display === 'flex' ? 'none' : 'flex';
}

function showSessions() {
  const s = currentSession;
  const el = document.getElementById('sessionInfo');
  if (!s) {
    el.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;font-size:16px;">No active session</p>';
  } else {
    el.innerHTML = `
      <div class="session-row">
        <div class="s-label"><i class="fas fa-ticket-alt"></i> Session ID</div>
        <div class="s-value" style="color:#e94560;font-family:monospace;font-size:14px;">${s.voucher_code}</div>
      </div>
      <div class="session-row">
        <div class="s-label"><i class="far fa-clock"></i> Time Left</div>
        <div class="s-value" style="color:#00a844;">${formatTime(s.minutes_remaining)}</div>
      </div>
      <div class="session-row">
        <div class="s-label"><i class="fas fa-hourglass-end"></i> Hard Expiry</div>
        <div class="s-value" style="color:#e65100;">${formatExpiry(s.hard_expires_at)}</div>
      </div>
      <div class="session-row">
        <div class="s-label"><i class="fas fa-circle"></i> Status</div>
        <div class="s-value" style="color:#00a844;">${s.is_paused ? 'Paused' : 'Active'}</div>
      </div>
    `;
  }
  document.getElementById('sessionsModal').classList.add('show');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

// ===== SESSION ACTIONS =====
async function pauseSession() {
  if (!currentSession) return;
  try {
    const res = await fetch(`${SERVER}/api/session/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voucher_code: currentSession.voucher_code })
    });
    const data = await res.json();
    if (data.success) checkSession();
    else alert(data.message);
  } catch(e) {}
}

async function resumeSession() {
  if (!currentSession) return;
  try {
    const res = await fetch(`${SERVER}/api/session/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voucher_code: currentSession.voucher_code })
    });
    const data = await res.json();
    if (data.success) checkSession();
    else { alert('Session expired.'); checkSession(); }
  } catch(e) {}
}

async function confirmDisconnect() {
  if (!confirm('End your current session?')) return;
  if (!currentSession) return;
  try {
    const res = await fetch(`${SERVER}/api/session/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voucher_code: currentSession.voucher_code })
    });
    const data = await res.json();
    if (data.success) updateUI(null);
  } catch(e) {}
}

async function redeemVoucher() {
  // Normalize: uppercase, remove spaces and dashes for flexible input
  const raw = document.getElementById('voucherInput').value.trim().toUpperCase();
  // Accept with or without dash: PROMO9XV8OC or PROMO-9XV8OC
  const code = raw.includes('-') ? raw : raw.replace(/^(PROMO|RJ)/, '$1-');
  if (!code) { alert('Enter a voucher code'); return; }
  const mac = getMac();
  if (!mac) { alert('Cannot detect device.'); return; }
  try {
    const res = await fetch(`${SERVER}/api/promo/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, code, ip: '' })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('voucherInput').value = '';
      document.getElementById('voucherInputRow').style.display = 'none';
      playSound('success');
      checkSession();
    } else {
      alert(data.message || 'Invalid code');
    }
  } catch(e) {}
}

// ===== MODAL BACKDROP CLOSE =====
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) {
      if (overlay.id === 'coinModal') closeCoinModal();
      else overlay.classList.remove('show');
    }
  });
});

// ===== POLLING =====
function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(checkSession, 8000);
}

// ===== FREE CLAIM =====
async function checkFreeClaimEligibility() {
  const mac = getMac();
  if (!mac) return;

  const freeBtn = document.getElementById('freeClaimBtn');
  if (!freeBtn) return;

  try {
    const res = await fetch(`${SERVER}/api/session/free-claim/status/${encodeURIComponent(mac)}`);
    const data = await res.json();
    if (data.success && data.eligible) {
      freeBtn.style.display = 'block';
    } else {
      freeBtn.style.display = 'none';
    }
  } catch(e) {
    freeBtn.style.display = 'none';
  }
}

async function claimFreeMinutes() {
  const mac = getMac();
  if (!mac) { alert('Cannot detect device.'); return; }

  const freeBtn = document.getElementById('freeClaimBtn');
  if (freeBtn) {
    freeBtn.disabled = true;
    freeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>&nbsp; CLAIMING...';
  }

  try {
    const res = await fetch(`${SERVER}/api/session/free-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, ip: '' })
    });
    const data = await res.json();

    if (data.success) {
      playSound('success');
      if (freeBtn) freeBtn.style.display = 'none';
      checkSession();
    } else {
      alert(data.message || 'Could not claim free minutes.');
      if (freeBtn) {
        freeBtn.disabled = false;
        freeBtn.innerHTML = '<i class="fas fa-gift"></i>&nbsp; CLAIM FREE 5 MINS';
      }
    }
  } catch(e) {
    alert('Server error. Please try again.');
    if (freeBtn) {
      freeBtn.disabled = false;
      freeBtn.innerHTML = '<i class="fas fa-gift"></i>&nbsp; CLAIM FREE 5 MINS';
    }
  }
}

// ===== INIT =====
async function init() {
  await loadSettings();
  await detectDevice();
  await checkSession();
  await checkFreeClaimEligibility();
  startPolling();
}

init();