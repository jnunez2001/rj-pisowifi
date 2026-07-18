#!/bin/bash
# Pi-hole DNS filtering — OPT-IN, separate from the main install.sh on
# purpose. Deferred for a while per the standing decision to let a prior
# night's network-stability fixes run proven-stable before adding new
# moving parts; this is that add-on now that it's been asked for.
#
# Runs as an isolated Docker container bound to loopback only — it never
# touches port 53/80 on any real interface, so it can't collide with this
# app's own dnsmasq (which stays the only DNS/DHCP server customers ever
# talk to) or its web admin panel. setup-network.sh points dnsmasq at this
# container as its FIRST upstream resolver, with the existing public DNS
# servers kept right behind it — if this container is down, dnsmasq just
# uses the next upstream. No customer loses DNS because Pi-hole crashed.
set -e
LOG="/var/log/rj-pihole-install.log"
DB="/var/lib/rj-pisowifi/database/rjpisowifi.db"

echo "=== R&J Pi-hole Install $(date) ===" >> $LOG

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash setup/install-pihole.sh"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[1/3] Installing Docker..." | tee -a $LOG
  curl -fsSL https://get.docker.com | sh >> $LOG 2>&1
fi

echo "[2/3] Starting Pi-hole container (loopback-only)..." | tee -a $LOG

if docker ps -a --format '{{.Names}}' | grep -qx rj-pihole; then
  # Bug: an existing-but-stopped container (e.g. after a reboot before the
  # --restart policy caught up, or a prior partial run) was left stopped -
  # enable_pihole would still get set to 1 below, so dnsmasq would point at
  # an upstream nothing is listening on. Fail-open design means customers
  # never lose DNS either way, but filtering would silently just not work.
  if ! docker ps --format '{{.Names}}' | grep -qx rj-pihole; then
    echo "rj-pihole container exists but is stopped - starting it" | tee -a $LOG
    docker start rj-pihole >> $LOG 2>&1
  else
    echo "rj-pihole container already running, leaving it as-is (re-run 'docker rm -f rj-pihole' first to recreate)" | tee -a $LOG
  fi
else
  ADMIN_PASS=$(openssl rand -base64 18)
  docker run -d \
    --name rj-pihole \
    --restart=unless-stopped \
    -p 127.0.0.1:5335:53/tcp \
    -p 127.0.0.1:5335:53/udp \
    -p 127.0.0.1:8081:80/tcp \
    -e TZ="$(cat /etc/timezone 2>/dev/null || echo UTC)" \
    -e FTLCONF_webserver_api_password="$ADMIN_PASS" \
    -e FTLCONF_dns_listeningMode="all" \
    -v rj-pihole-etc:/etc/pihole \
    -v rj-pihole-dnsmasq:/etc/dnsmasq.d \
    pihole/pihole:latest >> $LOG 2>&1

  echo "" | tee -a $LOG
  echo "Blocking service admin UI (SSH-tunnel or localhost only, not exposed to customers):" | tee -a $LOG
  echo "  http://127.0.0.1:8081/admin" | tee -a $LOG
  echo "  password: $ADMIN_PASS" | tee -a $LOG
  echo "  (save this now — it is only printed once)" | tee -a $LOG
  echo "" | tee -a $LOG

  # Stored encrypted (same secretCrypto helper as mikrotik_pass, see
  # server/utils/secretCrypto.js) so the app's own admin panel can query
  # the stats/status API without a human copy-pasting it into a settings
  # field. DB_PATH must match install.sh's real data directory so the
  # encryption key file (kept OUTSIDE the DB on purpose) is the same one
  # the running app process uses.
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  ENCRYPTED_PASS=$(DB_PATH="/var/lib/rj-pisowifi/database/rjpisowifi.db" node -e "console.log(require('$APP_DIR/server/utils/secretCrypto').encryptSecret(process.argv[1]))" "$ADMIN_PASS" 2>>"$LOG")
  if [ -n "$ENCRYPTED_PASS" ]; then
    sqlite3 "$DB" "INSERT OR REPLACE INTO settings (key, value) VALUES ('pihole_api_pass', '$(echo "$ENCRYPTED_PASS" | sed "s/'/''/g")')" 2>/dev/null || true
  else
    echo "WARNING: could not store the password for the app to use automatically - stats/status panel won't work until this is fixed" | tee -a $LOG
  fi
fi

echo "[3/3] Enabling Pi-hole in settings and re-applying network..." | tee -a $LOG
sqlite3 "$DB" "INSERT OR REPLACE INTO settings (key, value) VALUES ('enable_pihole', '1')" 2>/dev/null || true
bash "$(dirname "${BASH_SOURCE[0]}")/setup-network.sh"

echo "Done. dnsmasq now uses Pi-hole as its first upstream resolver, public DNS as fallback." | tee -a $LOG
