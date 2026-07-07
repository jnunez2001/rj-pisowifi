#include "config.h"
#include <WiFi.h>
#include <HTTPClient.h>

portMUX_TYPE coinMux = portMUX_INITIALIZER_UNLOCKED;

void IRAM_ATTR onCoinPulse() {
  if (!coinSlotActive) return;

  portENTER_CRITICAL_ISR(&coinMux);
  coinPulseCount++;
  lastPulseTime = millis();
  portEXIT_CRITICAL_ISR(&coinMux);
}

// Bug: a coin has already physically dropped and been counted by the time
// this runs — if the POST fails for a network reason (timeout, WiFi
// hiccup, server briefly restarting), the customer's money was taken and
// nothing was ever credited, with no way to recover short of complaining
// to staff. Retries only on a clear network-level failure (HTTPClient
// returns a negative code for those — connection refused, timeout, DNS
// failure), never on a real response from the server (a positive HTTP
// status, even a rejection like 400/429), since retrying an ambiguous
// case where the server's reply was merely lost in transit risks
// double-crediting instead. Not a full fix (that needs an idempotency key
// the server dedupes against) but turns "any hiccup loses the payment"
// into "only a sustained outage does."
void postCoin(int coinValue) {
  if (config.server_ip.isEmpty()) return;

  String url = "http://" + config.server_ip + ":" +
               String(config.server_port) + "/api/coin";

  Serial.println("Posting coin: P" + String(coinValue));
  lcdPrint(2, "Coin: P" + String(coinValue));

  String payload = "{";
  payload += "\"mac\":\"" + WiFi.macAddress() + "\",";
  payload += "\"coin_value\":" + String(coinValue) + ",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\"";
  payload += "}";

  const int maxAttempts = 3;
  int code = 0;

  for (int attempt = 1; attempt <= maxAttempts; attempt++) {
    HTTPClient http;
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(5000);

    code = http.POST(payload);
    http.end();

    if (code > 0) break; // got a real response from the server, stop retrying

    if (attempt < maxAttempts) {
      Serial.println("Coin POST attempt " + String(attempt) + " failed (network), retrying...");
      lcdPrint(3, "Retrying...");
      delay(1000);
    }
  }

  if (code == 200) {
    Serial.println("Coin accepted!");
    lcdPrint(3, "Accepted!");
    ledBlink(2, 100);
    relayActivatedAt = millis();
  } else {
    Serial.println("Coin rejected: " + String(code));
    lcdPrint(3, "Error: " + String(code));
    ledBlink(5, 50);
  }
}

void processCoinPulses() {
  if (coinPulseCount > 0) {
    if (!processingCoin) {
      processingCoin = true;
    }
    if (millis() - lastPulseTime >= COIN_WAIT_MS) {
      int total;
      portENTER_CRITICAL(&coinMux);
      total = coinPulseCount;
      coinPulseCount = 0;
      portEXIT_CRITICAL(&coinMux);
      processingCoin = false;
      Serial.println("Coin pulses: " + String(total));
      postCoin(total);
    }
  }
}
