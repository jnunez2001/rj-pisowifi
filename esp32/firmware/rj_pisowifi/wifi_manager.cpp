#include "config.h"
#include "event_queue.h"
#include <WiFi.h>
#include <HTTPClient.h>

unsigned long lastHeartbeat = 0;
// See the self-heal reboot logic in checkWiFiReconnect()'s connected
// branch below - tracks how long heartbeats have been failing at the
// network level despite WiFi.status() reporting connected.
unsigned long heartbeatStuckSince = 0;

// No ArduinoJson anywhere in this codebase (payloads are already built via
// plain string concatenation) - this is the matching manual extractor for
// the couple of string fields registerVendo() needs back out of the
// server's response. Only correct for simple, non-escaped string values
// (device_secret and status are both server-generated, never contain a
// literal quote), not a general JSON parser.
static String extractJsonString(const String& json, const String& key) {
  String pattern = "\"" + key + "\":\"";
  int idx = json.indexOf(pattern);
  if (idx == -1) return "";
  idx += pattern.length();
  int end = json.indexOf("\"", idx);
  if (end == -1) return "";
  return json.substring(idx, end);
}

bool connectWiFi() {
  if (config.wifi_ssid.isEmpty()) return false;

  if (config.static_ip && !config.device_ip.isEmpty()) {
    IPAddress ip, gw, sn;
    ip.fromString(config.device_ip);
    gw.fromString(config.gateway);
    sn.fromString(config.subnet);
    WiFi.config(ip, gw, sn);
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(config.wifi_ssid.c_str(), config.wifi_pass.c_str());

  Serial.print("Connecting to WiFi");
  lcdPrint(0, config.vendo_name);
  lcdPrint(1, "Connecting WiFi...");
  lcdPrint(2, config.wifi_ssid);
  lcdPrint(3, "");

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < WIFI_RETRY_COUNT) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nConnected! IP: " + WiFi.localIP().toString());
    lcdPrint(0, config.vendo_name);
    lcdPrint(1, "Connected!");
    lcdPrint(2, WiFi.localIP().toString());
    lcdPrint(3, "Server: " + config.server_ip);
    digitalWrite(LED_PIN, HIGH);
    return true;
  }

  Serial.println("\nWiFi failed.");
  lcdPrint(0, config.vendo_name);
  lcdPrint(1, "WiFi Failed!");
  lcdPrint(2, "Hold BTN 5s");
  lcdPrint(3, "for Setup Mode");
  digitalWrite(LED_PIN, LOW);
  return false;
}

// Returns true if the server actually answered (any HTTP status - even a
// 403/500 still proves the link is genuinely up), false only on a
// network-level failure (timeout, connection refused, DNS failure - code
// <= 0). This distinction is what lets checkWiFiReconnect() tell a real
// answer apart from WiFi.status() lying about the link being usable (see
// the "zombie connection" fix there).
bool registerVendo() {
  if (config.server_ip.isEmpty()) return true; // not a link failure, nothing to report yet

  String url = "http://" + config.server_ip + ":" +
               String(config.server_port) + "/api/admin/vendo/register";

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);

  String payload = "{";
  payload += "\"mac\":\"" + WiFi.macAddress() + "\",";
  payload += "\"name\":\"" + config.vendo_name + "\",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"version\":\"" + String(FIRMWARE_VERSION) + "\",";
  // Bug found live (curl-tested): the server has rejected every heartbeat
  // after the first one with 403 "Invalid device secret" since this field
  // was never sent back - the device kept crediting coins fine (a
  // separate route) but never again updated its own online status,
  // showing permanently offline in admin despite working normally.
  payload += "\"device_secret\":\"" + config.device_secret + "\"";
  payload += "}";

  int code = http.POST(payload);
  Serial.println("Register response: " + String(code));
  bool gotResponse = code > 0;

  if (code == 200) {
    String body = http.getString();
    String newSecret = extractJsonString(body, "device_secret");
    String status = extractJsonString(body, "status");
    bool changed = false;

    if (!newSecret.isEmpty() && newSecret != config.device_secret) {
      config.device_secret = newSecret;
      changed = true;
    }

    bool nowAdopted = (status == "adopted");
    if (config.is_adopted && !status.isEmpty() && !nowAdopted) {
      // The ONLY signal that should ever clear an adopted device's
      // binding automatically: the server itself, on a real 200
      // response, confirming this mac is no longer adopted (an operator
      // deleted/unbound it in Devices). A connectivity failure must
      // NEVER reach this - see checkWiFiReconnect()'s own guard below,
      // this is deliberately the opposite trigger.
      Serial.println("Server reports this device is no longer adopted - clearing local binding and returning to setup mode");
      config.is_adopted = false;
      config.device_secret = "";
      saveConfig();
      http.end();
      startSetupMode();
      return true;
    }

    if (nowAdopted != config.is_adopted) {
      config.is_adopted = nowAdopted;
      changed = true;
    }

    if (changed) saveConfig();
  } else if (code == 403) {
    // Rejected/mismatched secret - retry on the next heartbeat rather
    // than treating this as an unbind signal (see comment above).
    Serial.println("Register rejected (invalid device secret) - will retry on next heartbeat");
  }

  http.end();
  return gotResponse;
}

void checkWiFiReconnect() {
  if (WiFi.status() != WL_CONNECTED) {
    // Bug: the coin gate relay had no safety cutoff tied to connectivity -
    // if WiFi dropped while the relay was armed (RELAY_TIMEOUT_MS gives up
    // to 35s per Insert Coin press), the gate stayed physically open for
    // the rest of that window regardless. A coin dropped in during that
    // gap gets mechanically accepted by the coin validator (that part is
    // independent of the ESP32 entirely) but postCoin() can never reach
    // the server to credit it - money taken, nothing granted, no way for
    // the customer to know until they check their session. Closing the
    // gate the instant WiFi drops is the fix: it can't fully prevent this
    // for whatever coin is already mid-drop at the exact moment
    // connectivity dies, but it stops every coin after that.
    if (relayActive) {
      Serial.println("WiFi down while relay armed, closing coin gate for safety");
      deactivateRelay();
    }

    // Bug this fixes: a device whose saved WiFi credentials had gone bad
    // (the store's WiFi password changed, the SSID renamed) used to retry
    // those exact same broken credentials forever, silently - the only
    // recovery was someone physically walking over and holding the setup
    // button on the device itself. Track how long WiFi has actually been
    // down and, past a long-enough timeout to rule out just a temporary
    // outage (the router itself rebooting, a brief blip), open this
    // device's own setup hotspot automatically so it can be reconfigured
    // from any phone/laptop nearby, same as a brand-new device.
    if (wifiLostAt == 0) {
      wifiLostAt = millis();
      queueDeviceLog("WiFi lost");
    } else if (millis() - wifiLostAt >= WIFI_RECONNECT_TIMEOUT_MS) {
      // Bug found live (matches a reported brownout incident): this used
      // to fire unconditionally, so a WiFi router that lost power in the
      // same brownout as the server looked identical to "this device was
      // never set up" - it opened its own setup hotspot mid-outage,
      // confusing anyone who then had to walk over and manually cancel
      // it. An already-adopted device just keeps retrying indefinitely
      // instead - setup mode stays reachable via the physical button, and
      // via a real server-confirmed unbind (registerVendo() above), never
      // automatically from a connectivity gap alone.
      if (config.is_adopted) {
        static unsigned long lastAdoptedRetryLog = 0;
        if (lastAdoptedRetryLog == 0 || millis() - lastAdoptedRetryLog >= WIFI_RECONNECT_TIMEOUT_MS) {
          Serial.println("WiFi still unreachable, but this device is already adopted - retrying instead of opening setup mode");
          queueDeviceLog("WiFi still down after adoption - skipped auto setup mode, kept retrying");
          lastAdoptedRetryLog = millis();
        }
        // Real brownout report: retrying WiFi.begin() in software alone
        // never recovered, only a physical unplug/replug did - the radio
        // came out of the outage in a bad state plain retries can't clear.
        // This self-heals with a real reboot instead of waiting on someone
        // to physically visit the machine.
        if (millis() - wifiLostAt >= WIFI_DISCONNECTED_REBOOT_MS) {
          Serial.println("WiFi has been fully disconnected for " + String(WIFI_DISCONNECTED_REBOOT_MS / 60000) + " min - self-healing with a reboot");
          queueDeviceLog("Self-heal reboot: WiFi disconnected too long");
          delay(200);
          ESP.restart();
        }
      } else {
        Serial.println("WiFi still unreachable after " + String(WIFI_RECONNECT_TIMEOUT_MS / 60000) + " min - opening setup hotspot automatically");
        startSetupMode();
        return;
      }
    }

    Serial.println("WiFi lost, reconnecting...");
    lcdPrint(2, "WiFi lost...");
    lcdPrint(3, "Reconnecting...");
    connectWiFi();
    if (WiFi.status() == WL_CONNECTED) {
      wifiLostAt = 0;
      queueDeviceLog("WiFi regained");
      registerVendo();
      syncQueuedEvents();
      lastHeartbeat = millis();
    }
  } else {
    wifiLostAt = 0;
    // Send heartbeat every 60 seconds to stay Online in admin panel.
    // Piggybacks the queued-event sync onto the same cadence - no need
    // for a separate timer, and this only needs to run once WiFi (and
    // therefore the server) is actually reachable.
    if (millis() - lastHeartbeat >= 60000) {
      Serial.println("Sending heartbeat...");
      bool gotResponse = registerVendo();
      syncQueuedEvents();
      lastHeartbeat = millis();

      // Bug found live (real brownout report): when the AP/router lose
      // power in the SAME outage as this device (which has its own UPS
      // and never actually loses power), the ESP32's WiFi radio can come
      // out the other side holding a stale association - WiFi.status()
      // keeps reporting WL_CONNECTED (so none of the disconnect-recovery
      // logic above ever runs), but no actual traffic gets through, ever
      // - every heartbeat times out at the network level. Nothing short
      // of a full reboot cleared it in the field (confirmed: unplugging
      // the device's own UPS and reconnecting - a full power cycle - was
      // the only thing that fixed it, a soft WiFi.reconnect() would not).
      // Track how long heartbeats have been failing DESPITE a reported
      // connection, and self-heal with a real reboot rather than requiring
      // someone to physically visit the machine - the whole point of this
      // device having its own UPS is to survive a brownout unattended.
      if (!gotResponse) {
        if (heartbeatStuckSince == 0) heartbeatStuckSince = millis();
        if (millis() - heartbeatStuckSince >= HEARTBEAT_STUCK_REBOOT_MS) {
          Serial.println("Heartbeat has failed for " + String(HEARTBEAT_STUCK_REBOOT_MS / 60000) + " min despite WiFi reporting connected - self-healing with a reboot");
          queueDeviceLog("Self-heal reboot: heartbeat stuck failing despite WiFi reporting connected");
          delay(200);
          ESP.restart();
        }
      } else {
        heartbeatStuckSince = 0;
      }
    }
  }
}