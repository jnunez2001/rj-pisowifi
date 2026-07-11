# WISP Expansion Plan (DRAFT, planning only)

Status: **planning only, nothing in this document is built yet.**
Scope: WiFi/internet rental, growing toward small WISP and fiber ISP use cases. PC-rental-specific features (CCTV isolation, etc.) are explicitly out of scope here, that's a separate business line and a separate plan.

Companion to `ROUTER_MODE_PLAN.md` (the router-mode foundation this all builds on), `SECURITY_PLAN.md`, and `ESP32_FIRMWARE_PLAN.md`.

---

## Why this exists

Everything built so far turns this box into a coin-op WiFi/PC rental controller for one shop. The owner's stated goal is bigger: the same app should be able to run a WiFi/internet rental spot today, and grow into managing a small WISP or fiber ISP later, without a rewrite. The six items below were picked from a longer brainstorm specifically because they're the pieces that actually matter for that growth path, not because they're easy.

---

## Phase order (dependency-driven, not just priority)

| # | Phase | Depends on | Why this order |
|---|-------|-----------|-----------------|
| 1 | WAN-side PPPoE | Nothing new | Blocks real fiber deployments today (some ISPs require it just to get online at all). Small, self-contained, do it first. |
| 2 | Dual-WAN failover | Nothing new | Protects revenue immediately (one bad ISP outage doesn't kill the business). Simpler than load balancing, ships alone. |
| 3 | Digital payment top-up | Existing voucher/session engine | Reuses what already exists (coin insert → session), just a new way to trigger it. No new billing model needed yet. |
| 4 | Subscriber-style PPPoE billing | Phase 1 (PPPoE know-how), benefits from Phase 3 (auto-billing) | The actual "become a small WISP" feature — a genuinely new billing model (monthly, not per-session). Biggest single piece of work here. |
| 5 | Site-to-site VPN (remote management) | Nothing new | Independent of the others, can slot in anywhere, but ranked here since it's less urgent than revenue-protecting features. |
| 6 | Dual-WAN load balancing | Phase 2 must already be solid | Meaningfully harder than failover (breaks connections if done wrong) — only attempt once failover is proven in the field. |
| 7 | Reusable one-click branch setup | Everything above, informally | Not really new work — mostly packaging what already exists (Stage 4-7 of `ROUTER_MODE_PLAN.md`) into repeatable presets, so a future second location (or distributor) doesn't start from zero. |

---

## 1. WAN-side PPPoE

**Problem:** some ISPs (PLDT, Converge, and most fiber providers) require a PPPoE login just to get an internet connection at all, this box currently only supports DHCP or static IP for its own WAN connection. Plug it into a fiber line requiring PPPoE today and it simply won't get online.

**Router mode:** RouterOS has a native PPPoE client (`/interface/pppoe-client/add`). Add "PPPoE" as a third connection-type option on the WAN-role lane in Ports & Roles, alongside the port itself, needs username/password fields. `mikrotikProvisioner.js`'s `buildPlan()` already emits a NAT rule per WAN lane keyed off an interface name, this becomes: if PPPoE, create the PPPoE client interface first, then NAT out that instead of the raw port.

**Standalone mode:** `setup-network.sh` would need a PPPoE client path (the `rp-pppoe` package's `pon`/`poff`, or a systemd-managed `pppd` service), parallel to the existing DHCP/static WAN handling.

**Files touched:** `server/config/database.js` (WAN connection-type + PPPoE credentials on the WAN lane, encrypted like the MikroTik password), `server/services/mikrotikProvisioner.js`, `public/admin/pages/network.html`/`network.js`, `setup/setup-network.sh`, `setup/install.sh` (new package dependency for standalone mode).

---

## 2. Dual-WAN failover

**What it does:** two internet lines, one primary and one backup. RouterOS continuously checks the primary is actually working (not just "cable plugged in", a real reachability check); if it drops, traffic switches to the backup automatically within seconds, and switches back once the primary recovers.

**Why first, not load balancing first:** this is a routing-table change (two default routes, different priority, `check-gateway=ping`), not a traffic-splitting change. Much smaller blast radius if something's wrong with it.

**Design:** `router_ports` already allows multiple lanes with `role='wan'` (each currently gets its own NAT rule). Add a `wan_priority` field; `buildPlan()` adds `/ip/route/add` per WAN lane with `distance` derived from priority and `check-gateway=ping`, instead of relying on RouterOS's default single-route behavior. The Ports & Roles UI already supports multiple WAN-role lanes structurally, this mostly needs a priority field and updated warning copy explaining what happens with 2 WAN lanes vs 1.

**Files touched:** `server/config/database.js` (`wan_priority` column), `mikrotikProvisioner.js` (`buildPlan()`), `network.html`/`network.js` (priority field, only shown when 2+ WAN lanes exist).

---

## 3. Digital payment top-up (GCash / Maya / other e-wallets)

**What it is, restated plainly:** a second way to pay for the exact same WiFi session product, on top of the coin slot. Not a GCash cash-in service, not SIM load reselling.

**Flow:** customer on the portal picks a plan, clicks "Pay with GCash" (or Maya), gets sent to a payment checkout, pays, and on confirmation the server generates the same voucher/session a coin insert would have created, then redirects the customer straight into their paid session.

**Reality check on integration:** GCash and Maya don't generally offer direct small-merchant API access, in practice PH businesses integrate through a payment aggregator (PayMongo, Xendit, or DragonPay are the common ones) that supports both wallets under one API. This should be built as a **pluggable payment-provider interface**, not hardcoded to one aggregator, so switching providers later (or adding more) doesn't mean rewriting the payment flow.

**Design:**
- New `server/services/paymentService.js` — a thin abstraction (`createCheckout(amount, planId)`, `handleWebhook(payload)`) that a specific provider adapter implements.
- `POST /api/payments/webhook` — receives payment confirmation, verifies the signature (critical, this endpoint is unauthenticated by nature since the payment provider calls it, not the browser), then calls the same session-creation path `coin.js` already uses.
- New "Payment Methods" admin settings section: provider selection, API keys (encrypted at rest, same pattern as `mikrotik_pass` via `secretCrypto.js`).
- Portal UI: a "Pay with GCash/Maya" button next to (not replacing) "Insert Coin".

**Files touched:** new `server/services/paymentService.js` + provider adapter(s), new route file or additions to `server/routes/`, `server/utils/secretCrypto.js` (reused, not changed), `public/portal/` (new payment button + return flow), new admin settings page.

**Security note to flag now, not later:** webhook signature verification is not optional here, this endpoint effectively grants free internet access if it can be spoofed. Whichever aggregator is chosen, its signature-verification method needs to be implemented correctly before this ships, not deferred.

---

## 4. Subscriber-style PPPoE billing (the actual "small WISP" feature)

**What it is:** instead of a customer paying per session (coins or e-wallet, both still time-boxed), a customer gets a fixed username and password and pays monthly, the same way a real ISP works. This is a genuinely different billing model from everything else in the app, which is entirely session/time-based today.

**Design:**
- New tables: `subscriber_plans` (name, download/upload Mbps, monthly price), `subscribers` (name, contact info, PPPoE username, PPPoE password (encrypted), plan_id, status, next_billing_date), `subscriber_payments` (subscriber_id, amount, paid_at, method, period covered).
- **Router side:** RouterOS's native PPPoE server (`/interface/pppoe-server/server/add`) bound to a dedicated lane, with `/ppp/profile/add` per plan (controls speed natively via PPP, cleaner than simple queues for this use case) and `/ppp/secret/add` per subscriber (creates their actual login).
- **New lane role:** `subscriber` (alongside the existing wan/gated/open/unused), so a lane can be dedicated to PPPoE subscribers instead of Hotspot customers, `buildPlan()` gets a new branch for this role.
- **Billing automation:** extends the exact cron pattern `timerService.js` already uses for session expiry, a scheduled check for subscribers past their `next_billing_date` + grace period, auto-disables their PPP secret (`/ppp/secret/set disabled=yes`) to cut access, same "stop-on-nonpayment" logic as a session running out, just monthly instead of hourly.
- **Admin UI:** new "Subscribers" page (new sidebar item), list/add/edit subscribers, mark payment received (manual, or automatically if Phase 3's payment integration also covers recurring charges later).

**Files touched:** `server/config/database.js` (3 new tables + new lane role), `server/services/mikrotikProvisioner.js` (`buildPlan()` subscriber-role branch), new `server/services/subscriberService.js` (mirrors `sessionService.js`'s structure but monthly instead of session-based), `server/routes/admin.js` (new subscriber CRUD routes), new `public/admin/pages/subscribers.html` + `subscribers.js`.

**This is the biggest single item in this plan** — it's a new billing model, a new database domain, and a new admin page, not an extension of an existing one. Worth treating as its own multi-session build, not a quick add-on.

---

## 5. Site-to-site VPN for remote management

**What it is:** check on the shop (admin panel, router status) from anywhere, without exposing the admin panel directly to the public internet.

**Design:** RouterOS has native WireGuard support (`/interface/wireguard/add`, `/interface/wireguard/peers/add`), no extra software needed on the router. For a single branch, this is really "WireGuard server on the router, one peer profile for the owner's phone/laptop." `buildPlan()` or a standalone provisioning step creates the WireGuard interface and a peer; the admin panel gets a "Generate VPN Config" button that outputs a QR code or config file the WireGuard app can import directly.

**Note for the multi-branch future:** if/when Phase 7's multi-branch idea grows into managing several sites from one place, this same WireGuard foundation is what a future central hub would connect through, so building it per-branch now isn't wasted work even if a bigger multi-site architecture comes later.

**Files touched:** `server/services/mikrotikProvisioner.js` (new WireGuard step, likely opt-in, not part of the default lane provisioning), new small route + UI (`network.html`/`network.js` or a new small page), possibly a `qrcode` npm dependency for rendering the peer config as a scannable QR (small, well-established package, consistent with the project's preference for minimal new dependencies, this one earns its place since it saves the owner from typing a WireGuard config by hand on a phone).

---

## 6. Dual-WAN load balancing

**What it does:** combine two internet lines into more total bandwidth, instead of one being purely a backup, splitting customer connections across both.

**Why phase 6, not phase 2:** meaningfully more complex than failover. RouterOS's standard approach (PCC, Per Connection Classifier) hashes each new connection to one link and keeps it there for the life of that connection, get this wrong and downloads/video calls break mid-stream instead of just being slower. This should only be attempted after Phase 2's simpler failover has been running reliably in the field, both because it's a bigger technical risk and because failover alone already solves the more urgent problem (an outage killing the business).

**Design:** mangle rules to classify connections + multiple routing tables (one per WAN, PCC-based selection) instead of the simple priority-route approach failover uses. This would likely be a toggle on top of the failover feature ("Failover" vs "Load Balance" mode for a 2-WAN setup), not a separate feature from scratch.

**Files touched:** `mikrotikProvisioner.js` (`buildPlan()`, significant new logic for the mangle/routing-table setup), `network.html`/`network.js` (mode toggle).

---

## 7. Reusable one-click branch setup

**What it is:** less a new feature, more packaging what's already built (`ROUTER_MODE_PLAN.md` Stages 4-7, the whole "Configure" flow) so a second location, or eventually a distributor's customer, doesn't redesign the lane layout from scratch every time.

**Design direction (not finalized):** a "Save as Template" option on a working Ports & Roles configuration, exporting the lane structure (roles, names, VLAN pattern, not IPs/credentials) as a reusable starting point. A fresh router could then start from "WiFi Rental (2 lanes)" or "WiFi + Subscriber Hybrid" instead of an empty port list. This ties directly into the multi-branch/distributor conversation from earlier, but doesn't require solving multi-branch data architecture to deliver value on its own, even a single-operator business benefits from not re-explaining their topology if they ever replace a router.

**Files touched:** likely a new small `router_port_templates` concept in `mikrotikProvisioner.js`/`admin.js`, UI addition to the existing Ports & Roles card. Genuinely last on this list since it's the least urgent and most likely to change shape once Phases 1-6 reveal what a "typical" setup actually looks like across more than one real deployment.

---

## What this plan deliberately does not cover

- PC-rental-specific features (CCTV isolation, PC-rental billing) — explicitly out of scope per the owner, separate business line.
- Multi-tenant/multi-branch data architecture as its own project — Phase 5's VPN and Phase 7's templates lay groundwork for it, but actually building "one login, many routers" is a bigger architectural decision deferred until there's a real second location to design against, not built speculatively ahead of one.
- The online/offline licensing decision from `SECURITY_PLAN.md` — unrelated to this plan, still open there.
