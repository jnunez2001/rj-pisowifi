#include "config.h"
#include <WiFi.h>
#include <SPIFFS.h>

void setup() {
  Serial.begin(115200);
  Serial.println("\n🚀 R&J PisoWifi ESP32 " + String(FIRMWARE_VERSION));

  // Pin modes
  pinMode(COIN_PIN, INPUT_PULLUP);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(SETUP_BTN, INPUT_PULLUP);

  // Safe defaults
  digitalWrite(RELAY_PIN, LOW);
  digitalWrite(LED_PIN, LOW);

  // Init LCD
  lcdInit();
  lcdPrint(0, "R&J PisoWifi");
  lcdPrint(1, FIRMWARE_VERSION);
  lcdPrint(2, "Starting...");
  lcdPrint(3, "");

  // Init SPIFFS
  if (!SPIFFS.begin(true)) {
    Serial.println("SPIFFS failed — using fallback HTML");
  }

  // Load saved config
  loadConfig();

  // Check setup button held at boot
  delay(100);
  if (digitalRead(SETUP_BTN) == LOW) {
    Serial.println("Boot button held — entering setup mode");
    startSetupMode();
    return;
  }

  // No config saved — enter setup mode
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
    lcdPrint(3, "Ready!");
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

  // Coin pulse processing
  if (!setupMode) {
    processCoinPulses();
  }

  // Relay auto timeout
  if (!setupMode) {
    checkRelayTimeout();
  }

  // WiFi reconnect
  if (!setupMode) {
    checkWiFiReconnect();
  }

  delay(10);
}