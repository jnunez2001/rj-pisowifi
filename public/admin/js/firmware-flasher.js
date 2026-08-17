// ===== USB FIRMWARE FLASHER =====
// Browser-based ESP8266/ESP32 flashing via the Web Serial API + esptool-js
// (vendored locally in js/vendor/esptool-js/, not loaded from a CDN, so
// this keeps working with no internet access - matches the rest of this
// app's offline-first design). Needs no backend involvement at all: the
// browser talks directly to the USB device.
//
// This is a module script (see index.html's <script type="module">), so
// top-level functions are NOT automatically global the way classic
// <script> files' functions are - anything called from an onclick= in the
// HTML, or from app.js's page-load dispatch, is explicitly attached to
// window at the bottom of this file.

import { ESPLoader, Transport } from './vendor/esptool-js/bundle.js';

// Flash offset: 0x0 for ESP8266 (Arduino/arduino-cli's "Export Compiled
// Binary" produces one merged image, unlike ESP32 which needs separate
// bootloader/partition-table/app images at different offsets). ESP32
// support would need a real offset table here, not a single constant -
// out of scope until this app actually needs to flash ESP32 vendos too.
const FLASH_ADDRESS = 0x0;

let flasherPort = null;
let flasherTransport = null;
let flasherEsploader = null;
let flasherFileBytes = null;

function flasherLog(line) {
  const el = document.getElementById('flasherLog');
  if (!el) return;
  if (el.textContent === 'Waiting for device connection...') el.textContent = '';
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

function flasherTerminal() {
  return {
    clean() {
      const el = document.getElementById('flasherLog');
      if (el) el.textContent = '';
    },
    writeLine(data) { flasherLog(data); },
    write(data) { flasherLog(data); },
  };
}

function checkFlasherSupport() {
  const supported = 'serial' in navigator;
  document.getElementById('flasherUnsupportedCard').style.display = supported ? 'none' : 'block';
  document.getElementById('flasherMainCard').style.display = supported ? 'block' : 'none';
  return supported;
}

function loadFirmwareFlasherPage() {
  checkFlasherSupport();
  flasherFileBytes = null;
  document.getElementById('flasherFileInfo').textContent = '';
  document.getElementById('flasherFlashBtn').disabled = true;

  const fileInput = document.getElementById('flasherFile');
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    flasherFileBytes = new Uint8Array(await file.arrayBuffer());
    document.getElementById('flasherFileInfo').textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    updateFlasherFlashButtonState();
  };
}

function updateFlasherFlashButtonState() {
  const btn = document.getElementById('flasherFlashBtn');
  btn.disabled = !(flasherFileBytes && flasherEsploader);
}

async function flasherConnect() {
  const btn = document.getElementById('flasherConnectBtn');
  const status = document.getElementById('flasherConnectionStatus');
  btn.disabled = true;
  try {
    flasherPort = await navigator.serial.requestPort();
    flasherTransport = new Transport(flasherPort, true);
    flasherEsploader = new ESPLoader({
      transport: flasherTransport,
      baudrate: 115200,
      terminal: flasherTerminal(),
    });

    flasherLog('Connecting...');
    const chipName = await flasherEsploader.main();
    flasherLog(`Connected: ${chipName}`);
    status.textContent = `Connected: ${chipName}`;
    status.style.color = 'var(--accent-green)';
    btn.innerHTML = '<i class="fas fa-plug-circle-check"></i> Connected';
    updateFlasherFlashButtonState();
  } catch (e) {
    flasherLog('Connection failed: ' + (e.message || e));
    status.textContent = 'Connection failed';
    status.style.color = 'var(--accent-red)';
    btn.disabled = false;
    flasherEsploader = null;
  }
}

async function flasherFlash() {
  if (!flasherEsploader || !flasherFileBytes) return;
  const btn = document.getElementById('flasherFlashBtn');
  const progressWrap = document.getElementById('flasherProgressWrap');
  const progressBar = document.getElementById('flasherProgressBar');
  const progressText = document.getElementById('flasherProgressText');

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Flashing...';
  progressWrap.style.display = 'block';

  try {
    await flasherEsploader.writeFlash({
      fileArray: [{ data: flasherFileBytes, address: FLASH_ADDRESS }],
      flashMode: 'dio',
      flashFreq: '40m',
      flashSize: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const pct = total ? Math.round((written / total) * 100) : 0;
        progressBar.style.width = pct + '%';
        progressText.textContent = pct + '%';
      },
    });
    flasherLog('Flash complete! Resetting device...');
    await flasherEsploader.after('hard_reset');
    flasherLog('Done. The device is rebooting into the new firmware.');
    showToast('Firmware flashed successfully!', 'success');
    btn.innerHTML = '<i class="fas fa-check"></i> Flashed!';
  } catch (e) {
    flasherLog('Flash failed: ' + (e.message || e));
    showToast('Flash failed: ' + (e.message || 'unknown error'), 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-bolt"></i> Flash Firmware';
  }
}

window.loadFirmwareFlasherPage = loadFirmwareFlasherPage;
window.flasherConnect = flasherConnect;
window.flasherFlash = flasherFlash;
