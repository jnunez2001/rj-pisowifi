#include "config.h"

// LCD removed — no hardware connected
// Using Serial output only for debugging

void lcdPrint(int row, String text) {
  Serial.println("[LCD Row " + String(row) + "] " + text);
}

void lcdClear() {
  Serial.println("[LCD] Clear");
}

void ledBlink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(ms);
    digitalWrite(LED_PIN, LOW);
    delay(ms);
  }
}
