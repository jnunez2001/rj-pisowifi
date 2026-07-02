# R&J PisoWifi

Custom, offline-first Piso WiFi (coin-operated internet) management system, built from scratch by Josh — a PC cafe owner in Naga, Bicol, Philippines. Inspired by JuanFi / LPB PisoWifi, but **not** based on their code. Long-term goal: a commercial product that undercuts LPB PisoWifi on price and doesn't require cloud dependency.

**Current version:** v1.0.1 (live, running at Josh's cafe)

> **Note for Claude Code:** This README describes the intended architecture and current deployment state. Always verify against actual files in the repo before editing — this doc may lag behind the code. If something here contradicts what you find in the codebase, trust the codebase and flag the mismatch to Josh.

---

## Who's building this / how to work with Josh

- Josh is **not a strong coder**. Always give **complete file contents**, never diffs, partial snippets, or "add this line here" instructions.
- Windows-first workflow: Josh edits in **VS Code on Windows** (`D:\rj-pisowifi`), pushes to GitHub (`github.com/jnunez2001/rj-pisowifi`), then pulls on the Ubuntu VM. He does not edit directly on the VM.
- PowerShell on Windows — use `New-Item`, not `touch`.
- Nodemon runs in a separate VS Code terminal tab labeled "node"; started via `npm run dev`.
- Build-and-test incrementally — fix errors immediately, test each piece before moving to the next.
- Don't suggest: unnecessary hardware/services, footer "Powered by" text, business hours settings, Telegram notifications.

---

## Tech Stack

- **Backend:** Node.js + Express + SQLite (`better-sqlite3`)
- **Frontend:** Plain HTML/CSS/vanilla JS — no frameworks
- **Hardware:** ESP32 WROOM-32 DevKitC + JY-921 coin slot + Songle SRD-05VDC-SL-C relay
- **Deployment target (current):** Ubuntu 22.04 VM in VirtualBox
- **Network stack:** nftables (custom, replaces nodogsplash) + dnsmasq (systemd-managed) + tc (HTB bandwidth shaping)

---

## Live Deployment (current state)

Running on an Ubuntu 22.04 VM in VirtualBox on Josh's laptop.

- **WAN (Adapter 1):** Bridged → QCA9377 WiFi, interface `enp0s3`, `192.168.0.132`
- **LAN (Adapter 2):** Bridged → NX USB LAN adapter, interface `enp0s8`, `10.0.0.1`
- **SSH:** `ssh rjcyberzone@192.168.0.132`
- **App path:** `/home/rjcyberzone/rj-pisowifi`
- **Port redirect:** iptables redirects port 80 → 3000 on WAN side

### systemd services
- `rj-pisowifi.service` — the Node app
- `rj-network-setup.service` — runs `setup-network.sh` (nftables rules, interface config)
- `rj-fix-iptables.service` — 10s delayed start, adds DHCP/DNS rules to the `ndsRTR` chain (legacy from nodogsplash days, still required)
- `avahi-daemon` — mDNS, reachable at `rjcyberzone.local`

### Network stack notes
- Nodogsplash **is no longer used** — replaced by a clean custom nftables implementation in `setup-network.sh`.
- Splash/portal redirect happens via meta refresh to `http://10.0.0.1:3000/portal`.
- `iptables-legacy` is used to avoid nftables/iptables conflicts.
- dnsmasq **must** be managed via `systemctl restart dnsmasq` — manual `dnsmasq --conf-file=` launches conflict with the systemd-managed instance on port 53.

### Known recurring issues
- `setup-network.sh` is prone to git merge conflicts → regressions. **Fix:** `git reset --hard HEAD && git pull`.
- After any Node restart following a code/dependency change, `better-sqlite3`'s native binding can break. **Fix:** `npm rebuild better-sqlite3 --build-from-source` (3–5 min on this low-RAM VM — it's compiling C++).

---

## Hardware — ESP32 Coin Machine

- **Board:** ESP32 WROOM-32 DevKitC (expansion board for bench dev; bare dev board planned for production install inside the coin slot housing)
- **Power (production plan):** coin slot's regulated 5V output → VIN pin. Bench power: 12V 1.5A CCTV UPS via 5.5mm×2.1mm DC barrel jack.
- **Pinout:**
  - `COIN_PIN` → GPIO 4 (INPUT_PULLUP, FALLING interrupt)
  - `RELAY_PIN` → GPIO 5
  - `LED_PIN` → GPIO 2
  - `SETUP_BTN` → GPIO 0 (physical BOOT button; recommend wiring an external button to GPIO 0 + GND before final sealing)

### Relay security fix (already applied)
Relay activation goes through the Node server — `POST /api/portal/relay/:action` in `server/routes/portal.js` — instead of an unauthenticated direct browser-to-ESP32 call.

### Open hardware issues
1. Relay-at-boot grounding issue — traced to multiple GND wires landing on separate pins instead of a common ground junction.
2. ESP32 coin pulse race condition (noise / phantom credits) — also traced to grounding.
3. A bench ESP32 was shorted/damaged; a replacement DevKitC has been ordered (recommend ordering two, since bench work tends to kill boards).
4. Do not substitute ESP8266 — different libraries, requires a full firmware rewrite for minimal savings. Stick with ESP32 DevKitC form factor.

---

## Bandwidth Shaping (tc HTB)

Implemented, logging correctly, **not yet validated under sustained real load**.

- Passwordless `sudo` for `/usr/sbin/tc` granted via `/etc/sudoers.d/rj-pisowifi`
- Direction filtering via `flower dst_mac`
- Root qdisc: `r2q 1` (required — without this, small-rate HTB classes throttle erratically)
- Per-client classes: `quantum 15000`, `burst 32k`, `cburst 32k`
- Logs confirm shaping fires correctly (e.g. `[TC] Shaped mac to 5mbit (class 1:214)`)
- **TODO:** real-world sustained throughput test with multiple simultaneous clients

---

## Project File Structure

```
rj-pisowifi/
├── server/
│   ├── app.js                    ← main entry point (port 3000)
│   ├── config/
│   │   └── database.js           ← SQLite setup + default data
│   ├── database/
│   │   └── rjpisowifi.db         ← SQLite database file
│   ├── routes/
│   │   ├── coin.js               ← ESP32 coin API + spam protection
│   │   ├── session.js            ← session CRUD + pause/resume
│   │   ├── promo.js              ← promo voucher redemption
│   │   ├── admin.js              ← admin API (sales, sessions, rates, settings, upload)
│   │   └── portal.js             ← portal rates + settings API + relay proxy
│   ├── services/
│   │   ├── sessionService.js     ← session logic
│   │   ├── voucherService.js     ← voucher generation + rates
│   │   ├── timerService.js       ← cron job for session expiry
│   │   ├── spamService.js        ← spam/abuse protection
│   │   └── mikrotikService.js    ← planned: MikroTik RouterOS integration (not yet active — no MikroTik hardware yet)
│   └── middleware/
│       └── auth.js               ← (placeholder)
│
├── public/
│   ├── portal/
│   │   ├── index.html            ← customer portal (white theme)
│   │   └── assets/
│   │       ├── sounds/           ← insert.mp3, success.mp3, coin.mp3
│   │       ├── css/              ← local Font Awesome (offline support)
│   │       └── webfonts/
│   │
│   └── admin/
│       ├── index.html            ← admin shell + login
│       ├── css/
│       │   ├── admin.css
│       │   └── themes.css        ← dark/light mode CSS variables
│       ├── js/
│       │   ├── app.js            ← auth, routing, sidebar, toast
│       │   ├── dashboard.js      ← Chart.js dashboard
│       │   ├── sessions.js
│       │   ├── sales.js
│       │   ├── rates.js
│       │   ├── promos.js
│       │   ├── settings.js
│       │   ├── security.js       ← spam + bandwidth settings
│       │   ├── branding.js       ← logo/banner upload
│       │   ├── update.js
│       │   └── about.js
│       └── pages/
│           ├── dashboard.html
│           ├── sessions.html
│           ├── sales.html
│           ├── rates.html
│           ├── promos.html
│           ├── settings.html
│           ├── security.html
│           ├── branding.html
│           ├── update.html
│           └── about.html
│
└── esp32/
    └── firmware/
        └── rj_pisowifi.ino       ← ESP32 Arduino code
```

---

## Database Schema

### sessions
```
id, voucher_code (RJ-XXXXXX), mac_address, ip_address,
minutes_remaining, status, is_paused, paused_at,
hard_expires_at, created_at, expires_at
```

### transactions
```
id, voucher_code, coin_value, minutes_added, type (coin/promo), created_at
```

### promo_vouchers
```
id, code (PROMO-XXXXXX), duration_days, price, status, mac_address, created_at, expires_at
```

### rates
```
id, coin_value, minutes, expiration_minutes, label
```

### settings
```
key, value
-- Current keys: cafe_name, admin_password, admin_username, currency,
--   banner_text, max_mbps, spam_max_attempts, spam_block_minutes,
--   logo_url, banner_url
-- Planned additions (see Settings Page Expansion below):
--   welcome_message, disconnect_message, show_voucher, redirect_url,
--   allow_pause, max_pause_minutes, grace_period_minutes,
--   coin_wait_ms, min_coins, gcash_qr_url, maya_qr_url, show_payment_qr
```

**IMPORTANT:** Whenever the schema changes, delete `rjpisowifi.db` and restart the server to regenerate it with defaults. There is no migration system.

---

## Default Rates

| Coin | Access Time | Hard Expiry |
|------|------------|-------------|
| ₱1   | 5 mins     | 30 mins     |
| ₱5   | 1 hour     | 2 hours     |
| ₱10  | 2 hours    | 4 hours     |
| ₱15  | 3 hours    | 5 hours     |
| ₱20  | 5 hours    | 8 hours     |
| ₱50  | 3 days     | 3 days      |
| ₱100 | 7 days     | 7 days      |
| ₱300 | 30 days    | 30 days     |

**Stacking rule (Option A):** each new coin resets the hard expiration window.

---

## API Endpoints

### Public (no auth)
- `POST /api/coin` — ESP32 sends coin data `{mac, coin_value, ip}`
- `GET /api/coin/status/:mac` — check spam block status
- `GET /api/session/mac/:mac` — get session by MAC
- `GET /api/session/voucher/:code` — get session by voucher
- `POST /api/session/pause` — `{voucher_code}`
- `POST /api/session/resume` — `{voucher_code}`
- `POST /api/session/cancel` — `{voucher_code}`
- `POST /api/promo/redeem` — `{mac, code, ip}`
- `GET /api/portal/rates` — rates + cafe settings for portal
- `POST /api/portal/relay/:action` — server-mediated relay trigger (replaces direct ESP32 call)
- `GET /api/health` — health check

### Admin (requires `password` header)
- `GET /api/admin/sessions`
- `DELETE /api/admin/session/:code`
- `POST /api/admin/session/:code/addtime` — `{minutes}`
- `GET /api/admin/sales`
- `GET /api/admin/promos`
- `POST /api/admin/promos` — `{duration_days, price}`
- `DELETE /api/admin/promos/:id`
- `GET /api/admin/rates`
- `POST /api/admin/rates`
- `PUT /api/admin/rates/:id`
- `DELETE /api/admin/rates/:id`
- `GET /api/admin/settings`
- `POST /api/admin/settings`
- `GET /api/admin/spam-settings`
- `POST /api/admin/spam-settings`
- `GET /api/admin/assets`
- `POST /api/admin/upload/:type` — logo or banner image

---

## UI Design Reference

- **Palette (Apple-inspired):** Science Blue `#0066CC`, Shark `#1D1D1F`, Athens Gray `#F5F5F7`, White `#FFFFFF`
- **Portal theme:** White/off-white (`#f0f0f0`), Taskfly/GhostShield card style
- **Admin theme:** "Aura" dashboard style, dark/light toggle saved to localStorage
- **Fonts:** Orbitron (headings) + Rajdhani (body)
- **Icons:** Font Awesome 6.4, stored locally for offline use
- **Portal states:** Disconnected → Connected → Paused
- **INSERT COIN button:** green gradient, glowing pulse animation
- **Sounds:** `insert.mp3` (loops in coin modal), `success.mp3` (new session), `coin.mp3` (time added)
- **Spam block:** red countdown timer shown when blocked
- **Admin sidebar:** fixed on desktop, hamburger on mobile; fully responsive

---

## Network Architecture

### Current
```
Converge 400Mbps
    ↓
TP-Link AX1200 (main router)
    ↓
Ubuntu VM (R&J PisoWifi) ← WAN via QCA9377 WiFi
    ↓
EAP225 (AP for Piso WiFi customers) ← LAN via USB adapter
    ↓
ESP32 (coin machine) ↔ talks to VM over WiFi (AX1200)
```
F-Tech (separate, existing PC rental software — ₱500 setup + ₱300/yr) still runs PC1–PC4 independently; not integrated with R&J PisoWifi. Will eventually be replaced by R&J PisoNet (v2.0).

### Future (once MikroTik E50UG is purchased)
```
Converge 400Mbps
    ↓
MikroTik E50UG (hEX Refresh 2024, main router/brain)
├── AX1200 (AP mode, home WiFi)
├── EAP225 (AP mode, Piso WiFi)
└── Switch → PC1–PC4

R&J PisoWifi Server (VM or Orange Pi)
└── Talks to MikroTik API for access control (mikrotikService.js:
    allowClient, blockClient, setClientBandwidth)
```

---

## Roadmap (revised priority — supersedes older version-number roadmap below)

Kiosk and POS are **explicitly not current targets** — deferred roughly a year out, after many incremental version updates. No PPPoE, eload, GCash, or Maya integration for now. Josh's own PC cafe/computer shop is the test ground for everything before wider release.

**Current priority order:**
1. **Stabilize WiFi rental** — fix the known bugs above, finish voucher customization, print vouchers, bulk-delete-used. Goal: solid enough to sell/use standalone in cafes *and other locations*, not just internet cafes.
2. **iCafes (PC + WiFi combined)** — the biggest target market next. Will fold in a PC-rental module (see Branding section — likely "ZenCafe").
3. **Phone/tablet rental expansion** — later.
4. **Kiosk** (much later, future expansion) — McDonald's-style self-order kiosk concept:
   - For iCafes: pick a PC/seat, touch-login, or add time via coin slot/bill acceptor.
   - For cafes (coffee-shop use case): pick an order on the kiosk, pay via kiosk (bill acceptor/coin slot) or pay at the counter and the kiosk outputs an order code for the cashier to enter into the POS.
5. **POS system** (future, needed to support the kiosk order flow) — will be tested first in Josh's own computer shop before wider release.

### Older version-number roadmap (kept for reference, now superseded by priority order above)
- v1.1: ESP32 finalized + stable deploy + MikroTik integration + bandwidth control + buy time/data
- v1.2: GCash/Maya payments + advanced reports
- v1.3: R&J Cloud + remote monitoring + portable session + license system
- v1.4: Multi-machine + distributor support + VLAN subvendo
- v1.5: PPPoE + eload + phone rental
- v2.0: Full platform — PisoNet + kiosk + SQM

### Deployment targets (long-term)
OVA (current) → IMG (Orange Pi/RPi) → ISO (bare metal) → Windows EXE (Electron)

### Phase 3+ (cloud features)
Cloudflare Tunnel, unique subdomain per unit, WireGuard VPN, multi-unit cloud monitoring, subscription model (₱299/month Pro tier)

---

## Known Bugs (not yet fixed — logged here for later)

### Bug 1: Voucher/session status doesn't update on expiry
- A **used** voucher that later passes its `hard_expires_at` still displays status `used` instead of `expired`.
- An **active** session that runs out of `minutes_remaining` still displays status `active` instead of `expired`.
- **Likely cause:** status is being read directly from the `status` column in the DB rather than computed live against `hard_expires_at` / `now()`. Either the `timerService.js` cron sweep isn't updating `status` on expiry, or the read-side routes (`GET /api/session/mac/:mac`, `GET /api/session/voucher/:code`, `GET /api/admin/sessions`) aren't cross-checking expiry before returning status.
- **Files likely involved:** `server/services/timerService.js`, `server/services/sessionService.js`, `server/routes/session.js`, `server/routes/admin.js`

### Bug 2: Admin "+" add/reduce time button not working
- The sidebar/session-row control meant to add or reduce a connected client's remaining time does nothing (or fails silently).
- **Files likely involved:** `public/admin/js/sessions.js` (frontend handler/payload), `server/routes/admin.js` (`POST /api/admin/session/:code/addtime`) — payload shape or endpoint mismatch suspected; route may also need to support negative `minutes` for "reduce."

**Fix plan:** these will be tackled together once Josh shares the current `voucherService.js`, `sessionService.js`, `timerService.js`, and `admin.js` files — don't attempt fixes blind, and don't fix proactively unless asked.

---

## Pending Tasks

### 1. Voucher System Overhaul
Replace the hardcoded `PROMO-XXXXXX` / `RJ-XXXXXX` format with fully customizable voucher generation, configurable from Settings:
- `voucher_prefix` — optional (e.g. "RJ-" or blank)
- `voucher_length` — customizable character count
- `voucher_charset` — `letters_only` | `numbers_only` | `alphanumeric`
- `voucher_case` — `upper` | `lower` | `mixed`

Also add to admin:
- **Print vouchers** — generate a printable batch/labels
- **Bulk delete all used vouchers** button

### 2. Settings Page Expansion
Add to `public/admin/pages/settings.html` + `settings.js`:
- **Cafe Information:** name, tagline, currency, address, contact
- **Admin Credentials:** username, password
- **Portal Settings:** welcome message, disconnect message, show/hide voucher code, auto-redirect URL
- **Session Settings:** allow pause toggle, max pause duration, grace period after expiry
- **Coin Slot Settings:** coin insert wait time (debounce ms), minimum coins to start
- **Payment QR Codes:** GCash QR upload, Maya QR upload, show-on-portal toggle
- **Voucher customization settings** (see Voucher System Overhaul above)

New settings keys needed: `welcome_message, disconnect_message, show_voucher, redirect_url, allow_pause, max_pause_minutes, grace_period_minutes, coin_wait_ms, min_coins, gcash_qr_url, maya_qr_url, show_payment_qr, voucher_prefix, voucher_length, voucher_charset, voucher_case`

### 3. Portal Redesign — drop the green theme
- Replace the green gradient/glow INSERT COIN button with the Apple-inspired palette (Science Blue `#0066CC`, Shark `#1D1D1F`, Athens Gray `#F5F5F7`).
- Keep a **soft** animation (subtle pulse/glow in Science Blue, not the aggressive green glow currently used).
- Files: `public/portal/index.html`, portal CSS.

### 4. Network Update — WAN to USB-LAN
- Josh will switch the VM's WAN connection from the QCA9377 WiFi adapter to a wired USB-to-LAN adapter.
- Will require updating `setup-network.sh` and possibly `rj-network-setup.service` interface references (currently `enp0s3` for WAN).

### 5. Admin Additions
- Reboot/Shutdown buttons in sidebar
- Schedules tab (auto-reboot, auto-update, maintenance mode)
- Expanded network config UI (static IP, DHCP toggle, netplan integration)

### 6. ESP32 Firmware Hardening
- Fix relay-at-boot grounding issue
- Fix coin pulse race condition (grounding-related)
- Finalize production wiring inside coin slot housing

### 7. Bandwidth Shaping Validation
- Real-world sustained throughput test with multiple concurrent clients on current r2q/quantum/burst settings

### 8. MikroTik Integration (blocked on hardware purchase)
File: `server/services/mikrotikService.js`
- `node-routeros` package
- `allowClient(mac, minutes)`
- `blockClient(mac)`
- `setClientBandwidth(mac, mbps)`
- Wire into `sessionService.js` and `timerService.js`

---

## Licensing System (planned — v1.3, "R&J Cloud + license system")

**Decision: hybrid local + cloud verification.**

Rationale: pure cloud-only conflicts with the offline-first selling point (cafe internet drops = system down). Pure local-only is trivially crackable and gives no kill-switch for lapsed subscriptions or shared/pirated keys. Hybrid gets both.

Planned design:
- Cloud issues a **signed license token** (JWT-style) on activation — contains expiry date, tier, hardware fingerprint.
- App **caches the token locally** and validates the signature offline on every boot — no internet needed for normal day-to-day operation.
- App **phones home periodically** (e.g. every 24–72 hrs when internet is available) to refresh the token, catch renewals, or catch revocation.
- If it can't reach the cloud, runs on a **grace period** (e.g. 7–14 days) before locking features — protects legit customers with flaky internet while a pirated copy that never phones home eventually dies.
- **Hardware fingerprint binding** (MAC address or machine ID) stops one license key from being copied across multiple units.

Not a bulletproof/uncrackable system (nothing client-side ever is), but fits the target market (small cafe owners, not sophisticated crackers) and matches what LPB and most commercial offline-capable software use. Design/schema/endpoints not yet built — revisit when approaching v1.3.

---

## ESP8266 as alternative hardware (considered, not planned)

Technically possible to run coin/relay/WiFi logic on ESP8266 (NodeMCU/Wemos D1 Mini), but **not currently planned** — would require a full firmware rewrite (different WiFi library, different GPIO/interrupt handling, fewer safely-usable pins than ESP32, current pinout doesn't map cleanly), for only a marginal per-unit cost saving. Decision: stick with ESP32 as the standard hardware target. Could be revisited later as a "budget tier" hardware option once WiFi rental core is stable — but not before, since it would mean re-validating the grounding/coin-pulse-race fixes on a second board.

---

## Branding

Currently branded "R&J PisoWifi." **Zentry** is the confirmed likely commercial name (Zone + Entry) — chosen specifically because it isn't locked to WiFi or iCafe and can expand across verticals (WiFi rental, PC/phone/tab rental, POS, kiosk). Other names considered and dropped: Ventra, Netrayn, Raynet, Raynspot.

The future PC-rental module (previously "R&J PisoNet") is being renamed to fit the Zentry family — leaning **"ZenCafe"** over "R&J iCafe" since it shares the "Zen" root and reads as a product line rather than a specific shop name. Not finalized.

**Plan:** keep R&J branding until the core product (WiFi rental) is stable, then rebrand everything at once during a fresh OVA build. Don't rename files/branding in the codebase proactively — wait for explicit confirmation the rebrand is happening.

---

## Competitors (for reference)
- **LPB PisoWifi** — PHP + MySQL + OpenWrt, cloud sync, Android app, ships as Orange Pi/RPi IMG. Main competitor being displaced.
- AndroPiso, Wifizone — also studied for feature comparison.

R&J's differentiators: offline-first (no cloud dependency required), open architecture, cheaper licensing.

---

## Ground Rules for Claude / Claude Code

1. **Always give complete file contents** — never partial snippets or diffs. Josh copy-pastes whole files.
2. Check existing code before writing new code — avoid duplicating logic or breaking existing routes.
3. When adding new API routes, provide a Thunder Client-style example request.
4. Don't add: footer "Powered by" text, business hours settings, Telegram notifications, or any unnecessary hardware/service.
5. Portal UX must stay zero-friction — no manual steps for the customer.
6. Admin panel is desktop-first but must remain mobile responsive.
7. Any DB schema change → tell Josh to delete `rjpisowifi.db` and restart (no migrations exist yet).
8. After pulling changes on the VM that touch dependencies, remind Josh to run `npm rebuild better-sqlite3 --build-from-source`.
9. If `setup-network.sh` misbehaves after a pull, the fix is `git reset --hard HEAD && git pull`.
10. Nodemon runs in a separate "node" terminal tab in VS Code — don't tell Josh to start the server a different way unless asked.
11. Windows PowerShell syntax for any terminal commands aimed at his Windows machine (`New-Item`, not `touch`).
