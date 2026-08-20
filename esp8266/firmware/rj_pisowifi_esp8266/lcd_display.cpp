#include "config.h"

// LCD removed, no hardware connected
// Using Serial output only for debugging

void lcdPrint(int row, String text) {
  Serial.println("[LCD Row " + String(row) + "] " + text);
}

void lcdClear() {
  Serial.println("[LCD] Clear");
}

// Status LED removed, no hardware connected on this custom board.
// LED_PIN (GPIO2) stays reserved in config.h for a future revision, but
// nothing in this firmware drives it anymore, so this is a no-op kept
// only so every existing ledBlink() call site doesn't need touching.
void ledBlink(int times, int ms) {
}
