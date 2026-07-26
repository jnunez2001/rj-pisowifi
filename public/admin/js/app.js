const API = '';
let authToken = null;
let currentPage = 'dashboard';

// ===== AUTH =====
async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;

  if (!username || !password) {
    showLoginError('Please enter username and password.');
    return;
  }

  try {
    const res = await fetch(`${API}/api/admin/settings`, {
      headers: { 'password': password }
    });

    if (res.status === 401) {
      showLoginError('Invalid username or password.');
      return;
    }

    // Verify username against settings
    const data = await res.json();
    const savedUsername = data.settings?.admin_username || 'admin';

    if (username !== savedUsername) {
      showLoginError('Invalid username or password.');
      return;
    }

    authToken = password;
    sessionStorage.setItem('rj_admin_token', password);
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

function showAdmin() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('adminLayout').style.display = 'flex';
  navigateTo('dashboard');
  startSessionPolling();
  if (typeof refreshRouterFlyoutVisibility === 'function') refreshRouterFlyoutVisibility();
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
  sales: 'Sales Report',
  sessions: 'Active Sessions',
  vouchers: 'Vouchers',
  promos: 'Promos',
  rates: 'Rates Manager',
  settings: 'Settings',
  network: 'Network',
  security: 'Security',
  branding: 'Branding',
  devices: 'Devices',
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
  if (typeof destroyHotspotDashboard === 'function') destroyHotspotDashboard();

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

    // Run page script
    const scripts = {
      dashboard: () => typeof loadDashboard === 'function' && loadDashboard(),
      'hotspot-dashboard': () => typeof loadHotspotDashboard === 'function' && loadHotspotDashboard(),
      'satellite-kiosks': () => typeof loadSatelliteKiosks === 'function' && loadSatelliteKiosks(),
      'coin-slot-gpio': () => typeof loadCoinSlotGpio === 'function' && loadCoinSlotGpio(),
      sessions: () => typeof loadSessions === 'function' && loadSessions(),
      sales: () => typeof loadSales === 'function' && loadSales(),
      rates: () => typeof loadRates === 'function' && loadRates(),
      vouchers: () => typeof loadVouchers === 'function' && loadVouchers(),
      promos: () => typeof loadPromosPage === 'function' && loadPromosPage(),
      settings: () => typeof loadSettings === 'function' && loadSettings(),
      network: () => typeof loadNetworkPage === 'function' && loadNetworkPage(),
      security: () => typeof loadSecurity === 'function' && loadSecurity(),
      branding: () => typeof loadBranding === 'function' && loadBranding(),
      devices: () => typeof loadDevices === 'function' && loadDevices(),
      update: () => typeof loadUpdate === 'function' && loadUpdate(),
      about: () => typeof loadAbout === 'function' && loadAbout(),
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
  sessionStorage.removeItem('rj_admin_token');
  sessionStorage.removeItem('rj_admin_user');
  document.getElementById('adminLayout').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'block';
  showLoginError('Session expired or invalid. Please log in again.');
}

// ===== API HELPER =====
async function apiCall(method, endpoint, body = null) {
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