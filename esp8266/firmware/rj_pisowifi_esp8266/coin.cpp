#include "config.h"
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>

// ESP8266 is single-core, so it doesn't have ESP32's per-mutex critical
// section API (portMUX_TYPE/portENTER_CRITICAL_ISR) - the standard
// ESP8266 equivalent for "briefly make this shared-variable access atomic
// against the ISR" is the plain global noInterrupts()/interrupts() pair.

// Fires on both edges now (attachInterrupt(..., CHANGE) in the .ino),
// not just FALLING. A falling edge only marks the start of a candidate
// pulse, nothing is counted yet - counting happens on the matching
// rising edge, and only if the measured low-time actually looks like a
// real coin pulse (see COIN_PULSE_MIN_MS/MAX_MS above), not just any dip
// on the line.
void IRAM_ATTR onCoinPulse() {
  if (!coinSlotActive) return;

  unsigned long now = millis();
  // Rejects the relay's own SET-pin switching transient, which lands at a
  // fixed offset from arm-time regardless of how recently a real pulse
  // happened - the lastPulseTime check below can't catch it since
  // lastPulseTime is usually stale (last coin/session, seconds or minutes
  // ago) at the exact moment the relay arms.
  if (now - relayArmedAt < COIN_ARM_GUARD_MS) return;

  bool pinLow = (digitalRead(COIN_PIN) == LOW);

  if (pinLow) {
    // Falling edge: candidate pulse starting. Overwrites any previous
    // in-progress candidate rather than accumulating state, a pulse that
    // never returned HIGH (or returned HIGH so fast it was two rapid
    // edges the ISR only caught the second of) isn't a real coin either
    // way, and this keeps the state machine self-correcting instead of
    // ever getting stuck "waiting" on a rising edge that isn't coming.
    pulseStartTime = now;
    pulseInProgress = true;
    return;
  }

  // Rising edge with no matching start recorded (e.g. the very first
  // interrupt this window happened to be a rise, or coinSlotActive only
  // just turned on mid-pulse) - nothing to measure, ignore it.
  if (!pulseInProgress) return;
  pulseInProgress = false;

  unsigned long width = now - pulseStartTime;
  if (width < COIN_PULSE_MIN_MS || width > COIN_PULSE_MAX_MS) return;
  if (now - lastPulseTime < COIN_DEBOUNCE_MS) return;

  noInterrupts();
  coinPulseCount++;
  lastPulseTime = now;
  interrupts();
}

// Bug: a coin has already physically dropped and been counted by the time
// this runs, if the POST fails for a network reason (timeout, WiFi
// hiccup, server briefly restarting), the customer's money was taken and
// nothing was ever credited, with no way to recover short of complaining
// to staff. Retries only on a clear network-level failure (HTTPClient
// returns a negative code for those, connection refused, timeout, DNS
// failure), never on a real response from the server (a positive HTTP
// status, even a rejection like 400/429), since retrying an ambiguous
// case where the server's reply was merely lost in transit risks
// double-crediting instead.
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
    WiFiClient client;
    HTTPClient http;
    http.begin(client, url);
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
      noInterrupts();
      total = coinPulseCount;
      coinPulseCount = 0;
      interrupts();
      processingCoin = false;
      Serial.println("Coin pulses: " + String(total));
      postCoin(total);
    }
  }
}
