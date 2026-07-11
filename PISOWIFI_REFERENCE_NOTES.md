# LPB Reference Notes — Building Reliability Into R&J PisoWiFi

His build (LPB PisoWiFi) has been running clean for ~5 years. He gave the okay to study it and borrow patterns for making our system more reliable. This file documents what we found inspecting an actual flashed LPB image, and what to do with it — kept as a build note, not a task list, so it doesn't go stale as we implement pieces of it.

Source examined: `LPB-2.0-1.1.7.5-OPI-ONE.img` (ImmortalWrt 24.10.4, Orange Pi One), extracted and inspected directly.

---

## Plain-English summary

His system is **one compiled program** that does everything — portal, admin, coin reading, firewall control, bandwidth shaping, e-load reselling — running directly on the router itself. Ours is a **Node.js app** split across a separate PC/VM, a router, and an ESP32. Different shape, same job.

The reliability lessons below aren't "rewrite everything in Go and put it on a router." They're specific, small patterns his build uses that we can lift into our own stack, in our own language, without copying his code (we don't have his source — it's a stripped binary, we only have what we could observe from the outside).

---

## 1. How his app is structured

- **One binary, one job.** `lpbpisowifi` is a single Go program, statically compiled, running as an HTTP/REST API server on `127.0.0.1:100` (localhost only — not exposed directly).
- **Nginx sits in front of it.** Nginx listens on port 80/443 publicly, reverse-proxies everything to the app on localhost, and serves the pre-built admin dashboard files directly (no need to hit the app for static files). The app itself is never reachable from the network except through nginx.
- **The app lives on its own writable area** (`/mnt/lpbgo/`), separate from the base OS image. That means updating the app doesn't touch the OS, and reflashing/updating the OS doesn't wipe the app's data.
- **The service manager restarts it automatically** if it dies (OpenWrt's `procd`, via `/etc/init.d/lpbpisowifi`), and it's set to periodically recycle itself rather than run forever unattended.
- **Storage is SQLite**, with the *option* to point at Postgres instead via an environment variable — but SQLite is what actually ships. Simplicity by default, an escape hatch if it's ever needed.

**What this tells us:** none of this is exotic. It's "run behind a reverse proxy, keep the app separate from the OS, let a supervisor restart it, keep storage simple." That's achievable in our stack too.

---

## 2. How coins get counted

Three coin input paths, all handled by the same program:

1. **Direct GPIO** — reads the coin acceptor's pulse pin straight off the board's pins (`/sys/class/gpio/...`), pins configurable from settings, not hardcoded.
2. **Serial-attached acceptors** — some coin/bill acceptors connect over serial instead of GPIO; supported as an alternate input mode.
3. **ESP32 coin slots over MQTT** — the app runs its **own local MQTT broker** on the box itself. An ESP32 coin unit connects to `mqtt://<box-ip>:1883` and publishes coin events. No cloud round-trip needed for a coin to register — it's fully local, cloud sync happens after the fact.

Pulses are converted to time/credit through a **rate table stored in the database**, editable from the admin panel — not a hardcoded conversion in the program itself. Changing "1 coin = how many minutes" doesn't require a new build.

**What this tells us:** GPIO, serial, and ESP32 aren't three different products — they're three input drivers feeding the same core logic. That maps directly onto the `coin_mode` idea from our platform blueprint.

---

## 3. How internet access gets granted and cut (sessions)

- Uses **nftables** (the modern OpenWrt firewall, not old-style iptables) with a **named set** of allowed MAC addresses (`allowed_macs`) and a dedicated chain that only lets traffic through from MACs in that set.
- The app adds/removes MACs from that set at runtime as sessions start/expire (`nft add element ...` / `nft delete element ...`).
- Session state — start time, expiry, pause windows, data used — lives in the database, **not** in cron or in the firewall rules themselves. The firewall rules are just a reflection of what the database says is currently valid.
- Expiry/scheduling is handled by the app's own internal timer, backed by database rows, instead of relying on the OS's cron service to fire reliably.

**Why this matters for us specifically:** this is the pattern behind the "Critical" item on our earlier list — *firewall rules must reload correctly on every boot, not just the first time.* His approach is: on startup, don't assume the firewall state is correct. Rebuild the `allowed_macs` set from what the database says is actually still valid right now. That way a reboot never strands a paying customer offline, and never leaves a stale rule granting free access to someone whose time already ran out.

---

## 4. How the money/reseller side works

- E-load/GCash-style reselling pulls product catalogs from an external load API and **caches them locally** (`eload_cache/*.json`), so the machine can still show rates and queue a purchase even with a flaky connection — it doesn't need to hit the internet live for every screen.
- Every financial event (cash-in, e-load sent, bills paid) is written to **two places**: the database, and a plain dated log file on disk. The flat log file is redundant on purpose — if the database ever gets corrupted, there's still a plain-text audit trail of every peso that moved.
- The license/activation file is **encrypted at rest**, not stored as plain readable JSON.
- Multiple machines can sync to each other / to a central account over MQTT with TLS — this is the mechanism behind features like cross-machine session time and remote monitoring without needing a third-party tunnel tool.

---

## 5. How bandwidth shaping works

- Uses OpenWrt's own **SQM package with CAKE** (`sqm-scripts`, configured via `uci set sqm.*`) rather than a custom-built traffic shaper. CAKE is a well-tested, "fire and forget" algorithm designed for exactly this kind of mixed-traffic, many-small-clients situation.
- Per-app/port priority (e.g. prioritizing a game's traffic) is a separate, simpler layer on top of the base shaping, editable from admin.

**What this tells us:** don't hand-roll bandwidth fairness from scratch. If/when we're on an OpenWrt-capable board, `sqm-scripts` + CAKE is the standard, proven tool for this — not something to reinvent.

---

## 6. Security patterns worth borrowing

- Reverse proxy in front, app never directly exposed.
- App and OS kept on separate storage areas.
- MAC/session state rebuilt from the database on every boot, not trusted to persist correctly in the firewall.
- License/activation data encrypted at rest.
- Binary checks its own signature before applying an update, so a corrupted or malicious update package gets rejected instead of installed.
- Firewall/network commands built from structured calls (`nft ...`, `uci set key=value`) rather than raw shell string-concatenation — lower risk of a stray character breaking or hijacking the command.

## 7. Things observed in his build we should NOT copy

Being fair to both sides: his build isn't flawless either, and copying it wholesale would import these along with the good parts.

- Hardcoded secrets sitting in a plain config file on the box (`JWT_SECRET`, `PROXY_SECRET`) — readable by anyone with file access.
- Default admin passwords (`admin123`-style) baked in as database defaults, no forced change on first setup.
- PPPoE credentials stored and pushed around in plain text.
- Root SSH login enabled with password auth allowed.
- The local MQTT broker for ESP32 coin slots did not show evidence of requiring authentication — meaning, in theory, anything on the same WiFi could try to send fake "coin inserted" messages.

Our own code already does a couple of things *better* than what we observed here — parameterized SQL everywhere (no raw string-built queries), and MAC address validation before it's used in any firewall/shell command. Keep that discipline while adopting the patterns above.

---

## 8. Concrete next steps this maps to

These are the direct, actionable translations of the lessons above into our stack. Not meant to all happen at once.

1. **Put nginx in front of our Node app**, app bound to localhost only, nginx handling the public port and TLS. (`setup/nginx.conf` currently exists but is an empty placeholder — this is the fix.)
2. **Run the app under a real supervisor** (systemd `Restart=always` + a watchdog heartbeat, or the equivalent on whichever OS we land on) so a crash or hang gets caught and restarted automatically.
3. **Keep app/database storage on a separate area from the OS**, so an OS update or reflash can never accidentally wipe live session/customer data.
4. **On every boot, rebuild the firewall's allowed-MAC set from the database** — don't trust leftover rules, don't assume a clean slate. Reconcile against what sessions are actually still valid.
5. **Add a `coin_mode` setting** (`esp32` / `direct-gpio` / `serial`) so GPIO and serial become real input options on boards, not just the ESP32-over-HTTP path we have today.
6. **If we add multiple ESP32 sub-coinslots, consider a local MQTT broker** on the board instead of each ESP32 hitting the server's HTTP API directly — more resilient to brief network hiccups, and add authentication on it from day one (his build's likely gap, don't repeat it).
7. **Write financial events to a flat log file in addition to the database** (append-only, dated) — cheap insurance against database corruption for money-related events specifically.
8. **When we build the licensing/anti-piracy layer** (already on our own roadmap per `bugslog.md`), encrypt the activation data at rest and verify update packages before applying them.
9. **Adopt `sqm-scripts` + CAKE** for bandwidth shaping if/when we're running on an OpenWrt-capable board, instead of maintaining a hand-rolled shaper long-term.
10. **Fix the security gaps we already know about on our side** (plaintext admin password, no forced password change, no TLS) at the same time — his build shows these are easy to accidentally ship even in software that's otherwise been stable for years, so "it's been running fine" isn't proof the security side is fine too.

---

*This note reflects a point-in-time inspection of one LPB build (v2.0-1.1.7.5). If he updates his system or shares more detail directly, treat this as a starting reference, not a spec to match exactly.*
