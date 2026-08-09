#!/bin/bash
# Re-runs network setup automatically when a link comes back up (cable
# replugged, VM NIC toggled off/on), without any manual command. Triggered
# by udev via rj-network-relink.service - see setup/setup-network.sh's
# disable_os_network_management() for the other half of this fix (stopping
# netplan/NetworkManager from reclaiming the interface with DHCP in the
# meantime).
LOG="/var/log/rj-network-setup.log"
DEBOUNCE_FILE="/run/rj-network-relink.last"
DEBOUNCE_SECONDS=5

# A single physical unplug/replug can fire several udev "change" events in
# quick succession (link down, link up, carrier renegotiation) - without
# this, each one would independently restart network setup, doing several
# times the work for one real event and risking overlapping runs stepping
# on each other's nftables/tc state.
NOW=$(date +%s)
LAST=$(cat "$DEBOUNCE_FILE" 2>/dev/null || echo 0)
if [ $((NOW - LAST)) -lt $DEBOUNCE_SECONDS ]; then
    exit 0
fi
echo "$NOW" > "$DEBOUNCE_FILE"

# Let the link fully settle (carrier negotiation, DHCP-elsewhere-on-the-
# wire timing) before re-applying - matches this project's existing
# preference for a short fixed wait over a fragile poll-until-ready loop
# in other setup scripts.
sleep 2

echo "$(date '+%Y-%m-%d %H:%M:%S') Link change detected, re-running network setup" >> "$LOG"
systemctl restart rj-network-setup.service
