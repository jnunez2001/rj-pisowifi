// ===== SYSTEM TERMINAL =====
// Real shell access to the box this app runs on, gated behind its own
// separate password (never the admin login password) - see admin.js's
// /terminal/* routes for the actual security reasoning. termToken lives
// only in memory for this tab, never persisted (sessionStorage/localStorage)
// - closing the tab or navigating away and back always re-asks for the
// password, deliberately, same as the risk this feature carries.
let termToken = null;
let termHistory = [];
let termHistoryIndex = -1;

async function loadSystemTerminal() {
  termToken = null; // always re-lock on page (re)load
  document.getElementById('termSetupCard').style.display = 'none';
  document.getElementById('termLoginCard').style.display = 'none';
  document.getElementById('termConsoleCard').style.display = 'none';

  try {
    const data = await apiCall('GET', '/api/admin/terminal/status');
    if (data.success && !data.configured) {
      document.getElementById('termSetupCard').style.display = 'block';
    } else {
      document.getElementById('termLoginCard').style.display = 'block';
    }
  } catch (e) {
    document.getElementById('termLoginCard').style.display = 'block';
  }
}

async function termSetPassword() {
  const pass = document.getElementById('termNewPassword').value;
  const errEl = document.getElementById('termSetupError');
  errEl.style.display = 'none';
  try {
    const data = await apiCall('POST', '/api/admin/terminal/set-password', { new_password: pass });
    if (data.success) {
      showToast('Terminal password set');
      document.getElementById('termNewPassword').value = '';
      loadSystemTerminal();
    } else {
      errEl.textContent = data.message || 'Failed to set password';
      errEl.style.display = 'block';
    }
  } catch (e) {
    errEl.textContent = 'Server error, please try again.';
    errEl.style.display = 'block';
  }
}

function termShowChangePassword() {
  const wrap = document.getElementById('termChangePasswordWrap');
  wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
}

async function termChangePassword() {
  const current = document.getElementById('termChangeCurrent').value;
  const next = document.getElementById('termChangeNew').value;
  const errEl = document.getElementById('termChangeError');
  errEl.style.display = 'none';
  try {
    const data = await apiCall('POST', '/api/admin/terminal/set-password', { current_password: current, new_password: next });
    if (data.success) {
      showToast('Terminal password updated');
      document.getElementById('termChangeCurrent').value = '';
      document.getElementById('termChangeNew').value = '';
      document.getElementById('termChangePasswordWrap').style.display = 'none';
    } else {
      errEl.textContent = data.message || 'Failed to update password';
      errEl.style.display = 'block';
    }
  } catch (e) {
    errEl.textContent = 'Server error, please try again.';
    errEl.style.display = 'block';
  }
}

async function termLogin() {
  const pass = document.getElementById('termLoginPassword').value;
  const errEl = document.getElementById('termLoginError');
  errEl.style.display = 'none';
  try {
    const data = await apiCall('POST', '/api/admin/terminal/auth', { password: pass });
    if (data.success) {
      termToken = data.token;
      termHistory = [];
      termHistoryIndex = -1;
      document.getElementById('termLoginPassword').value = '';
      document.getElementById('termLoginCard').style.display = 'none';
      document.getElementById('termConsoleCard').style.display = 'block';
      document.getElementById('termOutput').textContent = 'Connected. Type a command below.';
      setTimeout(() => document.getElementById('termInput').focus(), 50);
    } else {
      errEl.textContent = data.message || 'Incorrect password';
      errEl.style.display = 'block';
    }
  } catch (e) {
    errEl.textContent = 'Server error, please try again.';
    errEl.style.display = 'block';
  }
}

function termLock() {
  termToken = null;
  document.getElementById('termConsoleCard').style.display = 'none';
  document.getElementById('termLoginCard').style.display = 'block';
}

function termHandleKey(event) {
  const input = document.getElementById('termInput');
  if (event.key === 'Enter') {
    const command = input.value;
    if (!command.trim()) return;
    termHistory.push(command);
    termHistoryIndex = termHistory.length;
    input.value = '';
    termRunCommand(command);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (termHistoryIndex > 0) {
      termHistoryIndex--;
      input.value = termHistory[termHistoryIndex];
    }
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (termHistoryIndex < termHistory.length - 1) {
      termHistoryIndex++;
      input.value = termHistory[termHistoryIndex];
    } else {
      termHistoryIndex = termHistory.length;
      input.value = '';
    }
  }
}

async function termRunCommand(command) {
  const output = document.getElementById('termOutput');
  const cwdLabel = document.getElementById('termPromptCwd');
  const input = document.getElementById('termInput');
  input.disabled = true;

  output.textContent += `\n\n${cwdLabel.textContent} ${command}\n`;
  output.scrollTop = output.scrollHeight;

  try {
    const data = await apiCall('POST', '/api/admin/terminal/run', { token: termToken, command });
    if (!data.success) {
      output.textContent += data.message || 'Command failed';
      if (data.message && data.message.includes('session expired')) {
        termLock();
      }
    } else {
      if (data.stdout) output.textContent += data.stdout;
      if (data.stderr) output.textContent += data.stderr;
      if (data.cwd) cwdLabel.textContent = data.cwd + ' $';
    }
  } catch (e) {
    output.textContent += 'Error: server error';
  }

  input.disabled = false;
  input.focus();
  output.scrollTop = output.scrollHeight;
}

window.loadSystemTerminal = loadSystemTerminal;
window.termSetPassword = termSetPassword;
window.termShowChangePassword = termShowChangePassword;
window.termChangePassword = termChangePassword;
window.termLogin = termLogin;
window.termLock = termLock;
window.termHandleKey = termHandleKey;
