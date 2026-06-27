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

# ── FULL IPTABLES CLEANUP ─────────────────────────────────────
# Remove jump rules FIRST, then flush, then delete chains
iptables -D INPUT -j ndsRTR 2>/dev/null || true
iptables -D FORWARD -j ndsNET 2>/dev/null || true
iptables -t nat -D PREROUTING -j ndsOUT 2>/dev/null || true

# Flush chains
iptables -F ndsRTR 2>/dev/null || true
iptables -F ndsNET 2>/dev/null || true
iptables -F ndsAUT 2>/dev/null || true
iptables -t nat -F ndsOUT 2>/dev/null || true

# Delete chains
iptables -X ndsRTR 2>/dev/null || true
iptables -X ndsNET 2>/dev/null || true
iptables -X ndsAUT 2>/dev/null || true
iptables -t nat -X ndsOUT 2>/dev/null || true

echo "iptables cleaned" >> $LOG

# ── CONFIGURE LAN ─────────────────────────────────────────────
ip addr flush dev $LAN_IF 2>/dev/null
ip addr add ${GATEWAY_IP}/24 dev $LAN_IF
ip link set $LAN_IF up
echo "LAN: $LAN_IF → $GATEWAY_IP" >> $LOG

# IP forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward

# NAT
iptables -t nat -F POSTROUTING 2>/dev/null
iptables -F FORWARD 2>/dev/null
iptables -t nat -A POSTROUTING -o $WAN_IF -j MASQUERADE
iptables -A FORWARD -i $LAN_IF -o $WAN_IF -j ACCEPT
iptables -A FORWARD -i $WAN_IF -o $LAN_IF -m state \
    --state RELATED,ESTABLISHED -j ACCEPT

# Port 80 → 3000 for both WAN (admin) and LAN (customers)
iptables -t nat -A PREROUTING -i $WAN_IF -p tcp --dport 80 \
    -j REDIRECT --to-port 3000
iptables -t nat -A PREROUTING -i $LAN_IF -p tcp --dport 80 \
    -j REDIRECT --to-port 3000

# ── START DNSMASQ ─────────────────────────────────────────────
pkill dnsmasq 2>/dev/null
sleep 1
rm -f /var/lib/misc/dnsmasq.leases

cat > /etc/dnsmasq.d/rj-pisowifi.conf << EOF
interface=$LAN_IF
bind-interfaces
dhcp-range=10.0.0.10,10.0.0.200,255.255.255.0,12h
dhcp-option=3,$GATEWAY_IP
dhcp-option=6,$GATEWAY_IP
address=/#/$GATEWAY_IP
no-resolv
server=8.8.8.8
EOF

dnsmasq --conf-file=/etc/dnsmasq.d/rj-pisowifi.conf >> $LOG 2>&1
echo "dnsmasq started" >> $LOG

# ── SPLASH PAGE ───────────────────────────────────────────────
mkdir -p /etc/nodogsplash/htdocs
cat > /etc/nodogsplash/htdocs/splash.html << EOF
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="refresh" content="0;url=http://$GATEWAY_IP:3000/portal">
<script>window.location.href = "http://$GATEWAY_IP:3000/portal";</script>
</head>
<body><p>Redirecting...</p></body>
</html>
EOF

# ── NODOGSPLASH ───────────────────────────────────────────────
if [ "$NETWORK_MODE" = "nodogsplash" ]; then
    pkill nodogsplash 2>/dev/null
    sleep 2

    cat > /etc/nodogsplash/nodogsplash.conf << EOF
GatewayInterface $LAN_IF
GatewayAddress $GATEWAY_IP
GatewayPort 2050
MaxClients 50
AuthIdleTimeout 120
WebRoot /etc/nodogsplash/htdocs
FirewallRuleSet authenticated-users {
    FirewallRule allow all
}
FirewallRuleSet preauthenticated-users {
    FirewallRule allow udp port 53
    FirewallRule allow udp port 67
    FirewallRule allow udp port 68
    FirewallRule allow tcp port 3000
    FirewallRule allow tcp port 2050
}
EOF

    nodogsplash >> $LOG 2>&1
    echo "nodogsplash started" >> $LOG

    # Wait for nodogsplash web server to be fully ready
    echo "Waiting for nodogsplash..." >> $LOG
    for i in {1..20}; do
        if curl -s http://$GATEWAY_IP:2050 > /dev/null 2>&1; then
            echo "nodogsplash ready after ${i}s" >> $LOG
            break
        fi
        sleep 1
    done
    sleep 1

    # Add DHCP/DNS rules AFTER nodogsplash fully initializes
    iptables -I ndsRTR 1 -i $LAN_IF -p udp --dport 67 -j ACCEPT
    iptables -I ndsRTR 1 -i $LAN_IF -p udp --dport 68 -j ACCEPT
    iptables -I ndsRTR 1 -i $LAN_IF -p udp --dport 53 -j ACCEPT
    iptables -I ndsRTR 1 -i $LAN_IF -p tcp --dport 3000 -j ACCEPT
    iptables -I ndsRTR 1 -i $LAN_IF -p tcp --dport 2050 -j ACCEPT
    echo "iptables rules added to ndsRTR" >> $LOG

elif [ "$NETWORK_MODE" = "mikrotik" ]; then
    pkill nodogsplash 2>/dev/null
    echo "MikroTik mode" >> $LOG
fi

echo "=== Setup complete ===" >> $LOG