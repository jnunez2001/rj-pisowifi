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

// ===== RELAY LOGIC =====
// Set to true if your relay module is ACTIVE-LOW
// (i.e. LOW = relay ON, HIGH = relay OFF). Most cheap Songle
// 1-channel boards without an H/L jumper are active-LOW.
//
// Bug report: relay (D5) stays energized from boot regardless of Insert
// Coin. First guess was that the board was active-HIGH (flipped this to
// false) - confirmed wrong after reflashing, relay was still stuck on.
// Reverting to `true` (active-LOW, LOW = on): the board is a standard
// active-LOW Songle-style module, matching the majority of cheap 1-channel
// relay boards without an H/L jumper.
//
// If flashing this still leaves the relay always-on, this constant can
// only correct a logic-level mismatch, not a wiring fault - check that
// D5 is actually wired to the relay module's signal pin (not VCC/GND
// swapped or a dead board/pin) before changing this again.
#define RELAY_ACTIVE_LOW  true

#if RELAY_ACTIVE_LOW
  #define RELAY_ON_STATE   LOW
  #define RELAY_OFF_STATE  HIGH
#else
  #define RELAY_ON_STATE   HIGH
  #define RELAY_OFF_STATE  LOW
#endif

// ===== AP MODE =====
#define AP_SSID     "RJ-Vendo-Setup"
#define AP_PASS     "rjpisowifi"

// ===== TIMING =====
#define RELAY_TIMEOUT_MS  35000
#define SETUP_HOLD_MS     5000
#define WIFI_RETRY_COUNT  20

// How long to wait after the LAST pulse before deciding a coin's pulse
// train is finished and reporting its total value (coin.cpp's
// processCoinPulses()). Needs to be longer than the real gap between
// pulses of the SAME coin (most mechanical coin acceptors finish their
// whole pulse train in well under 300ms), but every extra millisecond here
// is money-in-hand-to-credit-on-screen delay the customer directly feels.
// 1500ms was far more conservative than any real coin acceptor needs -
// dropped to 400ms, still a healthy multiple of a typical pulse train's
// real duration. If a specific coin acceptor model turns out to have
// unusually large gaps between pulses (undercounting a multi-pulse coin's
// value would show up as a customer getting less credit than they paid
// for), raise this - don't drop it further without testing that
// specific hardware's actual pulse timing first.
#define COIN_WAIT_MS      400

// How often to ask the server whether newer firmware is available
// (ota.cpp). Every boot already tells the server this device's current
// FIRMWARE_VERSION via registerVendo(), so this only needs to catch a
// version bump pushed *after* boot - not urgent, no need to check more
// than every few minutes.
#define OTA_CHECK_INTERVAL_MS  600000

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
extern volatile bool coinSlotActive;
extern volatile int coinPulseCount;
extern volatile unsigned long lastPulseTime;
extern bool processingCoin;
extern bool btnHeld;
extern unsigned long btnPressStart;
extern unsigned long lastOTACheck;

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

// ota.cpp
void checkForFirmwareUpdate();

#endif
