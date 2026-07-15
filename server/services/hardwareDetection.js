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

const TIERS = {
  MINIMAL: 'minimal',
  STANDARD: 'standard',
  FULL: 'full',
};

let cached = null;

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

module.exports = { detect, TIERS };
