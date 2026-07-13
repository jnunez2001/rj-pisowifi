#include "config.h"
#include <ESP8266WiFi.h>
#include <LittleFS.h>

void setup() {
  Serial.begin(115200);
  Serial.println("\nR&J PisoWifi ESP8266 " + String(FIRMWARE_VERSION));

  // Pin modes
  pinMode(COIN_PIN, INPUT_PULLUP);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(SETUP_BTN, INPUT_PULLUP);

  // Safe defaults — relay OFF using correct logic level for this board
  digitalWrite(RELAY_PIN, RELAY_OFF_STATE);
  digitalWrite(LED_PIN, LOW);

  // Init LittleFS (ESP8266's standard filesystem — the ESP32 version uses
  // SPIFFS, but LittleFS is what config.cpp's flat-file config storage and
  // web_server.cpp's optional custom setup page both rely on here)
  if (!LittleFS.begin()) {
    Serial.println("LittleFS mount failed — formatting...");
    LittleFS.format();
    LittleFS.begin();
  }

  // Load saved config
  loadConfig();

  // Check setup button held at boot
  delay(100);
  if (digitalRead(SETUP_BTN) == LOW) {
    Serial.println("Setup button held — entering setup mode");
    startSetupMode();
    return;
  }

  // No config — enter setup mode
  if (config.wifi_ssid.isEmpty() || config.server_ip.isEmpty()) {
    Serial.println("No config — entering setup mode");
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
        Serial.println("Setup button held — entering setup mode");
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
  if (!setupMode && !relayActive && !processingCoin &&
      millis() - lastOTACheck >= OTA_CHECK_INTERVAL_MS) {
    lastOTACheck = millis();
    checkForFirmwareUpdate();
  }

  delay(10);
}
