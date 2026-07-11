# Router Mode — Build Plan

Status: **all 7 stages built and verified (2026-07-09/10).** This file remains the reference for how it was built and why, so a future session (possibly a fresh Claude instance) can understand the design without re-deriving it from conversation history. Sections below still describe design decisions accurately; the stage table reflects final, shipped status.

---

## 1. Why this exists

Today, router mode only works with MikroTik routers on **RouterOS 7.1+**, using MikroTik's REST API (`server/services/mikrotikService.js`). That locks out cheaper/older MikroTik hardware (e.g. hAP lite/mini) that can't run RouterOS 7 at all — a real limitation for operators who can't afford newer routers. This plan replaces that with a universal approach, and also turns router setup from a manual Winbox job into a one-click, editable system inside R&J PisoWifi's own admin panel — while protecting the setup "recipe" from being copied and resold (a real concern in the PH market for working MikroTik configs).

---

## 2. Build stages

| # | Stage | Status |
|---|-------|--------|
| 1 | **Universal protocol client** — talks to MikroTik's native binary API (port 8728/8729), which works identically on RouterOS 6 *and* 7 (unlike REST, which is 7.1+ only) | ✅ **DONE & TESTED** — `server/services/mikrotikApiClient.js`. Verified: length-prefix encoding at every spec boundary, streaming decode under simulated TCP fragmentation, full login/multi-row-reply/error-trap flow against a fake server, and timeout behavior against a hung connection. |
| 2 | **Rewire `mikrotikService.js`** onto the new client, replacing the RouterOS-7-only REST calls, keeping the same exported functions (`allowClient`, `blockClient`, `setClientBandwidth`, `removeClientBandwidth`) so nothing else in the app needs to change | ✅ **DONE & TESTED** — all four functions verified end-to-end against a fake binary-protocol server (new-binding creation, refresh-existing, bandwidth queue with DHCP-lease IP lookup, invalid-input rejection, queue/binding removal). App boots cleanly with the rewritten service. |
| 3 | **Port discovery + role assignment UI** — query the router live for its actual physical ports (no hardcoded router-model list), let the admin assign a role/name/speed/VLAN per port | ✅ **DONE & TESTED** — `router_ports` table, `getRouterPorts()`/`getLiveStatus()`/`testConnection()` in `mikrotikService.js`, `/api/admin/router/ports` (GET scan+merge, POST save) and `/api/admin/router/status` + `/test-connection` routes, full UI in `network.html`/`network.js` (Your Internet Plan, Ports and Roles, Live Status cards). Verified via HTTP against a fake router (scan, save, merge-on-rescan, guaranteed-total calculation, invalid-role rejection) and by driving the real browser UI end-to-end (role change reveals fields, save persists, DB confirmed). |
| 4 | **The "Configure" action** — given the port roles, push the actual RouterOS config: bridges, Hotspot, DHCP, walled garden, dedicated least-privilege API user, bandwidth queues, fixed-address reservations | ✅ **DONE & TESTED** — `server/services/mikrotikProvisioner.js` (`buildPlan`/`preview`/`apply`), `/api/admin/router/provision/preview` + `/apply` routes, "Provision This Router" card in the UI. Verified: command-plan generation for WAN/gated/open lanes (unit-tested), full successful apply against a fake server (23 steps, backup confirmed, credentials auto-switched to the new dedicated API user), and the failure path (stops immediately at the failing step, reports it, preserves backup confirmation, does *not* switch credentials on failure). Browser UI tested end-to-end for both Preview and Configure. |
| 5 | **Multi-port lanes** — let a lane be made of two or more physical ports bridged together (e.g. a nearby USB adapter's port joining a far switch's port), added after real-world topology discussion ruled out VLAN tagging (see below) | ✅ **DONE & TESTED**, added 2026-07-10 — `router_ports.bridge_with` column, updated `/api/admin/router/ports` GET/POST with join validation (no self-join, target must be in the same request, target can't itself be joined to something else), `buildPlan()` groups ports by effective lane and attaches every member port to one shared bridge. Verified: unit-tested a 5-port scenario matching a real discussed topology, all three validation rejections confirmed via real HTTP calls, full browser UI flow confirmed end-to-end against a fake 5-port router (combine-with dropdown appears, fields hide correctly, database ends up holding the exact right rows). |
| 6 | **Two pre-flight fixes for real-router first contact** — (a) free every port Configure is about to use from any pre-existing bridge membership first, since a "new" router isn't actually blank (factory defaults usually already bridge most LAN ports); (b) detect RouterOS version live and fall back from CAKE to a PCQ-based queue on RouterOS 6, where CAKE likely doesn't exist as a queue type at all | ✅ **DONE & TESTED**, added 2026-07-10 (bugslog.md Bugs #93/#94) — `getAllLanePhysicalPorts()` + a new cleanup phase in `apply()`; `parseRouterOsMajor()`/`detectRouterOsMajor()` + a `routerOsMajor` parameter on `buildPlan()`. Verified: simulated factory-default bridge membership correctly detected and freed before Configure's own bridges are created; confirmed `buildPlan(6)`/`buildPlan(7)`/`buildPlan(null)` each produce the correct queue type and warning; confirmed a full apply run against a fake RouterOS-6-reporting router correctly detects the version and uses the fallback; confirmed `preview()` degrades gracefully (no crash) when the router is unreachable; confirmed both fixes together in one combined scenario, and that the existing backup/stop-on-failure/credential-switch guarantees still hold with the new phases inserted. |
| 7 | **Flexible VLAN tagging** — `router_ports` redesigned from "one row per port" to "one row per lane," so a physical port can carry an untagged lane plus any number of VLAN-tagged lanes at once, any of which can combine with any other lane (same building block as Stage 5, generalized). Router-side tagging only — a plain, VLAN-unaware device (like the AP) can join a tagged lane by having the *router* tag its port, sidestepping the EAP225's confirmed unreliable self-tagging (Bug #78) entirely. Explicitly built general-purpose, not hardcoded to one topology, per the user's request to let operators "be creative" with their own wiring | ✅ **DONE & TESTED**, added 2026-07-10 (bugslog.md) — `router_ports` schema rebuilt (`vlan_id` using `0` not `NULL` for correct SQL uniqueness, `bridge_with_id` replacing the old port-name-based `bridge_with`), `/api/admin/router/ports` GET/POST rewritten around lanes instead of ports, `buildPlan()` creates real VLAN interfaces before bridging tagged members in, full "Ports and Roles" UI rewrite (per-port card showing its untagged lane plus any VLAN lanes, "Add VLAN lane"/remove controls). Verified: unit-tested against the user's exact proposed topology (untagged + VLAN-13 lanes sharing one port, a second port getting a VLAN interface created purely on the router's side to join the tagged lane) and confirmed exactly correct RouterOS commands including both VLAN creations; full `apply()` run against a fake server (40 steps, all ok); full save/load round-trip verified through the real HTTP API including the two-pass `bridge_with_id` resolution; full browser UI verified end-to-end including Add/Remove VLAN lane and a real Save-button click producing the exact expected database state. |

**Formerly a known gap, now resolved:** Stage 5's `vlan_share` skip-with-warning is superseded by Stage 7 — VLAN-tagged lanes are now fully supported, just implemented as router-side port tagging rather than relying on the AP to tag its own traffic (which Bug #78 already showed isn't reliable for this project's specific AP hardware).

**Not yet run against a real MikroTik router** — every test above used a hand-built fake server validating protocol correctness and application logic. The actual RouterOS command syntax (path names, parameter names) follows MikroTik's published documentation but hasn't been confirmed against live hardware. First real-router run should use "Preview Changes" first and check the command list carefully before clicking "Configure."

---

## 3. Port-role model

Every port on any MikroTik (regardless of how many it has) gets one of these roles:

- **WAN** — exactly one, to the ISP modem.
- **Gated** — coin/session-controlled, same mechanism as WiFi customers today. Anything behind this port (AP, PC, or a switch fanning out to many) needs to pay to get online.
- **Open** — plain, unrestricted internet. No coin gate. For home networks, PC rental (when a separate 3rd-party system already handles that access control), or anything else that shouldn't be metered by this system.
- **Unused** — left alone, available for future use.

A port can have a switch behind it fanning out to many devices of that same role — the role applies to everything behind that port, not just what's directly plugged in.

**A lane can also be made of more than one physical port**, bridged together (Stage 5, `bridge_with`). This is the preferred way to avoid running a long cable, e.g. a nearby USB-to-LAN adapter's port can join a far switch's port as one combined lane, without needing a second cable run across the whole location.

**A lane can also carry a VLAN tag** (Stage 7, `vlan_id`), letting a single physical port host an untagged lane *and* any number of tagged lanes at once, each independently combinable with any other lane the same way multi-port bridging works. This ended up being the right tool after all, but not the way first pictured: the actual AP hardware in use (TP-Link EAP225) has a **confirmed, documented reliability problem** self-tagging its own traffic through its standalone local settings page — `bugslog.md` Bug #78 found, via live packet capture, that tagged frames never actually left the AP despite its UI showing VLAN as configured; it only works reliably when adopted into TP-Link's Omada Controller software instead. The fix that made VLAN tagging usable again: **tag on the router's side, not the AP's.** A plain, VLAN-unaware device (like this AP) can be plugged into a port the router has been told to treat as "anything arriving here is VLAN 13," joining a tagged lane without the device itself ever touching a VLAN setting. Multi-port lanes (above) and VLAN-tagged lanes solve two different real cabling problems — a long cable run, versus wanting to keep two lanes apart on a single wire without relying on unreliable AP-side tagging — and both are available as building blocks an operator can combine however their actual wiring needs, not locked to one fixed pattern.

---

## 4. Settings page — sections

Location: admin panel → Network → Router mode.

### 4.1 Your internet plan
- One field: total Mbps actually purchased from the ISP. Never hardcoded — every warning/calculation elsewhere scales off this real number, so the system works the same whether someone has a 10 Mbps or 1000 Mbps plan.

### 4.2 Connection
- Router IP, RouterOS version (auto-detect or manual), API username/password (the *dedicated* limited-permission login created by the Configure step — never the router's real admin password), encrypted-connection toggle.
- "Test connection" button — verifies before saving.

### 4.3 Ports and roles
- Live-scanned list of the router's actual ports (via the protocol client, not a static model database).
- Each port card shows its **untagged lane** plus any **VLAN-tagged lanes** defined on it (via "Add VLAN lane" — any VLAN ID 1-4094, no limit on how many), each independently configurable: **role** (WAN / Gated / Open / Unused), **lane name** (free text, e.g. "WiFi rental", "PC rental", "Home"), **speed cap** (guaranteed Mbps + optional burst Mbps), **combine with another lane** (dropdown, lists every other already-configured lane across every port and VLAN — joining one hides this lane's own name/speed/settings fields, since it inherits them entirely), **keep customers isolated from each other** (checkbox, on by default for Gated lanes).
- Running total vs. the plan-speed field, with a warning if allocated guaranteed speed exceeds the actual plan. A lane joined to another one via "combine with" doesn't count twice toward this total, since it shares the primary lane's speed rather than adding its own.

### 4.4 Hotspot (applies to all Gated lanes)
- DHCP pool range, lease time.
- **Reachable without paying**: the portal page (always on, this is the whole point of a captive portal) and, as a toggle, the **admin login page** — letting it through the walled garden means a technician can reach the admin panel from any device connected to the WiFi, paid or not, still protected by the admin password as always. This is what makes fully wireless setup/management possible after the first configure (see §10) — no LAN cable needed for anything after the very first bootstrap.
- **Extra allowed domains** — a short allow-list of outside addresses an unpaid device can still reach (needed only if a future payment method, like GCash/SMS verification, requires reaching an external service *before* the customer has paid — otherwise leave empty).

### 4.5 Smart queue (CAKE)
- Always on, both modes, not a toggle — see §9. Shown as a status line for transparency, not a setting to configure.

### 4.6 Provision this router
- "Preview changes" — shows exactly what commands are about to run before anything is sent, since this touches a live router.
- "Configure" — applies everything above for real. **Always backs up the router's current config immediately before pushing anything** — this is core to Stage 4, not optional, since it's protecting the provisioning action itself (new, hand-built code touching a live customer-facing router) at near-zero build cost (RouterOS already has a built-in export/backup command to call).
- Config-run log (what was set up, per step, success/failure), so a failed run is diagnosable instead of a silent partial state.

### 4.7 Live status (read live from the router itself, not our DB)
- Model, RouterOS version, uptime, active device count, CPU load, last successful sync time.

### 4.8 Deferred / build-if-time-allows (not required for core function)
- **Auto-reboot the router on a schedule** — worth having given this project targets budget/older hardware that can get sluggish over long uptimes, and it's cheap to build (one scheduled command). Build after Stage 4 lands, if there's time — not blocking.
- **Block specific devices (blacklist)** — reactive abuse-handling, not needed for the system to function. Deferred until there's an actual case that needs it, rather than built speculatively ahead of a real problem.

---

## 5. Protecting the setup "recipe" from being copied/resold

Decided direction (see §6 for the rejected alternative):

- **Never ship a standalone config script** (`.rsc` file or written guide) that could be copied to an unrelated router. The "recipe" — exact settings, order, values — lives only inside this app's own server code, executed live over the API. A technician only ever sees a "Configure" button, never the underlying commands.
- **The router's real admin login is never handed to the app or stored by it long-term** — the Configure step creates a separate, limited-permission API user for the app's own ongoing use (turning access on/off, reading status). This is a lighter protection than full admin-access withholding (see §6) — it protects the *live control channel*, not a full lockout of the end client from their own hardware.
- Explicitly **not** doing: withholding the router's full admin password from the end client entirely. That would functionally turn this into a managed-service business model (you become responsible for every deployed router going forward) — a much bigger commitment than the actual risk justifies right now. Revisit only if there's evidence of real config resale happening, not preemptively.

---

## 6. Licensing / activation (not part of this build — separate, later decision)

Full anti-piracy and code-protection architecture (bytecode compilation, hardware-bound licensing, distribution format, watermarking, legal terms) moved to its own document: **`SECURITY_PLAN.md`**. The one piece still genuinely undecided there is the *online vs. offline vs. hybrid* license check mechanism — a business-model decision for the user, not scoped into Stages 1–4 above.

---

## 12. Per-user speed cap fixes (real bugs, not new features)

- ~~**Coin-slot sessions only actually enforce one direction of bandwidth.**~~ **FIXED 2026-07-10 (bugslog.md Bug #96).** `setClientBandwidth()` now takes separate download/upload numbers end to end — `sessionService.js`/`timerService.js` read both `bandwidth_cap_download_mbps` and `bandwidth_cap_upload_mbps`, `mikrotikService.js` sets RouterOS's `max-limit` in its real upload/download order, and standalone mode's `networkService.js` now shapes upload too (via an ingress qdisc + police filter, added to `setup-network.sh`, since the existing root htb qdisc only ever governed egress/download). The admin Security page now has a separate Upload Mbps field instead of just one shared number.
- **Voucher groups need their own speed cap**, separate from the global coin-slot cap — e.g. a "premium" voucher group priced higher with a faster guaranteed speed, sold alongside a "standard" group at the regular cap. Currently voucher groups only control duration/price/quantity, nothing about speed. New fields needed: upload cap + download cap per voucher group, applied the same way coin-slot sessions get capped today. Not yet built — still open.

---

## 13. PPPoE — two different features, only one scoped here

- **WAN-side PPPoE** (this box's own connection to the ISP, e.g. PLDT/Converge requiring a PPPoE login on the WAN link): real gap — `setup-network.sh`'s WAN VLAN handling only supports DHCP or static IP today, no PPPoE option. **In scope for this build** — add as a third WAN connection-type option, both modes.
- **LAN-side PPPoE** (reselling wired internet to neighbors who connect their own router with a PPPoE username/password, instead of a phone going through Hotspot) — this is a genuinely different customer model: account/subscription-based instead of coin/session-based, needs its own PPPoE server + per-customer accounts on the MikroTik, and doesn't reuse the Hotspot/walled-garden mechanism at all. **Explicitly out of scope for this build** — noted here as its own future phase, to be scoped separately once the current plan is built and working.

---

## 14. OLT support — noted market signal, not scoped, needs its own research phase

Raised because some prospective users are specifically looking for OLT (fiber ISP equipment) management, and competitors reportedly handle this poorly. **Not comparable to the MikroTik work** — MikroTik is one vendor with one consistent, documented protocol across their whole line; OLT spans many vendors (Huawei, ZTE, C-Data, VSOL, etc.), each with their own management interface, often CLI-only or web-only with no real programmable access at all, sometimes requiring a vendor NDA/SDK to even get documentation.

**Before any commitment to build this:** find out which specific OLT brand(s) matter to the users asking for it, and what that specific brand actually exposes for automation. Could range from "similar effort to the MikroTik work" to "that brand offers no automation path at all." This is a research task, not a build task, and is not part of the current plan.

---

## 15. SSID renaming and AP identification — final answers

- **Renaming the AP's WiFi name (SSID) from inside our system**: possible only if the AP is MikroTik-brand (or the router's own built-in wireless) — same protocol client already covers it. **Not possible** for any other AP brand (TP-Link, Ubiquiti, generic) without building a separate, brand-specific integration, which is not planned.
- **Automatic AP detection** (recognizing "a device plugged into this port looks like an access point"): dropped, not going into this build. (For the record: full certainty isn't achievable anyway — device manufacturer can sometimes be guessed from its hardware address as a best-effort hint, but it's not a guarantee and shouldn't be treated as one.)

---

## 7. Physical topology reference example

One real scenario worked through during planning (laptop running two VMs — R&J PisoWifi + a 3rd-party PC rental system — on a 5-port MikroTik, hEX/E50UG-class, with a 5-port and an 8-port switch, using a USB-to-LAN adapter for a genuine second NIC):

- Port 1 → WAN → ISP modem
- Port 2 → 5-port switch → WiFi-rental AP + laptop's built-in LAN (VM1, R&J PisoWifi server) — role: **Gated**
- Port 3 → 8-port switch → 4 rental PCs + laptop's USB-to-LAN adapter (VM2, 3rd-party PC rental server) — role: **Open** (that system already handles its own access control via its own ping-based lock; this system should not also gate it)
- Port 4 → home AP, direct — role: **Open**
- Port 5 → left open/spare for future use

This is a worked example, not a fixed requirement — the actual Stage 3 UI should reproduce whatever topology a given operator actually has, discovered live from their router.

---

## 8. Open questions still needing the user's input before/during build

- Confirm final list of roles is exactly WAN / Gated / Open / Unused (or if more granularity is wanted later).
- Confirm which of the §4.8 "optional add-ons" items should be in the first build vs. deferred.
- §6 licensing direction — no rush, but will need a decision before that (separate, later) work starts.

---

## 9. Bufferbloat / QoS — CAKE (decided: yes, build this)

**Problem:** lag (e.g. in games) during shared use is usually not a bandwidth shortage — it's bufferbloat. A big download fills the router's send queue, and latency-sensitive traffic (small, frequent packets — what games look like) gets stuck behind it, adding real delay even though there's technically enough raw speed. Capping bandwidth alone (what's shaped today) doesn't fix this; the queue itself needs smarter handling.

**Decision: adopt CAKE as the default queueing method in both modes, on by default, no configuration required.**
- CAKE fights bufferbloat and automatically favors small/latency-sensitive traffic over bulk transfers, just from observing traffic behavior — no per-app or per-game knowledge needed.
- Available natively in **both** modes: the standalone mode's Linux engine supports it directly (replaces the current plain HTB shaping in `networkService.js`), and recent RouterOS versions added native CAKE support for MikroTik's queues too — same fix, both modes, not two separate systems.
- **Correction to the original `PISOWIFI_REFERENCE_NOTES.md` audit**: that document's item #9 ("adopt sqm-scripts + CAKE") was earlier marked not-applicable on the assumption it required OpenWrt hardware. That was wrong — CAKE runs fine on the existing Linux-based standalone setup without OpenWrt. This section supersedes that earlier call.

**Explicitly decided against: game-specific/port-based priority rules.** Considered and rejected — mobile games in particular route through generic cloud infrastructure with no stable, documented ports, and PC game ports vary and change over updates. A manually-maintained port priority list would be high-maintenance, frequently wrong, and a likely source of misconfiguration, for a problem CAKE's automatic fairness already covers in the general case without any configuration.

**If a "priority" lever is ever wanted later:** prefer *per-device* priority (e.g. a paid "priority session" tier) over per-game/per-port rules — it works regardless of what the device is actually doing and never breaks when a game updates. Not scoped into the current build; noted here only so a future session knows it was considered and deliberately deferred, not overlooked.

---

## 10. First-time setup — how an operator actually finds and reaches the server

This matters specifically because the goal is operators in general, not just a known/local setup — a headless board (e.g. Orange Pi, no screen/keyboard) paired with a router that has no built-in WiFi (e.g. a bare MikroTik hEX) has a real "how do I even find it" problem the first time.

**Ongoing management (after the router has been configured once): fully wireless, no cable needed.** Connect to the rental WiFi with any phone or laptop and go straight to the admin panel — see §4.4's "admin login page reachable without paying" toggle. This is a deliberate design choice, not an accident: the admin page sits behind the same walled-garden exception as the portal page, so it's reachable by anyone on the WiFi, still protected by the admin password.

**The very first time, before anything is configured: still needs one temporary wired connection.** Before "Configure" has ever run, that port has no Hotspot, no DHCP, no walled garden — there is no network yet for a phone to join, so WiFi can't bootstrap itself out of nothing. The reliable path:
1. Plug a laptop into the same switch/port area as the server, temporarily, just for this one-time setup.
2. The server already broadcasts itself as `rjcyberzone.local` via mDNS/avahi (existing feature, `install.sh`) — most laptops (Mac, Linux) can just browse to that name directly once on the same wired network. Windows mDNS support is inconsistent, so don't rely on it alone.
3. **Fallback if the friendly name doesn't resolve** (mainly a Windows issue): open the MikroTik's own admin page (reachable at its own known default address) and check its DHCP lease list to find the server's actual IP, then browse to that IP directly.

**Possible future enhancement, not scoped now:** if a specific Orange Pi model has its own built-in WiFi chip, the software could broadcast a temporary "setup network" on first boot (common pattern in smart-home devices), removing the wired-cable step entirely for that first bootstrap too. Only possible on hardware with built-in WiFi — needs confirming per board, not assumed.

---

## 11. Resilience and what config protection actually does and doesn't cover

**If the R&J PisoWifi server goes down**, the two systems (server and router) don't fail together — this is a deliberate property of the design, not a lucky accident:
- **Already-paid, already-online customers: unaffected.** Their access (the router's ip-binding entry) was already granted before the outage and the router keeps honoring it independently — it doesn't need to keep checking with the server to keep letting existing traffic through.
- **New customers trying to pay during the outage: blocked**, since the portal page they'd be redirected to is served by the (down) server.
- **Session expiry during the outage: delayed, not skipped.** The code that notices "this session's time ran out, cut them off" isn't running while the server's down, so someone whose paid time expires mid-outage keeps internet a bit longer than paid for, until the server's back and catches up. Minor revenue leak, not a security gap — same recovery pattern as the reboot-resilience fix (Bug #82, this session's earlier work).

**Can the end client export the MikroTik's config themselves? Yes — this needs to be stated plainly, not glossed over.** §5's protection stops the setup *recipe* from existing as a portable, reusable file — there's no `.rsc` script that could be copied to some other unrelated customer's router. It does **not** stop someone with admin access to their *own* router from running RouterOS's own `/export` command and seeing everything currently configured on it (Hotspot, DHCP, queues, all of it) — that's the same hard limit raised earlier in planning (§5's context): whoever holds admin access to a device can always read what's on it. The only thing that never leaves the server, under any circumstance, is the actual decision-making logic (coin matching, session timing, when to grant/revoke access) — that's application code, never MikroTik configuration, and a router export wouldn't include any of it.
