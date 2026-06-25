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
  document.getElementById('adminLayout').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'block';
  document.getElementById('loginPassword').value = '';
}

function showAdmin() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('adminLayout').style.display = 'flex';
  navigateTo('dashboard');
  startSessionPolling();
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

// ===== NAVIGATION =====
const pageTitles = {
  dashboard: 'Dashboard',
  sales: 'Sales Report',
  sessions: 'Active Sessions',
  promos: 'Promo Vouchers',
  rates: 'Rates Manager',
  settings: 'Settings',
  security: 'Security',
  branding: 'Branding',
  devices: 'Devices',
  update: 'System Update',
  about: 'About'
};

async function navigateTo(page) {
  // Destroy previous page intervals before switching
  if (typeof destroyAbout === 'function') destroyAbout();

  currentPage = page;

  // Update active nav item
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });
  event?.currentTarget?.classList.add('active');

  // Update breadcrumb
  document.getElementById('currentPageTitle').textContent =
    pageTitles[page] || page;

  // Load page
  const content = document.getElementById('pageContent');
  content.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

  try {
    const res = await fetch(`pages/${page}.html`);
    if (!res.ok) throw new Error('Page not found');
    const html = await res.text();
    content.innerHTML = html;

    // Run page script
    const scripts = {
      dashboard: () => typeof loadDashboard === 'function' && loadDashboard(),
      sessions: () => typeof loadSessions === 'function' && loadSessions(),
      sales: () => typeof loadSales === 'function' && loadSales(),
      rates: () => typeof loadRates === 'function' && loadRates(),
      promos: () => typeof loadPromos === 'function' && loadPromos(),
      settings: () => typeof loadSettings === 'function' && loadSettings(),
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
function startSessionPolling() {
  updateSessionCount();
  setInterval(updateSessionCount, 15000);
}

async function updateSessionCount() {
  try {
    const res = await fetch(`${API}/api/admin/sessions`, {
      headers: { 'password': authToken }
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('sessionCount').textContent = data.count || 0;
    }
  } catch(e) {}
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

// ===== INIT =====
function init() {
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