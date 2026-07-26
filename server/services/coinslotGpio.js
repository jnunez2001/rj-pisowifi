// ===== DIRECT GPIO COINSLOT LISTENER =====
// Literal port of Tarakifi's services/coinslot_gpio.py — debounce, min/max
// pulse-interval filtering, burst-rate limiting (rejects lighter/igniter
// fraud attempts), per-MAC busy-lock, and empty-open rate limiting/cooldown.
// Reimplemented in JS (Python subprocess.Popen -> Node child_process.spawn,
// Python threading.Lock() removed — Node is single-threaded, so the
// module-level state below doesn't need locking the way Tarakifi's does).
//
// This is an ALTERNATE credit path alongside the existing ESP32 HTTP-relay
// flow in routes/coin.js — for boxes with a coin acceptor wired straight
// into the box's own GPIO header instead of through an ESP32/ESP8266.
// Both paths ultimately call the same server/services/coinCreditService.js
// so a coin is credited identically no matter which path it came through.
//
// Simplification vs. Tarakifi's version: Tarakifi STAGES coins during the
// active window and only commits (unlock/extend) on Done-press or timeout,
// so it can support eLoad/rental flows that don't exist here yet. This
// first port commits each valid pulse's peso value immediately via
// creditCoinValue(), matching how the existing ESP32 path already behaves
// (each POST /api/coin call credits immediately). The staging pattern is
// still the right shared primitive for Workstream 6 (Rental) once that
// lands — `registerWaitingClient`/`cancelWaitingClient` below are written
// so a future staging layer can sit between the pulse listener and the
// credit call without changing the busy-lock/rate-limiter logic itself.

const { spawn, execFile } = require('child_process');
const db = require('../config/database');
const { creditCoinValue, NoMatchingRateError } = require('./coinCreditService');

const MODE_AUTO = 'auto';
const MODE_DIRECT_GPIO = 'direct_gpio';
const MODE_DISABLED = 'disabled';

const EDGE_VALUES = new Set(['falling', 'rising', 'both']);

// ---- Busy-lock (one coin window active at a time) ----
let _waitingMac = '';
let _waitingUntil = 0; // epoch ms

// ---- Empty-open rate limiter: { mac: [{ts, inserted}] } ----
const _openHistory = new Map();
const _cooldownUntil = new Map(); // mac -> epoch ms

// ---- Acceptor (SET/inhibit) output state ----
let _acceptorProc = null;
let _acceptorEnabled = null;
let _acceptorDisableTimer = null;

// ---- Status/error/internet LED state ----
const _ledProcs = {};
const _ledEnabled = {};

function getSetting(key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

function intSetting(key, fallback, min = 0, max = 86400) {
  const raw = getSetting(key, String(fallback));
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(value, max));
}

function boolSetting(key, fallback) {
  const raw = getSetting(key, '');
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'high'].includes(String(raw).trim().toLowerCase());
}

function resolveMode() {
  const raw = (getSetting('coinslot_gpio_mode', MODE_AUTO) || MODE_AUTO).trim().toLowerCase();
  if (raw === MODE_AUTO) {
    // rj-pisowifi has no standalone/router-mode-keyed default the way
    // Tarakifi's resolve_mode() does (that distinguishes "this box IS the
    // router" from "an ESP32 sub-vendo reader is in front of the coin
    // slot") — default AUTO to disabled until an operator explicitly opts
    // into direct GPIO, since most rj-pisowifi deployments use the ESP32
    // relay path today.
    return MODE_DISABLED;
  }
  if (raw === MODE_DIRECT_GPIO || raw === MODE_DISABLED) return raw;
  return MODE_DISABLED;
}

function currentConfig() {
  const modeRaw = (getSetting('coinslot_gpio_mode', MODE_AUTO) || MODE_AUTO).trim().toLowerCase();
  let edge = (getSetting('coinslot_gpio_edge', 'falling') || 'falling').trim().toLowerCase();
  if (!EDGE_VALUES.has(edge)) edge = 'falling';

  return {
    mode: modeRaw || MODE_AUTO,
    resolvedMode: resolveMode(),
    chip: (getSetting('coinslot_gpio_chip', '') || '').trim(),
    line: (getSetting('coinslot_gpio_line', '') || '').trim(),
    edge,
    debounceMs: intSetting('coinslot_gpio_debounce_ms', 5, 1, 5000),
    phpPerPulse: intSetting('coinslot_gpio_php_per_pulse', 1, 1, 100),
    activeWindowSeconds: intSetting('coinslot_gpio_active_window_seconds', 60, 10, 600),
    inhibitChip: (getSetting('coinslot_gpio_inhibit_chip', '') || '').trim(),
    inhibitLine: (getSetting('coinslot_gpio_inhibit_line', '') || '').trim(),
    inhibitActiveHigh: boolSetting('coinslot_gpio_inhibit_active_high', true),
    statusLedChip: (getSetting('coinslot_gpio_status_led_chip', '') || '').trim(),
    statusLedLine: (getSetting('coinslot_gpio_status_led_line', '') || '').trim(),
    statusLedActiveHigh: boolSetting('coinslot_gpio_status_led_active_high', true),
    errorLedChip: (getSetting('coinslot_gpio_error_led_chip', '') || '').trim(),
    errorLedLine: (getSetting('coinslot_gpio_error_led_line', '') || '').trim(),
    errorLedActiveHigh: boolSetting('coinslot_gpio_error_led_active_high', true),
    // Anti-manipulation pulse guard
    burstMax: intSetting('coinslot_gpio_burst_max', 3, 1, 100),
    burstWindowMs: intSetting('coinslot_gpio_burst_window_ms', 200, 50, 5000),
    minPulseMs: intSetting('coinslot_gpio_min_pulse_ms', 5, 1, 500),
    // Anti-abuse: repeatedly opening the coin window without paying
    maxEmptyOpens: intSetting('coinslot_gpio_max_empty_opens', 10, 0, 100),
    emptyOpenWindowSeconds: intSetting('coinslot_gpio_empty_open_window_seconds', 300, 30, 3600),
    emptyOpenCooldownSeconds: intSetting('coinslot_gpio_empty_open_cooldown_seconds', 30, 10, 3600),
    busyLockEnabled: boolSetting('coinslot_gpio_busy_lock', true),
    get enabled() {
      return this.resolvedMode === MODE_DIRECT_GPIO && !!(this.chip && this.line);
    },
    get acceptorControlEnabled() {
      return this.resolvedMode === MODE_DIRECT_GPIO && !!(this.inhibitChip && this.inhibitLine);
    },
  };
}

// ---- Register codes ----
const REGISTER_OK = 'ok';
const REGISTER_BUSY = 'busy';
const REGISTER_RATE_LIMITED = 'rate_limited';

function normalizeMac(mac) {
  return String(mac || '').trim().toLowerCase().replace(/-/g, ':');
}

function checkRateLimit(mac, cfg) {
  if (cfg.maxEmptyOpens === 0) return REGISTER_OK; // 0 = unlimited
  const now = Date.now();
  const blockedUntil = _cooldownUntil.get(mac);
  if (blockedUntil && now < blockedUntil) return REGISTER_RATE_LIMITED;

  const cutoff = now - cfg.emptyOpenWindowSeconds * 1000;
  let history = (_openHistory.get(mac) || []).filter((h) => h.ts > cutoff);
  const emptyOpens = history.filter((h) => !h.inserted).length;

  if (emptyOpens >= cfg.maxEmptyOpens) {
    _cooldownUntil.set(mac, now + cfg.emptyOpenCooldownSeconds * 1000);
    _openHistory.set(mac, history);
    console.warn(`[CoinslotGPIO] Insert Coin rate limit hit: mac=${mac} empty_opens=${emptyOpens}`);
    return REGISTER_RATE_LIMITED;
  }

  history.push({ ts: now, inserted: false });
  _openHistory.set(mac, history);
  return REGISTER_OK;
}

// Resets the rate-limit history for this MAC when a coin is inserted — a
// paying customer is never penalised for previous empty test-opens.
function markCoinInserted(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return;
  _openHistory.delete(normalized);
  _cooldownUntil.delete(normalized);
}

// Marks the freshest waiting portal client as ready for coin pulses.
// Returns { status, windowSeconds }.
function registerWaitingClient(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return { status: REGISTER_OK, windowSeconds: 0 };

  const cfg = currentConfig();
  if (cfg.resolvedMode !== MODE_DIRECT_GPIO) {
    setAcceptorEnabled(false, cfg);
    return { status: REGISTER_OK, windowSeconds: 0 };
  }

  if (cfg.busyLockEnabled) {
    const now = Date.now();
    if (_waitingMac && _waitingMac !== normalized && _waitingUntil > now) {
      console.log(`[CoinslotGPIO] Busy: mac=${_waitingMac} waiting, rejected mac=${normalized}`);
      return { status: REGISTER_BUSY, windowSeconds: 0 };
    }
  }

  const rlStatus = checkRateLimit(normalized, cfg);
  if (rlStatus !== REGISTER_OK) return { status: rlStatus, windowSeconds: 0 };

  const until = Date.now() + cfg.activeWindowSeconds * 1000;
  _waitingMac = normalized;
  _waitingUntil = until;
  setAcceptorEnabled(true, cfg);
  scheduleAcceptorDisable(cfg, until);
  return { status: REGISTER_OK, windowSeconds: cfg.activeWindowSeconds };
}

function currentWaitingMac() {
  const now = Date.now();
  if (_waitingMac && _waitingUntil > now) return _waitingMac;
  return '';
}

// Cancels the active coin window (customer closed the modal without
// paying) and immediately disables the acceptor.
function cancelWaitingClient(mac) {
  const normalized = normalizeMac(mac);
  const cfg = currentConfig();
  let cancelled = false;
  if (_waitingMac === normalized && _waitingUntil > Date.now()) {
    _waitingMac = '';
    _waitingUntil = 0;
    cancelled = true;
  }
  if (cancelled || cfg.resolvedMode === MODE_DIRECT_GPIO) {
    cancelAcceptorDisableTimer();
    setAcceptorEnabled(false, cfg);
  }
  return cancelled;
}

function chipArg(chip) {
  return chip.replace('/dev/', '');
}

function which(bin) {
  try {
    const result = require('child_process').execSync(`command -v ${bin} 2>/dev/null || which ${bin} 2>/dev/null`).toString().trim();
    return result || null;
  } catch (e) {
    return null;
  }
}

function gpiomonHelp(bin) {
  try {
    return require('child_process').execFileSync(bin, ['--help'], { timeout: 2000 }).toString();
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

function gpiosetHelp(bin) {
  return gpiomonHelp(bin);
}

function buildGpiomonCommand(cfg, bin) {
  const helpText = gpiomonHelp(bin);
  const chip = chipArg(cfg.chip);
  if (helpText.includes('--edges') && helpText.includes('--chip')) {
    // libgpiod v2 — one consolidated --edges flag. Debounce is enforced in
    // JS below, not via --debounce-period (that's a pulse-WIDTH filter in
    // v2, would eat every real coin pulse at typical acceptor pulse widths).
    return [bin, '--chip', chip, '--edges', cfg.edge, cfg.line];
  }
  const cmd = [bin, '--num-events=0'];
  if (cfg.edge === 'falling') cmd.push('--falling-edge');
  else if (cfg.edge === 'rising') cmd.push('--rising-edge');
  else if (cfg.edge === 'both' && helpText.includes('--both-edges')) cmd.push('--both-edges');
  cmd.push(chip, cfg.line);
  return cmd;
}

function acceptorValue(enabled, cfg) {
  if (enabled) return cfg.inhibitActiveHigh ? '1' : '0';
  return cfg.inhibitActiveHigh ? '0' : '1';
}

function outputValue(enabled, activeHigh) {
  if (enabled) return activeHigh ? '1' : '0';
  return activeHigh ? '0' : '1';
}

function buildGpiosetLineCommand(bin, chip, line, value) {
  const helpText = gpiosetHelp(bin);
  const chipName = chipArg(chip);
  const lineValue = `${line}=${value}`;
  if (helpText.includes('--chip')) {
    const cmd = [bin, '--chip', chipName];
    if (helpText.includes('--mode')) cmd.push('--mode=signal');
    cmd.push(lineValue);
    return cmd;
  }
  const cmd = [bin];
  if (helpText.includes('--mode')) cmd.push('--mode=signal');
  cmd.push(chipName, lineValue);
  return cmd;
}

function terminateProc(procRef) {
  if (procRef && procRef.exitCode === null && !procRef.killed) {
    procRef.kill('SIGTERM');
  }
}

function setAcceptorEnabled(enabled, cfg) {
  if (!cfg.acceptorControlEnabled) return false;
  const gpiosetBin = which('gpioset');
  if (!gpiosetBin) {
    console.warn('[CoinslotGPIO] Acceptor control skipped: gpioset not found.');
    return false;
  }
  if (_acceptorEnabled === enabled && _acceptorProc && _acceptorProc.exitCode === null) return true;
  terminateProc(_acceptorProc);

  const cmd = buildGpiosetLineCommand(gpiosetBin, cfg.inhibitChip, cfg.inhibitLine, acceptorValue(enabled, cfg));
  console.log(`[CoinslotGPIO] Setting acceptor ${enabled ? 'enabled' : 'disabled'}: ${cmd.join(' ')}`);
  try {
    _acceptorProc = spawn(cmd[0], cmd.slice(1), { stdio: 'ignore' });
    _acceptorEnabled = enabled;
    return true;
  } catch (e) {
    console.error('[CoinslotGPIO] Unable to set acceptor state:', e.message);
    _acceptorEnabled = null;
    return false;
  }
}

function setConfiguredLed(label, enabled, cfg) {
  const map = {
    status: [cfg.statusLedChip, cfg.statusLedLine, cfg.statusLedActiveHigh],
    error: [cfg.errorLedChip, cfg.errorLedLine, cfg.errorLedActiveHigh],
  };
  const entry = map[label];
  if (!entry) return false;
  const [chip, line, activeHigh] = entry;
  if (!(chip && line)) return false;
  const gpiosetBin = which('gpioset');
  if (!gpiosetBin) return false;

  if (_ledEnabled[label] === enabled && _ledProcs[label] && _ledProcs[label].exitCode === null) return true;
  terminateProc(_ledProcs[label]);
  const cmd = buildGpiosetLineCommand(gpiosetBin, chip, line, outputValue(enabled, activeHigh));
  try {
    _ledProcs[label] = spawn(cmd[0], cmd.slice(1), { stdio: 'ignore' });
    _ledEnabled[label] = enabled;
    return true;
  } catch (e) {
    console.error(`[CoinslotGPIO] Unable to set ${label} LED:`, e.message);
    delete _ledEnabled[label];
    return false;
  }
}

function cancelAcceptorDisableTimer() {
  if (_acceptorDisableTimer) clearTimeout(_acceptorDisableTimer);
  _acceptorDisableTimer = null;
}

function scheduleAcceptorDisable(cfg, until) {
  if (!cfg.acceptorControlEnabled) return;
  const delayMs = Math.max(0, until - Date.now());
  cancelAcceptorDisableTimer();
  _acceptorDisableTimer = setTimeout(() => {
    if (_waitingUntil === until && _waitingUntil <= Date.now()) {
      setAcceptorEnabled(false, cfg);
    }
  }, delayMs);
}

// Credits one pulse batch (in practice, one debounced pulse = one coin
// pulse) to whichever MAC currently owns the coin window.
async function creditWaitingClient(pulses = 1, cfg = null) {
  cfg = cfg || currentConfig();
  const mac = currentWaitingMac();
  if (!mac) {
    setAcceptorEnabled(false, cfg);
    console.warn('[CoinslotGPIO] Pulse ignored: no active Insert Coin client window.');
    return false;
  }
  const phpAmount = Math.max(1, pulses) * Math.max(1, cfg.phpPerPulse);

  try {
    await creditCoinValue(mac, phpAmount, '');
    markCoinInserted(mac);
    console.log(`[CoinslotGPIO] Credited direct GPIO coin pulse: mac=${mac} php=${phpAmount}`);
    return true;
  } catch (err) {
    if (err instanceof NoMatchingRateError) {
      // No configured rate tier accounts for this php amount (e.g. a
      // php_per_pulse setting that doesn't line up with any Rates Manager
      // tier) — log and let the customer's next pulse accumulate normally
      // rather than silently swallowing their money with no record.
      console.warn(`[CoinslotGPIO] Pulse credit had no matching rate: mac=${mac} php=${phpAmount}`);
      return false;
    }
    console.error('[CoinslotGPIO] Pulse credit failed:', err.message);
    return false;
  }
}

const EVENT_RE = /(FALLING|RISING|ACTIVE|INACTIVE|event)/i;

class CoinslotGpioListener {
  constructor() {
    this._proc = null;
    this._stopping = false;
    this._running = false;
  }

  get running() {
    return this._running;
  }

  start() {
    if (this._running) return;
    const cfg = currentConfig();
    if (!cfg.enabled) {
      console.log(`[CoinslotGPIO] Not started: resolvedMode=${cfg.resolvedMode} chip=${cfg.chip} line=${cfg.line}`);
      setConfiguredLed('status', false, cfg);
      return;
    }
    setAcceptorEnabled(false, cfg);
    const gpiomonBin = which('gpiomon');
    if (!gpiomonBin) {
      console.warn('[CoinslotGPIO] Not started: gpiomon command not found.');
      setConfiguredLed('error', true, cfg);
      return;
    }
    setConfiguredLed('error', false, cfg);
    setConfiguredLed('status', true, cfg);
    this._stopping = false;
    this._running = true;
    this._runLoop(cfg, gpiomonBin);
  }

  stop() {
    this._stopping = true;
    this._running = false;
    cancelAcceptorDisableTimer();
    const cfg = currentConfig();
    setAcceptorEnabled(false, cfg);
    setConfiguredLed('status', false, cfg);
    setConfiguredLed('error', false, cfg);
    terminateProc(this._proc);
  }

  _runLoop(cfg, gpiomonBin) {
    const cmd = buildGpiomonCommand(cfg, gpiomonBin);
    let lastEvent = 0;
    const restartDelayMs = 1000;
    const minPulseIntervalMs = cfg.minPulseMs;
    const maxPulseIntervalMs = 500;
    const burstWindowMs = cfg.burstWindowMs;
    const burstMax = cfg.burstMax;
    let burstCount = 0;
    let burstWindowStart = 0;

    const spawnListener = () => {
      if (this._stopping) return;
      console.log(`[CoinslotGPIO] Starting listener: ${cmd.join(' ')}`);
      const proc = spawn(cmd[0], cmd.slice(1));
      this._proc = proc;
      let buffer = '';

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!EVENT_RE.test(line)) continue;
          const now = Date.now();
          const interval = now - lastEvent;

          if (interval < cfg.debounceMs) continue; // hard debounce
          if (lastEvent > 0 && interval < minPulseIntervalMs) {
            console.warn(`[CoinslotGPIO] Pulse rejected — interval ${interval}ms below minimum ${minPulseIntervalMs}ms (igniter/lighter suspected)`);
            continue;
          }
          if (now - burstWindowStart > burstWindowMs) {
            burstWindowStart = now;
            burstCount = 0;
          }
          burstCount += 1;
          if (burstCount > burstMax) {
            console.warn(`[CoinslotGPIO] Pulse rejected — burst rate ${burstCount} pulses in ${burstWindowMs}ms exceeds max ${burstMax} (igniter/lighter suspected)`);
            continue;
          }
          lastEvent = now;
          creditWaitingClient(1, cfg);
        }
      });

      proc.on('exit', (code, signal) => {
        this._proc = null;
        if (this._stopping) return;
        if (signal === 'SIGTERM') {
          console.log('[CoinslotGPIO] gpiomon stopped (SIGTERM).');
        } else {
          console.warn(`[CoinslotGPIO] gpiomon exited code=${code}, restarting in ${restartDelayMs}ms`);
        }
        setTimeout(() => spawnListener(), restartDelayMs);
      });

      proc.on('error', (err) => {
        console.error('[CoinslotGPIO] Listener crashed:', err.message);
        setConfiguredLed('error', true, cfg);
      });
    };

    spawnListener();
  }
}

const _listener = new CoinslotGpioListener();

function startListener() {
  _listener.start();
  return _listener;
}

function stopListener() {
  _listener.stop();
}

module.exports = {
  currentConfig,
  registerWaitingClient,
  currentWaitingMac,
  cancelWaitingClient,
  markCoinInserted,
  creditWaitingClient,
  startListener,
  stopListener,
  setStatusLed: (enabled) => setConfiguredLed('status', enabled, currentConfig()),
  setErrorLed: (enabled) => setConfiguredLed('error', enabled, currentConfig()),
  REGISTER_OK,
  REGISTER_BUSY,
  REGISTER_RATE_LIMITED,
};
