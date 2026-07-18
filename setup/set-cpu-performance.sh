#!/bin/bash
# Cross-checked against an OpenWrt/rockchip reference build's
# etc/init.d/cpufreq — it explicitly pins a governor per CPU policy rather
# than trusting whatever the board's default image ships with. Some SBC
# images default to a powersave-biased governor that clocks down during
# idle gaps, adding latency spikes back under load — bad for a dedicated
# router appliance doing NAT + nftables + tc shaping continuously, where
# consistent throughput matters more than saving a few mW. sysfs resets to
# the kernel/image default on every boot, so this needs to run at every
# boot, not just once at install time (see rj-cpu-performance.service).
for policy in /sys/devices/system/cpu/cpufreq/policy*; do
  [ -f "$policy/scaling_governor" ] || continue
  if grep -qw performance "$policy/scaling_available_governors" 2>/dev/null; then
    echo performance > "$policy/scaling_governor" 2>/dev/null || true
  fi
done
