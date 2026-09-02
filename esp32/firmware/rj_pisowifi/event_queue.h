#ifndef EVENT_QUEUE_H
#define EVENT_QUEUE_H

#include <Arduino.h>

// Persisted (SPIFFS) local record of things this device saw but couldn't
// tell the server about at the time - a coin the acceptor physically
// counted while the network/server was unreachable, or a lifecycle event
// worth having on hand when debugging a field report ("the coinbox showed
// setup mode after a brownout" - this is what lets us later see the
// device's own account of what happened, not just the server's).
//
// Deliberately NOT the same as postCoin()'s own 3-attempt retry (coin.cpp)
// - that already covers a brief hiccup. This is the backstop for a
// SUSTAINED outage: once postCoin() gives up, the coin is not gone, it's
// queued here and re-sent the next time WiFi is confirmed up (see
// wifi_manager.cpp's checkWiFiReconnect(), piggybacked on the existing
// 60s heartbeat cadence). A queued coin can no longer be matched to the
// customer who inserted it in real time (their Insert Coin window on the
// server has long since expired) - the server credits it to this device's
// own mac and flags it for operator review, same fail-safe path as any
// other unmatched coin, never silently dropped.
void queueCoinEvent(int coinValue);

// A short local log line for device lifecycle events (WiFi lost/regained,
// setup mode skipped because already adopted, a coin queued, etc.) -
// capped in size so a device that's offline for a long time doesn't fill
// its flash. Synced to the server the same way as queued coins.
void queueDeviceLog(const String& message);

// Called periodically while WiFi is confirmed connected. Sends any queued
// coin events and log lines to the server, and only clears each local
// queue file once the server confirms it received that batch.
void syncQueuedEvents();

#endif
