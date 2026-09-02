#ifndef EVENT_QUEUE_H
#define EVENT_QUEUE_H

#include <Arduino.h>

// Persisted (LittleFS) local record of things this device saw but
// couldn't tell the server about at the time - a coin the acceptor
// physically counted while the network/server was unreachable, or a
// lifecycle event worth having on hand when debugging a field report.
// See the ESP32 sibling firmware's event_queue.h for the full rationale -
// identical design here, just LittleFS instead of SPIFFS.
void queueCoinEvent(int coinValue);
void queueDeviceLog(const String& message);
void syncQueuedEvents();

#endif
