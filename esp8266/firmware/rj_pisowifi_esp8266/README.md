# ESP8266 Vendo Firmware

Full feature parity with the ESP32 version (`esp32/firmware/rj_pisowifi/`) — coin detection, relay control, WiFi setup hotspot, auto-recovery on WiFi failure, and OTA updates from the admin panel — ported to run on the cheaper ESP8266.

## Wiring (NodeMCU / Wemos D1 Mini -style boards)

| Function    | Pin        |
|-------------|------------|
| Coin sensor | D2 (GPIO4) |
| Relay       | D1 (GPIO5) |
| Status LED  | D4 (GPIO2) — usually the board's own onboard LED |
| Setup button| D3 (GPIO0) — usually the board's own onboard "FLASH" button, no extra wiring needed |

D2/D1 have no boot-time role on ESP8266, unlike D4/D3, which is exactly why nearly every ESP8266 board already has its onboard LED and FLASH button wired to those two specific pins — reusing them here is standard practice, not a workaround.

## Arduino IDE setup

Same process as the ESP32 version, with two differences:

1. **Board package**: install *"esp8266 by ESP8266 Community"* in Boards Manager (not the ESP32 one) — add `https://arduino.esp8266.com/stable/package_esp8266com_index.json` under Preferences → Additional Board URLs (alongside the ESP32 URL if you have both installed).
2. **Board selection**: Tools → Board → pick your specific board (e.g. "NodeMCU 1.0 (ESP-12E Module)" or "LOLIN(WEMOS) D1 R2 & mini", whichever matches what you bought).

Everything else — opening the `.ino`, selecting the port, clicking Upload — is identical to the ESP32 process.

## Config storage

The ESP32 version uses its `Preferences` library (NVS-backed), which doesn't exist on ESP8266. This version uses `LittleFS` instead — a plain text file (`/config.txt`) with each setting on its own line. Functionally identical from the outside (same setup hotspot, same save/reset behavior), just a different storage mechanism under the hood.

## OTA updates

Uses the exact same admin panel flow as the ESP32 version — push a `.bin` through the Devices page, and this device picks it up automatically. Compile with Arduino IDE's *Sketch → Export Compiled Binary* the same way, just with the ESP8266 board selected instead of ESP32.
