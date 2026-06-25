#include "config.h"

void lcdInit() {
  Wire.begin();
  lcd.init();
  lcd.backlight();
  lcdAvailable = true;
  Serial.println("LCD initialized.");
}

void lcdPrint(int row, String text) {
  if (!lcdAvailable) return;
  lcd.setCursor(0, row);
  while (text.length() < LCD_COLS) text += " ";
  lcd.print(text.substring(0, LCD_COLS));
}

void lcdClear() {
  if (!lcdAvailable) return;
  lcd.clear();
}

void ledBlink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(ms);
    digitalWrite(LED_PIN, LOW);
    delay(ms);
  }
}