#include "config.h"
#include <WiFi.h>
#include <HTTPClient.h>

void IRAM_ATTR onCoinPulse() {
  coinPulseCount++;
  lastPulseTime = millis();
}

void postCoin(int coinValue) {
  if (config.server_ip.isEmpty()) return;

  String url = "http://" + config.server_ip + ":" +
               String(config.server_port) + "/api/coin";

  Serial.println("Posting coin: P" + String(coinValue));
  lcdPrint(2, "Coin: P" + String(coinValue) + "        ");

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);

  String payload = "{";
  payload += "\"mac\":\"" + WiFi.macAddress() + "\",";
  payload += "\"coin_value\":" + String(coinValue) + ",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\"";
  payload += "}";

  int code = http.POST(payload);

  if (code == 200) {
    Serial.println("Coin accepted!");
    lcdPrint(3, "Accepted!       ");
    ledBlink(2, 100);
    relayActivatedAt = millis();
  } else {
    Serial.println("Coin rejected: " + String(code));
    lcdPrint(3, "Error: " + String(code) + "      ");
    ledBlink(5, 50);
  }

  http.end();
}

void processCoinPulses() {
  if (coinPulseCount > 0) {
    if (!processingCoin) {
      processingCoin = true;
    }
    if (millis() - lastPulseTime >= COIN_WAIT_MS) {
      int total = coinPulseCount;
      coinPulseCount = 0;
      processingCoin = false;
      Serial.println("Coin pulses: " + String(total));
      postCoin(total);
    }
  }
}