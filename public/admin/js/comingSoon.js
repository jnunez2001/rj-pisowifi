// ===== COMING SOON PLACEHOLDER =====
// Renders an honest "not built yet" state for tabs that exist in the nav
// (so the full ZenFi roadmap is visible) but have no backend behind them
// yet. No fake data, no dead buttons — just the page title, what it will
// do once built, and which roadmap workstream it belongs to.
function renderComingSoon(container, { icon = 'fa-hourglass-half', title, description, workstream }) {
  container.innerHTML = `
    <div class="page-title">${title}</div>
    <div class="page-subtitle">${description}</div>
    <div class="empty-state" style="margin-top:16px;">
      <i class="fas ${icon}"></i>
      <h3>Coming Soon</h3>
      <p>${description}</p>
      ${workstream ? `<span class="badge badge-blue" style="margin-top:12px;">${workstream}</span>` : ''}
    </div>
  `;
}

// Registry of not-yet-built pages: page key -> { icon, title, description, workstream }.
// navigateTo() in app.js checks this before attempting to fetch pages/<page>.html —
// so these tabs never 404, they just render this placeholder directly.
const COMING_SOON_PAGES = {
  'wallet': {
    icon: 'fa-wallet',
    title: 'Wallet Overview',
    description: 'Accept online payments (GCash, Maya, and more via Xendit) alongside coins and vouchers. Balance and withdrawal go through the central ZenFi platform, which takes a 5% + ₱23 fee per withdrawal. Combined balance across every business line you run.',
    workstream: 'Workstream 5'
  },
  'wallet-hotspot': {
    icon: 'fa-bolt',
    title: 'Hotspot Earnings',
    description: 'Revenue breakdown from coin, voucher, and online-payment sales through your Hotspot line specifically, kept separate from ISP and Device Rental income.',
    workstream: 'Workstream 5'
  },
  'wallet-isp': {
    icon: 'fa-globe',
    title: 'ISP Earnings',
    description: 'Revenue breakdown from subscriber billing through your ISP line specifically, kept separate from Hotspot and Device Rental income.',
    workstream: 'Workstream 5'
  },
  'wallet-rental': {
    icon: 'fa-mobile-screen',
    title: 'Device Rental Earnings',
    description: 'Revenue breakdown from tablet/phone rental sessions specifically, kept separate from Hotspot and ISP income.',
    workstream: 'Workstream 5'
  },
  'wallet-withdrawals': {
    icon: 'fa-money-bill-transfer',
    title: 'Withdrawals',
    description: 'Request a payout of your combined wallet balance to your bank account. A 5% + ₱23 fee applies per withdrawal.',
    workstream: 'Workstream 5'
  },
  'isp-dashboard': {
    icon: 'fa-gauge-high',
    title: 'ISP Dashboard',
    description: 'A dedicated at-a-glance view of your ISP line only: subscriber counts, due-soon/overdue accounts, and billing revenue, separate from Hotspot and Device Rental numbers.',
    workstream: 'Workstream 12'
  },
  'rental-dashboard': {
    icon: 'fa-gauge-high',
    title: 'Device Rental Dashboard',
    description: 'A dedicated at-a-glance view of your Device Rental line only: devices in use, revenue, and rental session activity, separate from Hotspot and ISP numbers.',
    workstream: 'Workstream 6'
  },
  'rental-devices': {
    icon: 'fa-mobile-screen',
    title: 'Rental Devices',
    description: 'Register rental devices by MAC address and let customers pay by coin or wallet to unlock a device for a set number of minutes.',
    workstream: 'Workstream 6'
  },
  'rental-rates': {
    icon: 'fa-peso-sign',
    title: 'Rental Rates',
    description: 'Set pricing tiers for tablet/phone rental sessions, separate from Hotspot\'s coin/voucher rates.',
    workstream: 'Workstream 6'
  },
  'ai-assistant': {
    icon: 'fa-robot',
    title: 'AI Assistant',
    description: 'A built-in helper that answers setup and troubleshooting questions grounded in this box\'s actual live settings. Available here in the admin panel and as a guide in the customer portal.',
    workstream: 'Workstream 7'
  },
  'network-pppoe': {
    icon: 'fa-plug',
    title: 'PPPoE WAN',
    description: 'Connect to ISPs that require PPPoE authentication (username/password login) instead of plain DHCP or a static IP.',
    workstream: 'Workstream 2'
  },
  'network-pfsense': {
    icon: 'fa-shield-halved',
    title: 'pfSense',
    description: 'Use a pfSense router as the network backend: allow/block clients, apply bandwidth limits, and read DHCP leases via pfSense\'s REST API.',
    workstream: 'Workstream 3'
  },
  'network-mikrotik-script': {
    icon: 'fa-terminal',
    title: 'MikroTik Setup Script',
    description: 'Generate a copy-paste RouterOS script (for Winbox\'s terminal) as an alternative to the live one-click setup wizard, for operators who prefer to review and apply changes manually.',
    workstream: 'Workstream 9'
  },
  'mikrotik-interfaces': {
    icon: 'fa-ethernet',
    title: 'Interfaces',
    description: 'Browse every ethernet/bridge/VLAN/wireless interface on the connected MikroTik, with live up/down state and traffic counters.',
    workstream: 'Workstream 10'
  },
  'mikrotik-wan': {
    icon: 'fa-globe',
    title: 'MikroTik WAN',
    description: 'Configure the MikroTik router\'s own WAN connection: DHCP, static IP, or PPPoE.',
    workstream: 'Workstream 10'
  },
  'mikrotik-wireless': {
    icon: 'fa-wifi',
    title: 'Wireless / AP',
    description: 'Manage the MikroTik\'s Wi-Fi: SSID, security/passphrase, band/channel, and client isolation.',
    workstream: 'Workstream 10'
  },
  'mikrotik-dhcp': {
    icon: 'fa-list-ol',
    title: 'DHCP Server & Leases',
    description: 'View and manage static leases, and browse the live dynamic lease table on the connected MikroTik.',
    workstream: 'Workstream 10'
  },
  'mikrotik-vlans': {
    icon: 'fa-diagram-project',
    title: 'VLANs & Lanes',
    description: 'Ongoing management view of the bridge/VLAN lane setup created by the MikroTik setup wizard.',
    workstream: 'Workstream 10'
  },
  'mikrotik-queues': {
    icon: 'fa-gauge-high',
    title: 'Bandwidth / Queues',
    description: 'Browse and edit every active Simple Queue on the router, not just per-client caps.',
    workstream: 'Workstream 10'
  },
  'mikrotik-hotspot': {
    icon: 'fa-door-open',
    title: 'Hotspot / Captive Portal',
    description: 'View and edit the Hotspot profile and walled-garden entries created by the setup wizard.',
    workstream: 'Workstream 10'
  },
  'mikrotik-firewall': {
    icon: 'fa-fire',
    title: 'Firewall & NAT',
    description: 'Read-only view of the auto-generated NAT and hotspot-bypass rules with plain-language explanations of what each one does.',
    workstream: 'Workstream 10'
  },
  'mikrotik-backup': {
    icon: 'fa-box-archive',
    title: 'Backup & Restore',
    description: 'Download an on-demand backup of the router configuration, or restore from a previous one.',
    workstream: 'Workstream 10'
  },
  'mikrotik-users': {
    icon: 'fa-user-shield',
    title: 'Users & API Access',
    description: 'View, rotate, or revoke the least-privilege API user created by the setup wizard, and manage additional RouterOS accounts.',
    workstream: 'Workstream 10'
  },
  'mikrotik-wireguard': {
    icon: 'fa-lock',
    title: 'VPN / WireGuard',
    description: 'Manage WireGuard peers for remote admin access or site-to-site links between an ISP\'s multiple locations.',
    workstream: 'Workstream 10 (stretch)'
  },
  'mikrotik-routes': {
    icon: 'fa-route',
    title: 'Static Routes',
    description: 'View and manage the router\'s routing table.',
    workstream: 'Workstream 10 (stretch)'
  },
  'mikrotik-logs': {
    icon: 'fa-scroll',
    title: 'Logs',
    description: 'Filterable viewer for the router\'s system log.',
    workstream: 'Workstream 10 (stretch)'
  },
  'sms-email-gateway': {
    icon: 'fa-paper-plane',
    title: 'SMS / Email Gateway',
    description: '',
    workstream: 'Nav rebuild (12c)'
  },
  'isp-subscribers': {
    icon: 'fa-users-gear',
    title: 'Subscribers',
    description: 'Manage ISP subscriber accounts: PPPoE username/password, assigned plan, status, payment history. Requires MikroTik mode.',
    workstream: 'Workstream 12'
  },
  'isp-plans': {
    icon: 'fa-gauge',
    title: 'Plans',
    description: 'Recurring subscriber plan tiers: name, download/upload Mbps, price, billing cycle length.',
    workstream: 'Workstream 12'
  },
  'isp-billing': {
    icon: 'fa-file-invoice-dollar',
    title: 'Billing',
    description: 'Due-soon and overdue subscriber lists, manual "mark paid," auto-suspend on non-payment past the grace period, auto-restore on payment.',
    workstream: 'Workstream 12'
  },
  'isp-sms': {
    icon: 'fa-comment-sms',
    title: 'SMS Notifications',
    description: 'Send outage/maintenance broadcasts to subscribers, and configure automatic due-soon, suspension, and payment-confirmation SMS templates.',
    workstream: 'Workstream 12'
  },
  'isp-walled-garden': {
    icon: 'fa-tree',
    title: 'Walled Garden',
    description: 'Domains/IPs reachable before a customer pays or logs in. Payment gateway access is added automatically, plus an operator-editable allow-list for anything else (school portals, government sites, etc.).',
    workstream: 'Workstream 12'
  },
  'isp-import': {
    icon: 'fa-file-csv',
    title: 'Import',
    description: 'Bulk-import an existing subscriber list or MAC allow-list from a CSV file, with per-row validation and a preview before anything is committed.',
    workstream: 'Workstream 12'
  }
};
