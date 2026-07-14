#!/bin/bash
# =============================================
# R&J PisoWifi — One-Shot Installer
# Fresh Ubuntu 22.04 only
# Usage: sudo bash setup/install.sh
# =============================================

set -e
LOG="/var/log/rj-install.log"
APP_DIR="/home/rjcyberzone/rj-pisowifi"
USER="rjcyberzone"
SETUP_DIR="$APP_DIR/setup"

echo "=============================================" | tee -a $LOG
echo " R&J PisoWifi Installer $(date)" | tee -a $LOG
echo "=============================================" | tee -a $LOG

# ─── 0. GET THE CODE (fresh machines only) ───────────────────
# If $APP_DIR already exists, this is a dev/test machine managing its own
# clone (full history, git pull for updates) - leave it completely alone.
# A genuinely fresh install, with nothing there yet, gets a SHALLOW clone
# (--depth 1) instead - only the current state, not the full commit
# history, since a customer's own installed copy has no reason to carry
# every past commit with it.
if [ ! -d "$APP_DIR/.git" ]; then
  echo "[0/8] Fetching application code (shallow clone, no history)..." | tee -a $LOG
  REPO_URL="${RJ_PISOWIFI_REPO_URL:-https://github.com/jnunez2001/rj-pisowifi.git}"
  git clone --depth 1 "$REPO_URL" "$APP_DIR" >> $LOG 2>&1
fi

# ─── 1. CHECK ROOT ───────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash setup/install.sh"
  exit 1
fi

# ─── 2. UPDATE ───────────────────────────────────────────────
echo "[1/8] Updating system..." | tee -a $LOG
apt update -y >> $LOG 2>&1

# ─── 3. APT DEPENDENCIES ─────────────────────────────────────
echo "[2/8] Installing dependencies..." | tee -a $LOG
apt install -y \
  curl git sqlite3 \
  dnsmasq \
  isc-dhcp-client \
  iproute2 \
  nftables \
  iptables iptables-persistent netfilter-persistent \
  avahi-daemon avahi-utils \
  python3 \
  nginx openssl \
  >> $LOG 2>&1

# ─── 4. NODE.JS 20 ───────────────────────────────────────────
echo "[3/8] Installing Node.js 20..." | tee -a $LOG
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >> $LOG 2>&1
apt install -y nodejs >> $LOG 2>&1
echo "Node: $(node -v)" | tee -a $LOG

# ─── 5. DISABLE systemd-resolved ─────────────────────────────
echo "[4/8] Configuring DNS..." | tee -a $LOG
systemctl stop systemd-resolved >> $LOG 2>&1 || true
systemctl disable systemd-resolved >> $LOG 2>&1 || true
# Bug: chattr +i below makes this file immutable, so a second run of this
# script (e.g. to pick up new sudoers/package changes after a git pull)
# fails right here with "Operation not permitted" - rm can't remove an
# immutable file even as root without clearing the flag first.
chattr -i /etc/resolv.conf 2>/dev/null || true
rm -f /etc/resolv.conf
echo "nameserver 8.8.8.8" > /etc/resolv.conf
echo "nameserver 1.1.1.1" >> /etc/resolv.conf
chattr +i /etc/resolv.conf
echo "DNS configured" | tee -a $LOG

# ─── 6. SYSTEM CONFIG ────────────────────────────────────────
echo "[5/8] System configuration..." | tee -a $LOG

# IP forwarding permanent
grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf || \
  echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
sysctl -p >> $LOG 2>&1

# Hostname
hostnamectl set-hostname rjcyberzone >> $LOG 2>&1
grep -q "127.0.0.1 rjcyberzone" /etc/hosts || \
  echo "127.0.0.1 rjcyberzone" >> /etc/hosts

# Disable systemd managed services
# setup-network.sh controls them directly
systemctl disable dnsmasq >> $LOG 2>&1 || true
systemctl stop dnsmasq >> $LOG 2>&1 || true
systemctl disable nftables >> $LOG 2>&1 || true

# Disable nodogsplash if installed
systemctl disable nodogsplash >> $LOG 2>&1 || true
systemctl stop nodogsplash >> $LOG 2>&1 || true

# Remove UFW completely — we use nftables directly
apt purge ufw -y >> $LOG 2>&1 || true

# Bug: iptables-persistent auto-loads /etc/iptables/rules.v[46] at every boot,
# BEFORE rj-network-setup.service runs (confirmed via systemctl status
# timestamps - netfilter-persistent finished ~13s before rj-network-setup
# started on a live box). If anyone ever runs `netfilter-persistent save` or
# `iptables-save > /etc/iptables/rules.v4` mid-troubleshooting (easy to do
# by habit), that snapshot gets silently replayed on every future boot ahead
# of this project's own network setup - the same class of bug as two DHCP
# servers fighting each other, just with stale firewall rules instead. This
# project already re-applies its own iptables/nftables rules from scratch on
# every boot (setup-network.sh + rj-nftables-restore.service), so
# netfilter-persistent has no job here - disable and mask it so it can't
# load anything even if a rules.v4 file reappears later, and remove any
# snapshot that already exists.
systemctl disable netfilter-persistent >> $LOG 2>&1 || true
systemctl mask netfilter-persistent >> $LOG 2>&1 || true
rm -f /etc/iptables/rules.v4 /etc/iptables/rules.v6

# Bug #80: rj-fix-iptables.service (created by hand on past installs, not by
# this script) waits for a legacy nodogsplash "ndsRTR" iptables chain that
# setup-network.sh has deleted on every run for a long time now - it's been
# silently failing all 5 of its rule inserts on every boot. What it tried to
# allow (DHCP/DNS/portal ports on the LAN interface) is already covered by
# the current nftables rj_piso table, so it's dead weight, not a safety net.
# Clean it up if a past manual setup left it behind.
systemctl disable rj-fix-iptables >> $LOG 2>&1 || true
systemctl stop rj-fix-iptables >> $LOG 2>&1 || true
rm -f /etc/systemd/system/rj-fix-iptables.service
rm -f $APP_DIR/setup/fix-iptables.sh
systemctl daemon-reload >> $LOG 2>&1 || true

# ─── 7. CREATE NEEDED FOLDERS ────────────────────────────────
echo "Creating folders..." | tee -a $LOG
mkdir -p $APP_DIR/public/uploads
chown -R $USER:$USER $APP_DIR

# Data storage lives outside $APP_DIR on purpose (Bug: DB used to sit inside
# the app's own repo tree — an OS reflash or a careless `git clean` in the
# app dir could take live customer/session data with it). One-time migration
# below moves an existing DB from the old in-repo location if this is a
# re-run of install.sh on a box that predates this change; safe/idempotent
# on fresh installs since there's nothing to move.
DATA_DIR="/var/lib/rj-pisowifi"
mkdir -p $DATA_DIR/database $DATA_DIR/logs
if [ -f "$APP_DIR/server/database/rjpisowifi.db" ] && [ ! -f "$DATA_DIR/database/rjpisowifi.db" ]; then
  echo "Migrating existing database to $DATA_DIR/database ..." | tee -a $LOG
  mv $APP_DIR/server/database/rjpisowifi.db* $DATA_DIR/database/ 2>/dev/null || true
fi
chown -R $USER:$USER $DATA_DIR

# ─── 8. NPM INSTALL ──────────────────────────────────────────
echo "[6/8] Installing Node packages..." | tee -a $LOG
cd $APP_DIR
sudo -u $USER npm install >> $LOG 2>&1
sudo -u $USER npm rebuild >> $LOG 2>&1
echo "npm done" | tee -a $LOG

# ─── 9. SYSTEMD SERVICES ─────────────────────────────────────
echo "[7/8] Installing systemd services..." | tee -a $LOG

cat > /etc/systemd/system/rj-pisowifi.service << EOF
[Unit]
Description=R&J PisoWifi Server
After=network.target rj-network-setup.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server/app.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=DB_PATH=$DATA_DIR/database/rjpisowifi.db
Environment=FINANCIAL_LOG_DIR=$DATA_DIR/logs
Environment=VENDO_FIRMWARE_DIR=$DATA_DIR/firmware

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/rj-network-setup.service << EOF
[Unit]
Description=R&J PisoWifi Network Setup
After=network.target

[Service]
Type=oneshot
ExecStart=/bin/bash $APP_DIR/setup/setup-network.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

chmod +x $APP_DIR/setup/watchdog.sh

# Bug class this prevents: Restart=always above only fires when the Node
# process actually exits - a hang (process alive, event loop stuck, no
# longer answering any request) gets no automatic recovery at all without
# this. Real-hardware incident: the app became unreachable from every
# device on the network for an extended period with no crash in the
# service log, and only a manual VM power-cycle fixed it - exactly the gap
# a plain Restart=always can't cover. This polls the app's own health
# endpoint every 30s with a hard timeout and force-restarts the service if
# it ever stops answering, whether or not the process itself is still
# technically running.
cat > /etc/systemd/system/rj-pisowifi-watchdog.service << EOF
[Unit]
Description=R&J PisoWifi Health Watchdog

[Service]
Type=oneshot
ExecStart=/bin/bash $APP_DIR/setup/watchdog.sh
EOF

cat > /etc/systemd/system/rj-pisowifi-watchdog.timer << EOF
[Unit]
Description=Run R&J PisoWifi Health Watchdog every 30s

[Timer]
OnBootSec=60
OnUnitActiveSec=30

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload >> $LOG 2>&1
systemctl enable rj-pisowifi >> $LOG 2>&1
systemctl enable rj-network-setup >> $LOG 2>&1
systemctl enable rj-pisowifi-watchdog.timer >> $LOG 2>&1
systemctl start rj-pisowifi-watchdog.timer >> $LOG 2>&1
echo "Services installed" | tee -a $LOG

# ─── 9b. NGINX + TLS (WAN admin access) ──────────────────────
echo "Configuring nginx TLS front door..." | tee -a $LOG

mkdir -p /etc/rj-pisowifi/tls
# Self-signed — there's no public domain for this box. Still strictly
# better than the plaintext admin access this replaces (see setup-network.sh
# comment on the removed WAN port80->3000 redirect). Only generated once;
# re-running install.sh doesn't churn the cert or invalidate a browser's
# saved exception for it.
if [ ! -f /etc/rj-pisowifi/tls/fullchain.pem ]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /etc/rj-pisowifi/tls/privkey.pem \
    -out /etc/rj-pisowifi/tls/fullchain.pem \
    -subj "/CN=rjcyberzone.local" >> $LOG 2>&1
fi
chmod 600 /etc/rj-pisowifi/tls/privkey.pem

cp $SETUP_DIR/nginx.conf /etc/nginx/sites-available/rj-pisowifi
ln -sf /etc/nginx/sites-available/rj-pisowifi /etc/nginx/sites-enabled/rj-pisowifi
rm -f /etc/nginx/sites-enabled/default
nginx -t >> $LOG 2>&1
systemctl enable nginx >> $LOG 2>&1
systemctl restart nginx >> $LOG 2>&1
echo "nginx configured" | tee -a $LOG

# ─── 10. SUDOERS + AVAHI ─────────────────────────────────────
echo "[8/8] Final setup..." | tee -a $LOG

# Allow Node.js to run network setup without password
echo "$USER ALL=(ALL) NOPASSWD: /bin/bash $APP_DIR/setup/setup-network.sh" \
  > /etc/sudoers.d/rj-pisowifi
chmod 440 /etc/sudoers.d/rj-pisowifi

# Allow Node.js to run nft and tc commands without password
echo "$USER ALL=(ALL) NOPASSWD: /usr/sbin/nft" \
  >> /etc/sudoers.d/rj-pisowifi
echo "$USER ALL=(ALL) NOPASSWD: /usr/sbin/tc" \
  >> /etc/sudoers.d/rj-pisowifi

# Allow Node.js to remove a VLAN sub-interface when a VLAN is deleted from
# the admin panel's Network > VLAN Management page
echo "$USER ALL=(ALL) NOPASSWD: /sbin/ip, /usr/sbin/ip" \
  >> /etc/sudoers.d/rj-pisowifi

# Bug: the admin panel's Reboot/Shutdown buttons (server/routes/admin.js
# POST /system/reboot and /system/shutdown) call `sudo reboot`/`sudo
# shutdown` directly, but no sudoers entry for either was ever added here -
# the API call still returned success (it responds before the command's
# result comes back), so the button looked like it worked while the actual
# command silently failed waiting on a password prompt that never comes.
echo "$USER ALL=(ALL) NOPASSWD: /sbin/reboot, /usr/sbin/reboot" \
  >> /etc/sudoers.d/rj-pisowifi
echo "$USER ALL=(ALL) NOPASSWD: /sbin/shutdown, /usr/sbin/shutdown" \
  >> /etc/sudoers.d/rj-pisowifi

# Bug found on real hardware: the admin panel's Network > Network
# Configuration card (server/routes/admin.js POST /network) calls
# `sudo cp ... /etc/netplan/50-cloud-init.yaml` and `sudo netplan apply`
# directly, but no sudoers entry for either was ever added here either -
# same failure mode as the reboot/shutdown bug just above, except this one
# surfaces immediately ("Failed to apply config") instead of silently, since
# this route waits for the command result before responding. Scoped tightly
# to the one destination file this app ever writes, rather than a blanket
# grant on cp (which could otherwise overwrite any file on the system as
# root).
echo "$USER ALL=(ALL) NOPASSWD: /bin/cp * /etc/netplan/50-cloud-init.yaml" \
  >> /etc/sudoers.d/rj-pisowifi
echo "$USER ALL=(ALL) NOPASSWD: /usr/sbin/netplan apply" \
  >> /etc/sudoers.d/rj-pisowifi

# avahi mDNS — rjcyberzone.local
cat > /etc/avahi/services/rjcyberzone.service << EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name>R&amp;J PisoWifi</name>
  <service>
    <type>_http._tcp</type>
    <port>80</port>
  </service>
</service-group>
EOF
systemctl enable avahi-daemon >> $LOG 2>&1
systemctl restart avahi-daemon >> $LOG 2>&1

# ─── START ───────────────────────────────────────────────────
echo "Starting services..." | tee -a $LOG
systemctl start rj-network-setup
systemctl start rj-pisowifi

echo "" | tee -a $LOG
echo "=============================================" | tee -a $LOG
echo " R&J PisoWifi installed successfully!" | tee -a $LOG
echo " LAN admin access: http://rjcyberzone.local/admin" | tee -a $LOG
echo " Or: http://$(hostname -I | awk '{print $1}')/admin" | tee -a $LOG
echo " WAN admin access (TLS, self-signed cert): https://<this box's WAN IP>/admin" | tee -a $LOG
echo "=============================================" | tee -a $LOG
