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

Rather than making the owner learn and check a whole separate Pi-hole UI, surface the useful bits inside the existing admin panel via Pi-hole's own API: total queries, percentage blocked, **an Enable/Disable toggle**, and a manual whitelist field for when a legitimate site gets over-blocked (a real, common Pi-hole annoyance - default blocklists occasionally catch something a customer actually needs, and the admin needs a fast way to un-block it without touching a second system). Confirmed: yes, this is planned as a real toggle in the admin panel, not just a one-time install-and-forget.

## Branding - customers must never see "Pi-hole" anywhere

Explicit requirement, matching this project's standing rule that admin/customer-facing copy never exposes internal implementation details (same reasoning as the Devices page's firmware-update card copy earlier tonight). "Pi-hole" is purely an internal implementation detail - the underlying open-source software choice, not a name to appear anywhere a customer or even the admin-panel UI (as opposed to server logs, which are fine) can see it.

- **Admin panel display name**: needs its own branded label instead of "Pi-hole" - not decided yet, this is a naming/vision call for the owner, not something to pick without asking. Candidates to consider when this gets built: something consistent with the existing "Zen" branding direction (e.g. "ZenShield," "Zen Filter") or a plain functional name ("Ad & Tracker Blocker," "Content Filter"). Whatever's picked, used consistently in the admin UI, never "Pi-hole."
- **Customer-facing block behavior**: when Pi-hole blocks a domain, it can either return NXDOMAIN silently (page just fails to load, nothing shown at all - the safe default) or show a "blocked" landing page for certain query types. If a block page is ever shown to a customer, it must be re-skinned to match this app's own portal branding (or just kept silent/NXDOMAIN) - never Pi-hole's own default block page or logo.
- **Process/service names on the box itself** (`pihole-FTL`, log entries, etc.) can stay as-is - those are only ever visible to whoever SSHes into the server, not to admin-panel users or customers, so there's no real disclosure risk there worth engineering around.

## Reliability and no-conflict confirmation, explicitly for BOTH modes

Re-stated per explicit request - this isn't optional or "should be fine," it's a hard requirement before this ships in either mode:

- **Standalone mode**: `dnsmasq` currently owns both DHCP and DNS on port 53. Pi-hole's own DNS resolver (`pihole-FTL`) also wants port 53 - this is a real conflict that must be resolved by reconfiguring `dnsmasq` to DHCP-only (no DNS of its own) and forwarding its DNS responsibility to Pi-hole, verified with an actual conflict-free `systemctl status` on both services and a real DNS resolution test from a connected client before considering this done.
- **Router mode**: no port conflict on the Ubuntu server side at all in this mode (MikroTik handles DHCP/DNS-serving to clients, not this server) - Pi-hole here just needs to be reachable *from* the router as an upstream resolver, and the router's own DNS forwarding (already built for `portal_hostname`) points at it with the secondary-DNS fallback from above. Verified by confirming router mode's existing DNS/hostname feature still works correctly with Pi-hole inserted as the upstream, not just tested in isolation.
- **Cross-mode rule**: whichever mode is active, the *other* mode's Pi-hole wiring must stay inert (no port conflicts, no dangling config) so switching Network Mode later doesn't leave a broken half-configured DNS setup behind - matches how the rest of this app already keeps standalone/router-mode logic cleanly separated (`networkService.js`'s `isMikrotikMode()` branch pattern).

## Suggested build order

1. Install Pi-hole on the server, configure it DHCP-independent (DNS only, no DHCP - this app's own DHCP/dnsmasq or the MikroTik keeps doing that job).
2. Build the watchdog timer (mirrors the existing app watchdog exactly).
3. Wire secondary-DNS fallback into both standalone (`dnsmasq` forwarding) and router mode (`portal_hostname`-style per-lane `dns-server` field extended to carry two addresses), verifying no port/service conflict in either mode per the section above.
4. Resolve the port 80 conflict - move Pi-hole's UI off 80, or skip exposing it and go straight to step 5.
5. Add the admin panel integration card (stats + Enable/Disable toggle + whitelist) under its final branded name (owner to decide), so this never needs its own separately-bookmarked URL for daily use, and customers never see "Pi-hole" anywhere.
6. Enable per lane - Home first (lowest risk, no paying customers affected if something's off), then WiFi-Rental/PC-Rental once confirmed solid.
