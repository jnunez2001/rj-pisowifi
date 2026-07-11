# ESP32/ESP8266 Firmware — Configurability & Distribution Plan (DRAFT, awaiting approval)

Status: **planning only — nothing in this document is built yet.**
Companion to `ROUTER_MODE_PLAN.md` and `SECURITY_PLAN.md` — this covers the coin-slot hardware side (ESP32/ESP8266 "vendo" firmware), a separate area from the network/router work.

---

## 1. What already exists (checked against actual code, not assumed)

`esp32/firmware/rj_pisowifi/` already has a working setup flow:
- Holding the setup button puts the device into its own temporary WiFi network (`RJ-Vendo-Setup`), serving a real setup webpage (`web_server.cpp` + `esp32/firmware/data/index.html`, with a fallback HTML baked into the firmware itself).
- That page already lets someone configure: device name, WiFi SSID/password (with a live network scan), server IP/port, and static IP settings — saved persistently via the ESP32's `Preferences` storage.
- Already has real security fixes in place: setup-only endpoints (`/save`, `/reset`, `/reboot`, `/scan`, `/config`) are rejected once the device leaves setup mode, and `/relay/on`/`/relay/off` only accept requests from the known server IP — both documented as fixes for real prior bugs (unauthenticated factory reset / relay control from any device on the customer network).

**What's missing:** the physical GPIO pin assignments (`COIN_PIN`, `RELAY_PIN`, `LED_PIN`, `SETUP_BTN` in `config.h`) are hardcoded at compile time. Changing which physical pin does what requires editing the firmware source and reflashing — this is the gap the commercial "hat" boards (DIP switches, or their own companion apps) solve differently.

---

## 2. GPIO pin configurability — extend the existing setup page, don't build a separate app

**Decision: add pin assignment to the setup page that already exists**, rather than building a new, separate configuration app. The infrastructure (a served setup page, persistent config storage, a save/reboot flow) is already there — this is an incremental addition to it, not a new system.

- Move pin numbers out of hardcoded `#define` constants and into the same saved `Config` struct the WiFi settings already live in.
- Add a section to the setup page: "which pin is your coin slot on," "which pin is your relay on," etc.
- **Safety requirement, not optional:** don't offer a free-form "type any pin number" field. Not every physical pin on an ESP32/ESP8266 is safe to assign to any function — some are input-only, some affect the chip's boot behavior if pulled a certain way at power-on, and a wrong assignment can make a board fail to boot entirely. Offer a **vetted list of known-safe pins per function** (cross-check against `esp32/firmware/esp32_setup_diagram/Diagram.png`, which should already document safe pin usage), not an open field.

---

## 3. Protecting the firmware source, and how flashing works without Arduino IDE

**The `.ino` file itself should never be distributed.** The Arduino IDE's actual job is compiling `.ino` source into a `.bin` binary, then uploading that binary over USB — the upload step never needs the source, only a finished binary. Fix: **compile once, as part of the release process, and only ever distribute the compiled `.bin`.** This alone stops firmware logic from being readable, independent of how the binary later gets onto a board.

**Decision: use browser-based flashing (WebSerial-based tooling, the same approach used by established projects like ESPHome/Tasmota) instead of building a custom native flasher app.**
- Plug the ESP32 in over USB, visit a webpage, click "Install" — no separate application to install, no per-OS builds (Windows/Mac/Linux) to build and maintain ourselves.
- Same protection either way (source never leaves our hands, only the compiled binary does) — the flashing *method* is a convenience/maintenance choice, not a security decision, same lesson as the IMG/ISO/OVA distribution-format conversation in `SECURITY_PLAN.md`. A custom native app would cost real ongoing engineering effort for no additional protection over the browser-based route.
- **Natural tie-in to licensing**: the flashing page can require a valid license key (same mechanism as `SECURITY_PLAN.md`'s license system) before it will actually write to a board — closes what would otherwise be an unprotected side door into provisioning hardware outside the licensed server flow.

**Decision: the flasher page is hosted locally by the pisowifi server itself (part of the admin panel — e.g. Network/Devices → "Flash new vendo"), not on our company website.** This follows the same offline-resilience principle behind everything else in this whole plan (Bug #82's reboot recovery, the server-down resilience section in `ROUTER_MODE_PLAN.md`, the mDNS-with-fallback setup flow, CAKE running entirely locally): WebSerial flashing itself only ever needs a browser and a USB cable — the only reason it would need internet at all is if the *page* has to be fetched from somewhere external. Serving it locally (the same way `/admin` is already served today) means flashing a new vendo works even with zero internet at the shop, instead of depending on reaching our website at that exact moment.
- **Firmware binary distribution**: since the flasher can't always fetch the newest binary live from us, the compiled `.bin` rides along with the same mechanism that already updates the server software itself (the admin panel's existing System Update flow) — updating the app also refreshes the bundled firmware binary, and day-to-day flashing then works from whatever's already cached locally, no live connection needed at flash time.

---

## 4. Still open

- Confirm the vetted safe-pin list per function (needs cross-referencing actual ESP32/ESP8266 pin documentation, not guessed).
- License-gating the flasher page depends on the same offline/online/hybrid decision still open in `SECURITY_PLAN.md` §4 — not re-decided separately here.
