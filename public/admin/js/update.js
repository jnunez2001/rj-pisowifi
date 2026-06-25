// ===== SYSTEM UPDATE PAGE =====

async function loadUpdate() {
  // nothing to auto-load
}

async function checkForUpdates() {
  const btn = document.getElementById('checkUpdateBtn');
  const icon = document.getElementById('updateIcon');
  const lastChecked = document.getElementById('lastChecked');
  const updateAvailableCard = document.getElementById('updateAvailableCard');

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';
  icon.className = 'fas fa-spinner fa-spin';
  icon.style.color = 'var(--accent-yellow)';

  try {
    const data = await apiCall('GET', '/api/admin/check-update');

    lastChecked.textContent = new Date().toLocaleTimeString();
    icon.className = 'fas fa-cloud-download-alt';

    if (data.has_update) {
      // Update available
      icon.style.color = 'var(--accent-yellow)';

      // Update version badge
      document.getElementById('newVersionBadge').textContent = `v${data.latest_version}`;

      // Show release notes if available
      if (data.release_notes) {
        const notes = document.getElementById('releaseNotes');
        notes.style.display = 'block';
        notes.innerHTML = `<strong>What's new in v${data.latest_version}:</strong><br><br>${data.release_notes.replace(/\n/g, '<br>')}`;
      }

      // Update current version badge to show update available
      document.getElementById('versionStatusBadge').innerHTML = `
        <span class="badge badge-orange" style="font-size:13px;padding:6px 16px;">
          <i class="fas fa-exclamation-circle"></i> Update Available
        </span>`;

      // Show update card
      updateAvailableCard.style.display = 'block';
      updateAvailableCard.scrollIntoView({ behavior: 'smooth' });

    } else {
      // Up to date
      icon.style.color = 'var(--accent-green)';
      icon.className = 'fas fa-check-circle';

      document.getElementById('versionStatusBadge').innerHTML = `
        <span class="badge badge-green" style="font-size:13px;padding:6px 16px;">
          <i class="fas fa-check-circle"></i> Up to date
        </span>`;

      // Hide update card
      updateAvailableCard.style.display = 'none';

      // Show up to date message briefly
      const status = document.getElementById('updateStatus');
      status.style.display = 'block';
      status.style.background = 'var(--card-green-bg)';
      status.style.color = 'var(--card-green-text)';
      status.innerHTML = `<i class="fas fa-check-circle"></i> You are running the latest version — v${data.current_version}`;
    }

  } catch(e) {
    icon.className = 'fas fa-exclamation-triangle';
    icon.style.color = 'var(--accent-red)';

    const status = document.getElementById('updateStatus');
    status.style.display = 'block';
    status.style.background = 'var(--card-red-bg)';
    status.style.color = 'var(--card-red-text)';
    status.innerHTML = '<i class="fas fa-times-circle"></i> Could not check for updates. Check your internet connection.';
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Check for Updates';
}

async function installUpdate() {
  const btn = document.getElementById('installUpdateBtn');
  const status = document.getElementById('installStatus');

  if (!confirm('This will install the update and restart the server. Make sure you have a backup. Continue?')) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Installing...';
  status.style.display = 'block';
  status.style.background = 'var(--bg-primary)';
  status.style.color = 'var(--text-muted)';
  status.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Downloading and applying update...';

  try {
    const data = await apiCall('POST', '/api/admin/install-update');

    if (data.success) {
      status.style.background = 'var(--card-green-bg)';
      status.style.color = 'var(--card-green-text)';
      status.innerHTML = '<i class="fas fa-check-circle"></i> Update installed! Server is restarting... Page will reload in 10 seconds.';
      setTimeout(() => location.reload(), 10000);
    } else {
      status.style.background = 'var(--card-red-bg)';
      status.style.color = 'var(--card-red-text)';
      status.innerHTML = `<i class="fas fa-times-circle"></i> ${data.message}`;
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-download"></i> Install Update';
    }
  } catch(e) {
    // Server restarted — this is expected
    status.style.background = 'var(--card-green-bg)';
    status.style.color = 'var(--card-green-text)';
    status.innerHTML = '<i class="fas fa-check-circle"></i> Update applied! Server restarted. Reloading in 10 seconds...';
    setTimeout(() => location.reload(), 10000);
  }
}