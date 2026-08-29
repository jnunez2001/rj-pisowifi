const SERVER = '';
let currentSession = null;
let welcomeSoundPlayed = false;
// Tracks the last transactions.created_at value already shown to the
// customer as a "you added ₱X" toast, so the SAME credited total (still
// being returned on every poll until the next coin lands) doesn't toast
// again - only a genuinely newer last_credit_at does. Starts as null on
// page load so the very first poll's existing credit (if any) is treated
// as already-seen, not re-announced.
let lastShownCreditAt = null;
let lastShownCreditInit = false;
let timerInterval = null;
let pollInterval = null;
let soundEnabled = true;
let blockCountdown = null;
let isBlocked = false;
let detectedMac = '';

// Improvement: checkSession()'s catch block used to just console.error and
// silently do nothing. A customer with a live session but a flaky/dropped
// connection to the server would see a frozen screen with zero indication
// anything was wrong, easy to mistake for their session having ended.
let consecutivePollFailures = 0;
const POLL_FAILURE_BANNER_THRESHOLD = 2;

function updateConnectionBanner(failed) {
  const banner = document.getElementById('connectionLostBanner');
  if (!banner) return;
  if (failed) {
    consecutivePollFailures++;
    if (consecutivePollFailures >= POLL_FAILURE_BANNER_THRESHOLD) {
      banner.classList.add('show');
    }
  } else {
    consecutivePollFailures = 0;
    banner.classList.remove('show');
  }
}

// Bug: the portal only ever found out about a coin credit by polling,
// every 8s normally, every 1.5s while the Insert Coin modal was open, so
// even the fast path meant waiting up to ~1.5s to reflect a coin that
// already physically landed. This opens a live push connection so the
// server can wake the portal up the instant a coin/promo/free-claim
// actually credits this MAC, instead of it waiting on the next poll tick.
// Polling stays in place as a fallback in case this connection drops.
let eventSource = null;

function connectEventStream(mac) {
  if (!mac || typeof EventSource === 'undefined') return;
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${SERVER}/api/session/events/${encodeURIComponent(mac)}`);
  eventSource.onmessage = () => {
    checkSession();
    if (document.getElementById('coinModal').classList.contains('show')) {
      pollPendingTotal();
    }
  };
  // No custom onerror handling needed, EventSource reconnects
  // automatically on its own after a drop.
}

// ===== PORTAL SETTINGS =====
let portalSettings = {
  welcome_message: 'Welcome! Insert a coin to get started.',
  disconnect_message: 'Your session has ended. Thank you!',
  show_voucher: '0',
  redirect_url: '',
  allow_pause: '1',
  max_pause_minutes: '30',
  grace_period_minutes: '0',
  payment_methods: 'both',
  portal_hostname: '',
  allow_premium_to_regular_convert: '0'
};

// ===== COIN MODAL TIMER =====
let coinTimerInterval = null;
let coinTimeLeft = 30;
const COIN_TIMER_DURATION = 30;
const CIRCUMFERENCE = 314;

// Running total (pesos) credited so far during this INSERT COIN session,
// fetched from the server rather than derived from minutes, since pesos
// aren't reliably recoverable from a minutes delta (different coin
// denominations buy minutes at different rates).
let insertedTotal = 0;
let pendingPollInterval = null;
const PENDING_POLL_MS = 1500;
let redirectAfterCoinModal = false;

// Bug found live: a phantom ₱1 (or more) could show the instant the Insert
// Coin modal opened, before any real coin landed. registerPendingCoin()'s
// POST /api/coin/pending reset (server/routes/coin.js) and this client's
// own poll/SSE-triggered reads of GET /api/coin/pending/:mac are separate
// HTTP round-trips with no guaranteed ordering. If a poll (especially the
// SSE-triggered one in connectEventStream's onmessage, which can fire the
// instant the modal shows) reached the server before the reset did, it
// could read a leftover total from a PREVIOUS pending window for the same
// MAC that hadn't timed out yet (up to 40s old). Gating every read behind
// "the reset has actually been confirmed" closes that gap.
let pendingRegistered = false;

function startCoinTimer() {
  coinTimeLeft = COIN_TIMER_DURATION;
  updateCoinTimerUI();
  if (coinTimerInterval) clearInterval(coinTimerInterval);
  coinTimerInterval = setInterval(() => {
    coinTimeLeft--;
    updateCoinTimerUI();
    if (coinTimeLeft <= 0) {
      clearInterval(coinTimerInterval);
      // Same fix as the X/Connect button below (finishInsertingCoins):
      // this used to call closeCoinModal() directly, which never
      // finalizes. Any coins already inserted then sat in the server's
      // pending window for up to PENDING_TIMEOUT_MS (40s) after the modal
      // had already vanished, a real gap the customer felt as "coins went
      // in but nothing happened for a while."
      finishInsertingCoins();
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
  numEl.textContent = `₱${insertedTotal}`;
  const progress = coinTimeLeft / COIN_TIMER_DURATION;
  const offset = CIRCUMFERENCE * (1 - progress);
  arc.style.strokeDashoffset = offset;
  arc.className = 'timer-arc';
  if (coinTimeLeft <= 5) arc.classList.add('danger');
  else if (coinTimeLeft <= 10) arc.classList.add('warning');
}

// ===== PENDING COIN TOTAL (fast-polled while modal is open) =====
// Bug: the modal's 30s countdown never reset as coins came in. Someone
// dropping coins a few seconds apart could run out of time mid-insertion.
// This polls much faster than the normal 8s session poll specifically so a
// new coin resets the countdown promptly, and shows a running peso total.
async function pollPendingTotal() {
  if (!pendingRegistered) return;
  const mac = getMac();
  if (!mac) return;
  try {
    const res = await fetch(`${SERVER}/api/coin/pending/${encodeURIComponent(mac)}`);
    const data = await res.json();
    if (data.success && data.total > insertedTotal) {
      insertedTotal = data.total;
      resetCoinTimer();
      playSound('coin');
    }
  } catch (e) {}
}

function startPendingPoll() {
  stopPendingPoll();
  pendingPollInterval = setInterval(pollPendingTotal, PENDING_POLL_MS);
}

function stopPendingPoll() {
  if (pendingPollInterval) {
    clearInterval(pendingPollInterval);
    pendingPollInterval = null;
  }
}

// ===== SOUNDS =====
const sounds = {
  insert: document.getElementById('soundInsert'),
  success: document.getElementById('soundSuccess'),
  coin: document.getElementById('soundCoin')
};

// ===== TAB TITLE ALERT =====
// Real push notifications (Web Push) need HTTPS - captive portals need
// plain HTTP so phones can auto-detect and redirect to the login page in
// the first place, so those two requirements directly conflict here. This
// gets most of the same benefit with none of that complexity: flashing the
// BROWSER TAB TITLE is visible in the tab strip/app switcher whenever the
// portal tab is still open, even backgrounded (someone switched to
// Facebook but didn't close the tab - the overwhelmingly common case),
// with no permission prompt and no HTTPS requirement.
let baseTitle = document.title;
let titleFlashInterval = null;
let lowTimeWarned = false;

function startTitleFlash(message) {
  if (titleFlashInterval) return; // already flashing something
  let showAlert = true;
  document.title = message;
  titleFlashInterval = setInterval(() => {
    document.title = showAlert ? baseTitle : message;
    showAlert = !showAlert;
  }, 1000);
}

function stopTitleFlash() {
  if (titleFlashInterval) {
    clearInterval(titleFlashInterval);
    titleFlashInterval = null;
  }
  document.title = baseTitle;
}

// ===== WEB PUSH NOTIFICATIONS (optional, needs HTTPS) =====
// Real OS-level notifications (unlike the tab-title flash above, which
// only works while the tab is still open). Service workers require a
// secure context, which directly conflicts with captive portals needing
// plain HTTP - the plain-HTTP portal can't register one at all. The
// button below only appears when the browser actually supports the
// pieces needed AND a VAPID key exists; tapping it on the plain-HTTP page
// redirects to the LAN-facing HTTPS port (setup/nginx.conf's 8443 block)
// first, where the real subscribe flow then runs.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function updateNotificationsButton() {
  const btn = document.getElementById('enableNotificationsBtn');
  if (!btn) return;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const alreadyGranted = supported && Notification.permission === 'granted';
  btn.style.display = (supported && portalSettings.vapid_public_key && !alreadyGranted) ? 'block' : 'none';
}

async function enableNotifications() {
  if (location.protocol !== 'https:') {
    // Carry the customer's session identity across the protocol switch -
    // MAC detection on the HTTPS side re-derives from IP the same way the
    // HTTP side does, so nothing extra needs to be passed here.
    const httpsUrl = `https://${location.hostname}:8443${location.pathname}`;
    alert('You may see a one-time security warning on the next page. Tap through to continue.');
    window.location.href = httpsUrl;
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast('Notifications permission denied.', 'error');
      return;
    }

    const registration = await navigator.serviceWorker.register('/portal/assets/sw.js');
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(portalSettings.vapid_public_key)
    });

    const mac = getMac();
    await fetch(`${SERVER}/api/portal/push-subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, subscription })
    });

    updateNotificationsButton();
    playSound('success');
  } catch (e) {
    console.error('Enable notifications failed:', e);
  }
}

// Escapes the OS's restricted captive-portal webview (Android's captive
// portal login activity, iOS's Captive Network Assistant) into the
// customer's real browser, so the portal URL lands in normal history/tabs
// they can return to later without hunting for a hostname or waiting on a
// push notification. window.open() reliably hands off to the real browser
// on Android in most cases; iOS's CNA is deliberately hardened against
// exactly this kind of escape and may just ignore it, no way to force it
// from here, that's a platform restriction, not something fixable in this
// app. Falls back to a plain alert with the URL if the popup is blocked,
// so the customer at least sees an address to remember, rather than
// nothing happening with no explanation.
function continueInBrowser() {
  const url = location.href;
  const win = window.open(url, '_blank');
  if (!win) {
    alert(`Open this address in your browser to return anytime:\n\n${url}`);
  }
}

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
  // First check URL params (some captive-portal redirect flows pass ?mac=)
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

function showToast(message, type = 'success') {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();

  const colors = {
    success: '#00a844',
    error: '#e94560',
    warning: '#ff9800'
  };
  const icons = {
    success: 'fa-check-circle',
    error: 'fa-exclamation-circle',
    warning: 'fa-exclamation-triangle'
  };

  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.style.cssText = `
    position: fixed;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    max-width: calc(100vw - 32px);
    padding: 12px 16px;
    border-radius: 8px;
    background: ${colors[type] || colors.success};
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  `;
  toast.innerHTML = `<i class="fas ${icons[type] || icons.success}"></i> ${message}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ===== COIN MODAL =====
// Bug: this used to show "Vendo offline" any time /relay/on didn't return
// success - but the server correctly returns success:false with "No vendo
// configured" for any operator NOT using an ESP32 relay at all (Main Kiosk
// direct-GPIO, or before vendo_ip is set up), which isn't an error, it's
// the normal state. Only a real ESP32-configured-but-unreachable failure
// (502) should alarm the customer; "not configured" should stay silent.
async function activateVendoRelay() {
  try {
    const res = await fetch(`${SERVER}/api/portal/relay/on`, { method: 'POST' });
    const data = await res.json();
    if (!data.success && res.status !== 400) {
      showToast('Vendo offline - coin slot may not respond', 'error');
    }
  } catch(e) {
    // Network-level failure reaching this server's own API - not
    // necessarily the ESP32's fault, don't alarm the customer over it.
  }
}

async function deactivateVendoRelay() {
  try {
    await fetch(`${SERVER}/api/portal/relay/off`, { method: 'POST' });
  } catch(e) {}
}

// Best-effort, same silent-on-failure reasoning as activateVendoRelay()
// above - a vendo without a speaker attached, or not configured at all,
// shouldn't show the customer an error over a voice prompt not playing.
async function playVendoSound(sound) {
  try {
    await fetch(`${SERVER}/api/portal/play-sound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sound })
    });
  } catch (e) {}
}

// Same voice prompt, played straight from the customer's own phone -
// the vendo speaker and the portal page are two separate physical
// locations (the coin slot vs wherever the customer is sitting/standing),
// so playing it here too means they actually hear it even when they're
// not standing right next to the machine. Files are the exact same WAVs
// vendoAudioService.js streams to the ESP8266 (public/audio/vendo/), just
// played locally instead of over HTTP to the device. Best-effort: mobile
// browsers block autoplay before any user gesture on the page, so a
// prompt that fires before the customer has tapped anything (e.g. the
// very first "welcome" on page load) can silently fail to play here -
// that's fine, the vendo speaker still covers that case.
function playPortalSound(sound) {
  try {
    const audio = new Audio(`${SERVER}/audio/vendo/${sound}.wav`);
    audio.play().catch(() => {});
  } catch (e) {}
}

// Returns true if the coin slot is busy with another customer (single
// physical acceptor - see server/routes/coin.js's POST /pending busy-lock
// comment), so callers can bail out of the Insert Coin flow instead of
// silently proceeding as if a window was actually registered.
async function registerPendingCoin() {
  pendingRegistered = false;
  const mac = getMac();
  if (!mac) return false;
  try {
    const res = await fetch(`${SERVER}/api/coin/pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, mode: insertingMode })
    });
    if (res.status === 409) {
      console.log('Coin slot busy with another customer');
      return true;
    }
    // Only now is it safe to trust GET /api/coin/pending/:mac. Before
    // this resolves, a read could still return a leftover total from
    // whatever pending window existed before this one.
    pendingRegistered = true;
    console.log('Pending coin registered for', mac);
  } catch(e) {
    console.log('Failed to register pending coin');
  }
  return false;
}

// Main Kiosk (direct-GPIO) registration - safe to always call alongside
// the ESP32 pending registration above, regardless of which mode is
// actually active. The server no-ops this harmlessly when GPIO mode isn't
// configured (registerWaitingClient returns REGISTER_OK/0 and disables the
// acceptor), so there's no need to detect the mode client-side first.
// Unlike the ESP32 path, a GPIO coin credits a session immediately per
// pulse rather than accumulating in a "pending total" - the existing
// session-status poll already reacts to minutes_remaining increasing
// (see checkSession's coinModalOpen branch), so no separate GPIO polling
// loop is needed here.
// Returns true if the GPIO coin window is busy with another customer, same
// contract as registerPendingCoin() above.
async function registerPendingGpioCoin() {
  const mac = getMac();
  if (!mac) return false;
  try {
    // Direct-GPIO coin credit doesn't support Convert mode yet (only the
    // ESP32-relay path does, see coin.js's pendingMode) - a Convert tap
    // still registers the GPIO window as Premium so a box wired for
    // direct GPIO doesn't just silently ignore the coin, it credits as a
    // normal Boost instead of failing outright.
    const res = await fetch(`${SERVER}/api/coin/gpio/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, is_premium: insertingMode !== 'regular' })
    });
    if (res.status === 409) return true;
  } catch(e) {
    console.log('Failed to register GPIO coin window');
  }
  return false;
}

async function cancelPendingGpioCoin() {
  const mac = getMac();
  if (!mac) return;
  try {
    await fetch(`${SERVER}/api/coin/gpio/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac })
    });
  } catch(e) {}
}

// Which button the customer tapped: 'regular' (normal INSERT COIN),
// 'premium' (the gold BOOST button - temporary speed stack on top of
// existing time, reverts automatically), or 'convert' (permanent speed
// switch, sets minutes to the matched Premium rate's own value instead of
// adding to what's left - see coinCreditService.js's convertCoinValue).
// Doesn't change what the coin acceptor physically does - the server
// still decides what a coin buys purely from its value - this only
// decides what the modal SHOWS and which crediting path the coin lands
// on once inserted.
let insertingMode = 'regular';

// ===== CONVERT TO PREMIUM: CONFIRM STEP =====
// A coin, once physically inserted, is real money - there's no "cancel and
// get it back." So the accept/decline choice has to happen BEFORE any
// money changes hands, not after. Declining doesn't cancel anything, it
// just routes the very same "insert a coin" action into the plain Regular
// flow instead of Convert, so nothing is lost either way.
function confirmConvertToPremium() {
  if (!convertEligible()) return; // button should already be disabled/hidden
  const canConvertBack = portalSettings.allow_premium_to_regular_convert === '1';
  const body = document.getElementById('convertConfirmBody');
  if (body) {
    body.innerHTML = 'Your remaining time converts to its Premium-speed equivalent, and stays at Premium speed for the rest of your session.' +
      (canConvertBack
        ? ' You can switch back to Regular speed later if you change your mind.'
        : ' <strong>This cannot be undone for the rest of your session.</strong>');
  }
  document.getElementById('convertConfirmModal').classList.add('show');
}

function declineConvertToPremium() {
  document.getElementById('convertConfirmModal').classList.remove('show');
  handleInsertCoin('regular');
}

function acceptConvertToPremium() {
  document.getElementById('convertConfirmModal').classList.remove('show');
  handleInsertCoin('convert');
}

// Animated "N minutes -> M Mbps" counter, then confetti, then auto-closes.
// Purely a celebratory confirmation - the actual conversion already
// happened server-side (this fires off the resulting session data), so
// there's nothing to wait on or retry here.
function playConversionAnimation(prevSession, newSession) {
  const overlay = document.getElementById('convertAnimOverlay');
  const minutesEl = document.getElementById('convertAnimMinutes');
  const mbpsEl = document.getElementById('convertAnimMbps');
  const doneEl = document.getElementById('convertAnimDone');
  if (!overlay || !minutesEl || !mbpsEl) return;

  playSound('success');
  doneEl.classList.remove('show');
  overlay.classList.add('show');

  const targetMinutes = Math.round(newSession.minutes_remaining || 0);
  const targetMbps = newSession.premium_download_mbps || 0;
  const startMinutes = Math.round(prevSession.minutes_remaining || 0);

  const durationMs = 1100;
  const startTime = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - startTime) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    minutesEl.textContent = Math.round(startMinutes + (targetMinutes - startMinutes) * eased);
    mbpsEl.textContent = Math.round(targetMbps * eased);
    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      minutesEl.textContent = targetMinutes;
      mbpsEl.textContent = targetMbps;
      doneEl.classList.add('show');
      launchConfetti();
    }
  }
  requestAnimationFrame(tick);

  setTimeout(() => overlay.classList.remove('show'), 3800);
}

// Lightweight self-contained confetti burst - no external library, this
// app has no CDN access from a customer-facing captive-portal page (real
// devices often have no general internet yet at this exact moment, only
// walled-garden access to this server itself).
function launchConfetti() {
  const canvas = document.getElementById('confettiCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.scale(dpr, dpr);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  const colors = ['#d4af37', '#f9d873', '#ffffff', '#7ee787', '#5ec8ff'];
  const pieces = Array.from({ length: 140 }, () => ({
    x: w / 2 + (Math.random() - 0.5) * 60,
    y: h * 0.35 + (Math.random() - 0.5) * 40,
    vx: (Math.random() - 0.5) * 9,
    vy: -Math.random() * 9 - 4,
    size: Math.random() * 7 + 4,
    color: colors[Math.floor(Math.random() * colors.length)],
    rotation: Math.random() * Math.PI * 2,
    rotationSpeed: (Math.random() - 0.5) * 0.3,
    gravity: 0.28 + Math.random() * 0.12,
  }));

  const startTime = performance.now();
  const durationMs = 2600;
  function frame(now) {
    const elapsed = now - startTime;
    ctx.clearRect(0, 0, w, h);
    for (const p of pieces) {
      p.vy += p.gravity * 0.15;
      p.x += p.vx * 0.6;
      p.y += p.vy * 0.6;
      p.rotation += p.rotationSpeed;
      const fade = Math.max(0, 1 - elapsed / durationMs);
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (elapsed < durationMs) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
  }
  requestAnimationFrame(frame);
}

async function handleInsertCoin(mode) {
  if (isBlocked) return;
  if (mode === 'convert' && !convertEligible()) return; // button should already be disabled/hidden
  playSound('insert');
  insertedTotal = 0;
  pendingRegistered = false;
  insertingMode = mode;

  // Only one customer can physically drop coins at a time. Both requests
  // are fired together (the ESP32-relay and direct-GPIO paths are mutually
  // exclusive per install, the server no-ops whichever mode isn't active),
  // so either one coming back busy means the kiosk is genuinely occupied.
  const [espBusy, gpioBusy] = await Promise.all([
    registerPendingCoin(),
    registerPendingGpioCoin()
  ]);
  if (espBusy || gpioBusy) {
    showToast('Another customer is using the coin slot right now. Please wait a moment and try again.', 'error');
    return;
  }

  const modal = document.getElementById('coinModal');
  modal.classList.toggle('coin-modal-premium', mode === 'premium' || mode === 'convert');
  const title = document.getElementById('coinModalTitle');
  // A Converted customer pressing what's now their ONLY "add time" button
  // still goes through mode 'premium' server-side (same crediting path,
  // correct Premium pricing) - but calling it "PREMIUM BOOST" here is
  // wrong once there's no baseline speed left to boost FROM, they're
  // already permanently on Premium. Same coin flow, different framing.
  const alreadyConvertedForModal = currentSession && currentSession.converted_to_premium;
  title.innerHTML = mode === 'convert'
    ? '<i class="fas fa-bolt"></i>&nbsp; INSERT COIN (CONVERT TO PREMIUM)'
    : mode === 'convert_down'
      ? '<i class="fas fa-arrow-down"></i>&nbsp; INSERT COIN (CONVERT TO REGULAR)'
      : mode === 'premium'
        ? (alreadyConvertedForModal
            ? '<i class="fas fa-bolt"></i>&nbsp; INSERT COIN TO ADD TIME'
            : '<i class="fas fa-bolt"></i>&nbsp; INSERT COIN (PREMIUM BOOST)')
        : '<i class="fas fa-coins"></i>&nbsp; INSERT COIN';
  renderCoinRatesList();

  // Boost stays available even with a Regular session already running
  // (it's a real, deliberate upsell - the server already supports buying
  // it mid-session, see coinCreditService.js's premium/regular stacking
  // comment), but a customer who hasn't dealt with it before could easily
  // assume it REPLACES their current session rather than adding a
  // temporary speed boost on top of it. Convert gets its own distinct
  // notice since its actual effect (permanent speed, minutes SET to the
  // Premium rate's own value, not added) is different enough from both
  // Regular and Boost that it needs explaining every time, not just once.
  const stackNotice = document.getElementById('coinModalStackNotice');
  const hasRegularSessionRunning = currentSession && currentSession.minutes_remaining > 0;
  const alreadyHasPremium = currentSession && currentSession.premium_expires_at &&
    new Date(currentSession.premium_expires_at).getTime() > Date.now();
  if (stackNotice) {
    if (mode === 'convert') {
      // Whether this is reversible later depends entirely on the
      // operator's own setting (Settings > Allow Premium-to-Regular
      // Convert) - showing a fixed "no going back" warning regardless
      // would be flatly wrong on any install where that's turned on.
      const canConvertBack = portalSettings.allow_premium_to_regular_convert === '1';
      stackNotice.innerHTML = '<i class="fas fa-circle-info"></i>&nbsp; This permanently switches your speed to Premium for the rest of your session. Your remaining time converts to its Premium-speed equivalent (a bit less, since Premium time costs more per minute) and the new coin\'s time is added on top.' +
        (canConvertBack
          ? ' You can switch back to Regular speed later if you change your mind.'
          : ' <strong>This cannot be undone for the rest of your session.</strong>');
      stackNotice.style.display = 'block';
    } else if (mode === 'convert_down') {
      stackNotice.innerHTML = '<i class="fas fa-circle-info"></i>&nbsp; This switches your speed back to Regular for the rest of your session. Your remaining time converts to its Regular-speed equivalent (a bit more, since Regular time costs less per minute) and the new coin\'s time is added on top.';
      stackNotice.style.display = 'block';
    } else if (mode === 'premium' && alreadyConvertedForModal) {
      stackNotice.innerHTML = '<i class="fas fa-circle-info"></i>&nbsp; Adds more time at your current Premium speed.';
      stackNotice.style.display = 'block';
    } else if (mode === 'premium' && hasRegularSessionRunning && !alreadyHasPremium) {
      stackNotice.innerHTML = '<i class="fas fa-circle-info"></i>&nbsp; This adds temporary high-speed time on top of your current session, it does not replace your regular minutes.';
      stackNotice.style.display = 'block';
    } else {
      stackNotice.style.display = 'none';
    }
  }

  modal.classList.add('show');
  startCoinTimer();
  startPendingPoll();
  activateVendoRelay();
  if (mode === 'regular') { playVendoSound('insert-coin'); playPortalSound('insert-coin'); }
}

// Shared handler for both the CONNECT button and the modal's X close
// button. Bug found live: X used to call closeCoinModal() directly, which
// only cancels the GPIO "waiting for a coin" window - it never finalized,
// so already-inserted coins just sat in the server's pending window for up
// to PENDING_TIMEOUT_MS (40s) with zero feedback before quietly granting
// access on their own. From the operator/customer's side that reads as
// "the coins didn't count," even though nothing was actually lost. X now
// finalizes immediately, same as CONNECT - only a truly empty session
// (insertedTotal <= 0, nothing to finalize) still just closes.
async function finishInsertingCoins() {
  if (insertedTotal <= 0) {
    closeCoinModal();
    return;
  }
  const mac = getMac();
  try {
    const res = await fetch(`${SERVER}/api/coin/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac })
    });
    const data = await res.json();
    if (data.success) {
      redirectAfterCoinModal = true;
    } else if (data.reason === 'no_matching_rate') {
      showToast(data.message || 'That amount doesn\'t match a rate yet.', 'error');
      return; // leave the modal open so they can insert more
    } else if (data.reason === 'convert_failed') {
      showToast(data.message || 'Could not convert to Premium. Your coins are still safe, please try again.', 'error');
      return; // leave the modal open, same as no_matching_rate above
    }
    // Any other failure (including no_pending_coins) still falls through
    // to closeCoinModal() below. The coins, if any, are still safely
    // waiting in the server's pending window and will finalize on their
    // own once it goes quiet.
  } catch (e) {
    // Network/server unreachable, nothing was finalized. Don't pretend it
    // was: keep the modal open (the fast pending-poll keeps retrying) and
    // let the customer know, instead of silently closing as if connected.
    showToast('Could not reach the server, please try again.', 'error');
    return;
  }
  closeCoinModal();
}

function closeCoinModal() {
  stopSound('insert');
  stopCoinTimer();
  stopPendingPoll();
  pendingRegistered = false;
  document.getElementById('coinModal').classList.remove('show');
  deactivateVendoRelay();
  cancelPendingGpioCoin();
  if (redirectAfterCoinModal) {
    redirectAfterCoinModal = false;
    // Was 500ms - too fast for the "success" sound (triggered separately,
    // by updateUI() once the session actually goes active) to finish
    // before the page navigated away and cut it off. Matches the delay
    // already used for the no-modal connect path below.
    setTimeout(() => {
      window.location.href = portalSettings.redirect_url;
    }, 2000);
  }
}

// ===== APPLY PORTAL SETTINGS TO UI =====
// Bug: this function existed but was never actually called anywhere - the
// pause-button and voucher-box logic it was written for was duplicated
// inline elsewhere instead (see updateUI()). Now also owns showing/hiding
// the coin and voucher entry points per the admin's Payment Methods
// setting (Settings > Portal Settings) - runs once after settings load
// since these buttons are static DOM elements, not re-rendered per state
// change.
function applyPortalSettings() {
  const voucherBox = document.getElementById('voucherBox');
  if (currentSession && currentSession.active) {
    voucherBox.style.display = portalSettings.show_voucher === '1' ? 'block' : 'none';
  }
  const pauseBtn = document.getElementById('pauseBtn');
  if (pauseBtn) {
    pauseBtn.style.display = portalSettings.allow_pause === '1' ? 'block' : 'none';
  }

  // Lets a customer who already closed this page find their way back to
  // pause or top up, instead of only ever seeing this button once, right
  // when they first connect.
  const hostnameHint = document.getElementById('portalHostnameHint');
  if (hostnameHint) {
    if (portalSettings.portal_hostname) {
      hostnameHint.textContent = `Return anytime at ${portalSettings.portal_hostname}`;
      hostnameHint.style.display = 'block';
    } else {
      hostnameHint.style.display = 'none';
    }
  }

  const showCoin = portalSettings.payment_methods !== 'voucher';
  const showVoucherEntry = portalSettings.payment_methods !== 'coin';

  const insertBtn = document.getElementById('insertBtn');
  if (insertBtn) insertBtn.style.display = showCoin ? 'block' : 'none';
  const insertBtnConnected = document.getElementById('insertBtnConnected');
  if (insertBtnConnected) insertBtnConnected.style.display = showCoin ? 'block' : 'none';

  const vouchersBtn = document.getElementById('vouchersBtn');
  const voucherInputRow = document.getElementById('voucherInputRow');

  // Connected-state "Add Time with Voucher" - same showVoucherEntry rule as
  // the disconnected state's Vouchers button, just its own elements since
  // both sections coexist in the DOM (only one visible at a time).
  const vouchersBtnConnected = document.getElementById('vouchersBtnConnected');
  const voucherInputRowConnected = document.getElementById('voucherInputRowConnected');
  if (vouchersBtnConnected) vouchersBtnConnected.style.display = showVoucherEntry ? 'block' : 'none';
  if (!showVoucherEntry && voucherInputRowConnected) voucherInputRowConnected.style.display = 'none';

  if (portalSettings.payment_methods === 'voucher') {
    // Voucher Only: the code entry box IS the primary action, not something
    // buried behind a small button below "Claim Free Time" - move it to the
    // top of the disconnected section (right after the welcome message) and
    // show it immediately, and hide the now-redundant toggle button.
    if (vouchersBtn) vouchersBtn.style.display = 'none';
    if (voucherInputRow) {
      const section = document.getElementById('sectionDisconnected');
      const welcomeMsg = document.getElementById('welcomeMsg');
      if (section && welcomeMsg && voucherInputRow.parentElement === section) {
        section.insertBefore(voucherInputRow, welcomeMsg.nextSibling);
      }
      voucherInputRow.style.display = 'flex';
    }
  } else {
    if (vouchersBtn) vouchersBtn.style.display = showVoucherEntry ? 'block' : 'none';
    if (!showVoucherEntry && voucherInputRow) voucherInputRow.style.display = 'none';
  }
}

// ===== UI UPDATE =====
// Shows a live "Premium X mins left, then Standard speed" indicator
// while a Premium boost is active. The server already handles the actual
// revert automatically the moment premium_expires_at passes (see
// sessionService.js's effectiveBandwidth - Premium only wins while it
// hasn't expired yet), there's no manual "downgrade" action needed or
// possible. This is purely so the customer isn't left guessing why their
// speed changed later in the session with no warning.
let speedIndicatorInterval = null;

function stopSpeedIndicatorTicker() {
  if (speedIndicatorInterval) {
    clearInterval(speedIndicatorInterval);
    speedIndicatorInterval = null;
  }
}

// Renders the gold bar's label + fill width for the CURRENT instant.
// Called on every fresh session poll AND every second by the ticker below,
// the ticker is what actually makes the bar visibly drain in real time
// between poll cycles rather than only jumping every ~8s.
function renderSpeedIndicatorFrame(expiresAtMs, startedAtMs) {
  const el = document.getElementById('speedIndicator');
  const label = document.getElementById('speedIndicatorLabel');
  const fill = document.getElementById('speedIndicatorFill');
  if (!el || !label || !fill) return;

  const now = Date.now();
  const msLeft = Math.max(0, expiresAtMs - now);
  if (msLeft <= 0) {
    stopSpeedIndicatorTicker();
    el.style.display = 'none';
    return;
  }

  const minsLeft = Math.max(0, Math.ceil(msLeft / 60000));
  label.innerHTML = `<i class="fas fa-bolt"></i>&nbsp; PREMIUM SPEED &middot; ${minsLeft}m left, then back to Standard`;

  // startedAtMs can be missing on an older session row from before this
  // column existed - falls back to a flat 100% fill (still shows the
  // countdown text correctly, just without a meaningful drain animation)
  // rather than dividing by zero or guessing a start point.
  const totalMs = startedAtMs && expiresAtMs > startedAtMs ? expiresAtMs - startedAtMs : null;
  const pct = totalMs ? Math.max(0, Math.min(100, (msLeft / totalMs) * 100)) : 100;
  fill.style.width = pct + '%';

  // Urgency color scale (portal.css's .speed-tier-* classes) - green while
  // there's plenty of time left, yellow in the middle stretch, red once
  // it's about to run out. Applied on the outer container so both the
  // label text and the fill/glow/sparks all pick up the same variables.
  el.classList.remove('speed-tier-green', 'speed-tier-yellow', 'speed-tier-red');
  if (pct > 50) el.classList.add('speed-tier-green');
  else if (pct > 20) el.classList.add('speed-tier-yellow');
  else el.classList.add('speed-tier-red');

  el.style.display = 'block';
}

function updateSpeedIndicator(session) {
  const el = document.getElementById('speedIndicator');
  if (!el) return;
  stopSpeedIndicatorTicker();

  const premiumActive = session.premium_expires_at &&
    new Date(session.premium_expires_at).getTime() > Date.now();
  if (!premiumActive) {
    el.style.display = 'none';
    return;
  }

  const expiresAtMs = new Date(session.premium_expires_at).getTime();
  const startedAtMs = session.premium_started_at ? new Date(session.premium_started_at).getTime() : null;
  renderSpeedIndicatorFrame(expiresAtMs, startedAtMs);
  speedIndicatorInterval = setInterval(() => renderSpeedIndicatorFrame(expiresAtMs, startedAtMs), 1000);
}

// Shows how many pauses are left when the operator has set a limit
// (settings.max_pauses > 0, server/routes/session.js's pausesRemaining()).
// pauses_remaining is null when there's no limit configured, hides the
// hint entirely rather than showing a confusing "unlimited" label.
function updatePausesRemainingHint(session) {
  const hint = document.getElementById('pausesRemainingHint');
  if (!hint) return;
  if (session.pauses_remaining === null || session.pauses_remaining === undefined) {
    hint.style.display = 'none';
    return;
  }
  const n = session.pauses_remaining;
  hint.textContent = n > 0
    ? `${n} pause${n === 1 ? '' : 's'} left for this session`
    : 'No pauses left for this session';
  hint.style.display = 'block';
}

function updateUI(session) {
  const prev = currentSession;
  currentSession = session;

  // Peso-credit toast: fires once per completed coin total (server batches
  // rapid coin pulses into one transactions row per finalizePendingCoins()
  // call, so last_credit_at only changes when a NEW total posts, not per
  // individual coin). First poll after page load just records whatever's
  // already there without toasting it - otherwise reopening the portal
  // page would re-announce an old credit that happened minutes/hours ago.
  if (session && session.last_credit_at) {
    if (!lastShownCreditInit) {
      lastShownCreditInit = true;
      lastShownCreditAt = session.last_credit_at;
    } else if (session.last_credit_at !== lastShownCreditAt) {
      lastShownCreditAt = session.last_credit_at;
      showToast(`You have added ₱${session.last_credit_amount}`, 'success');
      const amt = Math.round(Number(session.last_credit_amount));
      if (Number.isFinite(amt) && amt >= 1 && amt <= 300) {
        playPortalSound(`amounts/amount-${amt}`);
      }
    }
  }

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
    expiryWarning.style.display = 'none';
    stopSpeedIndicatorTicker();
    document.getElementById('speedIndicator').style.display = 'none';
    document.getElementById('sectionDisconnected').style.display = 'block';
    document.getElementById('sectionConnected').style.display = 'none';
    document.getElementById('sectionPaused').style.display = 'none';

    if (welcomeMsg) {
      if (prev && prev.active) {
        welcomeMsg.textContent = portalSettings.disconnect_message;
        welcomeMsg.style.color = '#e94560';
        // Real timeout (was connected, now isn't) - swap the 2-minute
        // warning flash (if it was even running) for a distinct "time's up"
        // one, visible in the tab title even if they've backgrounded the
        // tab. Cleared the moment they reconnect (see the connected branch
        // below), not left flashing forever.
        lowTimeWarned = false;
        stopTitleFlash();
        playSound('coin');
        startTitleFlash('⚠️ TIME\'S UP - Reconnect now');
      } else {
        welcomeMsg.textContent = portalSettings.welcome_message;
        welcomeMsg.style.color = '#888';
        // First render since page load (prev is still null) - a genuine
        // "just arrived" moment, not every time they cycle back through
        // disconnected (e.g. after their session ends). Guarded so this
        // can never repeat within the same page load.
        if (!prev && !welcomeSoundPlayed) {
          welcomeSoundPlayed = true;
          playVendoSound('welcome');
          playPortalSound('welcome');
        }
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
    stopSpeedIndicatorTicker();
    document.getElementById('speedIndicator').style.display = 'none';

  } else {
    // Connected with real time on the clock - clear any flash from a prior
    // low-time warning or timeout (covers reconnecting, and topping up
    // while the warning was already showing).
    if (session.minutes_remaining > 2) {
      lowTimeWarned = false;
      stopTitleFlash();
    }

    const coinModalOpen = document.getElementById('coinModal').classList.contains('show');
    if (!prev || !prev.active) {
      playSound('success');
      playVendoSound('connected');
      playPortalSound('connected');
      if (coinModalOpen) {
        // Bug: this used to force-close the modal (and redirect) the instant
        // the first coin created a session, cutting the customer off mid
        // insertion if they were still dropping more coins. The coin's
        // already reflected via pollPendingTotal's own faster poll; let the
        // modal's own timer or a manual close decide when insertion is done,
        // and only redirect once that actually happens.
        if (portalSettings.redirect_url) redirectAfterCoinModal = true;
      } else {
        deactivateVendoRelay();
        if (portalSettings.redirect_url) {
          setTimeout(() => {
            window.location.href = portalSettings.redirect_url;
          }, 2000);
        }
      }
    } else if (prev.voucher_code === session.voucher_code &&
               session.minutes_remaining > prev.minutes_remaining) {
      playSound('coin');
      if (coinModalOpen) {
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
    updateSpeedIndicator(session);

    const pauseBtn = document.getElementById('pauseBtn');
    if (pauseBtn) {
      pauseBtn.style.display = portalSettings.allow_pause === '1' ? 'block' : 'none';
    }
    updatePausesRemainingHint(session);
    updateConvertButton();

    // Fires exactly once, the moment a session actually flips from not-
    // converted to converted - catches the real server-confirmed switch
    // (after the coin's pending window closes) rather than the instant
    // Accept was tapped, so this plays even if the tab was backgrounded
    // or the poll landed a beat late.
    if (prev && !prev.converted_to_premium && session.converted_to_premium) {
      playConversionAnimation(prev, session);
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
        // Bug: the local countdown hitting zero doesn't mean the server has
        // actually expired the session yet - timerService.js's sweep only
        // runs every 30s, so a single checkSession() 2s after zero often
        // landed in that gap and found the session still "active" (with
        // internet already gone the moment the sweep does run). The page
        // just sat on 00:00:00 with no clear message - looked like a
        // connected-but-broken WiFi, not an expired session. Poll tightly
        // for the first 40s after hitting zero instead of a single check,
        // so it catches the real server-side expiry within a few seconds
        // of it happening rather than waiting for the next regular 8s poll.
        let catchUpChecks = 0;
        const catchUpInterval = setInterval(() => {
          catchUpChecks++;
          checkSession();
          if (catchUpChecks >= 8) clearInterval(catchUpInterval); // ~40s at 5s each
        }, 5000);
      } else {
        timeDisplay.textContent = formatTime(remaining);
        const lowTime = remaining <= 2;
        expiryWarning.style.display = lowTime ? 'block' : 'none';
        if (lowTime && !lowTimeWarned) {
          lowTimeWarned = true;
          playSound('coin');
          startTitleFlash('⏰ 2 MIN LEFT - Tap to add time!');
        }
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
    updateConnectionBanner(false);
    updateUI(data.active ? data : null);

    if (!isBlocked) {
      const spamRes = await fetch(`${SERVER}/api/coin/status/${encodeURIComponent(mac)}`);
      const spamData = await spamRes.json();
      if (spamData.blocked && spamData.remaining > 0) {
        showBlockUI(spamData.remaining);
      }
    }
  } catch(e) {
    console.error(e);
    updateConnectionBanner(true);
  }
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
    portalSettings.payment_methods = data.payment_methods || 'both';
    portalSettings.vapid_public_key = data.vapid_public_key || '';
    portalSettings.portal_hostname = data.portal_hostname || '';
    portalSettings.allow_premium_to_regular_convert = data.allow_premium_to_regular_convert || '0';
    applyPortalSettings();
    updateNotificationsButton();

    document.getElementById('cafeName').textContent = data.cafe_name.toUpperCase();
    baseTitle = data.cafe_name;
    document.title = baseTitle;

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
// Split once here rather than re-filtering on every tab click - Premium
// is any rate with a download_mbps set (coinCreditService.js's own
// definition of "premium," not a separate flag, so the two can never
// drift apart).
let standardRates = [];
let premiumRates = [];

function renderRateItem(r) {
  const expLabel = r.expiration_minutes >= 1440
    ? `${Math.round(r.expiration_minutes/1440)} day expiry`
    : r.expiration_minutes >= 60
      ? `${Math.round(r.expiration_minutes/60)}hr expiry`
      : `${r.expiration_minutes}min expiry`;

  const speedLine = r.download_mbps
    ? `<div class="rate-label" style="color:#00a844;"><i class="fas fa-bolt"></i> ${r.download_mbps}/${r.upload_mbps || r.download_mbps} Mbps</div>`
    : '';

  return `
    <div class="rate-item">
      <div class="rate-left">
        <div class="rate-icon"><i class="fas ${r.download_mbps ? 'fa-bolt' : 'fa-coins'}"></i></div>
        <div>
          <div class="rate-price">₱${r.coin_value}</div>
          <div class="rate-label">${expLabel}</div>
          ${speedLine}
        </div>
      </div>
      <div>
        <div class="rate-time">${formatMinutes(r.minutes)}</div>
        <div class="rate-expiry">Valid ${expLabel}</div>
      </div>
    </div>`;
}

function buildRatesUI(rates) {
  standardRates = rates.filter(r => !r.download_mbps);
  premiumRates = rates.filter(r => r.download_mbps);

  const premiumTab = document.getElementById('rateTabPremium');
  if (premiumTab) premiumTab.style.display = premiumRates.length ? 'block' : 'none';

  // The gold PREMIUM insert-coin buttons only make sense to show once
  // there's actually at least one Premium rate configured - same
  // condition the WiFi Rates modal's own Premium tab already uses.
  const hasPremium = premiumRates.length > 0;
  ['premiumBtn', 'premiumBtnConnected'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.style.display = hasPremium ? 'block' : 'none';
  });

  document.getElementById('ratesList').innerHTML = standardRates.map(renderRateItem).join('');
  renderCoinRatesList();
  updateConvertButton();
}

// Convert button visibility depends on both whether any Premium rates
// exist AND the live remaining-time eligibility check (convertEligible),
// so this needs re-running on every session update, not just once when
// rates first load (buildRatesUI already calls it once for that reason).
function updateConvertButton() {
  const hasPremium = premiumRates.length > 0;
  const eligible = hasPremium && convertEligible();
  const alreadyConverted = !!(currentSession && currentSession.converted_to_premium);

  // Once a customer has actually Converted (permanent for the rest of the
  // session), converting again makes no sense - hide that button. A plain
  // Boost purchase (temporary, stacks on top) never sets converted_to_premium,
  // so this only fires for a real Convert, not every Premium session.
  ['convertBtn', 'convertBtnConnected'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.style.display = (hasPremium && !alreadyConverted) ? 'block' : 'none';
    btn.disabled = !eligible;
  });

  // Bug found live: a Converted customer's plain "Insert Coin to Add Time"
  // button still credited REGULAR-priced minutes, which then rode on the
  // Premium speed for free until the session's own premium window would
  // otherwise have ended (correct in principle - speed is a property of
  // the live connection, not tied to which coin paid for which minute -
  // but confusing and easy to read as a bug from the operator side, and a
  // real revenue gap since Regular-priced time is quietly getting
  // Premium-priced treatment). Once truly Converted, the portal should
  // only offer PREMIUM-priced ways to add more time, not a cheaper
  // regular option sitting right next to it - hide the regular button
  // entirely and repurpose the existing Boost button (same coin flow,
  // Premium rates) as the one and only "add time" action, relabeled since
  // "Boost (temporary)" no longer describes what it does for someone
  // already permanently on Premium.
  const insertBtnConnected = document.getElementById('insertBtnConnected');
  const premiumBtnConnected = document.getElementById('premiumBtnConnected');
  const premiumBtnConnectedLabel = document.getElementById('premiumBtnConnectedLabel');
  if (insertBtnConnected && alreadyConverted) {
    insertBtnConnected.style.display = 'none';
  }
  if (premiumBtnConnected && premiumBtnConnectedLabel) {
    if (alreadyConverted) {
      premiumBtnConnected.style.display = hasPremium ? 'block' : 'none';
      premiumBtnConnectedLabel.textContent = 'INSERT COIN TO ADD TIME';
    } else {
      premiumBtnConnectedLabel.textContent = 'BOOST (TEMPORARY HIGH SPEED)';
    }
  }

  // Convert-back-to-Regular only shows when the operator has explicitly
  // turned it on AND this specific session's elevated speed actually came
  // from Convert (converted_to_premium), never a voucher's own override.
  const downBtn = document.getElementById('convertDownBtnConnected');
  if (downBtn) {
    const show = portalSettings.allow_premium_to_regular_convert === '1' &&
      alreadyConverted && standardRates.length > 0;
    downBtn.style.display = show ? 'block' : 'none';
  }
}

function setRatesTab(tab) {
  const list = tab === 'premium' ? premiumRates : standardRates;
  document.getElementById('ratesList').innerHTML = list.map(renderRateItem).join('');
  document.getElementById('rateTabStandard').classList.toggle('active', tab === 'standard');
  document.getElementById('rateTabPremium').classList.toggle('active', tab === 'premium');
}

// Insert Coin modal's own list matches whichever button the customer
// tapped to get here (insertingMode) - shows exactly the rates relevant
// to what they're about to do, not the full mixed list. Convert matches
// against Premium rates too (same coin values), same list as Boost.
function renderCoinRatesList() {
  const list = (insertingMode === 'premium' || insertingMode === 'convert') ? premiumRates : standardRates;
  document.getElementById('coinRatesList').innerHTML = list.map(renderRateItem).join('');
}

// Convert only makes sense with enough remaining time that switching
// speed is worth it - converting when there's almost nothing left would
// mean losing time rather than gaining anything (see coinCreditService.js's
// convertCoinValue - minutes gets SET to the matched rate's own value, not
// added). Gated on the operator's own configured Premium rates rather than
// a separate setting: needs at least as much time remaining as the
// cheapest Premium rate grants, otherwise there's no rate that could
// possibly leave them with more time than they already have.
function convertEligible() {
  if (!currentSession || !(currentSession.minutes_remaining > 0)) return false;
  if (!premiumRates.length) return false;
  const minPremiumMinutes = Math.min(...premiumRates.map(r => r.minutes));
  return currentSession.minutes_remaining >= minPremiumMinutes;
}

// ===== MODALS =====
function showRates() {
  setRatesTab('standard');
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
    else showToast(data.message || 'Could not pause session.', 'error');
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
  const raw = document.getElementById('voucherInput').value.trim().toUpperCase();
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

// Add-time-while-connected - server/routes/promo.js now adds this voucher's
// minutes to the customer's existing session instead of rejecting it for
// already having one, mirroring how the coin slot has always let a
// connected customer top up. Separate input/button from the disconnected
// state's (different element ids) since both sections can exist in the DOM
// at once, just not both visible at the same time.
function showVoucherInputConnected() {
  const row = document.getElementById('voucherInputRowConnected');
  row.style.display = row.style.display === 'flex' ? 'none' : 'flex';
}

async function redeemVoucherConnected() {
  const raw = document.getElementById('voucherInputConnected').value.trim().toUpperCase();
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
      document.getElementById('voucherInputConnected').value = '';
      document.getElementById('voucherInputRowConnected').style.display = 'none';
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

// Same accessibility gap as the admin panel (see app.js's own version of
// this): a plain `<div onclick="...">` (the expiry-warning banner) is
// clickable with a mouse but invisible to keyboard/assistive navigation.
// This is the general public's own page, so this matters more here, not
// less.
function makeClickableDivsKeyboardAccessible(root) {
  const scope = root || document;
  const NATIVE_FOCUSABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
  scope.querySelectorAll('[onclick]').forEach((el) => {
    if (NATIVE_FOCUSABLE.has(el.tagName)) return;
    if (el.dataset.kbdEnhanced) return;
    el.dataset.kbdEnhanced = '1';
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });
  });
}

// ===== INIT =====
// Voucher Login QR support (Voucher Designer's QR element) - a printed
// voucher's QR encodes this portal's own URL with ?code=<voucher code>,
// scanned by the customer's phone camera. Auto-fills and submits the
// same real redeemVoucher() flow a customer typing the code by hand
// already uses - no separate/duplicate redemption path.
function tryAutoRedeemFromQr() {
  const code = new URLSearchParams(window.location.search).get('code');
  if (!code) return;
  const input = document.getElementById('voucherInput');
  if (input) {
    input.value = code;
    redeemVoucher();
  }
  // Strip the code from the URL after attempting it once, so a page
  // refresh (or the customer sharing the link) doesn't silently retry
  // an already-used/invalid code.
  const url = new URL(window.location.href);
  url.searchParams.delete('code');
  window.history.replaceState({}, '', url);
}

async function init() {
  await loadSettings();
  await detectDevice();
  connectEventStream(getMac());
  await checkSession();
  await checkFreeClaimEligibility();
  startPolling();
  makeClickableDivsKeyboardAccessible(document);
  tryAutoRedeemFromQr();
}

init();
