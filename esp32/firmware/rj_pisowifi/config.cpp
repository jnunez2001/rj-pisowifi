#include "config.h"

// ===== GLOBAL VARIABLE DEFINITIONS =====
Config config;
Preferences prefs;
WebServer server(80);
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

// ===== LOAD CONFIG =====
void loadConfig() {
  prefs.begin("rjconfig", true);
  config.vendo_name  = prefs.getString("vendo_name", "Vendo 1");
  config.wifi_ssid   = prefs.getString("wifi_ssid", "");
  config.wifi_pass   = prefs.getString("wifi_pass", "");
  config.server_ip   = prefs.getString("server_ip", "");
  config.server_port = prefs.getInt("server_port", 3000);
  config.static_ip   = prefs.getBool("static_ip", false);
  config.device_ip   = prefs.getString("device_ip", "");
  config.gateway     = prefs.getString("gateway", "");
  config.subnet      = prefs.getString("subnet", "255.255.255.0");
  prefs.end();

  Serial.println("Config loaded:");
  Serial.println("  Vendo:  " + config.vendo_name);
  Serial.println("  WiFi:   " + config.wifi_ssid);
  Serial.println("  Server: " + config.server_ip + ":" + String(config.server_port));
}

// ===== SAVE CONFIG =====
void saveConfig() {
  prefs.begin("rjconfig", false);
  prefs.putString("vendo_name",  config.vendo_name);
  prefs.putString("wifi_ssid",   config.wifi_ssid);
  prefs.putString("wifi_pass",   config.wifi_pass);
  prefs.putString("server_ip",   config.server_ip);
  prefs.putInt("server_port",    config.server_port);
  prefs.putBool("static_ip",     config.static_ip);
  prefs.putString("device_ip",   config.device_ip);
  prefs.putString("gateway",     config.gateway);
  prefs.putString("subnet",      config.subnet);
  prefs.end();
  Serial.println("Config saved.");
}

// ===== CLEAR CONFIG =====
void clearConfig() {
  prefs.begin("rjconfig", false);
  prefs.clear();
  prefs.end();
  Serial.println("Config cleared.");
}
