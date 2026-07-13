# R&J PisoWifi

Custom, offline-first Piso WiFi (coin-operated internet) management system, built from scratch by Josh — a PC cafe owner in Naga, Bicol, Philippines. Inspired by JuanFi / LPB PisoWifi, but **not** based on their code. Long-term goal: a commercial product that undercuts LPB PisoWifi on price and doesn't require cloud dependency.

**Current version:** v1.0.1 (live, running at Josh's cafe)  
**Status:** ✅ **PRODUCTION-READY** — WiFi rental system stable, reliable, and fully tested.

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
4. **Update:** ESP8266 support now exists (`esp8266/firmware/rj_pisowifi_esp8266/`) — after bricking multiple ESP32 boards, the cost/reliability tradeoff flipped. Full feature parity (coin detection, relay control, setup hotspot, WiFi auto-recovery, OTA updates), just on cheaper, more available hardware. See its own README for the (few) wiring/pin differences.

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
minutes_remaining, is_paused, paused_at,
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
--   banner_text, max_mbps, enable_bandwidth_cap, bandwidth_cap_download_mbps,
--   bandwidth_cap_upload_mbps, spam_max_attempts, spam_block_minutes,
--   logo_url, banner_url, welcome_message, disconnect_message, show_voucher,
--   redirect_url, allow_pause, max_pause_minutes, grace_period_minutes,
--   coin_wait_ms, min_coins, free_minutes_enabled, free_minutes_amount, vendo_ip
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

## Roadmap (revised priority)

Kiosk and POS are **explicitly not current targets** — deferred roughly a year out, after many incremental version updates. No PPPoE, eload, GCash, or Maya integration for now. Josh's own PC cafe/computer shop is the test ground for everything before wider release.

**Current priority order:**
1. ✅ **WiFi rental system stable & reliable** — all critical bugs fixed, production-ready. See `bugslog.md` for details on 32 bugs fixed.
2. **iCafes (PC + WiFi combined)** — the biggest target market next. Will fold in a PC-rental module ("ZenCafe").
3. **Phone/tablet rental expansion** — later.
4. **Kiosk** (much later, future expansion) — McDonald's-style self-order kiosk concept.
5. **POS system** (future) — will be tested first in Josh's own computer shop before wider release.

### Deployment targets (long-term)
OVA (current) → IMG (Orange Pi/RPi) → ISO (bare metal) → Windows EXE (Electron)

### Phase 3+ (cloud features)
Cloudflare Tunnel, unique subdomain per unit, WireGuard VPN, multi-unit cloud monitoring, subscription model (₱299/month Pro tier)

---

## Bug Audit & Fixes (Completed 2026-07-03)

✅ **32 Bugs Fixed:** 5 Critical + 10 High-Severity + 17 Medium-Severity  
✅ **3 Low-Severity Bugs Remaining:** Minor cosmetic/edge-case issues  

**Full audit and fix details:** See [`bugslog.md`](bugslog.md) for comprehensive documentation including:
- Effects of each bug
- Root causes
- Fixes applied
- Files modified with line numbers
- Performance improvements
- Database schema changes
- Testing & validation results

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

## ESP8266 as alternative hardware (built)

Originally deferred (see history below) — built once the actual cost/reliability tradeoff on the ground made it worth it (multiple ESP32 boards bricked, ESP32 pricing too high for a budget tier). Full feature parity with the ESP32 firmware: coin detection, relay control, setup hotspot, WiFi auto-recovery, OTA updates from the admin panel. Lives at `esp8266/firmware/rj_pisowifi_esp8266/`, own README covers the pin/wiring differences (fewer safely-usable GPIOs than ESP32, different config storage mechanism under the hood — LittleFS instead of ESP32's Preferences/NVS, functionally identical from the outside).

*Original note, kept for history: "Technically possible... but not currently planned — would require a full firmware rewrite... for only a marginal per-unit cost saving." That calculus changed once real hardware got bricked in the field.*

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
