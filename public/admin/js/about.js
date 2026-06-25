// ===== ABOUT PAGE =====

let sysInfoInterval = null;

function formatBytes(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return gb.toFixed(2) + ' GB';
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(0) + ' MB';
}

function getBarColor(percent) {
  if (percent >= 90) return 'red';
  if (percent >= 70) return 'yellow';
  return null; // use default class color
}

async function loadSysInfo() {
  try {
    const data = await apiCall('GET', '/api/admin/sysinfo');
    if (!data.success) return;
    const s = data.sysinfo;

    // Static info
    document.getElementById('siVersion').textContent = s.version;
    document.getElementById('siPlatform').textContent = s.platform;
    document.getElementById('siProcessor').textContent = s.processor;
    document.getElementById('siCores').textContent = s.cpu_cores + ' cores';
    document.getElementById('siIp').textContent = s.ip_address;
    document.getElementById('siGateway').textContent = s.gateway;
    document.getElementById('siMachineId').textContent = s.machine_id;
    document.getElementById('siLicense').textContent = s.license;
    document.getElementById('sysinfoUptime').textContent = 'Uptime: ' + s.uptime;

    // RAM
    const ramPct = s.mem_percent;
    document.getElementById('ramPercent').textContent = ramPct + '%';
    document.getElementById('ramBar').style.width = ramPct + '%';
    document.getElementById('ramUsed').textContent = formatBytes(s.used_mem);
    document.getElementById('ramFree').textContent = formatBytes(s.free_mem);
    document.getElementById('ramTotal').textContent = formatBytes(s.total_mem);

    // RAM bar color
    const ramBar = document.getElementById('ramBar');
    ramBar.className = 'stat-bar-fill';
    const ramColor = getBarColor(ramPct);
    ramBar.classList.add(ramColor || 'blue');

    // Storage
    if (s.storage && s.storage.total !== 'N/A') {
      const storagePct = s.storage.percent;
      document.getElementById('storagePercent').textContent = storagePct + '%';
      document.getElementById('storageBar').style.width = storagePct + '%';
      document.getElementById('storageUsed').textContent = s.storage.used;
      document.getElementById('storageFree').textContent = s.storage.free;
      document.getElementById('storageTotal').textContent = s.storage.total;

      const storageBar = document.getElementById('storageBar');
      storageBar.className = 'stat-bar-fill';
      const storageColor = getBarColor(storagePct);
      storageBar.classList.add(storageColor || 'green');
    } else {
      document.getElementById('storagePercent').textContent = 'N/A';
      document.getElementById('storageUsed').textContent = 'N/A';
      document.getElementById('storageFree').textContent = 'N/A';
      document.getElementById('storageTotal').textContent = 'N/A';
    }

    // CPU Cores
    const cpuRow = document.getElementById('cpuCoresRow');
    cpuRow.innerHTML = '';
    s.cpu_usage.forEach((usage, i) => {
      const color = getBarColor(usage) || 'yellow';
      cpuRow.innerHTML += `
        <div class="card">
          <div class="card-header">
            <div class="card-title" style="font-size:13px;">
              <i class="fas fa-microchip" style="margin-right:6px;color:var(--accent-yellow);"></i>CPU Core ${i}
            </div>
            <span style="font-size:13px;font-weight:700;color:var(--accent-yellow);">${usage}%</span>
          </div>
          <div class="stat-bar-track">
            <div class="stat-bar-fill ${color}" style="width:${usage}%"></div>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px;">${usage}% Usage</div>
        </div>
      `;
    });

  } catch(e) {
    console.error('Sysinfo error:', e);
  }
}

function initAbout() {
  loadSysInfo();
  // Refresh every 5 seconds
  sysInfoInterval = setInterval(loadSysInfo, 5000);
}

function destroyAbout() {
  if (sysInfoInterval) {
    clearInterval(sysInfoInterval);
    sysInfoInterval = null;
  }
}
function loadAbout() {
  initAbout();
}