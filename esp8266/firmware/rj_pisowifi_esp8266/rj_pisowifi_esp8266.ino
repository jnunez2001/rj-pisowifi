#include "config.h"
#include "audio.h"
#include <ESP8266WiFi.h>
#include <LittleFS.h>

void setup() {
  Serial.begin(115200);
  Serial.println("\nR&J PisoWifi ESP8266 " + String(FIRMWARE_VERSION));

  // Pin modes
  pinMode(COIN_PIN, INPUT_PULLUP);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(SETUP_BTN, INPUT_PULLUP);
  // LED_PIN is reserved only (see config.h), no LED on this board, so it
  // is never configured as an output or driven.

  // Safe defaults, relay OFF using correct logic level for this board
  digitalWrite(RELAY_PIN, RELAY_OFF_STATE);

  // Init LittleFS (ESP8266's standard filesystem, the ESP32 version uses
  // SPIFFS, but LittleFS is what config.cpp's flat-file config storage and
  // web_server.cpp's optional custom setup page both rely on here)
  if (!LittleFS.begin()) {
    Serial.println("LittleFS mount failed, formatting...");
    LittleFS.format();
    LittleFS.begin();
  }

  // Load saved config
  loadConfig();

  // Check setup button held at boot
  delay(100);
  if (digitalRead(SETUP_BTN) == LOW) {
    Serial.println("Setup button held, entering setup mode");
    startSetupMode();
    return;
  }

  // Bug found live: this required BOTH wifi_ssid AND server_ip to be set
  // before ever leaving Setup Mode - but the zero-config discovery flow
  // right below (discoverServer(), when server_ip is empty) exists
  // specifically so an operator CAN leave Server IP blank during setup
  // and have the device find it automatically once connected. That
  // discovery code could never run: an empty server_ip alone sent the
  // device straight back into Setup Mode every single boot, regardless
  // of a perfectly valid saved WiFi SSID/password. Confirmed live via the
  // Serial Monitor - WiFi loaded fine ("R&J PisoWiFi"), but "Server: :3000"
  // (empty) was still enough to trigger "No config, entering setup mode."
  // Only WiFi is actually required to attempt a normal boot; a missing
  // server address is exactly what discovery is meant to resolve next.
  if (config.wifi_ssid.isEmpty()) {
    Serial.println("No WiFi configured, entering setup mode");
    startSetupMode();
    return;
  }

  // Normal mode
  bool connected = connectWiFi();
  if (connected) {
    // Zero-config discovery: if no server was manually configured during
    // setup, find it on the LAN now instead of registering nowhere. Saves
    // the discovered address so this only needs to happen once, not on
    // every boot - a later admin-panel/settings change to config.server_ip
    // still takes priority over rediscovering.
    if (config.server_ip.isEmpty()) {
      lcdPrint(1, "Finding server...");
      if (discoverServer()) {
        saveConfig();
      }
    }
    registerVendo();
    // CHANGE, not FALLING - onCoinPulse() now measures actual pulse width
    // (both edges) instead of just counting falling edges, see coin.cpp.
    attachInterrupt(digitalPinToInterrupt(COIN_PIN), onCoinPulse, CHANGE);
    setupWebServer();
    server.begin();
    Serial.println("Ready!");
    ledBlink(3, 200);

    // Bug found live: lastOTACheck starts at 0 every boot, and loop()'s
    // check only fires once millis() - lastOTACheck >= OTA_CHECK_INTERVAL_MS
    // has elapsed - since millis() also starts at 0, a fresh boot's FIRST
    // check didn't happen until a full 10 minutes after that boot, not
    // shortly after connecting. Power-cycling a device to "force" a
    // faster update check actually made it slower, resetting the wait
    // back to the full interval instead of picking up wherever a
    // continuously-running device's periodic timer already was. Checking
    // once here, right after a successful boot, means a fresh device (or
    // an operator power-cycling one on purpose) gets update-checked
    // promptly; lastOTACheck below still seeds the normal 10-minute
    // periodic check in loop() from this point onward.
    checkForFirmwareUpdate();
    lastOTACheck = millis();
  }
}

void loop() {
  server.handleClient();
  if (setupMode) dnsServer.processNextRequest();

  // Plays one more decoded chunk of whatever sound is currently streaming
  // (if any) - never blocks for the whole file, safe to call every
  // iteration alongside everything else below. Runs even in setup mode,
  // unlike coin/relay/OTA checks, since a sound could reasonably be
  // useful during setup too and playback itself can't affect WiFi/button
  // state the way those can.
  audioLoop();

  // Setup button hold check
  if (!setupMode) {
    if (digitalRead(SETUP_BTN) == LOW) {
      if (!btnHeld) {
        btnPressStart = millis();
        btnHeld = true;
      } else if (millis() - btnPressStart >= SETUP_HOLD_MS) {
        Serial.println("Setup button held, entering setup mode");
        startSetupMode();
      }
    } else {
      btnHeld = false;
    }
  }

  if (!setupMode) processCoinPulses();
  if (!setupMode) checkRelayTimeout();
  if (!setupMode) checkWiFiReconnect();

  // Skip while a coin is actively being processed or the relay is armed -
  // an OTA update mid-insertion would be bad timing for a customer paying
  // right now, and this check can safely wait for the next interval.
  //
  // Bug found live: also needs to skip while the setup button is being
  // held (btnHeld). checkForFirmwareUpdate()'s version check is a
  // BLOCKING HTTP call with up to a 5-second timeout (ota.cpp) - if it
  // fires mid-hold, the entire loop() stalls for up to 5 seconds with no
  // digitalRead(SETUP_BTN) happening at all, on a device whose setup mode
  // specifically requires reading a continuous 5-second hold. Whether
  // that stall makes the hold appear to silently do nothing (frustrated
  // release before the check returns) or just delays it unpredictably,
  // neither is acceptable for a button whose entire job is a precise
  // timed hold - skip the check outright while btnHeld is true, same as
  // the existing relay/coin exceptions above.
  if (!setupMode && !relayActive && !processingCoin && !btnHeld &&
      millis() - lastOTACheck >= OTA_CHECK_INTERVAL_MS) {
    lastOTACheck = millis();
    checkForFirmwareUpdate();
  }

  delay(10);
}
