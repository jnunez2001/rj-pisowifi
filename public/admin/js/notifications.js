// ===== NOTIFICATION BELL =====
// Replaces the old standalone Alerts nav page. Pulls from the same
// GET /api/admin/alerts endpoint, which now merges the live-recomputed
// health checks with the persisted alert_events log (server/services/
// alertEventService.js) - see admin.js for both.
//
// "Seen" tracking is just a localStorage timestamp (this is a single-admin
// panel, no per-user server-side state needed): any alert newer than the
// last time the dropdown was opened counts as unseen and lights the dot.
const NOTIF_LAST_SEEN_KEY = 'notif_last_seen_at';
const NOTIF_POLL_MS = 30000;
const NOTIF_POLL_JITTER_MS = 8000;

let notifAlertsCache = [];
let notifLastPolledAt = null;
let notifDropdownOpen = false;

function getNotifLastSeen() {
  return localStorage.getItem(NOTIF_LAST_SEEN_KEY) || '1970-01-01T00:00:00.000Z';
}

function setNotifLastSeen(iso) {
  localStorage.setItem(NOTIF_LAST_SEEN_KEY, iso);
}

const NOTIF_SEVERITY_ICON = {
  critical: { icon: 'fa-circle-exclamation', color: 'var(--accent-red)' },
  warning: { icon: 'fa-triangle-exclamation', color: 'var(--accent-orange)' },
  info: { icon: 'fa-circle-info', color: 'var(--accent-blue)' },
};

function renderNotifDropdown() {
  const body = document.getElementById('notifDropdownBody');
  if (!body) return;
  if (!notifAlertsCache.length) {
    body.innerHTML = `
      <div style="text-align:center;color:var(--text-muted);padding:24px 16px;font-size:13px;">
        <i class="fas fa-circle-check" style="font-size:18px;color:var(--accent-green);margin-bottom:8px;display:block;"></i>
        No alerts - everything checked out clean.
      </div>`;
    return;
  }
  body.innerHTML = notifAlertsCache.map((a) => {
    const meta = NOTIF_SEVERITY_ICON[a.severity] || NOTIF_SEVERITY_ICON.info;
    return `
      <div class="notif-item">
        <i class="fas ${meta.icon}" style="color:${meta.color};margin-top:2px;"></i>
        <div style="min-width:0;">
          <div class="notif-item-title">${a.title}</div>
          ${a.detail ? `<div class="notif-item-detail">${a.detail}</div>` : ''}
          <div class="notif-item-time">${new Date(a.time).toLocaleString()}</div>
        </div>
      </div>`;
  }).join('');
}

function updateNotifDot() {
  const dot = document.getElementById('notifDot');
  if (!dot) return;
  const lastSeen = new Date(getNotifLastSeen()).getTime();
  const hasUnseen = notifAlertsCache.some((a) => new Date(a.time).getTime() > lastSeen);
  dot.style.display = hasUnseen ? 'block' : 'none';
}

async function fetchNotifAlerts() {
  try {
    const data = await apiCall('GET', '/api/admin/alerts');
    if (!data.success) return;
    const previousNewest = notifLastPolledAt;
    notifAlertsCache = data.alerts || [];

    // Toast for anything newer than what we last polled (skip the very
    // first fetch after page load - nothing to compare against yet, and
    // it would otherwise toast the entire history on every login).
    if (previousNewest) {
      const newOnes = notifAlertsCache.filter((a) => new Date(a.time).getTime() > previousNewest);
      newOnes.forEach((a) => {
        const type = a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warning' : 'info';
        showToast(`${a.title}${a.detail ? ' - ' + a.detail : ''}`, type);
      });
    }

    if (notifAlertsCache.length) {
      notifLastPolledAt = Math.max(...notifAlertsCache.map((a) => new Date(a.time).getTime()));
    }

    if (notifDropdownOpen) renderNotifDropdown();
    updateNotifDot();
  } catch (e) {
    // Silent - this is background polling, not a user-initiated action.
  }
}

function toggleNotifDropdown(evt) {
  if (evt) evt.stopPropagation();
  const dropdown = document.getElementById('notifDropdown');
  if (!dropdown) return;
  notifDropdownOpen = dropdown.style.display !== 'block';
  dropdown.style.display = notifDropdownOpen ? 'block' : 'none';
  if (notifDropdownOpen) {
    renderNotifDropdown();
    setNotifLastSeen(new Date().toISOString());
    updateNotifDot();
  }
}

document.addEventListener('click', (e) => {
  if (notifDropdownOpen && !e.target.closest('.notif-bell-wrap')) {
    document.getElementById('notifDropdown').style.display = 'none';
    notifDropdownOpen = false;
  }
});

function startNotifPolling() {
  fetchNotifAlerts();
  const tick = () => {
    fetchNotifAlerts();
    setTimeout(tick, NOTIF_POLL_MS + Math.random() * NOTIF_POLL_JITTER_MS);
  };
  setTimeout(tick, NOTIF_POLL_MS + Math.random() * NOTIF_POLL_JITTER_MS);
}

// Kicked off once the admin is authenticated and the dashboard is ready
// (dashboardReady() in app.js) rather than at plain script-load time.
