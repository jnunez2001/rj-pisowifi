// ===== PC RENTAL - STANDALONE ADMIN SHELL =====
// Opened in its own browser tab from the main StarkFi admin (Manage PC
// deserves its own nav tree, not one squeezed item in the main sidebar).
// Reuses the main admin's session token (sessionStorage is cloned into a
// same-origin tab opened via window.open/target=_blank, per spec) rather
// than requiring a second login.
const API = '';
let authToken = sessionStorage.getItem('rj_admin_token');

if (!authToken) {
  // No session to inherit (e.g. this URL was opened directly, or in a
  // browser that doesn't clone sessionStorage into new tabs) - send them
  // to log in on the main admin instead of showing a broken blank shell.
  window.location.href = '../index.html';
}

// Same shape as the main admin's app.js apiCall() - kept as a small local
// copy rather than loading the whole app.js (which brings in unrelated
// dashboard/session polling this standalone page has no use for).
const inFlightGets = new Map();
async function apiCall(method, endpoint, body = null) {
  if (!authToken) return { success: false, message: 'Not authenticated' };
  if (method === 'GET' && !body && inFlightGets.has(endpoint)) {
    return inFlightGets.get(endpoint);
  }
  const options = { method, headers: { 'Content-Type': 'application/json', 'password': authToken } };
  if (body) options.body = JSON.stringify(body);
  const promise = (async () => {
    const res = await fetch(`${API}${endpoint}`, options);
    if (res.status === 401) { sessionStorage.removeItem('rj_admin_token'); window.location.href = '../index.html'; }
    return res.json();
  })();
  if (method === 'GET' && !body) {
    inFlightGets.set(endpoint, promise);
    promise.finally(() => inFlightGets.delete(endpoint));
  }
  return promise;
}

const RENTAL_PANEL_TITLES = {
  dashboard: 'Dashboard', managepc: 'Manage PC', members: 'Members',
  timerrates: 'Timer Rates', redeemrates: 'Redeem Rates',
  redeemhistory: 'Redeem History', reports: 'Reports', coinslot: 'Coinslot',
  settings: 'Settings', systeminfo: 'System Info'
};

// Panels not built yet render an honest placeholder instead of pretending
// - same pattern the main admin uses for its own not-yet-built roadmap
// tabs (app.js's COMING_SOON_PAGES). Members/Redeem Rates/Redeem History/
// Reports are real now (see js/rental.js) - only Sub-Coinslot (per-PC
// dedicated hardware, not built - v1 is a single shared coin box) and
// PC Performance/Spectate (deferred, need a system-stats/screen-streaming
// agent on the Windows client) stay placeholders.
const RENTAL_COMING_SOON = {
  systeminfo: 'Per-PC system information (CPU, RAM, disk) - needs a stats agent on the Windows client'
};

// Real panels load their content once, on first switch to them, rather
// than all up front - same lazy-load reasoning as the main admin's SPA
// page loader.
const RENTAL_PANEL_LOADERS = {
  members: refreshRentalMembers,
  timerrates: refreshRentalRates,
  redeemrates: refreshRentalRedeemRates,
  redeemhistory: refreshRentalRedemptions,
  reports: refreshRentalReports,
  settings: loadRentalSettings,
  coinslot: loadRentalCoinslotSettings
};

function switchRentalPanel(panel) {
  document.querySelectorAll('.rental-shell-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.panel === panel);
  });
  document.querySelectorAll('.rental-panel').forEach((el) => { el.style.display = 'none'; });
  const target = document.getElementById(`rentalPanel${panel.charAt(0).toUpperCase()}${panel.slice(1)}`);
  if (target) {
    target.style.display = 'block';
    if (RENTAL_COMING_SOON[panel] && !target.dataset.rendered) {
      target.dataset.rendered = '1';
      target.innerHTML = `
        <div class="rental-coming-soon">
          <i class="fas fa-hammer"></i>
          <div style="font-weight:700;margin-bottom:4px;">Coming soon</div>
          <div>${RENTAL_COMING_SOON[panel]}</div>
        </div>`;
    } else if (RENTAL_PANEL_LOADERS[panel]) {
      RENTAL_PANEL_LOADERS[panel]();
    }
  }
  document.getElementById('rentalPanelTitle').textContent = RENTAL_PANEL_TITLES[panel] || panel;
}

async function refreshRentalDashboard() {
  const data = await apiCall('GET', '/api/admin/rental/pcs');
  const pcs = data.pcs || [];
  document.getElementById('rentalStatTotal').textContent = pcs.length;
  document.getElementById('rentalStatUnlocked').textContent = pcs.filter((p) => p.status === 'adopted' && !p.locked).length;
  document.getElementById('rentalStatCandidates').textContent = pcs.filter((p) => p.status !== 'adopted').length;

  const el = document.getElementById('rentalDashboardList');
  el.innerHTML = pcs.length
    ? pcs.map(renderRentalPcRow).join('')
    : '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No rental PCs yet - run the Windows client on a PC to have it appear here.</div>';
}

if (authToken) {
  loadRentalPage(); // from ../js/rental.js - populates Manage PC + Timer Rates panels
  refreshRentalDashboard();
  setInterval(refreshRentalDashboard, 5000);
}
