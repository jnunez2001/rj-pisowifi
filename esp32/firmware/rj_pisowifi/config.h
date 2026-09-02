#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>
#include <Preferences.h>
#include <WebServer.h>

// ===== VERSION =====
#define FIRMWARE_VERSION "v1.0.2"

// ===== PINS =====
#define COIN_PIN    4
#define RELAY_PIN   5
#define LED_PIN     2
#define SETUP_BTN   0

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
#define AP_SSID     "StarkFi-Setup"
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

// How long WiFi can stay disconnected before this device gives up on the
// saved credentials and opens its own setup hotspot automatically
// (wifi_manager.cpp's checkWiFiReconnect()). Long enough that a real but
// temporary outage (the router itself rebooting, a brief power blip) won't
// falsely trigger it - this only fires for a genuinely broken connection
// (the store's WiFi password changed, the SSID renamed), the exact
// scenario that used to require someone physically holding the setup
// button on the device itself.
#define WIFI_RECONNECT_TIMEOUT_MS  300000

// How many CONSECUTIVE postCoin() failures (coin.cpp - either a network
// failure after all retries, or the server itself rejecting the credit)
// before this device stops opening the coin gate at all. A single failure
// is treated as noise (a blip); this many in a row without a single
// success in between means something is actually wrong with this specific
// coin acceptor/link, and letting it keep taking money into a pipeline
// that's already shown it won't credit it is worse than refusing new
// coins until an operator (or a self-heal restart) clears it.
#define COIN_HEALTH_FAIL_THRESHOLD  3

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
  // Persisted across reboots/connectivity loss. Bug found live: without
  // this, ANY sufficiently long WiFi/server outage (a brownout, the
  // router itself losing power) looked identical to "never configured" -
  // checkWiFiReconnect() opened this device's own setup hotspot
  // automatically regardless of whether it had already been through
  // onboarding. Set true only once the server's own registration
  // response confirms adopted status (wifi_manager.cpp's registerVendo());
  // cleared only by a genuine unbind (the server no longer recognizing
  // this mac as adopted - an admin deleted it from Devices) or a manual
  // factory reset via the physical setup button. See
  // checkWiFiReconnect()'s guard on this flag.
  bool   is_adopted;
  // Issued by the server on first registration, must be echoed back on
  // every future call (see server/routes/admin.js's POST /vendo/register
  // comment on this exact mechanism). Bug found live: this field existed
  // server-side but firmware never stored or resent it, so every
  // registration after the very first one was silently rejected with
  // 403 "Invalid device secret" - the device kept crediting coins fine
  // (a separate route), but never successfully updated its own
  // last_seen/online status again, looking permanently offline in
  // admin despite working.
  String device_secret;
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
extern unsigned long wifiLostAt;

// Consecutive postCoin() failures that were NOT a network problem (see
// coin.cpp) - i.e. attempts that reached the server and got a real error
// back, or (once coinHealthOk is wired into activateRelay(), see below)
// the count that trips it. Reset to 0 on any successful credit.
extern int coinFailStreak;
// False once coinFailStreak crosses COIN_HEALTH_FAIL_THRESHOLD.
// activateRelay() checks this and refuses to open the coin gate while
// false, so a coin acceptor in a bad state can't keep taking customers'
// money into a pipeline that's already shown it won't credit it. Cleared
// back to true only by a successful coin credit or an operator-triggered
// self-heal (web_server.cpp's /report-issue handler).
extern bool coinHealthOk;

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
bool activateRelay();
void deactivateRelay();
void checkRelayTimeout();

// ota.cpp
void checkForFirmwareUpdate();

// event_queue.cpp
void queueCoinEvent(int coinValue);
void queueDeviceLog(const String& message);
void syncQueuedEvents();

#endif
