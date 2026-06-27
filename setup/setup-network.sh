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

# Configure LAN
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

# Port 80 → 3000
iptables -t nat -F PREROUTING 2>/dev/null
iptables -t nat -A PREROUTING -i $LAN_IF -p tcp --dport 80 \
    -j REDIRECT --to-port 3000

# Step 1: Start dnsmasq FIRST
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

# Step 2: Start nodogsplash
if [ "$NETWORK_MODE" = "nodogsplash" ]; then
    pkill nodogsplash 2>/dev/null
    sleep 1

    cat > /etc/nodogsplash/nodogsplash.conf << EOF
GatewayInterface $LAN_IF
GatewayAddress $GATEWAY_IP
GatewayPort 2050
MaxClients 50
AuthIdleTimeout 120
RedirectURL http://$GATEWAY_IP/
FirewallRuleSet authenticated-users {
    FirewallRule allow all
}
FirewallRuleSet preauthenticated-users {
    FirewallRule allow udp port 53
    FirewallRule allow udp port 67
    FirewallRule allow udp port 68
    FirewallRule allow tcp port 80
    FirewallRule allow tcp port 443
    FirewallRule allow tcp port 3000
}
EOF

    nodogsplash >> $LOG 2>&1
    sleep 2

    # Step 3: Add DHCP/DNS rules AFTER nodogsplash
    # so they appear after ndsRTR in iptables
    iptables -I INPUT 2 -i $LAN_IF -p udp --dport 53 -j ACCEPT
    iptables -I INPUT 2 -i $LAN_IF -p udp --dport 67 -j ACCEPT
    iptables -I INPUT 2 -i $LAN_IF -p udp --dport 68 -j ACCEPT
    echo "nodogsplash started" >> $LOG

elif [ "$NETWORK_MODE" = "mikrotik" ]; then
    pkill nodogsplash 2>/dev/null
    echo "MikroTik mode" >> $LOG
fi

echo "=== Setup complete ===" >> $LOG