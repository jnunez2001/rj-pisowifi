#include "config.h"
#include <WiFi.h>
#include <SPIFFS.h>

void setup() {
  Serial.begin(115200);
  Serial.println("\nR&J PisoWifi ESP32 " + String(FIRMWARE_VERSION));

  // Pin modes
  pinMode(COIN_PIN, INPUT_PULLUP);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(SETUP_BTN, INPUT_PULLUP);

  // Safe defaults, relay OFF using correct logic level for this board
  digitalWrite(RELAY_PIN, RELAY_OFF_STATE);
  digitalWrite(LED_PIN, LOW);

  // Init SPIFFS
  if (!SPIFFS.begin(true)) {
    Serial.println("SPIFFS failed, using fallback HTML");
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

  // Bug found live (ESP8266 firmware, same shared structure): required
  // BOTH wifi_ssid AND server_ip before ever leaving Setup Mode - but the
  // zero-config discovery flow below (when server_ip is empty) exists
  // specifically so Server IP can be left blank during setup and found
  // automatically once connected. An empty server_ip alone sent the
  // device straight back into Setup Mode every boot, regardless of a
  // valid saved WiFi SSID/password, so discovery could never run. Only
  // WiFi is actually required to attempt a normal boot.
  if (config.wifi_ssid.isEmpty()) {
    Serial.println("No WiFi configured, entering setup mode");
    startSetupMode();
    return;
  }

  // Normal mode
  bool connected = connectWiFi();
  if (connected) {
    registerVendo();
    attachInterrupt(digitalPinToInterrupt(COIN_PIN), onCoinPulse, FALLING);
    setupWebServer();
    server.begin();
    Serial.println("Ready!");
    ledBlink(3, 200);
  }
}

void loop() {
  server.handleClient();

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
  // Also skips while the setup button is held (btnHeld) - matches the same
  // fix in the ESP8266 firmware. checkForFirmwareUpdate()'s version check
  // is a blocking HTTP call (ota.cpp), so firing mid-hold freezes the
  // entire loop() - including digitalRead(SETUP_BTN) - for up to the
  // request's full timeout, on a button whose whole job is reading a
  // precise continuous hold.
  if (!setupMode && !relayActive && !processingCoin && !btnHeld &&
      millis() - lastOTACheck >= OTA_CHECK_INTERVAL_MS) {
    lastOTACheck = millis();
    checkForFirmwareUpdate();
  }

  delay(10);
}