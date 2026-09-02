#include "config.h"

bool activateRelay() {
  // Refuses to open the coin gate once repeated postCoin() failures
  // (coin.cpp) show something is wrong, either the acceptor's link to the
  // server or the acceptor itself. Better to have the portal tell the
  // customer to try again / report the issue than to take their money
  // into a pipeline that's already demonstrated it won't credit it.
  if (!coinHealthOk) {
    Serial.println("Relay activation blocked: coin health check failed");
    return false;
  }
  digitalWrite(RELAY_PIN, RELAY_ON_STATE);
  relayActive = true;
  relayActivatedAt = millis();
  coinSlotActive = true;
  Serial.println("Relay ON");
  lcdPrint(2, "Insert coin now");
  lcdPrint(3, "");
  return true;
}

void deactivateRelay() {
  digitalWrite(RELAY_PIN, RELAY_OFF_STATE);
  relayActive = false;
  coinSlotActive = false;
  Serial.println("Relay OFF");
  lcdPrint(2, "");
  lcdPrint(3, "");
}

void checkRelayTimeout() {
  if (relayActive && millis() - relayActivatedAt >= RELAY_TIMEOUT_MS) {
    Serial.println("Relay timeout, deactivating");
    deactivateRelay();
  }
}
