#!/bin/bash
LOG="/var/log/rj-network-setup.log"
DB="/home/rjcyberzone/rj-pisowifi/server/database/rjpisowifi.db"
GATEWAY_IP="10.0.0.1"

echo "=== R&J Network Setup $(date) ===" >> $LOG

# Read from DB
WAN_IF=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='wan_interface';" 2>/dev/null)
LAN_IF=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='lan_interface';" 2>/dev/null)
NETWORK_MODE=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='network_mode';" 2>/dev/null)

# Auto-detect fallback
if [ -z "$WAN_IF" ]; then
    WAN_IF=$(ip route show default 2>/dev/null | awk '/default/ {print $5}' | head -1)
fi
if [ -z "$LAN_IF" ]; then
    for iface in $(ls /sys/class/net/ | grep -E '^(eth|enp|ens|enx)'); do
        if [ "$iface" != "$WAN_IF" ]; then
            LAN_IF="$iface"
            break
        fi
    done
fi
[ -z "$NETWORK_MODE" ] && NETWORK_MODE="nodogsplash"

echo "WAN: $WAN_IF  LAN: $LAN_IF  Mode: $NETWORK_MODE" >> $LOG

if [ -z "$LAN_IF" ]; then
    echo "ERROR: No LAN interface found." >> $LOG
    exit 0
fi

# ── STOP NODOGSPLASH COMPLETELY ───────────────────────────────
pkill nodogsplash 2>/dev/null || true
systemctl stop nodogsplash 2>/dev/null || true
systemctl disable nodogsplash 2>/dev/null || true

# ── DISABLE UFW PERMANENTLY ───────────────────────────────────
systemctl stop ufw 2>/dev/null || true
systemctl disable ufw 2>/dev/null || true

# ── CLEAN ALL OLD NODOGSPLASH IPTABLES CHAINS ─────────────────
iptables -D INPUT -j ndsRTR 2>/dev/null || true
iptables -D FORWARD -j ndsNET 2>/dev/null || true
iptables -t nat -D PREROUTING -j ndsOUT 2>/dev/null || true
iptables -F ndsRTR 2>/dev/null || true
iptables -F ndsNET 2>/dev/null || true
iptables -F ndsAUT 2>/dev/null || true
iptables -t nat -F ndsOUT 2>/dev/null || true
iptables -X ndsRTR 2>/dev/null || true
iptables -X ndsNET 2>/dev/null || true
iptables -X ndsAUT 2>/dev/null || true
iptables -t nat -X ndsOUT 2>/dev/null || true
echo "nodogsplash chains cleaned" >> $LOG

# ── CONFIGURE LAN ─────────────────────────────────────────────
ip addr flush dev $LAN_IF 2>/dev/null
ip addr add ${GATEWAY_IP}/24 dev $LAN_IF
ip link set $LAN_IF up
echo "LAN: $LAN_IF → $GATEWAY_IP" >> $LOG

# IP forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward

# ── IPTABLES NAT ──────────────────────────────────────────────
iptables -t nat -F POSTROUTING 2>/dev/null
iptables -F FORWARD 2>/dev/null
iptables -t nat -A POSTROUTING -o $WAN_IF -j MASQUERADE
iptables -A FORWARD -i $LAN_IF -o $WAN_IF -j ACCEPT
iptables -A FORWARD -i $WAN_IF -o $LAN_IF -m state \
    --state RELATED,ESTABLISHED -j ACCEPT

# Port 80 → 3000 for WAN side (admin access)
iptables -t nat -F PREROUTING 2>/dev/null
iptables -t nat -A PREROUTING -i $WAN_IF -p tcp --dport 80 \
    -j REDIRECT --to-port 3000
echo "iptables NAT configured" >> $LOG

# ── START DNSMASQ ─────────────────────────────────────────────
sleep 1
rm -f /var/lib/misc/dnsmasq.leases

cat > /etc/dnsmasq.d/rj-pisowifi.conf << EOF
interface=$LAN_IF
bind-interfaces
dhcp-range=10.0.0.10,10.0.0.200,255.255.255.0,12h
dhcp-option=3,$GATEWAY_IP
dhcp-option=6,8.8.8.8
dhcp-option=114,http://$GATEWAY_IP:3000/portal
no-resolv
server=8.8.8.8
server=8.8.4.4
EOF

systemctl restart dnsmasq >> $LOG 2>&1
echo "dnsmasq started" >> $LOG

# ── NFTABLES CAPTIVE PORTAL ───────────────────────────────────
if [ "$NETWORK_MODE" = "nodogsplash" ]; then

    nft delete table ip rj_piso 2>/dev/null || true
    sleep 1

    cat > /tmp/rj-piso.nft << NFTEOF
table ip rj_piso {
    set allowed_macs {
        type ether_addr
        flags dynamic
    }
    chain input {
        type filter hook input priority filter; policy accept;
        iifname "$LAN_IF" udp dport 67 accept
        iifname "$LAN_IF" tcp dport 3000 accept
        iifname "$LAN_IF" tcp dport 80 accept
    }
    chain forward {
        type filter hook forward priority filter; policy accept;
        ct state established,related accept
        iifname "$LAN_IF" ether saddr @allowed_macs accept
        iifname "$LAN_IF" drop
    }
    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        oifname "$WAN_IF" masquerade
    }
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        iifname "$LAN_IF" ether saddr != @allowed_macs udp dport 53 dnat to $GATEWAY_IP:53
        iifname "$LAN_IF" ether saddr != @allowed_macs tcp dport 53 dnat to $GATEWAY_IP:53
        iifname "$LAN_IF" ether saddr != @allowed_macs tcp dport 80 dnat to $GATEWAY_IP:3000
    }
}
NFTEOF

    nft -f /tmp/rj-piso.nft >> $LOG 2>&1
    echo "nftables captive portal loaded" >> $LOG

    # ── TC BANDWIDTH SHAPING SETUP ────────────────────────────────
    tc qdisc del dev $LAN_IF root 2>/dev/null || true
    tc qdisc add dev $LAN_IF root handle 1: htb default 999 r2q 1
    tc class add dev $LAN_IF parent 1: classid 1:999 htb rate 100mbit ceil 100mbit
    echo "tc root qdisc configured on $LAN_IF" >> $LOG

elif [ "$NETWORK_MODE" = "mikrotik" ]; then
    echo "MikroTik mode" >> $LOG
fi

# ── SAVE NFTABLES FOR REBOOT ──────────────────────────────────
nft list ruleset > /etc/nftables-rj.nft
echo "nftables rules saved" >> $LOG

# ── INSTALL NFTABLES RESTORE SERVICE ─────────────────────────
cat > /etc/systemd/system/rj-nftables-restore.service << EOF2
[Unit]
Description=R&J PisoWifi nftables restore
After=network.target
Before=rj-network-setup.service

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/nftables-rj.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF2
systemctl daemon-reload >> $LOG 2>&1
systemctl enable rj-nftables-restore >> $LOG 2>&1
echo "nftables restore service installed" >> $LOG

echo "=== Setup complete ===" >> $LOG