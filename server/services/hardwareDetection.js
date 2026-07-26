// Detects the device's real capability once at startup and caches it, so
// every other Standalone-mode feature (CAKE vs fq_codel, VLAN lane limits,
// dashboard polling rate, the BIOS power-loss reminder) can read one shared
// answer instead of re-probing hardware on every request.
//
// Deliberately checks actual RAM/cores rather than assuming from CPU
// architecture - an x86 mini PC like the Dell Wyse 3040 has only 2GB fixed
// RAM, well below a Raspberry Pi 4's 4GB, so "x86 means more capable" would
// be wrong here. ARM SBCs (Orange Pi, Raspberry Pi) and x86 mini PCs both
// get judged on the same RAM/core thresholds.
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

const TIERS = {
  MINIMAL: 'minimal',
  STANDARD: 'standard',
  FULL: 'full',
};

let cached = null;
let cachedGpio = null;

function detect() {
  if (cached) return cached;

  const cores = os.cpus().length;
  const totalMemGB = os.totalmem() / (1024 * 1024 * 1024);
  const arch = os.arch();
  // ARM SBCs (Orange Pi, Raspberry Pi) have no traditional BIOS and no real
  // "soft off" power state - they just boot when power returns, so the
  // "Restore on AC Power Loss" reminder card only makes sense for x86.
  const isX86 = arch === 'x64' || arch === 'ia32';

  let tier;
  if (totalMemGB >= 4 && cores >= 4) {
    tier = TIERS.FULL;
  } else if (totalMemGB >= 2 && cores >= 2) {
    tier = TIERS.STANDARD;
  } else {
    tier = TIERS.MINIMAL;
  }

  cached = {
    tier,
    cores,
    totalMemGB: Math.round(totalMemGB * 10) / 10,
    arch,
    isX86,
    // Per-feature gates, kept here in one place rather than scattered
    // threshold checks throughout the codebase.
    //
    // Bug in the original design: CAKE was gated off Minimal tier on the
    // assumption fq_codel is "lighter." That's only true comparing them in
    // isolation at unshaped/native line rate - this app always shapes
    // traffic (per-client bandwidth caps are the whole product), and for
    // shaped traffic CAKE beats the older htb+fq_codel combo even on weak
    // hardware, since it does shaping and queuing in one integrated pass
    // instead of two stacked mechanisms. A weak dual-core ARM chip at
    // 650MHz handles up to 200Mbps under CAKE - far above the 2-20Mbps
    // per-client caps typical in this market. CAKE runs on every tier.
    features: {
      cake: true,
      wireguard: tier !== TIERS.MINIMAL,
      multiWanFailover: tier === TIERS.FULL,
      maxVlanLanes: tier === TIERS.MINIMAL ? 2 : tier === TIERS.STANDARD ? 6 : 16,
      dashboardPollMs: tier === TIERS.MINIMAL ? 10000 : 3000,
    },
  };
  return cached;
}

// Separate concern from the compute-tier detection above: not "how
// powerful is this hardware" but "does it physically have GPIO pins at
// all." A generic Linux PC (or a VM, or a Windows box) can be plenty
// powerful and still have nowhere to wire a coin acceptor directly - only
// single-board computers (Orange Pi, Raspberry Pi, etc.) expose real GPIO.
// Main Kiosk (direct-GPIO) is gated on this; Satellite Kiosk is NOT - an
// ESP32 relaying over WiFi/HTTP works on any hardware, including this one.
function detectGpioCapability() {
  if (cachedGpio) return cachedGpio;

  if (process.platform !== 'linux') {
    cachedGpio = {
      available: false,
      hasHardware: false,
      toolsInstalled: false,
      reason: `Main Kiosk direct wiring requires a Linux single-board computer with GPIO pins (Orange Pi, Raspberry Pi, etc.). This box is running ${process.platform === 'win32' ? 'Windows' : process.platform}, which has no GPIO header to wire a coin acceptor into.`,
    };
    return cachedGpio;
  }

  let hasHardware = false;
  try {
    hasHardware = fs.readdirSync('/dev').some((f) => f.startsWith('gpiochip'));
  } catch (e) {
    hasHardware = false;
  }

  // Same lookup shape as coinslotGpio.js's own which() (a separate concern
  // - that one gates the listener actually starting, this one gates
  // whether the admin UI should even offer the feature) - kept consistent
  // so the two checks can't quietly disagree about whether tools exist.
  let toolsInstalled = false;
  try {
    const result = execSync('command -v gpiomon 2>/dev/null || which gpiomon 2>/dev/null').toString().trim();
    toolsInstalled = !!result;
  } catch (e) {
    toolsInstalled = false;
  }

  let reason = null;
  if (!hasHardware) {
    reason = 'No GPIO hardware detected on this device (no /dev/gpiochip* found). Main Kiosk direct wiring requires a single-board computer with GPIO pins (Orange Pi, Raspberry Pi, etc.) - a generic PC or VM can\'t accept a coin acceptor wired directly into it.';
  } else if (!toolsInstalled) {
    reason = 'GPIO hardware was detected, but the required tools (libgpiod\'s gpiomon/gpioset) aren\'t installed. Install them and restart: sudo apt install gpiod';
  }

  cachedGpio = {
    available: hasHardware && toolsInstalled,
    hasHardware,
    toolsInstalled,
    reason,
  };
  return cachedGpio;
}

module.exports = { detect, detectGpioCapability, TIERS };
