# Pi-hole (Network-Wide Ad Blocking) — Plan

**Status:** Planning only, nothing built yet. Build later, not blocking anything currently in progress.

## What it gives every lane

Pi-hole is a DNS-level ad/tracker/malware-domain blocker. Point a network's DNS at it instead of a plain public resolver (8.8.8.8), and every device on that network gets ad-blocking automatically - no per-device app, no per-device setup, works the same on phones, PCs, smart TVs, everything.

**Yes, Home gets this too** - and so does PC-Rental, if wanted. This isn't a gated-lane-only feature; it's just a DNS forwarding target. Each lane's DHCP network already has its own `dns-server` setting (the exact mechanism the custom portal hostname feature - `portal_hostname` - already uses for gated lanes). Pointing any lane at Pi-hole instead of 8.8.8.8 directly is the same one-line change, repeated per lane the admin wants covered. No reason not to enable it everywhere at once, including Home.

## The real reliability question (asked explicitly, taken seriously)

Pi-hole becomes a single point of failure for DNS if it's the *only* resolver every lane depends on - if it crashes or the server it runs on has a bad moment, every lane loses working DNS, which looks exactly like "no internet" to every customer and to the owner at home. Given tonight's watchdog work (Bug: app hangs weren't auto-recovering) exists specifically to prevent this class of problem, Pi-hole needs the same standard applied, not a weaker one.

**Reliability design, not just "add it and hope":**

1. **Own watchdog, same pattern as `rj-pisowifi-watchdog.timer`** - a timer checking Pi-hole's actual DNS resolution (not just that the process exists) every 30s, restarting `pihole-FTL` on failure.
2. **Secondary DNS as a real fallback, not just cosmetic** - every lane's DHCP network gets Pi-hole as the *primary* DNS server and a plain public resolver (1.1.1.1) as *secondary*. Standard DHCP behavior: if primary doesn't answer, clients fall back to secondary on their own, without needing any of this app's own code to detect the outage. This is the single most important reliability decision here - it means a Pi-hole outage degrades to "no ad-blocking for a few minutes" instead of "no internet."
3. **Router mode specifically**: since a lane's DHCP `dns-server` field already supports being set explicitly (used today for `portal_hostname`), it can carry both values RouterOS-style (`dns-server=<pihole-ip>,1.1.1.1`) - no new mechanism needed, just supplying two addresses instead of one.
4. **Standalone mode specifically**: needs `dnsmasq` (which currently does its own DNS resolution directly) reconfigured to forward to Pi-hole instead, with dnsmasq's own `server=` fallback entries providing the same secondary-resolver safety net.

## Port conflicts to resolve during setup, not surprises found in production

- **Port 53**: `dnsmasq` already listens here in standalone mode. Needs reconfiguring to DHCP-only + forward to Pi-hole, not fighting over the same port.
- **Port 80**: Pi-hole's own admin web UI defaults here, same port nginx already uses for this app's own WAN-facing admin front door (Bug #113's fix). Resolution: move Pi-hole's own UI to a different port (or don't expose it publicly at all), and instead...

## Admin integration (better than a second, separate admin panel)

Rather than making the owner learn and check a whole separate Pi-hole UI, surface the useful bits inside the existing admin panel via Pi-hole's own API: total queries, percentage blocked, an enable/disable toggle, maybe a manual whitelist field for when a legitimate site gets over-blocked (a real, common Pi-hole annoyance - default blocklists occasionally catch something a customer actually needs, and the admin needs a fast way to un-block it without touching a second system).

## Suggested build order

1. Install Pi-hole on the server, configure it DHCP-independent (DNS only, no DHCP - this app's own DHCP/dnsmasq or the MikroTik keeps doing that job).
2. Build the watchdog timer (mirrors the existing app watchdog exactly).
3. Wire secondary-DNS fallback into both standalone (`dnsmasq` forwarding) and router mode (`portal_hostname`-style per-lane `dns-server` field extended to carry two addresses).
4. Resolve the port 80 conflict - move Pi-hole's UI off 80, or skip exposing it and go straight to step 5.
5. Add the admin panel integration card (stats + toggle + whitelist), so this never needs its own separately-bookmarked URL for daily use.
6. Enable per lane - Home first (lowest risk, no paying customers affected if something's off), then WiFi-Rental/PC-Rental once confirmed solid.
