// ===== FLYOUT MEGA-MENUS (Workstream 13 Foundation) =====
// Replaces the old always-expanded accordion for large tab groups.
// Sidebar items with many children (MikroTik Control Center's 13 tabs,
// ISP Tools' 7, etc.) are single flyout triggers instead of dozens of
// individual rows — the panel opens beside the sidebar, columned, plain
// links, closes on outside-click or Escape. See docs/design/omada-
// reference.md for the reference this pattern is drawn from.

// Column definitions per the named settings taxonomy. Each column has a
// heading and a list of { page, label, icon } entries that call the
// existing navigateTo(page) — no new routing needed, this is purely a
// different way of presenting the same nav targets.
const FLYOUT_MENUS = {
  network: {
    title: 'Network',
    columns: [
      {
        heading: 'General',
        items: [
          { page: 'settings', label: 'Site Settings', icon: 'fa-store' },
          { page: 'settings', label: 'Admin Credentials', icon: 'fa-user-shield' },
          { page: 'settings', label: 'Backup & Restore', icon: 'fa-box-archive' },
        ],
      },
      {
        heading: 'Connectivity',
        items: [
          { page: 'network', label: 'Server IP & Network Mode', icon: 'fa-network-wired' },
          { page: 'network-pppoe', label: 'PPPoE WAN', icon: 'fa-plug' },
          { page: 'network-pfsense', label: 'pfSense', icon: 'fa-shield-halved' },
        ],
      },
    ],
  },
  router: {
    title: 'Router (MikroTik)',
    columns: [
      {
        heading: 'Connection',
        items: [
          { page: 'network', label: 'MikroTik Connection', icon: 'fa-plug-circle-bolt' },
          { page: 'network-mikrotik-script', label: 'Generate Setup Script', icon: 'fa-terminal' },
        ],
      },
      {
        heading: 'Interfaces & WAN',
        items: [
          { page: 'mikrotik-interfaces', label: 'Interfaces', icon: 'fa-ethernet' },
          { page: 'mikrotik-wan', label: 'WAN', icon: 'fa-globe' },
          { page: 'mikrotik-wireless', label: 'Wireless / AP', icon: 'fa-wifi' },
        ],
      },
      {
        heading: 'Addressing & Shaping',
        items: [
          { page: 'mikrotik-dhcp', label: 'DHCP Server & Leases', icon: 'fa-list-ol' },
          { page: 'mikrotik-vlans', label: 'VLANs & Lanes', icon: 'fa-diagram-project' },
          { page: 'mikrotik-queues', label: 'Bandwidth / Queues', icon: 'fa-gauge-high' },
        ],
      },
      {
        heading: 'Access Control',
        items: [
          { page: 'mikrotik-hotspot', label: 'Hotspot / Captive Portal', icon: 'fa-door-open' },
          { page: 'mikrotik-firewall', label: 'Firewall & NAT', icon: 'fa-fire' },
        ],
      },
      {
        heading: 'Remote & Recovery',
        items: [
          { page: 'mikrotik-wireguard', label: 'VPN / WireGuard', icon: 'fa-lock' },
          { page: 'mikrotik-backup', label: 'Backup & Restore', icon: 'fa-box-archive' },
          { page: 'mikrotik-users', label: 'Users & API Access', icon: 'fa-user-shield' },
          { page: 'mikrotik-routes', label: 'Static Routes', icon: 'fa-route' },
          { page: 'mikrotik-logs', label: 'Logs', icon: 'fa-scroll' },
        ],
      },
    ],
  },
  wallet: {
    title: 'Wallet',
    columns: [
      {
        heading: 'Overview',
        items: [
          { page: 'wallet', label: 'Wallet Overview', icon: 'fa-wallet' },
        ],
      },
      {
        // Every balance/ledger entry is tagged by which business line earned
        // it, so an operator running more than one line can tell the income
        // streams apart at a glance instead of one merged number.
        heading: 'Earnings by Business Line',
        items: [
          { page: 'wallet-hotspot', label: 'Hotspot Earnings', icon: 'fa-bolt' },
          { page: 'wallet-isp', label: 'ISP Earnings', icon: 'fa-globe' },
          { page: 'wallet-rental', label: 'Device Rental Earnings', icon: 'fa-mobile-screen' },
        ],
      },
      {
        heading: 'Payouts',
        items: [
          { page: 'wallet-withdrawals', label: 'Withdrawals', icon: 'fa-money-bill-transfer' },
        ],
      },
    ],
  },
  isp: {
    title: 'ISP',
    columns: [
      {
        heading: 'Overview',
        items: [
          { page: 'isp-dashboard', label: 'ISP Dashboard', icon: 'fa-gauge-high' },
        ],
      },
      {
        heading: 'Subscribers & Billing',
        items: [
          { page: 'isp-subscribers', label: 'Subscribers', icon: 'fa-users-gear' },
          { page: 'isp-plans', label: 'Plans', icon: 'fa-gauge' },
          { page: 'isp-billing', label: 'Billing', icon: 'fa-file-invoice-dollar' },
        ],
      },
      {
        heading: 'Communication',
        items: [
          { page: 'isp-sms', label: 'SMS Notifications', icon: 'fa-comment-sms' },
        ],
      },
      {
        heading: 'Access & Data',
        items: [
          { page: 'isp-walled-garden', label: 'Walled Garden', icon: 'fa-tree' },
          { page: 'isp-import', label: 'Import', icon: 'fa-file-csv' },
        ],
      },
    ],
  },
  hotspot: {
    title: 'Hotspot',
    columns: [
      {
        heading: 'Overview',
        items: [
          { page: 'hotspot-dashboard', label: 'Hotspot Dashboard', icon: 'fa-gauge-high' },
        ],
      },
      {
        heading: 'Sales & Access',
        items: [
          { page: 'vouchers', label: 'Vouchers', icon: 'fa-ticket-alt' },
          { page: 'plans', label: 'Plans', icon: 'fa-list-check' },
          { page: 'promos', label: 'Promos', icon: 'fa-gift' },
          { page: 'rates', label: 'Rates Manager', icon: 'fa-peso-sign' },
          { page: 'coin-slot-gpio', label: 'Main Kiosk Coin Slot', icon: 'fa-coins' },
          { page: 'satellite-kiosks', label: 'Satellite Kiosks', icon: 'fa-tower-broadcast' },
        ],
      },
      {
        heading: 'Portal Settings',
        items: [
          { page: 'security', label: 'Security', icon: 'fa-shield-alt' },
          { page: 'branding', label: 'Branding', icon: 'fa-palette' },
        ],
      },
    ],
  },
  rental: {
    title: 'Device Rental',
    columns: [
      {
        heading: 'Overview',
        items: [
          { page: 'rental-dashboard', label: 'Device Rental Dashboard', icon: 'fa-gauge-high' },
        ],
      },
      {
        heading: 'Devices & Rates',
        items: [
          { page: 'rental-devices', label: 'Rental Devices', icon: 'fa-mobile-screen' },
          { page: 'rental-rates', label: 'Rental Rates', icon: 'fa-peso-sign' },
        ],
      },
    ],
  },
  system: {
    title: 'System',
    columns: [
      {
        heading: 'System',
        items: [
          { page: 'update', label: 'System Update', icon: 'fa-sync-alt' },
          { page: 'about', label: 'About', icon: 'fa-info-circle' },
        ],
      },
    ],
  },
};

let _openFlyoutKey = null;
let _flyoutEl = null;

const FLYOUT_MOBILE_BREAKPOINT = 768;

// venue_type-driven overrides applied on top of FLYOUT_MENUS at render
// time - kept as a small lookup table here rather than hardcoding
// per-venue branches into the menu structure itself, so adding a new
// venue type later means adding one entry here, not restructuring the
// whole nav. `window.currentVenueType` is set once at login (see
// app.js's showAdmin()), defaults to 'piso_wifi' so an install that never
// touches the new Business Type setting sees zero change.
const VENUE_LABEL_OVERRIDES = {
  cafe: { vouchers: 'Guest Passes' },
  coworking: { vouchers: 'Member Access' },
};
// Coin-slot hardware is Piso WiFi-specific - a cafe or co-working space
// has no coin acceptor to configure. Hidden, not just relabeled, same
// "don't show a card with nothing behind it" rule used elsewhere.
const VENUE_HIDDEN_PAGES = {
  cafe: ['coin-slot-gpio'],
  coworking: ['coin-slot-gpio'],
};

function _buildFlyoutPanel(key) {
  const menu = FLYOUT_MENUS[key];
  if (!menu) return null;
  const isMobile = window.innerWidth <= FLYOUT_MOBILE_BREAKPOINT;
  const venueType = window.currentVenueType || 'piso_wifi';
  const labelOverrides = VENUE_LABEL_OVERRIDES[venueType] || {};
  const hiddenPages = VENUE_HIDDEN_PAGES[venueType] || [];

  const panel = document.createElement('div');
  panel.className = 'flyout-panel';
  panel.id = 'flyoutPanel';

  const mobileHeader = isMobile
    ? `<div class="flyout-mobile-header">
         <div class="flyout-mobile-title">${menu.title}</div>
         <button class="flyout-mobile-close" onclick="closeFlyout()"><i class="fas fa-times"></i></button>
       </div>`
    : '';

  panel.innerHTML = mobileHeader + menu.columns.map((col) => `
    <div class="flyout-column">
      <div class="flyout-column-heading">${col.heading}</div>
      ${col.items.filter((item) => !hiddenPages.includes(item.page)).map((item) => `
        <div class="flyout-link" data-page="${item.page}">
          <i class="fas ${item.icon}"></i>
          <span>${labelOverrides[item.page] || item.label}</span>
        </div>
      `).join('')}
    </div>
  `).join('');

  panel.querySelectorAll('.flyout-link').forEach((el) => {
    el.addEventListener('click', () => {
      const page = el.dataset.page;
      closeFlyout();
      // Reuse the existing router — flyout links are just another way to
      // reach the same navigateTo() targets every other nav item uses.
      navigateTo(page);
    });
  });

  return panel;
}

function toggleFlyout(key, triggerEl) {
  if (_openFlyoutKey === key) {
    closeFlyout();
    return;
  }
  closeFlyout();

  const panel = _buildFlyoutPanel(key);
  if (!panel) return;

  document.body.appendChild(panel);
  if (typeof makeClickableDivsKeyboardAccessible === 'function') makeClickableDivsKeyboardAccessible(panel);
  _flyoutEl = panel;
  _openFlyoutKey = key;
  triggerEl.classList.add('flyout-trigger-active');

  const sidebarRect = document.getElementById('sidebar').getBoundingClientRect();
  const triggerRect = triggerEl.getBoundingClientRect();
  panel.style.left = `${sidebarRect.right}px`;
  panel.style.top = `${Math.max(8, triggerRect.top)}px`;

  // Defer listener registration one tick so the click that opened the
  // flyout doesn't immediately bubble into the outside-click handler and
  // close it right back.
  setTimeout(() => {
    document.addEventListener('click', _handleOutsideClick);
    document.addEventListener('keydown', _handleEscape);
  }, 0);
}

function closeFlyout() {
  if (_flyoutEl) {
    _flyoutEl.remove();
    _flyoutEl = null;
  }
  document.querySelectorAll('.flyout-trigger-active').forEach((el) => el.classList.remove('flyout-trigger-active'));
  _openFlyoutKey = null;
  document.removeEventListener('click', _handleOutsideClick);
  document.removeEventListener('keydown', _handleEscape);
}

function _handleOutsideClick(e) {
  if (_flyoutEl && !_flyoutEl.contains(e.target) && !e.target.closest('.nav-flyout-trigger')) {
    closeFlyout();
  }
}

function _handleEscape(e) {
  if (e.key === 'Escape') closeFlyout();
}

// Router flyout trigger only makes sense when network_mode = mikrotik —
// checked once after login and whenever Network settings are saved.
async function refreshRouterFlyoutVisibility() {
  try {
    const data = await apiCall('GET', '/api/admin/settings');
    const trigger = document.getElementById('routerFlyoutTrigger');
    if (trigger && data.success) {
      trigger.style.display = data.settings.network_mode === 'mikrotik' ? 'flex' : 'none';
    }
  } catch (e) {
    // Non-fatal — leave the Router entry hidden if settings can't be read.
  }
}
