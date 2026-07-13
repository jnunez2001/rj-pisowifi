#include "config.h"
#include <LittleFS.h>

// ===== GLOBAL VARIABLE DEFINITIONS =====
Config config;
ESP8266WebServer server(80);
bool setupMode = false;
bool relayActive = false;
unsigned long relayActivatedAt = 0;
volatile bool coinSlotActive = false;
volatile int coinPulseCount = 0;
volatile unsigned long lastPulseTime = 0;
bool processingCoin = false;
bool btnHeld = false;
unsigned long btnPressStart = 0;
unsigned long lastOTACheck = 0;
unsigned long wifiLostAt = 0;

// ESP32's version of this firmware uses the Preferences library (NVS-
// backed key/value storage), which doesn't exist on ESP8266. LittleFS is
// the standard ESP8266 equivalent for anything persisted across reboots,
// but it's a filesystem, not a key/value store - a plain flat file, one
// field per line in a fixed order, gets the same result without pulling
// in a JSON library for what's ultimately nine fields.
static const char* CONFIG_PATH = "/config.txt";

// ===== LOAD CONFIG =====
void loadConfig() {
  config.vendo_name  = "Vendo 1";
  config.wifi_ssid   = "";
  config.wifi_pass   = "";
  config.server_ip   = "";
  config.server_port = 3000;
  config.static_ip   = false;
  config.device_ip   = "";
  config.gateway     = "";
  config.subnet      = "255.255.255.0";

  File f = LittleFS.open(CONFIG_PATH, "r");
  if (f) {
    config.vendo_name  = f.readStringUntil('\n');
    config.wifi_ssid   = f.readStringUntil('\n');
    config.wifi_pass   = f.readStringUntil('\n');
    config.server_ip   = f.readStringUntil('\n');
    String portStr     = f.readStringUntil('\n'); portStr.trim();
    if (portStr.length()) config.server_port = portStr.toInt();
    String staticStr   = f.readStringUntil('\n'); staticStr.trim();
    config.static_ip   = staticStr == "1";
    config.device_ip   = f.readStringUntil('\n');
    config.gateway     = f.readStringUntil('\n');
    config.subnet      = f.readStringUntil('\n');
    f.close();

    // Every line above still carries its trailing '\n' except possibly
    // the last - readStringUntil('\n') keeps everything before the
    // delimiter but the delimiter itself is consumed, not included, so
    // just trim stray whitespace/newlines left over from how the file
    // was originally written.
    config.vendo_name.trim();
    config.wifi_ssid.trim();
    config.wifi_pass.trim();
    config.server_ip.trim();
    config.device_ip.trim();
    config.gateway.trim();
    config.subnet.trim();
  }

  Serial.println("Config loaded:");
  Serial.println("  Vendo:  " + config.vendo_name);
  Serial.println("  WiFi:   " + config.wifi_ssid);
  Serial.println("  Server: " + config.server_ip + ":" + String(config.server_port));
}

// ===== SAVE CONFIG =====
void saveConfig() {
  File f = LittleFS.open(CONFIG_PATH, "w");
  if (!f) {
    Serial.println("Config save failed - could not open file");
    return;
  }
  f.println(config.vendo_name);
  f.println(config.wifi_ssid);
  f.println(config.wifi_pass);
  f.println(config.server_ip);
  f.println(config.server_port);
  f.println(config.static_ip ? "1" : "0");
  f.println(config.device_ip);
  f.println(config.gateway);
  f.println(config.subnet);
  f.close();
  Serial.println("Config saved.");
}

// ===== CLEAR CONFIG =====
void clearConfig() {
  LittleFS.remove(CONFIG_PATH);
  Serial.println("Config cleared.");
}
