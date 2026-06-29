#include "config.h"

void activateRelay() {
  digitalWrite(RELAY_PIN, HIGH);
  relayActive = true;
  relayActivatedAt = millis();
  Serial.println("Relay ON");
  lcdPrint(2, "Insert coin now ");
  lcdPrint(3, "                ");
}

void deactivateRelay() {
  digitalWrite(RELAY_PIN, LOW);
  relayActive = false;
  Serial.println("Relay OFF");
  lcdPrint(2, "                ");
  lcdPrint(3, "                ");
}

void checkRelayTimeout() {
  if (relayActive && millis() - relayActivatedAt >= RELAY_TIMEOUT_MS) {
    Serial.println("Relay timeout — deactivating");
    deactivateRelay();
  }
}