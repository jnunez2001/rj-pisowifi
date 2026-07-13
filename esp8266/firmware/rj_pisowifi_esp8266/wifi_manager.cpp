#include "config.h"
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>

unsigned long lastHeartbeat = 0;

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
  payload += "\"version\":\"" + String(FIRMWARE_VERSION) + "\"";
  payload += "}";

  int code = http.POST(payload);
  Serial.println("Register response: " + String(code));
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
