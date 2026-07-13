#!/bin/bash
# Health watchdog for rj-pisowifi.service.
#
# systemd's Restart=always (rj-pisowifi.service) only fires when the Node
# process actually exits - it does nothing for a process that's still
# running but stuck (an unhandled hang, a blocked event loop, a wedged
# connection to the router) and no longer answering requests at all. That
# gap is exactly what this catches: a real HTTP request to the app's own
# health endpoint, with a hard timeout. No response in time -> the service
# gets force-restarted, the same recovery a crash would already get
# automatically, extended to cover a hang too.
LOG="/var/log/rj-pisowifi-watchdog.log"

if ! curl -sf --max-time 5 http://127.0.0.1:3000/api/health > /dev/null 2>&1; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') Health check failed - restarting rj-pisowifi" >> "$LOG"
    systemctl restart rj-pisowifi
fi
