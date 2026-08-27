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

const STARKFI_ASCII_BANNER = `                                                    ,,
 .M"""bgd mm                   \`7MM      \`7MM"""YMM db
,MI    "Y MM                     MM        MM    \`7
\`MMb.   mmMMmm  ,6"Yb.  \`7Mb,od8 MM  ,MP'  MM   d \`7MM
  \`YMMNq. MM   8)   MM    MM' "' MM ;Y     MM""MM   MM
.     \`MM MM    ,pm9MM    MM     MM;Mm     MM   Y   MM
Mb     dM MM   8M   MM    MM     MM \`Mb.   MM       MM
P"Ybmmd"  \`Mbmo\`Moo9^Yo..JMML. .JMML. YA..JMML.   .JMML.`;

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
  // Web Serial needs a real USB port, so even on the rare Android/Chrome
  // combination that technically has the API, flashing over a phone's
  // USB port is not a realistic flow for this product. Guards a direct
  // link/bookmark landing here on mobile even though the nav item itself
  // is already hidden below the same width in admin.css.
  const isMobileWidth = window.innerWidth < 768;
  const hasWebSerial = 'serial' in navigator;
  const supported = hasWebSerial && !isMobileWidth;

  const unsupportedCard = document.getElementById('flasherUnsupportedCard');
  const heading = document.getElementById('flasherUnsupportedHeading');
  const detail = document.getElementById('flasherUnsupportedDetail');
  if (isMobileWidth) {
    heading.textContent = 'Use a Computer to Flash';
    detail.textContent = 'USB firmware flashing needs a real USB port and a desktop browser. Open this page on a Windows, Mac, or Linux computer with Chrome or Edge instead.';
  } else {
    heading.textContent = 'Needs Chrome or Edge';
    detail.textContent = 'This only works in Chrome or Microsoft Edge. Use Arduino IDE or esptool.py instead.';
  }
  unsupportedCard.style.display = supported ? 'none' : 'block';
  document.getElementById('flasherMainCard').style.display = supported ? 'block' : 'none';
  return supported;
}

async function loadFirmwareFlasherPage() {
  if (!checkFlasherSupport()) return;
  flasherFileArray = null;
  flasherManualOverride = false;
  document.getElementById('flasherFileInfo').textContent = '';
  document.getElementById('flasherFlashBtn').disabled = true;

  const logEl = document.getElementById('flasherLog');
  if (logEl) {
    logEl.textContent = STARKFI_ASCII_BANNER + '\n\n';
  }

  try {
    flasherManifest = await fetch(FIRMWARE_ASSETS_BASE + 'manifest.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
  } catch (e) {
    flasherManifest = null;
  }

  flasherLog('HOW TO FLASH A VENDO');
  flasherLog('1. Plug the ESP8266/ESP32 board into this computer over USB.');
  flasherLog('2. Click "Connect" above and pick the device from the browser prompt.');
  flasherLog('3. The right firmware for the detected chip loads automatically.');
  flasherLog('4. Click "Flash Firmware" and wait for it to finish. Do not unplug the device while it is flashing.');
  if (flasherManifest) {
    const versions = Object.entries(flasherManifest)
      .map(([name, entry]) => `${name} ${entry.version}`)
      .join(', ');
    if (versions) flasherLog(`Bundled firmware: ${versions}`);
  }
  flasherLog('');
  flasherLog('Waiting for device connection...');

  const fileInput = document.getElementById('flasherFile');
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    flasherManualOverride = true;
    const bytes = new Uint8Array(await file.arrayBuffer());
    flasherFileArray = [{ data: bytes, address: 0 }];
    document.getElementById('flasherFileInfo').textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB) - manual selection`;
    if (flasherEsploader) flasherLog('Ready to flash. Click "Flash Firmware".');
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
    info.textContent = `No bundled firmware for ${chipName}. Pick a .bin above.`;
    return;
  }
  info.textContent = `Loading ${chipName} firmware...`;
  try {
    const files = await Promise.all(entry.files.map(async (f) => {
      const buf = await fetch(FIRMWARE_ASSETS_BASE + f.file + '?t=' + Date.now(), { cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error(`${f.file}: HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      return { data: new Uint8Array(buf), address: f.address };
    }));
    flasherFileArray = files;
    info.textContent = `Loaded: ${chipName} ${entry.version}`;
    flasherLog(`Loaded ${chipName} firmware ${entry.version}.`);
    flasherLog('Ready to flash. Click "Flash Firmware".');
    updateFlasherFlashButtonState();
  } catch (e) {
    info.textContent = `Couldn't load firmware: ${e.message}. Pick a .bin above.`;
    flasherLog('Firmware load failed: ' + e.message);
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
    flasherLog('Flashed. Resetting...');
    await flasherEsploader.after('hard_reset');
    flasherLog('');
    flasherLog('Done! The device is rebooting with the new firmware.');
    flasherLog('You can unplug it now and set it up as usual (WiFi credentials, coin slot wiring, etc.).');
    showToast('Firmware flashed! You can unplug the device now.', 'success');
    btn.innerHTML = '<i class="fas fa-check"></i> Flashed!';
  } catch (e) {
    flasherLog('Flash failed: ' + (e.message || e));
    showToast('Flash failed: ' + (e.message || 'unknown error'), 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-bolt"></i> Flash Firmware';
  }
}

// ===== SERIAL MONITOR =====
// Independent of the Connect/Flash flow above - esptool-js's Transport
// takes exclusive ownership of the port for flashing, so watching live
// Serial.println() output needs its own separate port.open()/reader,
// not a re-use of flasherPort. Plain Web Serial, same offline-first
// constraint as the flasher itself (no CDN, nothing installed beyond
// the browser).
let monitorPort = null;
let monitorReader = null;
let monitorKeepReading = false;

function monitorLogLine(line) {
  const el = document.getElementById('monitorLog');
  if (!el) return;
  if (el.textContent.startsWith('Click Connect')) el.textContent = '';
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

function monitorClear() {
  const el = document.getElementById('monitorLog');
  if (el) el.textContent = '';
}

async function monitorConnect() {
  if (!('serial' in navigator)) {
    showToast('This browser does not support Web Serial (use Chrome or Edge).', 'error');
    return;
  }
  try {
    monitorPort = await navigator.serial.requestPort();
    // 115200 matches every firmware variant's own Serial.begin(115200) -
    // a mismatched baud rate here would just show garbled characters,
    // not an error, so this needs to stay in sync with the firmware side.
    await monitorPort.open({ baudRate: 115200 });

    document.getElementById('monitorConnectBtn').style.display = 'none';
    document.getElementById('monitorDisconnectBtn').style.display = 'inline-flex';
    document.getElementById('monitorStatus').textContent = 'Connected - watching live output';
    const liveDot = document.getElementById('monitorLiveDot');
    if (liveDot) liveDot.classList.add('live');
    monitorLogLine('--- Connected. Power-cycle or reset the device now to see its boot log. ---');

    monitorKeepReading = true;
    const decoder = new TextDecoderStream();
    const readableClosed = monitorPort.readable.pipeTo(decoder.writable);
    monitorReader = decoder.readable.getReader();

    let lineBuffer = '';
    while (monitorKeepReading) {
      const { value, done } = await monitorReader.read();
      if (done) break;
      if (value) {
        lineBuffer += value;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop(); // keep the incomplete tail for next read
        for (const line of lines) monitorLogLine(line.replace(/\r$/, ''));
      }
    }
    await readableClosed.catch(() => {});
  } catch (e) {
    if (e && e.name === 'NotFoundError') return; // user cancelled the port picker
    monitorLogLine('Connection error: ' + (e.message || e));
    showToast('Serial monitor error: ' + (e.message || 'unknown'), 'error');
    await monitorDisconnect();
  }
}

async function monitorDisconnect() {
  monitorKeepReading = false;
  try {
    if (monitorReader) {
      await monitorReader.cancel().catch(() => {});
      monitorReader.releaseLock();
    }
  } catch (e) {}
  try {
    if (monitorPort) await monitorPort.close();
  } catch (e) {}
  monitorReader = null;
  monitorPort = null;
  document.getElementById('monitorConnectBtn').style.display = 'inline-flex';
  document.getElementById('monitorDisconnectBtn').style.display = 'none';
  const status = document.getElementById('monitorStatus');
  if (status) status.textContent = 'Not connected';
  const liveDot = document.getElementById('monitorLiveDot');
  if (liveDot) liveDot.classList.remove('live');
  monitorLogLine('--- Disconnected ---');
}

window.loadFirmwareFlasherPage = loadFirmwareFlasherPage;
window.flasherConnect = flasherConnect;
window.flasherFlash = flasherFlash;
window.monitorConnect = monitorConnect;
window.monitorDisconnect = monitorDisconnect;
window.monitorClear = monitorClear;
