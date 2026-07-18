#!/bin/bash
# Cross-checked against an OpenWrt/rockchip reference build's
# etc/init.d/sysfixtime — cheap ARM boards (Orange Pi 3B class hardware)
# often have no battery-backed RTC, so a cold boot after full power loss
# can start with the system clock stuck at whatever the kernel's built-in
# default is (often epoch, or a build date years in the past), before
# systemd-timesyncd/chrony has had a chance to sync over the network.
#
# Session/promo expires_at comparisons (sessionService.js, timerService.js)
# and nginx's TLS cert validity window all trust the system clock directly
# with no defense against this — a session could look already-expired (or
# never-expiring) and nginx could reject its own cert as "not yet valid" in
# that window. This forces the clock forward to a sane floor (the newest
# mtime among this app's own files, which is always chronologically after
# any real clock-reset scenario) before either service starts. It's a
# floor, not a fix — real time still comes from NTP once the network is up.
LOG="/var/log/rj-fix-clock.log"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NEWEST_MTIME=0
for f in $(find "$APP_DIR" -maxdepth 2 -type f 2>/dev/null); do
  m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
  [ "$m" -gt "$NEWEST_MTIME" ] && NEWEST_MTIME=$m
done

CURRENT=$(date +%s)

if [ "$NEWEST_MTIME" -gt 0 ] && [ "$CURRENT" -lt "$NEWEST_MTIME" ]; then
  date -s "@$NEWEST_MTIME" >> "$LOG" 2>&1
  echo "$(date): system clock was behind app files ($CURRENT < $NEWEST_MTIME), forced forward" >> "$LOG"
else
  echo "$(date): system clock looks sane, no action" >> "$LOG"
fi
