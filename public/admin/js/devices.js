// ===== DEVICES PAGE =====

function timeAgo(dateStr) {
  const now = new Date();
  const then = new Date(dateStr);
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function isOnline(lastSeen) {
  const diff = (new Date() - new Date(lastSeen)) / 1000;
  return diff < 180; // online if seen within 3 minutes
}

async function loadDevices() {
  try {
    const data = await apiCall('GET', '/api/admin/vendos');
    const tbody = document.getElementById('devicesTable');
    if (!tbody) return;

    if (!data.success || !data.vendos.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align:center;color:var(--text-muted);padding:32px;">
            <i class="fas fa-microchip" style="font-size:32px;margin-bottom:12px;display:block;opacity:0.3;"></i>
            No devices registered yet.<br>
            <span style="font-size:12px;">Follow the steps on the right to add a device.</span>
          </td>
        </tr>`;

      document.getElementById('totalDevices').textContent = '0';
      document.getElementById('onlineDevices').textContent = '0';
      document.getElementById('offlineDevices').textContent = '0';
      return;
    }

    // Count online/offline
    let online = 0;
    let offline = 0;

    tbody.innerHTML = data.vendos.map(v => {
      const on = isOnline(v.last_seen);
      if (on) online++; else offline++;

      const statusBadge = on
        ? `<span class="badge badge-green">
             <i class="fas fa-circle" style="font-size:7px;margin-right:4px;"></i>Online
           </span>`
        : `<span class="badge badge-red">
             <i class="fas fa-circle" style="font-size:7px;margin-right:4px;"></i>Offline
           </span>`;

      const ipLink = v.ip_address
        ? `<a href="http://${v.ip_address}" target="_blank"
              style="color:var(--accent-blue);text-decoration:none;font-family:monospace;font-size:13px;">
             ${v.ip_address}
           </a>`
        : '—';

      return `
        <tr>
          <td>
            <div style="font-weight:700;">${v.name}</div>
          </td>
          <td style="font-family:monospace;font-size:12px;color:var(--text-muted);">
            ${v.mac_address}
          </td>
          <td>${ipLink}</td>
          <td>
            <span class="badge badge-blue">${v.firmware || '—'}</span>
          </td>
          <td>${statusBadge}</td>
          <td style="font-size:13px;color:var(--text-muted);">
            ${timeAgo(v.last_seen)}
          </td>
        </tr>`;
    }).join('');

    // Update summary
    document.getElementById('totalDevices').textContent = data.vendos.length;
    document.getElementById('onlineDevices').textContent = online;
    document.getElementById('offlineDevices').textContent = offline;

  } catch(e) {
    console.error('Devices error:', e);
  }
}

// Auto refresh every 30 seconds
setInterval(loadDevices, 30000);