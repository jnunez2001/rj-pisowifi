const API = '';
let authToken = null;
let currentPage = 'dashboard';

// ===== ACCESSIBILITY: keyboard support for onclick-only elements =====
// A real gap found in a design/accessibility audit: nav rows, cards, and
// table actions throughout this app are plain `<div onclick="...">`
// elements - clickable with a mouse, completely invisible and
// unreachable to anyone navigating by keyboard (divs aren't focusable or
// "Enter/Space activates it" by default, unlike a real <button>). Rather
// than hand-edit every one of these across 16+ pages (high risk of
// missing some, and they get added over time), this enhancement runs
// once for the static sidebar and again after every dynamic page load,
// adding real keyboard support to anything clickable that isn't already
// a native focusable element - no visual change, purely additive.
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

// ===== AUTH =====
async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const otpToken = document.getElementById('login2faToken').value.trim();

  if (!username || !password) {
    showLoginError('Please enter username and password.');
    return;
  }

  try {
    // POST /login is the one place that checks a 2FA code (if the account
    // has it enabled) and issues a session token - installs that never
    // turn 2FA on get exactly the same behavior as before (password
    // checked, token issued, used identically to how the raw password
    // itself used to be sent on every request).
    const loginRes = await fetch(`${API}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, otp_token: otpToken || undefined }),
    });
    const loginData = await loginRes.json();

    if (loginData.requires2fa && !otpToken) {
      // Correct password, 2FA is on, code not entered yet - reveal the
      // field instead of failing outright.
      document.getElementById('login2faGroup').style.display = 'block';
      document.getElementById('login2faToken').focus();
      return;
    }
    if (!loginData.success) {
      showLoginError(loginData.message || 'Invalid username or password.');
      return;
    }

    const sessionToken = loginData.token;

    // Verify username + fetch settings using the freshly-issued token.
    const res = await fetch(`${API}/api/admin/settings`, {
      headers: { 'password': sessionToken }
    });
    const data = await res.json();
    const savedUsername = data.settings?.admin_username || 'admin';

    if (username !== savedUsername) {
      showLoginError('Invalid username or password.');
      return;
    }

    authToken = sessionToken;
    sessionStorage.setItem('rj_admin_token', sessionToken);
    sessionStorage.setItem('rj_admin_user', username);

    showAdmin();

    // Bug: default admin123 password shipped with no forced-change flow.
    // must_change_password is set on first install (or migrated from an
    // unchanged default) — send the admin straight to Settings to pick a
    // real password instead of leaving it silently flagged in the DB.
    if (data.settings?.must_change_password === '1') {
      navigateTo('settings');
      setTimeout(() => {
        if (typeof showToast === 'function') {
          showToast('Please set a new admin password before continuing.', 'error');
        } else {
          alert('Please set a new admin password before continuing.');
        }
      }, 300);
    }
  } catch(e) {
    showLoginError('Cannot connect to server.');
  }
}

function showLoginError(msg) {
  const err = document.getElementById('loginError');
  document.getElementById('loginErrorMsg').textContent = msg;
  err.style.display = 'flex';
  setTimeout(() => err.style.display = 'none', 3000);
}

function togglePasswordView() {
  const input = document.getElementById('loginPassword');
  const icon = document.getElementById('eyeIcon');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fas fa-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'fas fa-eye';
  }
}

function doLogout() {
  if (!confirm('Are you sure you want to logout?')) return;
  sessionStorage.removeItem('rj_admin_token');
  authToken = null;
  stopSessionPolling();
  document.getElementById('adminLayout').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'block';
  document.getElementById('loginPassword').value = '';
}

// Splash shows for at least SPLASH_MIN_MS, but never leaves the admin
// staring at a half-rendered layout either - it waits for whichever is
// later: the minimum time, or navigateTo('dashboard')'s own data fetch
// actually finishing. dashboardReady() is called by dashboard.js once its
// initial load completes; a page that's slow to report ready (or errors
// out) still gets released by the hard SPLASH_MAX_MS ceiling so a login
// can never get stuck behind a permanently-visible splash.
const SPLASH_MIN_MS = 700;
const SPLASH_MAX_MS = 3000;
let splashDashboardReady = false;
let splashMinTimeElapsed = false;
let splashResolved = false;

function hideSplash() {
  if (splashResolved) return;
  splashResolved = true;
  const splash = document.getElementById('loginSplash');
  if (!splash) return;
  splash.style.opacity = '0';
  setTimeout(() => { splash.style.display = 'none'; }, 400);
}

function maybeHideSplash() {
  if (splashDashboardReady && splashMinTimeElapsed) hideSplash();
}

// Called by dashboard.js once its first load of real data completes.
function dashboardReady() {
  splashDashboardReady = true;
  maybeHideSplash();
}

function showAdmin() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('adminLayout').style.display = 'flex';

  splashDashboardReady = false;
  splashMinTimeElapsed = false;
  splashResolved = false;
  const splash = document.getElementById('loginSplash');
  if (splash) {
    splash.style.display = 'flex';
    splash.style.opacity = '1';
  }
  setTimeout(() => { splashMinTimeElapsed = true; maybeHideSplash(); }, SPLASH_MIN_MS);
  setTimeout(hideSplash, SPLASH_MAX_MS);

  navigateTo('dashboard');
  startSessionPolling();
  if (typeof refreshRouterFlyoutVisibility === 'function') refreshRouterFlyoutVisibility();
  checkDiskSpaceBanner();
  loadVenueType();
  if (typeof startNotifPolling === 'function') startNotifPolling();
}

// Sets window.currentVenueType once per login, read by flyoutNav.js to
// relabel/hide venue-specific nav items. Defaults to piso_wifi (matches
// the DB default) so a failed fetch just means "no change," not broken nav.
async function loadVenueType() {
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    window.currentVenueType = (data.success && data.settings?.venue_type) || 'piso_wifi';
  } catch (e) {
    window.currentVenueType = 'piso_wifi';
  }
}

// Quiet background check, shown once per login rather than polled
// continuously - a full SD card fills up slowly, not something that needs
// second-by-second monitoring.
async function checkDiskSpaceBanner() {
  try {
    const data = await apiCall('GET', '/api/admin/disk-space');
    const banner = document.getElementById('diskSpaceBanner');
    const text = document.getElementById('diskSpaceBannerText');
    if (!data.success || !data.checked || !data.low) {
      if (banner) banner.style.display = 'none';
      return;
    }
    text.textContent = `This box is running low on disk space (${data.availMb} MB free, ${data.usePercent}% used). Free up space soon to avoid backups, logs, or the database failing to write.`;
    banner.style.display = 'block';
  } catch (e) {
    // Non-fatal - a failed check just means the banner doesn't show.
  }
}

// ===== THEME =====
function toggleTheme() {
  const html = document.documentElement;
  const btn = document.getElementById('themeBtn');
  const isDark = html.getAttribute('data-theme') === 'dark';
  if (isDark) {
    html.setAttribute('data-theme', 'light');
    btn.innerHTML = '<i class="fas fa-moon"></i> <span class="theme-label">Dark Mode</span>';
    localStorage.setItem('rj_theme', 'light');
  } else {
    html.setAttribute('data-theme', 'dark');
    btn.innerHTML = '<i class="fas fa-sun"></i> <span class="theme-label">Light Mode</span>';
    localStorage.setItem('rj_theme', 'dark');
  }
}

// ===== SIDEBAR MINIMIZE (Workstream 13) =====
// Replaces the old per-section accordion (retired — large groups are now
// flyoutNav.js mega-menus instead) with a single whole-sidebar
// collapse-to-icon-rail toggle, matching the Omada reference. State
// persists per-browser so an operator's preference sticks across reloads.
const SIDEBAR_COLLAPSED_KEY = 'rj_sidebar_collapsed';

function toggleSidebarCollapse() {
  const sidebar = document.getElementById('sidebar');
  const layout = document.getElementById('adminLayout');
  const collapsed = sidebar.classList.toggle('collapsed');
  layout.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  if (typeof closeFlyout === 'function') closeFlyout();
}

function initSidebarCollapse() {
  if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') {
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('adminLayout').classList.add('sidebar-collapsed');
  }
}

// ===== NAVIGATION =====
const pageTitles = {
  dashboard: 'Overview',
  analytics: 'Analytics',
  users: 'Users',
  'sms-email-gateway': 'SMS / Email Gateway',
  'system-health': 'System Health',
  logs: 'Logs',
  sales: 'Sales Report',
  sessions: 'Active Sessions',
  vouchers: 'Vouchers',
  plans: 'Plans',
  routers: 'Routers',
  'access-points': 'Access Points',
  'network-devices': 'Network Devices',
  'bandwidth-profiles': 'Bandwidth Profiles',
  'firmware-flasher': 'Firmware Flasher',
  promos: 'Promos',
  rates: 'Rates Manager',
  settings: 'Settings',
  network: 'Network',
  security: 'Security',
  branding: 'Branding',
  devices: 'Vendo Devices',
  update: 'System Update',
  about: 'About',
  'coin-slot-gpio': 'Main Kiosk Coin Slot',
  'satellite-kiosks': 'Satellite Kiosks',
  'hotspot-dashboard': 'Hotspot Dashboard',
  wallet: 'Wallet Overview',
  'wallet-hotspot': 'Hotspot Earnings',
  'wallet-isp': 'ISP Earnings',
  'wallet-rental': 'Device Rental Earnings',
  'wallet-withdrawals': 'Withdrawals',
  'isp-dashboard': 'ISP Dashboard',
  'rental-dashboard': 'Device Rental Dashboard',
  'rental-devices': 'Rental Devices',
  'rental-rates': 'Rental Rates',
  'ai-assistant': 'AI Assistant',
  'network-pppoe': 'PPPoE WAN',
  'network-pfsense': 'pfSense',
  'network-mikrotik-script': 'MikroTik Setup Script',
  'mikrotik-interfaces': 'Interfaces',
  'mikrotik-wan': 'MikroTik WAN',
  'mikrotik-wireless': 'Wireless / AP',
  'mikrotik-dhcp': 'DHCP Server & Leases',
  'mikrotik-vlans': 'VLANs & Lanes',
  'mikrotik-queues': 'Bandwidth / Queues',
  'mikrotik-hotspot': 'Hotspot / Captive Portal',
  'mikrotik-firewall': 'Firewall & NAT',
  'mikrotik-backup': 'Backup & Restore',
  'mikrotik-users': 'Users & API Access',
  'mikrotik-wireguard': 'VPN / WireGuard',
  'mikrotik-routes': 'Static Routes',
  'mikrotik-logs': 'Logs',
  'isp-subscribers': 'Subscribers',
  'isp-plans': 'Plans',
  'isp-billing': 'Billing',
  'isp-sms': 'SMS Notifications',
  'isp-walled-garden': 'Walled Garden',
  'isp-import': 'Import'
};

function refreshCurrentPage() {
  const btn = event?.currentTarget;
  if (btn) {
    btn.classList.remove('spinning');
    // Force reflow so re-adding the class restarts the animation on repeat clicks.
    void btn.offsetWidth;
    btn.classList.add('spinning');
  }
  navigateTo(currentPage);
}

async function navigateTo(page) {
  // Destroy previous page intervals before switching
  if (typeof destroyAbout === 'function') destroyAbout();
  if (typeof destroySessions === 'function') destroySessions();
  if (typeof destroyDashboard === 'function') destroyDashboard();
  if (typeof destroyAnalytics === 'function') destroyAnalytics();
  if (typeof destroyUsersPage === 'function') destroyUsersPage();
  if (typeof destroyVouchersPage === 'function') destroyVouchersPage();
  if (typeof destroyHotspotDashboard === 'function') destroyHotspotDashboard();
  if (typeof destroyDevices === 'function') destroyDevices();
  if (typeof destroyNetworkDevices === 'function') destroyNetworkDevices();

  currentPage = page;

  // Update active nav item. Prefer the actual clicked element when this
  // came from a real nav-item click; otherwise (refresh button, flyout
  // link, programmatic call) look the item up by its onclick target so
  // the sidebar highlight doesn't just vanish on non-click navigations.
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });
  const clickedItem = event?.currentTarget;
  if (clickedItem?.classList.contains('nav-item')) {
    clickedItem.classList.add('active');
  } else {
    const matched = document.querySelector(`.nav-item[onclick="navigateTo('${page}')"]`);
    if (matched) matched.classList.add('active');
  }

  // Update breadcrumb
  document.getElementById('currentPageTitle').textContent =
    pageTitles[page] || page;

  // Load page
  const content = document.getElementById('pageContent');
  content.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

  // Not-yet-built roadmap tabs render an honest placeholder instead of
  // fetching a page file that doesn't exist yet.
  if (typeof COMING_SOON_PAGES !== 'undefined' && COMING_SOON_PAGES[page]) {
    renderComingSoon(content, COMING_SOON_PAGES[page]);
    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarOverlay').style.display = 'none';
    }
    return;
  }

  try {
    const res = await fetch(`pages/${page}.html`);
    if (!res.ok) throw new Error('Page not found');
    const html = await res.text();
    content.innerHTML = html;
    makeClickableDivsKeyboardAccessible(content);

    // Run page script
    const scripts = {
      dashboard: () => typeof loadDashboard === 'function' && loadDashboard(),
      analytics: () => typeof loadAnalytics === 'function' && loadAnalytics(),
      users: () => typeof loadUsersPage === 'function' && loadUsersPage(),
      'hotspot-dashboard': () => typeof loadHotspotDashboard === 'function' && loadHotspotDashboard(),
      'satellite-kiosks': () => typeof loadSatelliteKiosks === 'function' && loadSatelliteKiosks(),
      'coin-slot-gpio': () => typeof loadCoinSlotGpio === 'function' && loadCoinSlotGpio(),
      sessions: () => typeof loadSessions === 'function' && loadSessions(),
      sales: () => typeof loadSales === 'function' && loadSales(),
      rates: () => typeof loadRates === 'function' && loadRates(),
      vouchers: () => typeof loadVouchersPage === 'function' && loadVouchersPage(),
      plans: () => typeof loadPlansPage === 'function' && loadPlansPage(),
      routers: () => typeof loadRoutersPage === 'function' && loadRoutersPage(),
      'access-points': () => typeof loadAccessPointsPage === 'function' && loadAccessPointsPage(),
      'network-devices': () => typeof loadNetworkDevicesPage === 'function' && loadNetworkDevicesPage(),
      'bandwidth-profiles': () => typeof loadBandwidthProfilesPage === 'function' && loadBandwidthProfilesPage(),
      'firmware-flasher': () => typeof loadFirmwareFlasherPage === 'function' && loadFirmwareFlasherPage(),
      promos: () => typeof loadPromosPage === 'function' && loadPromosPage(),
      settings: () => typeof loadSettings === 'function' && loadSettings(),
      network: () => typeof loadNetworkPage === 'function' && loadNetworkPage(),
      security: () => typeof loadSecurity === 'function' && loadSecurity(),
      branding: () => typeof loadBranding === 'function' && loadBranding(),
      devices: () => typeof loadDevices === 'function' && loadDevices(),
      update: () => typeof loadUpdate === 'function' && loadUpdate(),
      about: () => typeof loadAbout === 'function' && loadAbout(),
      'system-health': () => typeof loadSystemHealth === 'function' && loadSystemHealth(),
      logs: () => typeof loadLogsPage === 'function' && loadLogsPage(),
    };

    if (scripts[page]) scripts[page]();

  } catch(e) {
    content.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-exclamation-triangle" style="color:var(--accent-red)"></i>
        <h3>Page not found</h3>
        <p>Could not load ${page} page.</p>
      </div>`;
  }

  // Close mobile sidebar
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').style.display = 'none';
  }
}

// ===== SIDEBAR TOGGLE =====
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const isOpen = sidebar.classList.contains('open');
  if (isOpen) {
    sidebar.classList.remove('open');
    overlay.style.display = 'none';
  } else {
    sidebar.classList.add('open');
    overlay.style.display = 'block';
  }
}

// ===== SESSION COUNT POLLING =====
// Bug: this interval's id was never stored, so nothing could ever stop it.
// Once authToken went stale for any reason (server restored from an older
// backup with a different password while a tab was still logged in, DB
// swapped out during testing, etc.), this kept firing every 15s with a bad
// password forever — each failure recorded against the new admin-login
// rate limiter, repeatedly re-triggering (and re-extending) a 429 block
// that never had a chance to clear on its own. From the outside this looks
// exactly like "everything in the admin panel is broken" (stuck loading,
// "server error" on every save) even though the actual endpoints are fine.
let sessionPollInterval = null;

function startSessionPolling() {
  updateSessionCount();
  if (sessionPollInterval) clearInterval(sessionPollInterval);
  sessionPollInterval = setInterval(updateSessionCount, 15000);
}

function stopSessionPolling() {
  if (sessionPollInterval) {
    clearInterval(sessionPollInterval);
    sessionPollInterval = null;
  }
}

async function updateSessionCount() {
  try {
    const res = await fetch(`${API}/api/admin/sessions`, {
      headers: { 'password': authToken }
    });
    if (res.status === 401) { handleAuthFailure(); return; }
    const data = await res.json();
    if (data.success) {
      // Bug: this used to be `count` (includes paused sessions, whose
      // internet is blocked), shown next to the "Active Sessions" nav label.
      document.getElementById('sessionCount').textContent = data.active_count ?? data.count ?? 0;
    }
  } catch(e) {}
}

// Bug: nothing ever reacted to a 401 from an already-"logged in" session
// (e.g. the admin password was changed in another tab, or the saved token
// is just stale) — the background pollers (session count every 15s,
// sysinfo every 5s) would keep silently retrying with the same bad
// password forever. Combined with the new admin-auth rate limit, that would
// lock the real admin out of their own panel. Log back out to the login
// screen instead of retrying.
function handleAuthFailure() {
  if (authToken === null) return; // already logged out, avoid repeat triggers
  authToken = null;
  stopSessionPolling();
  // Also stop whichever page-specific poll interval is currently running
  // (Dashboard's bandwidth chart, Live Sessions' auto-refresh, Users',
  // Devices', About's sysinfo) - stopSessionPolling() above only covers
  // app.js's own interval. Without this, the page you're sitting on keeps
  // polling with the now-null token every few seconds, forever.
  if (typeof destroyDashboard === 'function') destroyDashboard();
  if (typeof destroySessions === 'function') destroySessions();
  if (typeof destroyUsersPage === 'function') destroyUsersPage();
  if (typeof destroyDevices === 'function') destroyDevices();
  if (typeof destroyNetworkDevices === 'function') destroyNetworkDevices();
  if (typeof destroyAbout === 'function') destroyAbout();
  if (typeof destroyAnalytics === 'function') destroyAnalytics();
  if (typeof destroyVouchersPage === 'function') destroyVouchersPage();
  if (typeof destroyHotspotDashboard === 'function') destroyHotspotDashboard();
  sessionStorage.removeItem('rj_admin_token');
  sessionStorage.removeItem('rj_admin_user');
  document.getElementById('adminLayout').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'block';
  showLoginError('Session expired or invalid. Please log in again.');
}

// ===== API HELPER =====
// Bug: background poll intervals (Dashboard's bandwidth chart, Live
// Sessions' auto-refresh, etc.) only get cleared when navigateTo() switches
// pages - a tab left open in the background keeps polling forever. Once
// auth failed once and authToken was cleared to null, this function still
// fired the fetch anyway, sending the literal string "null" as the
// password header. That fails auth again, records another spam attempt,
// and repeats every few seconds indefinitely - silently re-triggering the
// "Too many attempts" block over and over from a tab nobody is looking at.
// Short-circuiting here (the one shared place every poll goes through)
// stops every caller at once instead of having to fix each interval.
async function apiCall(method, endpoint, body = null) {
  if (!authToken) {
    return { success: false, message: 'Not authenticated' };
  }
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'password': authToken
    }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${API}${endpoint}`, options);
  if (res.status === 401) { handleAuthFailure(); }
  return res.json();
}

// ===== DURATION FORMATTING =====
// "Minutes Sold" style stats used to show a raw minute count (e.g. "2000
// mins") once a busy day added up - reads as a big, hard-to-parse number
// instead of the "about 1 day 9 hours" an owner actually wants at a
// glance. Auto-scales to the coarsest unit that still fits.
function formatDurationShort(totalMinutes) {
  const mins = Math.round(totalMinutes || 0);
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'}`;

  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const remMins = mins % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

// ===== TOAST NOTIFICATION =====
function showToast(message, type = 'success') {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();

  const colors = {
    success: 'var(--card-green-bg)',
    error: 'var(--card-red-bg)',
    warning: 'var(--card-orange-bg)',
    info: 'var(--card-blue-bg)'
  };
  const textColors = {
    success: 'var(--card-green-text)',
    error: 'var(--card-red-text)',
    warning: 'var(--card-orange-text)',
    info: 'var(--card-blue-text)'
  };
  const icons = {
    success: 'fa-check-circle',
    error: 'fa-times-circle',
    warning: 'fa-exclamation-triangle',
    info: 'fa-info-circle'
  };

  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: ${colors[type]};
    color: ${textColors[type]};
    padding: 12px 20px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    z-index: 9999;
    animation: slideIn 0.3s ease;
  `;
  toast.innerHTML = `<i class="fas ${icons[type]}"></i> ${message}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ===== POWER CONTROLS (Reboot/Shutdown) =====
let powerConfirmAction = null; // 'reboot' | 'shutdown'

function openPowerConfirm(action) {
  powerConfirmAction = action;
  const isReboot = action === 'reboot';
  document.getElementById('powerConfirmTitle').textContent = isReboot ? 'Reboot Server' : 'Shutdown Server';
  document.getElementById('powerConfirmMessage').textContent = isReboot
    ? 'The server will restart. The admin panel and customer portal will be briefly unreachable, then come back on their own.'
    : 'The server will power off completely and will NOT come back on by itself, someone must physically power it back on. All customers will lose internet access until then.';
  const word = isReboot ? 'REBOOT' : 'SHUTDOWN';
  document.getElementById('powerConfirmWord').textContent = word;
  document.getElementById('powerConfirmInput').value = '';
  document.getElementById('powerConfirmBtn').disabled = true;
  document.getElementById('powerConfirmBtnLabel').textContent = isReboot ? 'Reboot Now' : 'Shutdown Now';
  document.getElementById('powerConfirmModal').classList.add('show');
}

function closePowerConfirm() {
  document.getElementById('powerConfirmModal').classList.remove('show');
  powerConfirmAction = null;
}

function checkPowerConfirmInput() {
  const word = powerConfirmAction === 'reboot' ? 'REBOOT' : 'SHUTDOWN';
  document.getElementById('powerConfirmBtn').disabled = document.getElementById('powerConfirmInput').value !== word;
}

async function executePowerAction() {
  const action = powerConfirmAction;
  const word = action === 'reboot' ? 'REBOOT' : 'SHUTDOWN';
  const btn = document.getElementById('powerConfirmBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Working...';

  try {
    const data = await apiCall('POST', `/api/admin/system/${action}`, { confirm: word });
    if (data.success) {
      showToast(data.message, 'success');
      closePowerConfirm();
    } else {
      showToast(data.message || 'Failed', 'error');
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-exclamation-triangle"></i> ${action === 'reboot' ? 'Reboot Now' : 'Shutdown Now'}`;
    }
  } catch (e) {
    // The connection dropping is expected here — the server is rebooting/
    // shutting down mid-response, not necessarily an actual failure.
    showToast(action === 'reboot' ? 'Rebooting...' : 'Shutting down...', 'success');
    closePowerConfirm();
  }
}

// ===== FIELD HELP POPOVER =====
// Small "?" or book icon next to a field label, click to show a short
// tooltip instead of always-visible gray paragraph text under every
// field. One document-level delegate so it works on every page loaded
// dynamically into #pageContent, no per-page rebinding needed.
function initFieldHelp() {
  document.addEventListener('click', (e) => {
    const existing = document.querySelector('.field-help-popover');
    if (existing) existing.remove();

    const trigger = e.target.closest('.field-help');
    if (!trigger) return;
    e.stopPropagation();

    const popover = document.createElement('div');
    popover.className = 'field-help-popover';
    popover.textContent = trigger.dataset.help || '';
    document.body.appendChild(popover);

    const rect = trigger.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    let left = rect.left;
    if (left + popRect.width > window.innerWidth - 12) {
      left = window.innerWidth - popRect.width - 12;
    }
    popover.style.left = `${Math.max(12, left)}px`;
    popover.style.top = `${rect.bottom + 8}px`;
  });
}

// ===== INIT =====
function init() {
  initSidebarCollapse();
  makeClickableDivsKeyboardAccessible(document);

  // Load saved theme
  const savedTheme = localStorage.getItem('rj_theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  const btn = document.getElementById('themeBtn');
  if (savedTheme === 'dark') {
    btn.innerHTML = '<i class="fas fa-sun"></i> Light Mode';
  }

  // Check saved session
  const savedToken = sessionStorage.getItem('rj_admin_token');
  if (savedToken) {
    authToken = savedToken;
    showAdmin();
  } else {
    document.getElementById('loginScreen').style.display = 'block';
  }

  initFieldHelp();

  // Boot loading screen (branded, replaces the blank-white flash that used
  // to show while init() decided login vs admin) - hidden last so it
  // covers that whole decision, not just page paint.
  const bootLoading = document.getElementById('bootLoading');
  if (bootLoading) bootLoading.style.display = 'none';
}

// Add slide-in animation
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(100px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
`;
document.head.appendChild(style);

init();