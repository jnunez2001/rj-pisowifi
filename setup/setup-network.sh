#!/bin/bash
LOG="/var/log/rj-network-setup.log"
# Bug (found on real hardware, root cause of a whole night of "network mode
# keeps reverting to standalone" confusion): this used to be hardcoded to
# the app's old in-repo database path. The database was moved outside the
# app directory a while back (server/config/database.js reads DB_PATH from
# the environment, set by install.sh to /var/lib/rj-pisowifi/database/... for
# the app's own systemd service) - but this script is invoked separately
# (its own systemd service at boot, or a direct sudo call from the admin
# panel), neither of which ever passed DB_PATH through. Every query below
# was silently hitting an empty/nonexistent file the entire time, meaning
# NETWORK_MODE always fell back to "standalone" and LAN_VLAN_ROW was always
# empty, no matter what was actually saved in the real, correct database.
# $DB_PATH here still respects the env var if it's ever actually passed
# through in the future, falling back to the known real production path.
DB="${DB_PATH:-/var/lib/rj-pisowifi/database/rjpisowifi.db}"
GATEWAY_IP="10.0.0.1"

echo "=== R&J Network Setup $(date) ===" >> $LOG

# Read from DB
WAN_IF=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='wan_interface';" 2>/dev/null)
LAN_IF=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='lan_interface';" 2>/dev/null)
NETWORK_MODE=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='network_mode';" 2>/dev/null)

# VLAN Management (admin panel > Network > VLAN Management): supports the
# "everything on one unmanaged switch" wiring some setups use, where an ISP
# requires a VLAN-tagged uplink (mode='wan') and/or an access point tags
# customer WiFi traffic to keep it separate from the ISP's untagged traffic
# on the same wire (mode='lan'). Only the most recently created row of each
# mode is used - multiple LAN or multiple WAN VLANs aren't a real scenario
# here since there's only one customer network and one ISP link.
LAN_VLAN_ROW=$(sqlite3 -separator '|' "$DB" "SELECT base_interface, vlan_id FROM vlans WHERE mode='lan' ORDER BY id DESC LIMIT 1;" 2>/dev/null)
WAN_VLAN_ROW=$(sqlite3 -separator '|' "$DB" "SELECT base_interface, vlan_id, protocol, static_ip, static_gateway, static_netmask FROM vlans WHERE mode='wan' ORDER BY id DESC LIMIT 1;" 2>/dev/null)
if [ -n "$LAN_VLAN_ROW" ]; then
    LAN_VLAN_BASE=$(echo "$LAN_VLAN_ROW" | cut -d'|' -f1)
    LAN_VLAN_ID=$(echo "$LAN_VLAN_ROW" | cut -d'|' -f2)
fi
if [ -n "$WAN_VLAN_ROW" ]; then
    WAN_VLAN_BASE=$(echo "$WAN_VLAN_ROW" | cut -d'|' -f1)
    WAN_VLAN_ID=$(echo "$WAN_VLAN_ROW" | cut -d'|' -f2)
    WAN_VLAN_PROTO=$(echo "$WAN_VLAN_ROW" | cut -d'|' -f3)
    WAN_VLAN_IP=$(echo "$WAN_VLAN_ROW" | cut -d'|' -f4)
    WAN_VLAN_GATEWAY=$(echo "$WAN_VLAN_ROW" | cut -d'|' -f5)
    WAN_VLAN_NETMASK=$(echo "$WAN_VLAN_ROW" | cut -d'|' -f6)
fi
# LAN_IF auto-detect below needs to know the WAN VLAN's base interface too,
# so it doesn't accidentally pick that as the LAN interface.
if [ -n "$WAN_VLAN_BASE" ] && [ -z "$WAN_IF" ]; then
    WAN_IF="$WAN_VLAN_BASE"
fi

# Auto-detect fallback
if [ -z "$WAN_IF" ]; then
    WAN_IF=$(ip route show default 2>/dev/null | awk '/default/ {print $5}' | head -1)
fi
# Bug #78: a configured LAN-mode VLAN's base interface can legitimately be
# the SAME physical NIC as WAN_IF - that's the whole point of VLAN tagging
# on a shared switch (modem + server + AP all on one cable/switch, the AP
# tags customer traffic to separate it). The old auto-detect below
# explicitly excluded WAN_IF when searching for a LAN interface, so a
# single-NIC setup with a VLAN configured would never find one and the
# script would abort with "No LAN interface found" - even though the LAN
# VLAN row it needs is sitting right there in the DB.
#
# Bug (found on real hardware): this only kicked in when $LAN_IF was
# already empty, i.e. only when the separate, older "lan_interface"
# setting had never been set at all. If that setting held any stale value
# (leftover from earlier standalone-mode testing, or just never cleared),
# it silently won every time, even though it disagreed with what the admin
# had actually configured in VLAN Management - the VLAN row's own
# base_interface never got a chance to matter, and the LAN VLAN block
# below (which requires an exact match) kept skipping every single run,
# freezing that interface at whatever state it was in the one time the
# two settings happened to agree. A configured LAN VLAN is a more specific,
# more recent declaration of intent than the older lan_interface setting,
# so it should always win when one exists, not just when the other is
# empty.
if [ -n "$LAN_VLAN_BASE" ]; then
    LAN_IF="$LAN_VLAN_BASE"
fi
if [ -z "$LAN_IF" ]; then
    for iface in $(ls /sys/class/net/ | grep -E '^(eth|enp|ens|enx)'); do
        if [ "$iface" != "$WAN_IF" ]; then
            LAN_IF="$iface"
            break
        fi
    done
fi
# 'nodogsplash' was this project's old internal name for standalone mode
# (the real Nodogsplash software was replaced by this script's own
# nftables/tc setup long ago; only the label lingered). The database was
# renamed to 'standalone', so treat any leftover 'nodogsplash' value from
# an un-migrated install the same way, not as a fourth, unrecognized mode.
[ -z "$NETWORK_MODE" ] && NETWORK_MODE="standalone"
[ "$NETWORK_MODE" = "nodogsplash" ] && NETWORK_MODE="standalone"

echo "WAN: $WAN_IF  LAN: $LAN_IF  Mode: $NETWORK_MODE" >> $LOG

if [ -z "$LAN_IF" ]; then
    echo "ERROR: No LAN interface found." >> $LOG
    exit 0
fi

# If the ISP requires a VLAN-tagged uplink, create that sub-interface and
# get it addressed (DHCP or static) - WAN_VIF is what every NAT/masquerade
# rule below actually uses, WAN_IF stays the untagged physical parent.
WAN_VIF="$WAN_IF"
if [ -n "$WAN_VLAN_ID" ] && [ "$WAN_VLAN_BASE" = "$WAN_IF" ]; then
    WAN_VIF="${WAN_IF}.${WAN_VLAN_ID}"
    ip link set $WAN_IF up
    ip link add link $WAN_IF name $WAN_VIF type vlan id $WAN_VLAN_ID 2>/dev/null || true
    ip link set $WAN_VIF up
    if [ "$WAN_VLAN_PROTO" = "static" ]; then
        ip addr flush dev $WAN_VIF 2>/dev/null
        ip addr add ${WAN_VLAN_IP}/${WAN_VLAN_NETMASK} dev $WAN_VIF
        ip route replace default via $WAN_VLAN_GATEWAY dev $WAN_VIF
        echo "WAN VLAN: $WAN_VIF static $WAN_VLAN_IP/$WAN_VLAN_NETMASK via $WAN_VLAN_GATEWAY" >> $LOG
    else
        # Backgrounded (-nw) - a fiber ISP's DHCP server on the tagged VLAN
        # can take a few seconds to answer, this script shouldn't block on it.
        pkill -f "dhclient.*$WAN_VIF" 2>/dev/null || true
        dhclient -nw $WAN_VIF >> $LOG 2>&1 || true
        echo "WAN VLAN: $WAN_VIF requesting DHCP" >> $LOG
    fi
fi

# Bug: a LAN-mode VLAN (admin panel > Network > VLAN Management) only ever
# got created when network_mode=standalone, as part of that mode's own full
# network stack setup below. In mikrotik/router mode, the row sat in the
# database completely unused - the UI promises "no need to SSH in and run
# anything manually," but nothing ever actually tagged this server's own
# traffic, silently breaking any shared-wire VLAN setup (e.g. a server VM
# tagging its own traffic to share one cable with another lane, per
# ROUTER_MODE_PLAN.md's flexible-VLAN topology). Interface creation now
# always runs when a LAN VLAN row exists, regardless of mode; each mode
# then does its own thing with that same interface below.
LAN_VIF="$LAN_IF"
if [ -n "$LAN_VLAN_ID" ] && [ "$LAN_VLAN_BASE" = "$LAN_IF" ]; then
    LAN_VIF="${LAN_IF}.${LAN_VLAN_ID}"
    ip link set $LAN_IF up
    ip link add link $LAN_IF name $LAN_VIF type vlan id $LAN_VLAN_ID 2>/dev/null || true
    ip link set $LAN_VIF up
    echo "VLAN: $LAN_VIF (id $LAN_VLAN_ID) on $LAN_IF" >> $LOG
fi

if [ "$NETWORK_MODE" = "mikrotik" ] && [ "$LAN_VIF" != "$LAN_IF" ]; then
    # Router mode: this server is just another device on the MikroTik's
    # network - it doesn't run its own gateway/DHCP/firewall (the MikroTik
    # does all of that, see the mikrotik-mode branch further below). All it
    # needs on the tagged interface is an address, the same way WAN_VIF gets
    # one above when the ISP requires a tagged uplink.
    pkill -f "dhclient.*$LAN_VIF" 2>/dev/null || true
    dhclient -nw $LAN_VIF >> $LOG 2>&1 || true
    echo "LAN VLAN ($LAN_VIF): requesting DHCP from router" >> $LOG
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

# Bug #75: this whole block (static gateway IP + NAT + dnsmasq as DHCP
# server) used to run unconditionally, even in "mikrotik"/external-router
# mode. There, the MikroTik is already the network's router and DHCP
# server — running our own dnsmasq on the same LAN put two DHCP servers
# answering the same clients' DISCOVERs, which is exactly what "stuck on
# Obtaining IP Address" looks like (conflicting offers/NAKs). Only stand up
# our own IP/NAT/DHCP when we're actually the router (standalone mode); in
# mikrotik mode we're just another device on the MikroTik's network and get
# our own address the normal way.
if [ "$NETWORK_MODE" = "standalone" ]; then

  # LAN_VIF (and its VLAN sub-interface, if a LAN VLAN row exists) was
  # already created above, ahead of the mode branches - some setups run the
  # ISP modem, this board, and the WiFi access point(s) all off one shared
  # unmanaged switch, with the AP(s) tagging customer traffic with an
  # 802.1Q VLAN ID to keep it separate from the ISP's untagged traffic on
  # the same wire.

  # ── CONFIGURE LAN ─────────────────────────────────────────────
  ip addr flush dev $LAN_VIF 2>/dev/null
  ip addr add ${GATEWAY_IP}/24 dev $LAN_VIF
  ip link set $LAN_VIF up
  echo "LAN: $LAN_VIF → $GATEWAY_IP" >> $LOG

  # IP forwarding
  echo 1 > /proc/sys/net/ipv4/ip_forward

  # ── IPTABLES NAT ──────────────────────────────────────────────
  iptables -t nat -F POSTROUTING 2>/dev/null
  iptables -F FORWARD 2>/dev/null
  iptables -t nat -A POSTROUTING -o $WAN_VIF -j MASQUERADE
  iptables -A FORWARD -i $LAN_VIF -o $WAN_VIF -j ACCEPT
  iptables -A FORWARD -i $WAN_VIF -o $LAN_VIF -m state \
      --state RELATED,ESTABLISHED -j ACCEPT

  # Bug: WAN admin access used to be a straight port 80 -> 3000 redirect
  # here, meaning the admin panel (default password, no TLS) was reachable
  # in plaintext from the internet. nginx now owns ports 80/443 directly on
  # all interfaces (setup/nginx.conf, installed by install.sh) — 80 redirects
  # to 443, which terminates TLS and proxies to 127.0.0.1:3000. No PREROUTING
  # redirect needed for WAN anymore; removing this rule doesn't affect the
  # LAN captive portal, which reaches this app through the separate nftables
  # DNAT rule below (LAN_VIF-scoped, still plain HTTP as required for
  # captive-portal auto-detection).
  iptables -t nat -F PREROUTING 2>/dev/null
  echo "iptables NAT configured (WAN admin access now via nginx TLS, see nginx.conf)" >> $LOG

  # ── START DNSMASQ ─────────────────────────────────────────────
  sleep 1
  rm -f /var/lib/misc/dnsmasq.leases

  # Bug: clients getting stuck on "Obtaining IP Address" traces to two
  # compounding issues in the DHCP config below:
  # 1. dhcp-authoritative was missing. Every run of this script wipes the
  #    lease file (line above), but a phone that connected before a reboot
  #    still remembers its old IP and sends a DHCPREQUEST for it, not a fresh
  #    DISCOVER. Without this flag, dnsmasq doesn't know it's the sole
  #    authority on the network, so its RFC-correct response to a lease it
  #    doesn't recognize is to silently ignore the request — the client sits
  #    waiting through its own timeout (often 30-60+ seconds) before falling
  #    back to a full DISCOVER. With the flag, dnsmasq immediately NAKs it
  #    instead, and the client restarts DHCP right away.
  # 2. The pool (10.10-10.200, 191 addresses) with a 12h lease is sized for a
  #    small, mostly-static home network, not a walk-up coin-op location with
  #    many short, transient visits — leases can pile up faster than they
  #    expire and exhaust the pool mid-day, well before any single lease's
  #    12h is up. Widened the range and cut the lease time so departed
  #    customers' addresses free up much sooner.
  cat > /etc/dnsmasq.d/rj-pisowifi.conf << EOF
interface=$LAN_VIF
bind-interfaces
dhcp-authoritative
dhcp-range=10.0.0.10,10.0.0.250,255.255.255.0,2h
dhcp-option=3,$GATEWAY_IP
dhcp-option=6,8.8.8.8
dhcp-option=114,http://$GATEWAY_IP:3000/portal
no-resolv
server=8.8.8.8
server=8.8.4.4
EOF

  # Static DHCP leases (admin panel > Network > Static DHCP Leases) - one
  # dhcp-host line per reserved MAC, appended after the base config above so
  # a stale reservation from a prior run never lingers past this rewrite.
  sqlite3 -separator '|' "$DB" "SELECT mac_address, ip_address FROM static_leases;" 2>/dev/null | \
    while IFS='|' read -r LEASE_MAC LEASE_IP; do
      [ -n "$LEASE_MAC" ] && echo "dhcp-host=$LEASE_MAC,$LEASE_IP" >> /etc/dnsmasq.d/rj-pisowifi.conf
    done
  echo "static leases applied" >> $LOG

  systemctl restart dnsmasq >> $LOG 2>&1
  echo "dnsmasq started" >> $LOG

else
  # mikrotik mode: the router owns DHCP/NAT — make sure our own dnsmasq
  # isn't still running from a prior standalone setup and fighting it.
  rm -f /etc/dnsmasq.d/rj-pisowifi.conf
  systemctl stop dnsmasq >> $LOG 2>&1 || true
  systemctl disable dnsmasq >> $LOG 2>&1 || true
  echo "mikrotik mode: dnsmasq disabled, deferring to router for DHCP" >> $LOG
fi

# ── NFTABLES CAPTIVE PORTAL ───────────────────────────────────
if [ "$NETWORK_MODE" = "standalone" ]; then

    nft delete table ip rj_piso 2>/dev/null || true
    sleep 1

    # Port forwarding (admin panel > Network > Port Forwarding, standalone
    # mode only - in mikrotik mode the router owns NAT, this table isn't
    # read there). One dnat rule per enabled row, scoped to WAN_VIF so a
    # forward never accidentally matches traffic arriving on the LAN side.
    PORT_FORWARD_RULES=""
    while IFS='|' read -r FWD_PROTO FWD_EXT FWD_IP FWD_INT; do
        [ -z "$FWD_PROTO" ] && continue
        PORT_FORWARD_RULES="${PORT_FORWARD_RULES}
        iifname \"$WAN_VIF\" $FWD_PROTO dport $FWD_EXT dnat to $FWD_IP:$FWD_INT"
    done <<< "$(sqlite3 -separator '|' "$DB" "SELECT protocol, external_port, internal_ip, internal_port FROM port_forwards WHERE enabled=1;" 2>/dev/null)"

    cat > /tmp/rj-piso.nft << NFTEOF
table ip rj_piso {
    set allowed_macs {
        type ether_addr
        flags dynamic
    }
    chain input {
        type filter hook input priority filter; policy accept;
        iifname "$LAN_VIF" udp dport 67 accept
        iifname "$LAN_VIF" tcp dport 3000 accept
        iifname "$LAN_VIF" tcp dport 80 accept
    }
    chain forward {
        type filter hook forward priority filter; policy accept;
        ct state established,related accept
        iifname "$LAN_VIF" ether saddr @allowed_macs accept
        # Bug #76: this was a silent "drop" for every unpaid device's
        # traffic that wasn't DNS(53)/HTTP(80) - including HTTPS(443),
        # which is what modern phones increasingly use for their
        # background "do I have real internet" check. A silent drop means
        # that check just hangs until the phone's own timeout, and Android
        # in particular responds to that by deciding the network has no
        # internet and disconnecting from it entirely ("Avoided poor
        # internet connection"), instead of failing fast and showing the
        # captive portal sign-in prompt. "reject" sends an immediate
        # TCP RST/ICMP unreachable instead, so the check fails in
        # milliseconds and the OS falls back to the HTTP-based check
        # (which the prerouting DNAT below already redirects to the
        # portal correctly).
        iifname "$LAN_VIF" reject
    }
    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        oifname "$WAN_VIF" masquerade
    }
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        iifname "$LAN_VIF" ether saddr != @allowed_macs udp dport 53 dnat to $GATEWAY_IP:53
        iifname "$LAN_VIF" ether saddr != @allowed_macs tcp dport 53 dnat to $GATEWAY_IP:53
        iifname "$LAN_VIF" ether saddr != @allowed_macs tcp dport 80 dnat to $GATEWAY_IP:3000
$PORT_FORWARD_RULES
    }
}
NFTEOF

    nft -f /tmp/rj-piso.nft >> $LOG 2>&1
    echo "nftables captive portal loaded" >> $LOG

    # ── TC BANDWIDTH SHAPING SETUP ────────────────────────────────
    tc qdisc del dev $LAN_VIF root 2>/dev/null || true
    tc qdisc add dev $LAN_VIF root handle 1: htb default 999 r2q 1
    tc class add dev $LAN_VIF parent 1: classid 1:999 htb rate 100mbit ceil 100mbit
    echo "tc root qdisc configured on $LAN_VIF" >> $LOG

    # Ingress qdisc for per-client upload shaping (ROUTER_MODE_PLAN.md §12 -
    # the root htb qdisc above only ever shaped download; per-client upload
    # caps are enforced via police filters on this ingress qdisc, added by
    # networkService.js's setClientBandwidth()/removeClientBandwidth()).
    tc qdisc del dev $LAN_VIF ingress 2>/dev/null || true
    tc qdisc add dev $LAN_VIF ingress
    echo "tc ingress qdisc configured on $LAN_VIF" >> $LOG

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