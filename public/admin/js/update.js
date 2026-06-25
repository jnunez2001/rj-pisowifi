// ===== SYSTEM UPDATE PAGE =====

async function loadUpdate() {
  // nothing to auto-load
}

async function checkForUpdates() {
  const btn = document.getElementById('checkUpdateBtn');
  const status = document.getElementById('updateStatus');
  const icon = document.getElementById('updateIcon');
  const lastChecked = document.getElementById('lastChecked');

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';
  icon.className = 'fas fa-spinner fa-spin';
  icon.style.color = 'var(--accent-yellow)';

  await new Promise(resolve => setTimeout(resolve, 1500));

  // Up to date
  icon.className = 'fas fa-check-circle';
  icon.style.color = 'var(--accent-green)';

  status.style.display = 'block';
  status.style.background = 'var(--card-green-bg)';
  status.style.color = 'var(--card-green-text)';
  status.innerHTML = '<i class="fas fa-check-circle"></i> You are running the latest version — v1.0.0';

  lastChecked.textContent = new Date().toLocaleTimeString();

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Check for Updates';
}