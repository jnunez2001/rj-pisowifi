#!/bin/bash
# Pi-hole DNS filtering, OPT-IN, separate from the main install.sh on
# purpose. Deferred for a while per the standing decision to let a prior
# night's network-stability fixes run proven-stable before adding new
# moving parts; this is that add-on now that it's been asked for.
#
# Standalone mode: runs as an isolated Docker container bound to loopback
# only, it never touches port 53/80 on any real interface, so it can't
# collide with this app's own dnsmasq (which stays the only DNS/DHCP server
# customers ever talk to) or its web admin panel. setup-network.sh points
# dnsmasq at this container as its FIRST upstream resolver, with the
# existing public DNS servers kept right behind it, if this container is
# down, dnsmasq just uses the next upstream. No customer loses DNS because
# Pi-hole crashed.
#
# Controller (MikroTik) mode: dnsmasq isn't running at all in this mode -
# the DNS consumer is the physical MikroTik router itself, a SEPARATE
# device on the LAN, not this box. Loopback-only would make it permanently
# unreachable from the router (127.0.0.1 is only ever local to the machine
# it's bound on) - server/services/mikrotikService.js's setDnsFilterServers()
# could point the router at this box's real LAN IP all day and it would
# still just be querying nothing, exactly the "toggle is on, real customer
# traffic never shows up in the stats" bug found live. Bound additionally to
# 0.0.0.0:53 in this mode instead (dnsmasq being stopped means nothing else
# already owns that port), with an nftables rule right after, further down,
# that drops any port 53 request arriving via a WAN interface specifically -
# so this never becomes an open DNS resolver reachable from the public
# internet on a box that also happens to have a WAN-facing interface.
set -e
LOG="/var/log/rj-pihole-install.log"
DB="/var/lib/rj-pisowifi/database/rjpisowifi.db"
APP_USER="rjcyberzone"

NETWORK_MODE=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='network_mode';" 2>/dev/null)
WAN_IF=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='wan_interface';" 2>/dev/null)
LAN_IF=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='lan_interface';" 2>/dev/null)

echo "=== R&J Pi-hole Install $(date) ===" >> $LOG

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash setup/install-pihole.sh"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[1/3] Installing Docker..." | tee -a $LOG
  curl -fsSL https://get.docker.com | sh >> $LOG 2>&1
fi

# Bug found live: the "Update Block Lists" button (POST
# /api/admin/dns-filter/update-lists) runs `docker exec ...` as the app's
# own process, which runs as $APP_USER (systemd User=, not root) - without
# group membership, that call fails on Docker's socket permission check
# with no useful error surfaced to the admin panel beyond "Could not
# update block lists right now". Docker group membership is functionally
# root-equivalent (same trust level this app's process already has via
# its narrow NOPASSWD sudoers entries for nft/tc/ip), so this isn't a new
# privilege the app didn't already effectively have. Restarting the
# service is required, not optional - a running systemd unit doesn't pick
# up new group membership just because usermod ran; it needs to actually
# restart so its process gets re-spawned with the updated group list.
if ! id -nG "$APP_USER" 2>/dev/null | grep -qw docker; then
  usermod -aG docker "$APP_USER"
  echo "Added $APP_USER to the docker group" | tee -a $LOG
  systemctl restart rj-pisowifi >> $LOG 2>&1 || true
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

  # Always keep the loopback:5335 mapping - Standalone mode's dnsmasq
  # depends on it regardless of which mode is active right now (a mode
  # switch later shouldn't require reinstalling this container). Only add
  # the LAN-reachable standard-port-53 mapping when actually in Controller
  # mode, since Standalone mode's own dnsmasq already legitimately owns
  # port 53 on the LAN interface - binding Pi-hole there too would collide
  # with it and fail the container start outright.
  DOCKER_DNS_PORTS=(-p 127.0.0.1:5335:53/tcp -p 127.0.0.1:5335:53/udp)
  if [ "$NETWORK_MODE" = "mikrotik" ]; then
    DOCKER_DNS_PORTS+=(-p 0.0.0.0:53:53/tcp -p 0.0.0.0:53:53/udp)
    echo "Controller mode detected - also binding port 53 for the MikroTik router to reach (firewall-restricted to the LAN interface below)" | tee -a $LOG
  fi

  docker run -d \
    --name rj-pihole \
    --restart=unless-stopped \
    "${DOCKER_DNS_PORTS[@]}" \
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
  echo "  (save this now, it is only printed once)" | tee -a $LOG
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

# Controller mode's port-53 binding above is 0.0.0.0 (Docker doesn't bind
# well to a LAN IP that can change on DHCP renewal), which by itself would
# make Pi-hole reachable from EVERY interface on this box, including a WAN
# one if this box happens to have a public-facing interface directly (as
# opposed to sitting entirely behind the MikroTik router on the LAN side).
# This rule is what actually enforces "LAN only": drop any port 53 request
# arriving via the WAN interface specifically, independent of Docker's own
# binding. Re-applied every run (not just on first install) so it can't
# drift out of sync with whatever the current interface config is. A
# separate nftables table of its own (not touching the existing rj_piso
# table Standalone mode's client-access-control uses) so this can never
# corrupt that unrelated ruleset.
if [ "$NETWORK_MODE" = "mikrotik" ] && [ -n "$WAN_IF" ] && [ "$WAN_IF" != "$LAN_IF" ]; then
  echo "Restricting port 53 to the LAN interface ($LAN_IF), blocking it on WAN ($WAN_IF)..." | tee -a $LOG
  nft delete table inet rj_pihole_guard 2>/dev/null || true
  nft -f - << NFTEOF 2>>"$LOG" || echo "WARNING: could not apply the WAN firewall guard for port 53 - fix this before relying on Controller-mode DNS filtering, or Pi-hole may be reachable from the internet" | tee -a $LOG
table inet rj_pihole_guard {
  chain input {
    type filter hook input priority -1; policy accept;
    iifname "$WAN_IF" udp dport 53 drop
    iifname "$WAN_IF" tcp dport 53 drop
  }
}
NFTEOF
elif [ "$NETWORK_MODE" = "mikrotik" ]; then
  echo "No separate WAN interface identified for this box - skipping the port 53 firewall guard (nothing to restrict against)." | tee -a $LOG
fi

echo "[3/3] Enabling Pi-hole in settings and re-applying network..." | tee -a $LOG
sqlite3 "$DB" "INSERT OR REPLACE INTO settings (key, value) VALUES ('enable_pihole', '1')" 2>/dev/null || true
bash "$(dirname "${BASH_SOURCE[0]}")/setup-network.sh"

echo "Done. dnsmasq now uses Pi-hole as its first upstream resolver, public DNS as fallback." | tee -a $LOG
