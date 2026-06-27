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

# ─── 1. CHECK ROOT ───────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash setup/install.sh"
  exit 1
fi

# ─── 2. UPDATE ───────────────────────────────────────────────
echo "[1/9] Updating system..." | tee -a $LOG
apt update -y >> $LOG 2>&1

# ─── 3. APT DEPENDENCIES ─────────────────────────────────────
echo "[2/9] Installing dependencies..." | tee -a $LOG
apt install -y \
  curl git sqlite3 \
  dnsmasq \
  iptables iptables-persistent netfilter-persistent \
  avahi-daemon avahi-utils \
  build-essential libmicrohttpd-dev make debhelper dpkg-dev \
  python3 \
  >> $LOG 2>&1

# ─── 4. NODE.JS 20 ───────────────────────────────────────────
echo "[3/9] Installing Node.js 20..." | tee -a $LOG
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >> $LOG 2>&1
apt install -y nodejs >> $LOG 2>&1
echo "Node: $(node -v)" | tee -a $LOG

# ─── 5. NODOGSPLASH (build from source) ──────────────────────
echo "[4/9] Building nodogsplash..." | tee -a $LOG
rm -rf /tmp/nodogsplash
git clone https://github.com/nodogsplash/nodogsplash.git \
  /tmp/nodogsplash >> $LOG 2>&1
cd /tmp/nodogsplash
make >> $LOG 2>&1
make install >> $LOG 2>&1
mkdir -p /etc/nodogsplash
cd $APP_DIR
echo "nodogsplash installed" | tee -a $LOG

# ─── 6. DISABLE systemd-resolved ─────────────────────────────
echo "[5/9] Configuring DNS..." | tee -a $LOG
systemctl stop systemd-resolved >> $LOG 2>&1 || true
systemctl disable systemd-resolved >> $LOG 2>&1 || true
rm -f /etc/resolv.conf
echo "nameserver 8.8.8.8" > /etc/resolv.conf
echo "nameserver 1.1.1.1" >> /etc/resolv.conf
chattr +i /etc/resolv.conf
echo "DNS configured" | tee -a $LOG

# ─── 7. SYSTEM CONFIG ────────────────────────────────────────
echo "[6/9] System configuration..." | tee -a $LOG

# IP forwarding permanent
grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf || \
  echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
sysctl -p >> $LOG 2>&1

# Hostname
hostnamectl set-hostname rjcyberzone >> $LOG 2>&1
grep -q "127.0.0.1 rjcyberzone" /etc/hosts || \
  echo "127.0.0.1 rjcyberzone" >> /etc/hosts

# Disable systemd dnsmasq + nodogsplash
# setup-network.sh controls them directly
systemctl disable dnsmasq >> $LOG 2>&1 || true
systemctl stop dnsmasq >> $LOG 2>&1 || true

# Firewall
ufw allow 22 >> $LOG 2>&1
ufw allow 80 >> $LOG 2>&1
ufw allow 3000 >> $LOG 2>&1
ufw --force enable >> $LOG 2>&1

# ─── 8. CREATE NEEDED FOLDERS ────────────────────────────────
echo "Creating folders..." | tee -a $LOG
mkdir -p $APP_DIR/server/database
mkdir -p $APP_DIR/public/uploads
chown -R $USER:$USER $APP_DIR

# ─── 9. NPM INSTALL ──────────────────────────────────────────
echo "[7/9] Installing Node packages..." | tee -a $LOG
cd $APP_DIR
sudo -u $USER npm install >> $LOG 2>&1
sudo -u $USER npm rebuild >> $LOG 2>&1
echo "npm done" | tee -a $LOG

# ─── 10. SYSTEMD SERVICES ────────────────────────────────────
echo "[8/9] Installing systemd services..." | tee -a $LOG

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

systemctl daemon-reload >> $LOG 2>&1
systemctl enable rj-pisowifi >> $LOG 2>&1
systemctl enable rj-network-setup >> $LOG 2>&1
echo "Services installed" | tee -a $LOG

# ─── 11. SUDOERS + AVAHI ─────────────────────────────────────
echo "[9/9] Final setup..." | tee -a $LOG

# Allow Node.js to trigger network reconfiguration without password
echo "$USER ALL=(ALL) NOPASSWD: /bin/bash $APP_DIR/setup/setup-network.sh" \
  > /etc/sudoers.d/rj-pisowifi
chmod 440 /etc/sudoers.d/rj-pisowifi

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

# iptables port 80 → 3000 for admin access
iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3000
netfilter-persistent save >> $LOG 2>&1

# ─── START ───────────────────────────────────────────────────
echo "Starting services..." | tee -a $LOG
systemctl start rj-network-setup
systemctl start rj-pisowifi

echo "" | tee -a $LOG
echo "=============================================" | tee -a $LOG
echo " R&J PisoWifi installed successfully!" | tee -a $LOG
echo " Admin: http://rjcyberzone.local/admin" | tee -a $LOG
echo " Or: http://$(hostname -I | awk '{print $1}')/admin" | tee -a $LOG
echo "=============================================" | tee -a $LOG