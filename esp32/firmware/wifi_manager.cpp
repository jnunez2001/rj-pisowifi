#include "config.h"
#include <WiFi.h>
#include <HTTPClient.h>

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
               String(config.server_port) + "/api/vendo/register";

  HTTPClient http;
  http.begin(url);
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
    Serial.println("WiFi lost — reconnecting...");
    lcdPrint(2, "WiFi lost...");
    lcdPrint(3, "Reconnecting...");
    connectWiFi();
    if (WiFi.status() == WL_CONNECTED) {
      registerVendo();
    }
  }
}