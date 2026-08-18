#include "config.h"
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiUdp.h>

unsigned long lastHeartbeat = 0;

// Zero-config discovery (server/services/vendoDiscoveryService.js) - lets
// this device find the ZenFi server's address on its own instead of
// someone typing it into the setup page by hand. Can only run once this
// device has actually joined the target WiFi (setup mode's own isolated
// AP has no path to the real server), so this is called from setup() right
// after connectWiFi() succeeds, before the first registerVendo() - not from
// the setup page itself. Broadcasts the server's documented discovery
// request on the LAN and waits briefly for its unicast JSON reply
// ({"address":"...","port":NNNN,...}); a plain substring extraction is
// used instead of a JSON library, same "one known fixed shape, not worth
// the dependency" reasoning as ota.cpp's version-string parsing.
bool discoverServer() {
  WiFiUDP udp;
  if (!udp.begin(6971)) {
    Serial.println("UDP discovery: failed to bind local port");
    return false;
  }

  // Simple /24 broadcast assumption - same "good enough for the common
  // case" convention this codebase already uses elsewhere (e.g.
  // networkDiscoveryService.js's own primary-LAN-address heuristic) rather
  // than computing a real subnet broadcast from an arbitrary mask.
  IPAddress broadcastIp = WiFi.localIP();
  broadcastIp[3] = 255;

  udp.beginPacket(broadcastIp, 6970);
  udp.write((const uint8_t*)"ZENFI_DISCOVER_V1", 17);
  udp.endPacket();
  Serial.println("UDP discovery: broadcast sent to " + broadcastIp.toString() + ":6970, waiting for reply...");

  const unsigned long DISCOVERY_TIMEOUT_MS = 3000;
  unsigned long start = millis();
  while (millis() - start < DISCOVERY_TIMEOUT_MS) {
    int packetSize = udp.parsePacket();
    if (packetSize > 0) {
      char buf[256];
      int len = udp.read(buf, sizeof(buf) - 1);
      if (len <= 0) { udp.stop(); return false; }
      buf[len] = '\0';
      String body(buf);

      String foundIp;
      int foundPort = 0;

      int addrKey = body.indexOf("\"address\"");
      if (addrKey >= 0) {
        int addrStart = body.indexOf('"', body.indexOf(':', addrKey) + 1) + 1;
        int addrEnd = body.indexOf('"', addrStart);
        if (addrStart > 0 && addrEnd > addrStart) {
          foundIp = body.substring(addrStart, addrEnd);
        }
      }
      int portKey = body.indexOf("\"port\"");
      if (portKey >= 0) {
        int portStart = body.indexOf(':', portKey) + 1;
        int portEnd = body.indexOf(',', portStart);
        if (portEnd < 0) portEnd = body.indexOf('}', portStart);
        if (portStart > 0 && portEnd > portStart) {
          foundPort = body.substring(portStart, portEnd).toInt();
        }
      }

      udp.stop();
      if (foundIp.isEmpty() || foundPort <= 0) return false;
      config.server_ip = foundIp;
      config.server_port = foundPort;
      Serial.println("UDP discovery: found server at " + config.server_ip + ":" + String(config.server_port));
      return true;
    }
    delay(50);
  }

  udp.stop();
  Serial.println("UDP discovery: no reply, timed out");
  return false;
}

bool connectWiFi() {
  if (config.wifi_ssid.isEmpty()) return false;

  // Bug found live: WiFi.config() was called before WiFi.mode(WIFI_STA) -
  // on ESP8266, setting a static IP before the WiFi subsystem is actually
  // in station mode gets silently ignored, not deferred. This meant the
  // static IP never actually applied on ANY boot, not just after a
  // brownout - the device always came up on whatever DHCP handed it,
  // masked during initial testing because the freshly-set IP happened to
  // still be reachable from whatever DHCP gave it that one time. Order
  // matters: mode must be set first, config() right after and before
  // begin(), same sequence the ESP8266 Arduino core's own examples use.
  WiFi.mode(WIFI_STA);

  if (config.static_ip && !config.device_ip.isEmpty()) {
    IPAddress ip, gw, sn;
    ip.fromString(config.device_ip);
    gw.fromString(config.gateway);
    sn.fromString(config.subnet);
    WiFi.config(ip, gw, sn);
  }

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
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nConnected! IP: " + WiFi.localIP().toString());
    lcdPrint(0, config.vendo_name);
    lcdPrint(1, "Connected!");
    lcdPrint(2, WiFi.localIP().toString());
    lcdPrint(3, "Server: " + config.server_ip);
    return true;
  }

  Serial.println("\nWiFi failed.");
  lcdPrint(0, config.vendo_name);
  lcdPrint(1, "WiFi Failed!");
  lcdPrint(2, "Hold BTN 5s");
  lcdPrint(3, "for Setup Mode");
  return false;
}

void registerVendo() {
  if (config.server_ip.isEmpty()) return;

  String url = "http://" + config.server_ip + ":" +
               String(config.server_port) + "/api/admin/vendo/register";

  WiFiClient client;
  HTTPClient http;
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);

  String payload = "{";
  payload += "\"mac\":\"" + WiFi.macAddress() + "\",";
  payload += "\"name\":\"" + config.vendo_name + "\",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"version\":\"" + String(FIRMWARE_VERSION) + "\",";
  payload += "\"device_secret\":\"" + config.device_secret + "\"";
  payload += "}";

  int code = http.POST(payload);
  Serial.println("Register response: " + String(code));

  // First-ever register (or a legacy device that never had one) gets a
  // secret back to remember for every future call - same hand-rolled
  // extraction ota.cpp already uses for its own one-field response, not
  // worth a JSON library for this. A device already carrying a secret
  // that doesn't match what the server has on file gets 403'd here with
  // nothing to extract, and correctly keeps failing registration rather
  // than silently adopting a value from whoever answered.
  if (code == 200) {
    String body = http.getString();
    int key = body.indexOf("\"device_secret\"");
    if (key >= 0) {
      int start = body.indexOf('"', body.indexOf(':', key) + 1) + 1;
      int end = body.indexOf('"', start);
      if (start > 0 && end > start) {
        String issued = body.substring(start, end);
        if (issued.length() && issued != config.device_secret) {
          config.device_secret = issued;
          saveConfig();
        }
      }
    }
  }

  http.end();
}

void checkWiFiReconnect() {
  if (WiFi.status() != WL_CONNECTED) {
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
    } else if (millis() - wifiLostAt >= WIFI_RECONNECT_TIMEOUT_MS) {
      Serial.println("WiFi still unreachable after " + String(WIFI_RECONNECT_TIMEOUT_MS / 60000) + " min - opening setup hotspot automatically");
      startSetupMode();
      return;
    }

    Serial.println("WiFi lost — reconnecting...");
    lcdPrint(2, "WiFi lost...");
    lcdPrint(3, "Reconnecting...");
    connectWiFi();
    if (WiFi.status() == WL_CONNECTED) {
      wifiLostAt = 0;
      registerVendo();
      lastHeartbeat = millis();
    }
  } else {
    wifiLostAt = 0;
    // Send heartbeat every 60 seconds to stay Online in admin panel
    if (millis() - lastHeartbeat >= 60000) {
      Serial.println("Sending heartbeat...");
      registerVendo();
      lastHeartbeat = millis();
    }
  }
}
