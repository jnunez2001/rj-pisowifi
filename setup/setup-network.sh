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

# Cross-checked against an OpenWrt/rockchip reference build's
# etc/init.d/packet_steering — it spreads each interface's RX packet
# processing (RPS) across every CPU core instead of leaving it pinned to
# whichever core handles that NIC's interrupt. On a multi-core board doing
# NAT + nftables + tc shaping (Orange Pi 3B class hardware), that single
# core can become the real throughput ceiling well before the network link
# itself does. Best-effort: /sys queue files don't exist on every kernel/
# NIC driver, and interfaces here are frequently VLAN sub-interfaces or
# bridges created moments earlier, so failures are silently ignored rather
# than aborting network setup over a pure performance tweak.
enable_rps() {
    local ifc="$1"
    local ncpus
    ncpus=$(nproc 2>/dev/null || echo 1)
    [ "$ncpus" -le 1 ] && return 0
    local mask
    mask=$(printf '%x' $(( (1 << ncpus) - 1 )))
    for q in /sys/class/net/"$ifc"/queues/rx-*/rps_cpus; do
        [ -e "$q" ] && echo "$mask" > "$q" 2>/dev/null || true
    done
}

echo "=== R&J Network Setup $(date) ===" >> $LOG

# Read from DB
WAN_IF=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='wan_interface';" 2>/dev/null)
LAN_IF=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='lan_interface';" 2>/dev/null)
NETWORK_MODE=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='network_mode';" 2>/dev/null)

# Pi-hole (setup/install-pihole.sh, opt-in, off by default): when enabled,
# dnsmasq's UPSTREAM_DNS_LINES puts Pi-hole's loopback-only container
# FIRST, with the same public DNS servers this project has always used
# kept right behind it as automatic fallback - dnsmasq stops routing to an
# upstream that's not answering, so a Pi-hole crash never takes DNS down
# for customers (see settings default in database.js, and the
# fail-open-by-design rule this app's add-ons all follow).
ENABLE_PIHOLE=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='enable_pihole';" 2>/dev/null)
if [ "$ENABLE_PIHOLE" = "1" ]; then
    UPSTREAM_DNS_LINES="server=127.0.0.1#5335
server=8.8.8.8
server=8.8.4.4"
else
    UPSTREAM_DNS_LINES="server=8.8.8.8
server=8.8.4.4"
fi

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
# ── STANDALONE MULTI-LANE DETECTION (STANDALONE_ARCHITECTURE_PLAN.md) ──
# router_ports was originally built for router/MikroTik mode's port-role
# UI - reused here for Standalone's own WAN/LAN engine rather than
# reinvented, per the plan doc. Only rows whose port_name is a REAL
# interface on THIS box ever count - a MikroTik's own port names
# (ether1, ether2...) saved from router mode just never match anything
# here and are silently ignored, so switching modes never cross-contaminates
# the other mode's saved lanes.
LOCAL_IFACES=$(ls /sys/class/net/ 2>/dev/null | grep -E '^(eth|enp|ens|enx|wlan|wlx|wlp)' | grep -v '\.')
is_local_iface() {
    echo "$LOCAL_IFACES" | grep -qx "$1"
}

MULTI_LANE_MODE=0
if [ "$NETWORK_MODE" = "standalone" ]; then
    while IFS='|' read -r RP_PORT; do
        if [ -n "$RP_PORT" ] && is_local_iface "$RP_PORT"; then
            MULTI_LANE_MODE=1
            break
        fi
    done <<< "$(sqlite3 -separator '|' "$DB" "SELECT port_name FROM router_ports WHERE role IN ('gated','open');" 2>/dev/null)"
fi
echo "Multi-lane mode: $MULTI_LANE_MODE" >> $LOG

if [ "$NETWORK_MODE" = "standalone" ] && [ "$MULTI_LANE_MODE" = "1" ]; then
  # ═══════════════════════════════════════════════════════════════
  # MULTI-LANE ENGINE — Network > Ports and Roles (Standalone), any
  # number of gated/open lanes, VLAN sub-interfaces and/or Linux bridges
  # for lanes spanning more than one physical port/VLAN.
  # ═══════════════════════════════════════════════════════════════

  # A router_ports row with role='wan' matching a real local interface
  # overrides the VLAN-table/auto-detected WAN_VIF computed above, letting
  # an owner dedicate a specific physical port to the ISP explicitly.
  while IFS='|' read -r W_PORT W_VLAN; do
      [ -z "$W_PORT" ] && continue
      if is_local_iface "$W_PORT"; then
          if [ -n "$W_VLAN" ] && [ "$W_VLAN" != "0" ]; then
              WAN_VIF="${W_PORT}.${W_VLAN}"
              ip link set $W_PORT up
              ip link add link $W_PORT name $WAN_VIF type vlan id $W_VLAN 2>/dev/null || true
          else
              WAN_VIF="$W_PORT"
          fi
          ip link set $WAN_VIF up
          pkill -f "dhclient.*$WAN_VIF" 2>/dev/null || true
          dhclient -nw $WAN_VIF >> $LOG 2>&1 || true
          echo "Lane engine WAN override: $WAN_VIF" >> $LOG
          break
      fi
  done <<< "$(sqlite3 -separator '|' "$DB" "SELECT port_name, vlan_id FROM router_ports WHERE role='wan' ORDER BY id;" 2>/dev/null)"

  enable_rps "$WAN_VIF"

  echo 1 > /proc/sys/net/ipv4/ip_forward

  iptables -t nat -F POSTROUTING 2>/dev/null
  iptables -F FORWARD 2>/dev/null
  iptables -t nat -A POSTROUTING -o $WAN_VIF -j MASQUERADE
  # WAN admin access goes through nginx TLS on ports 80/443 (setup/nginx.conf),
  # not a PREROUTING redirect - same reasoning as the legacy single-lane path.
  iptables -t nat -F PREROUTING 2>/dev/null

  rm -f /etc/dnsmasq.d/rj-pisowifi.conf
  sleep 1
  rm -f /var/lib/misc/dnsmasq.leases

  nft delete table ip rj_piso 2>/dev/null || true
  sleep 1

  DNSMASQ_LANES=""
  NFT_FORWARD_RULES=""
  NFT_PREROUTING_RULES=""
  LANE_MAP_JSON="["
  LANE_MAP_SEP=""
  LANE_INDEX=0
  # Flowtable (nftables' equivalent of OpenWrt's flow_offloading): once a
  # connection is accepted, the kernel fast-paths its packets past the
  # forward chain instead of re-walking every lane's MAC-set lookup for the
  # life of the connection. Matters most on weak ARM boards (Orange Pi 3B
  # class hardware) where per-packet chain evaluation is the bottleneck.
  # WAN_VIF is always a member; each lane interface joins as its loop runs.
  FLOWTABLE_DEVICES="\"$WAN_VIF\""

  while IFS='|' read -r H_ID H_PORT H_VLAN H_ROLE H_NAME H_SPEED H_ISOLATE; do
      [ -z "$H_ID" ] && continue
      is_local_iface "$H_PORT" || continue

      LANE_INDEX=$((LANE_INDEX + 1))
      # Keeps the 10.<OCTET>.0.0/24 scheme inside a valid, collision-free
      # octet range - hardware-tier caps (2/6/16 lanes) never get close to
      # this limit, it's just a hard backstop.
      if [ "$LANE_INDEX" -gt 200 ]; then
          echo "Lane engine: too many lanes, stopping at 200" >> $LOG
          break
      fi

      if [ -n "$H_VLAN" ] && [ "$H_VLAN" != "0" ]; then
          H_IF="${H_PORT}.${H_VLAN}"
          ip link set $H_PORT up
          ip link add link $H_PORT name $H_IF type vlan id $H_VLAN 2>/dev/null || true
      else
          H_IF="$H_PORT"
      fi
      ip link set $H_IF up

      # Members: other rows joined to this lane via bridge_with_id (e.g. a
      # second physical port or VLAN sharing the same subnet as this one).
      BRIDGE_IF="br-lane${H_ID}"
      MEMBER_COUNT=0
      while IFS='|' read -r M_PORT M_VLAN; do
          [ -z "$M_PORT" ] && continue
          is_local_iface "$M_PORT" || continue
          if [ "$MEMBER_COUNT" = "0" ]; then
              ip link add name $BRIDGE_IF type bridge 2>/dev/null || true
              ip link set $BRIDGE_IF up
              ip link set $H_IF master $BRIDGE_IF
          fi
          if [ -n "$M_VLAN" ] && [ "$M_VLAN" != "0" ]; then
              M_IF="${M_PORT}.${M_VLAN}"
              ip link set $M_PORT up
              ip link add link $M_PORT name $M_IF type vlan id $M_VLAN 2>/dev/null || true
          else
              M_IF="$M_PORT"
          fi
          ip link set $M_IF up
          ip link set $M_IF master $BRIDGE_IF
          if [ "$H_ISOLATE" = "1" ]; then
              bridge link set dev $M_IF isolated on 2>/dev/null || true
          fi
          MEMBER_COUNT=$((MEMBER_COUNT + 1))
      done <<< "$(sqlite3 -separator '|' "$DB" "SELECT port_name, vlan_id FROM router_ports WHERE bridge_with_id = $H_ID;" 2>/dev/null)"

      if [ "$MEMBER_COUNT" -gt 0 ]; then
          LANE_IF="$BRIDGE_IF"
          if [ "$H_ISOLATE" = "1" ]; then
              bridge link set dev $H_IF isolated on 2>/dev/null || true
          fi
      else
          LANE_IF="$H_IF"
          # Client isolation on a single, unbridged lane is a WiFi-radio or
          # switch-side feature (this box only ever sees traffic that's
          # already been switched between clients on the same AP/port) -
          # nothing to enforce here, logged so it's not a silent no-op.
          [ "$H_ISOLATE" = "1" ] && echo "Lane $H_ID ($LANE_IF): isolate_clients has no effect without a bridged second port - enable client isolation on the access point itself" >> $LOG
      fi

      enable_rps "$LANE_IF"

      OCTET=$((50 + LANE_INDEX))
      LANE_GATEWAY="10.${OCTET}.0.1"
      LANE_SPEED=${H_SPEED:-0}
      [ "$LANE_SPEED" -le 0 ] 2>/dev/null && LANE_SPEED=100

      ip addr flush dev $LANE_IF 2>/dev/null
      ip addr add ${LANE_GATEWAY}/24 dev $LANE_IF
      ip link set $LANE_IF up
      echo "Lane $H_ID ($H_NAME): $LANE_IF → $LANE_GATEWAY [$H_ROLE, ${LANE_SPEED}mbit]" >> $LOG

      DNSMASQ_LANES="${DNSMASQ_LANES}
interface=${LANE_IF}
dhcp-range=interface:${LANE_IF},10.${OCTET}.0.10,10.${OCTET}.0.250,255.255.255.0,2h
dhcp-option=interface:${LANE_IF},3,${LANE_GATEWAY}
dhcp-option=interface:${LANE_IF},6,8.8.8.8"

      if [ "$H_ROLE" = "gated" ]; then
          DNSMASQ_LANES="${DNSMASQ_LANES}
dhcp-option=interface:${LANE_IF},114,http://${LANE_GATEWAY}:3000/portal"
          # Shared allowed_macs set (defined once below) - a paid session
          # stays valid across every gated lane, not just the one it started
          # on, matching how this app has exactly one session system, not
          # one per lane.
          NFT_FORWARD_RULES="${NFT_FORWARD_RULES}
        iifname \"$LANE_IF\" ether saddr @allowed_macs accept
        iifname \"$LANE_IF\" reject"
          NFT_PREROUTING_RULES="${NFT_PREROUTING_RULES}
        iifname \"$LANE_IF\" ether saddr != @allowed_macs udp dport 53 dnat to ${LANE_GATEWAY}:53
        iifname \"$LANE_IF\" ether saddr != @allowed_macs tcp dport 53 dnat to ${LANE_GATEWAY}:53
        iifname \"$LANE_IF\" ether saddr != @allowed_macs tcp dport 80 dnat to ${LANE_GATEWAY}:3000"
      else
          # 'open' role: trusted, full access, no captive-portal gating -
          # e.g. a "Home"/staff lane that doesn't need to pay.
          NFT_FORWARD_RULES="${NFT_FORWARD_RULES}
        iifname \"$LANE_IF\" accept"
      fi

      # Root htb qdisc (not CAKE) is deliberate here, not an oversight -
      # networkService.js's setClientBandwidth()/removeClientBandwidth()
      # target this exact classid:999-default structure per client; CAKE
      # doesn't support classid-based tc class/filter the way this needs.
      # CAKE-based shaping is still a real, separate Tier 2 item.
      tc qdisc del dev $LANE_IF root 2>/dev/null || true
      tc qdisc add dev $LANE_IF root handle 1: htb default 999 r2q 1
      tc class add dev $LANE_IF parent 1: classid 1:999 htb rate ${LANE_SPEED}mbit ceil ${LANE_SPEED}mbit
      tc qdisc del dev $LANE_IF ingress 2>/dev/null || true
      tc qdisc add dev $LANE_IF ingress

      [ -n "$LANE_MAP_SEP" ] && LANE_MAP_JSON="${LANE_MAP_JSON},"
      LANE_MAP_JSON="${LANE_MAP_JSON}{\"headId\":${H_ID},\"interface\":\"${LANE_IF}\",\"subnet\":\"10.${OCTET}.0.0\",\"gateway\":\"${LANE_GATEWAY}\",\"role\":\"${H_ROLE}\"}"
      LANE_MAP_SEP="1"
      FLOWTABLE_DEVICES="${FLOWTABLE_DEVICES}, \"$LANE_IF\""
  done <<< "$(sqlite3 -separator '|' "$DB" "SELECT id, port_name, vlan_id, role, lane_name, speed_mbps, isolate_clients FROM router_ports WHERE role IN ('gated','open') AND bridge_with_id IS NULL ORDER BY id;" 2>/dev/null)"

  LANE_MAP_JSON="${LANE_MAP_JSON}]"
  sqlite3 "$DB" "INSERT OR REPLACE INTO settings (key, value) VALUES ('standalone_lane_map', '$(echo "$LANE_MAP_JSON" | sed "s/'/''/g")')" 2>/dev/null
  echo "Lane map saved: $LANE_MAP_JSON" >> $LOG

  cat > /etc/dnsmasq.d/rj-pisowifi.conf << EOF
bind-interfaces
dhcp-authoritative
no-resolv
$UPSTREAM_DNS_LINES
$DNSMASQ_LANES
EOF

  sqlite3 -separator '|' "$DB" "SELECT mac_address, ip_address FROM static_leases;" 2>/dev/null | \
    while IFS='|' read -r LEASE_MAC LEASE_IP; do
      [ -n "$LEASE_MAC" ] && echo "dhcp-host=$LEASE_MAC,$LEASE_IP" >> /etc/dnsmasq.d/rj-pisowifi.conf
    done

  systemctl restart dnsmasq >> $LOG 2>&1
  echo "dnsmasq started (multi-lane)" >> $LOG

  PORT_FORWARD_RULES=""
  while IFS='|' read -r FWD_PROTO FWD_EXT FWD_IP FWD_INT; do
      [ -z "$FWD_PROTO" ] && continue
      PORT_FORWARD_RULES="${PORT_FORWARD_RULES}
        iifname \"$WAN_VIF\" $FWD_PROTO dport $FWD_EXT dnat to $FWD_IP:$FWD_INT"
  done <<< "$(sqlite3 -separator '|' "$DB" "SELECT protocol, external_port, internal_ip, internal_port FROM port_forwards WHERE enabled=1;" 2>/dev/null)"

  cat > /tmp/rj-piso.nft << NFTEOF
table ip rj_piso {
    flowtable ft {
        hook ingress priority 0;
        devices = { $FLOWTABLE_DEVICES };
    }
    set allowed_macs {
        type ether_addr
        flags dynamic
    }
    chain input {
        type filter hook input priority filter; policy accept;
    }
    chain forward {
        type filter hook forward priority filter; policy accept;
        ct state established,related accept
        ip protocol { tcp, udp } flow add @ft
$NFT_FORWARD_RULES
    }
    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        oifname "$WAN_VIF" masquerade
    }
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
$NFT_PREROUTING_RULES
$PORT_FORWARD_RULES
    }
}
NFTEOF

  nft -f /tmp/rj-piso.nft >> $LOG 2>&1
  echo "nftables multi-lane captive portal loaded (flow offload: $FLOWTABLE_DEVICES)" >> $LOG

elif [ "$NETWORK_MODE" = "standalone" ]; then
  # ═══════════════════════════════════════════════════════════════
  # LEGACY SINGLE-LANE PATH — no gated/open router_ports rows configured
  # yet, so behave exactly as before (one fixed 10.0.0.0/24 LAN on LAN_VIF).
  # Existing installs that have never touched Ports and Roles keep working
  # unchanged, no migration required.
  # ═══════════════════════════════════════════════════════════════

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

  enable_rps "$WAN_VIF"
  enable_rps "$LAN_VIF"

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
$UPSTREAM_DNS_LINES
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

  sqlite3 "$DB" "DELETE FROM settings WHERE key = 'standalone_lane_map'" 2>/dev/null

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
    flowtable ft {
        hook ingress priority 0;
        devices = { "$WAN_VIF", "$LAN_VIF" };
    }
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
        ip protocol { tcp, udp } flow add @ft
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
  echo "nftables captive portal loaded (flow offload: $WAN_VIF, $LAN_VIF)" >> $LOG

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

else
  # mikrotik mode: the router owns DHCP/NAT — make sure our own dnsmasq
  # isn't still running from a prior standalone setup and fighting it.
  rm -f /etc/dnsmasq.d/rj-pisowifi.conf
  systemctl stop dnsmasq >> $LOG 2>&1 || true
  systemctl disable dnsmasq >> $LOG 2>&1 || true
  echo "mikrotik mode: dnsmasq disabled, deferring to router for DHCP" >> $LOG
  sqlite3 "$DB" "DELETE FROM settings WHERE key = 'standalone_lane_map'" 2>/dev/null
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