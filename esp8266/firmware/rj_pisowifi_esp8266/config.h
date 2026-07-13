#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>
#include <ESP8266WebServer.h>

// ===== VERSION =====
#define FIRMWARE_VERSION "v1.0.0"

// ===== PINS =====
// ESP8266 (NodeMCU/Wemos D1 Mini -style D-labels) has far fewer usable
// GPIOs than ESP32, several with real boot-mode constraints. Picked to
// avoid every one of those constraints EXCEPT where reusing a
// board-provided button is actually the safer, more convenient choice:
//   D2 (GPIO4)  - COIN_PIN:   plain GPIO, interrupt-capable, no boot role.
//   D1 (GPIO5)  - RELAY_PIN:  plain GPIO, no boot role.
//   D4 (GPIO2)  - LED_PIN:    a boot-strapping pin (must be HIGH at boot),
//                             but this is also the standard onboard-LED
//                             pin on nearly every ESP8266 dev board for
//                             exactly this reason - completely safe to
//                             drive from user code once setup()/loop() are
//                             running, well past the boot-mode window.
//   D3 (GPIO0)  - SETUP_BTN:  also boot-strapping (LOW during reset means
//                             "enter flash mode"), which is precisely why
//                             most ESP8266 boards already have their own
//                             physical "FLASH" button wired here with a
//                             pullup - reusing it as SETUP_BTN needs no
//                             extra wiring on most boards and is the same
//                             safe INPUT_PULLUP pattern used everywhere
//                             else in this firmware.
#define COIN_PIN    4
#define RELAY_PIN   5
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
