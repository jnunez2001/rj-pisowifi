#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>
#include <Preferences.h>
#include <WebServer.h>

// ===== VERSION =====
#define FIRMWARE_VERSION "v1.0.0"

// ===== PINS =====
#define COIN_PIN    4
#define RELAY_PIN   5
#define LED_PIN     2
#define SETUP_BTN   13

// ===== AP MODE =====
#define AP_SSID     "RJ-Vendo-Setup"
#define AP_PASS     "rjpisowifi"

// ===== TIMING =====
#define RELAY_TIMEOUT_MS  35000
#define SETUP_HOLD_MS     5000
#define WIFI_RETRY_COUNT  20
#define COIN_WAIT_MS      1500

// ===== CONFIG STRUCT =====
struct Config {
  String vendo_name;
  String wifi_ssid;
  String wifi_pass;
  String server_ip;
  int    server_port;
  bool   static_ip;
  String device_ip;
  String gateway;
  String subnet;
};

// ===== GLOBAL VARIABLES =====
extern Config config;
extern Preferences prefs;
extern WebServer server;
extern bool setupMode;
extern bool relayActive;
extern unsigned long relayActivatedAt;
extern volatile int coinPulseCount;
extern volatile unsigned long lastPulseTime;
extern bool processingCoin;
extern bool btnHeld;
extern unsigned long btnPressStart;

// ===== FUNCTION DECLARATIONS =====

// config.cpp
void loadConfig();
void saveConfig();
void clearConfig();

// lcd_display.cpp
void lcdPrint(int row, String text);
void lcdClear();
void ledBlink(int times, int ms);

// wifi_manager.cpp
bool connectWiFi();
void registerVendo();
void checkWiFiReconnect();

// web_server.cpp
void setupWebServer();
void startSetupMode();
String getFallbackHTML();

// coin.cpp
void IRAM_ATTR onCoinPulse();
void processCoinPulses();
void postCoin(int coinValue);

// relay.cpp
void activateRelay();
void deactivateRelay();
void checkRelayTimeout();

#endif