#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>
#include <ESP8266WebServer.h>

// ===== VERSION =====
#define FIRMWARE_VERSION "v1.0.0"

// ===== PINS =====
// Matches a specific custom ESP8266 "hat" board (NodeMCU/ESP-12E form
// factor), not the generic NodeMCU/Wemos D1 Mini pin choice this firmware
// used before:
//   D1 (GPIO5)  - COIN_PIN:   plain GPIO, interrupt-capable, no boot role.
//   D2 (GPIO4)  - RELAY_PIN:  this board's own "coin slot power" line -
//                             the SAME concept as every other RELAY_PIN
//                             use in this codebase (activateRelay() powers
//                             the coin acceptor on when the portal's
//                             Insert Coin flow starts, deactivateRelay()
//                             powers it off, checkRelayTimeout() auto-offs
//                             if no coin arrives in time), just wired to
//                             this board's dedicated pin for it. Plain
//                             GPIO, no boot role.
//   D3 (GPIO0)  - SETUP_BTN:  boot-strapping pin (must not be pulled LOW
//                             during the brief ROM-bootloader window
//                             before setup() runs, or the chip enters
//                             flash mode instead of booting normally) -
//                             which is exactly why nearly every ESP8266
//                             devboard already has its own onboard
//                             "FLASH" button wired here with a pullup.
//                             Reusing it needs no extra wiring and is the
//                             same safe INPUT_PULLUP pattern used
//                             everywhere else in this firmware; the
//                             devboard's separate RST button is a
//                             hardware reset line, not a GPIO, so it
//                             cannot be read as a held button the way
//                             this one can (see note below).
//   D4 (GPIO2)  - LED_PIN:    RESERVED ONLY. No LED is wired on this
//                             board - nothing in this firmware drives
//                             this pin (see lcd_display.cpp's ledBlink()
//                             stub). Kept defined so a future board
//                             revision with an LED doesn't need a config
//                             change, not because anything uses it today.
//
// Note on RST: while it's held, the chip is fully off and nothing is
// running, so there is no way for firmware to distinguish a brief tap
// from a long hold. Setup mode is entered only via SETUP_BTN (GPIO0,
// hold 5s) or automatically when there's no saved config yet - a plain
// reset/power blip still reconnects to saved WiFi on its own, it does
// not fall into setup mode.
#define COIN_PIN    5
#define RELAY_PIN   4
#define LED_PIN     2
#define SETUP_BTN   0

// ===== RELAY LOGIC =====
// Set to true if your relay module is ACTIVE-LOW
// (i.e. LOW = relay ON, HIGH = relay OFF). Most cheap Songle
// 1-channel boards without an H/L jumper are active-LOW.
#define RELAY_ACTIVE_LOW  true

#if RELAY_ACTIVE_LOW
  #define RELAY_ON_STATE   LOW
  #define RELAY_OFF_STATE  HIGH
#else
  #define RELAY_ON_STATE   HIGH
  #define RELAY_OFF_STATE  LOW
#endif

// ===== AP MODE =====
#define AP_SSID     "ZenFi-Setup"
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
#define COIN_WAIT_MS      400

// How often to ask the server whether newer firmware is available
// (ota.cpp). Every boot already tells the server this device's current
// FIRMWARE_VERSION via registerVendo(), so this only needs to catch a
// version bump pushed *after* boot - not urgent, no need to check more
// than every few minutes.
#define OTA_CHECK_INTERVAL_MS  600000

// How long WiFi can stay disconnected before this device gives up on the
// saved credentials and opens its own setup hotspot automatically
// (wifi_manager.cpp's checkWiFiReconnect()). Long enough that a real but
// temporary outage (the router itself rebooting, a brief power blip) won't
// falsely trigger it - this only fires for a genuinely broken connection
// (the store's WiFi password changed, the SSID renamed), the exact
// scenario that used to require someone physically holding the setup
// button on the device itself.
#define WIFI_RECONNECT_TIMEOUT_MS  300000

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
extern ESP8266WebServer server;
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
extern unsigned long wifiLostAt;

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
