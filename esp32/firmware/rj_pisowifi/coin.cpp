#include "config.h"
#include <WiFi.h>
#include <HTTPClient.h>

portMUX_TYPE coinMux = portMUX_INITIALIZER_UNLOCKED;

// Reverted 2026-07-17, same day: briefly counted every pulse regardless of
// coinSlotActive (see git history) to stop legitimately-mistimed coins from
// being silently discarded while the coin gate relay is stuck physically
// open (a wiring/relay-module fault - see config.h's own history on this).
// In practice this let anyone generate credit at will once they noticed the
// gate ignores whether Insert Coin was ever pressed - real fraud, not just
// an edge case, and worse than the problem it was meant to solve. Back to
// only counting pulses during a legitimate Insert Coin window
// (coinSlotActive, set by activateRelay()). The underlying stuck-open gate
// still needs a physical fix - until then, coins dropped outside a real
// Insert Coin window are ignored again (as they should be), and the coin
// slot should stay physically disconnected if it can't be trusted to stay
// closed on its own.
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
