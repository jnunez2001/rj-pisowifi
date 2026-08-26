#!/bin/bash
# Copyright (c) 2026 Zentry Systems. All rights reserved.
#
# Regenerates /etc/issue (the pre-login console banner) with whatever IP
# addresses are actually assigned right now. Extracted out of
# setup-network.sh so it can be called again later in boot, after the
# static IP is actually applied.
#
# Real bug this closes: setup-network.sh writes /etc/issue once, early in
# boot, while DHCP negotiation on the WAN side can still be in progress
# and before hostNetworkService.js's reapplyStaticNetworkOnBoot() (which
# runs later, when the Node app itself starts) has assigned the real
# static IP. Nothing called this again after that point, so a box could
# be fully reachable at its correct static IP while the console still
# said "(no IP assigned yet)" - confusing during troubleshooting even
# though nothing was actually wrong. hostNetworkService.js now calls this
# script again right after a successful static apply so the banner
# reflects reality instead of a stale boot-time snapshot.

APP_DIR="/home/rjcyberzone/rj-pisowifi"
ISSUE_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$APP_DIR/package.json" 2>/dev/null | sed 's/.*:[[:space:]]*"//;s/"$//')
[ -z "$ISSUE_VERSION" ] && ISSUE_VERSION="unknown"

{
    echo ""
    printf '\033[36m'
    cat << 'ISSUELOGO'
                                                    ,,
 .M"""bgd mm                   `7MM      `7MM"""YMM db
,MI    "Y MM                     MM        MM    `7
`MMb.   mmMMmm  ,6"Yb.  `7Mb,od8 MM  ,MP'  MM   d `7MM
  `YMMNq. MM   8)   MM    MM' "' MM ;Y     MM""MM   MM
.     `MM MM    ,pm9MM    MM     MM;Mm     MM   Y   MM
Mb     dM MM   8M   MM    MM     MM `Mb.   MM       MM
P"Ybmmd"  `Mbmo`Moo9^Yo..JMML. .JMML. YA..JMML.   .JMML.
ISSUELOGO
    printf '\033[0m'
    echo ""
    echo "Zentry Systems - StarkFi Hotspot Server $ISSUE_VERSION"
    echo "Copyright (c) $(date +%Y) Zentry Systems. All rights reserved."
    echo "-----------------------------------------------"
    FOUND_IP=0
    ISSUE_PRIMARY_IP=""
    for ifc in $(ls /sys/class/net/ | grep -vE '^(lo|docker|veth|br-)'); do
        IP=$(ip -4 -o addr show dev "$ifc" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
        if [ -n "$IP" ]; then
            echo "  $ifc: $IP"
            [ -z "$ISSUE_PRIMARY_IP" ] && ISSUE_PRIMARY_IP="$IP"
            FOUND_IP=1
        fi
    done
    [ "$FOUND_IP" = "0" ] && echo "  (no IP assigned yet)"
    echo "-----------------------------------------------"
    ISSUE_DEVICE_ID=$(grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' /var/lib/rj-pisowifi/.device-identity 2>/dev/null | sed 's/.*:[[:space:]]*"//;s/"$//')
    [ -n "$ISSUE_DEVICE_ID" ] && echo "  Device ID: $ISSUE_DEVICE_ID"
    if [ -n "$ISSUE_PRIMARY_IP" ]; then
        echo "  Admin panel: http://$ISSUE_PRIMARY_IP:3000/admin"
        echo "  Portal: http://$ISSUE_PRIMARY_IP:3000/portal"
    else
        echo "  Admin panel: (unavailable - no IP assigned yet)"
    fi
    echo "-----------------------------------------------"
    echo ""
} > /etc/issue
