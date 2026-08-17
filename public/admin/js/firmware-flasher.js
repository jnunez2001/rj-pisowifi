// ===== USB FIRMWARE FLASHER =====
// Browser-based ESP8266/ESP32 flashing via the Web Serial API + esptool-js
// (vendored locally in js/vendor/esptool-js/, not loaded from a CDN, so
// this keeps working with no internet access - matches the rest of this
// app's offline-first design). Needs no backend involvement at all: the
// browser talks directly to the USB device.
//
// The current firmware for both chip families ships bundled with the app
// (assets/firmware/*.bin + manifest.json) - once connected, the detected
// chip is looked up in the manifest and its bundled image loads
// automatically, no file picker needed for the common case. Manual file
// selection still works and overrides the bundled pick, for a custom or
// newer build not yet baked into this release.
//
// This is a module script (see index.html's <script type="module">), so
// top-level functions are NOT automatically global the way classic
// <script> files' functions are - anything called from an onclick= in the
// HTML, or from app.js's page-load dispatch, is explicitly attached to
// window at the bottom of this file.

import { ESPLoader, Transport } from './vendor/esptool-js/bundle.js';

const FIRMWARE_ASSETS_BASE = 'assets/firmware/';

let flasherManifest = null;
let flasherPort = null;
let flasherTransport = null;
let flasherEsploader = null;
let flasherFileArray = null; // [{data: Uint8Array, address: number}, ...]
let flasherManualOverride = false;

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

async function loadFirmwareFlasherPage() {
  if (!checkFlasherSupport()) return;
  flasherFileArray = null;
  flasherManualOverride = false;
  document.getElementById('flasherFileInfo').textContent = '';
  document.getElementById('flasherFlashBtn').disabled = true;

  try {
    flasherManifest = await fetch(FIRMWARE_ASSETS_BASE + 'manifest.json').then((r) => r.json());
  } catch (e) {
    flasherManifest = null;
  }

  const fileInput = document.getElementById('flasherFile');
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    flasherManualOverride = true;
    const bytes = new Uint8Array(await file.arrayBuffer());
    flasherFileArray = [{ data: bytes, address: 0 }];
    document.getElementById('flasherFileInfo').textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB) - manual selection`;
    updateFlasherFlashButtonState();
  };
}

function updateFlasherFlashButtonState() {
  const btn = document.getElementById('flasherFlashBtn');
  btn.disabled = !(flasherFileArray && flasherEsploader);
}

// esptool-js's main() returns a detailed package/revision description
// (e.g. "ESP8266EX", "ESP32-D0WDQ6", "ESP32-D0WD (revision 3)"), not a
// plain "ESP8266"/"ESP32" string - and each ESP32 sub-family (classic,
// S2, S3, C3, ...) has its own distinct description format, which matters
// here since this app's bundled esp32-vendo.bin is compiled for classic
// ESP32 only and would be the WRONG image for an S2/S3/C3 board. Matching
// is prefix-based against every known classic-ESP32 package variant
// string (manifest.json's chipNamePrefixes) rather than a single fixed
// name, and anything that doesn't match falls through to "no bundled
// firmware" rather than guessing - never auto-flash an unverified chip
// family's board with firmware built for a different one.
async function autoLoadBundledFirmware(chipName) {
  if (flasherManualOverride || !flasherManifest) return;
  const entry = Object.values(flasherManifest).find((e) =>
    e.chipNamePrefixes.some((prefix) => chipName.startsWith(prefix))
  );
  const info = document.getElementById('flasherFileInfo');
  if (!entry) {
    info.textContent = `No bundled firmware for "${chipName}" - choose a .bin file manually above.`;
    return;
  }
  info.textContent = `Loading bundled firmware (${chipName}, ${entry.version})...`;
  try {
    const files = await Promise.all(entry.files.map(async (f) => {
      const buf = await fetch(FIRMWARE_ASSETS_BASE + f.file).then((r) => {
        if (!r.ok) throw new Error(`${f.file}: HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      return { data: new Uint8Array(buf), address: f.address };
    }));
    flasherFileArray = files;
    info.textContent = `Bundled: ${chipName} vendo firmware ${entry.version} (auto-loaded)`;
    flasherLog(`Auto-loaded bundled firmware for ${chipName} (${entry.version}).`);
    updateFlasherFlashButtonState();
  } catch (e) {
    info.textContent = `Failed to load bundled firmware: ${e.message}. Choose a .bin file manually above.`;
    flasherLog('Bundled firmware load failed: ' + e.message);
  }
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
    await autoLoadBundledFirmware(chipName);
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
  if (!flasherEsploader || !flasherFileArray) return;
  const btn = document.getElementById('flasherFlashBtn');
  const progressWrap = document.getElementById('flasherProgressWrap');
  const progressBar = document.getElementById('flasherProgressBar');
  const progressText = document.getElementById('flasherProgressText');

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Flashing...';
  progressWrap.style.display = 'block';

  try {
    await flasherEsploader.writeFlash({
      fileArray: flasherFileArray,
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
