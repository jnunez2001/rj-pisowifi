#include "config.h"
#include "event_queue.h"
#include <SPIFFS.h>
#include <WiFi.h>
#include <HTTPClient.h>

static const char* COIN_QUEUE_PATH = "/coin_queue.txt";
static const char* DEVICE_LOG_PATH = "/device_log.txt";

// Soft caps so a device stuck offline for days doesn't fill its flash.
// Past this many bytes, new events stop being queued (best-effort - an
// operator seeing a long-running outage has bigger problems than losing
// the newest few coins in an already-abnormal situation) rather than the
// device running out of SPIFFS space and failing in some other way.
static const size_t MAX_QUEUE_FILE_BYTES = 32768;

static void appendLine(const char* path, const String& line) {
  File existing = SPIFFS.open(path, FILE_READ);
  size_t currentSize = existing ? existing.size() : 0;
  if (existing) existing.close();
  if (currentSize >= MAX_QUEUE_FILE_BYTES) {
    Serial.println("Queue file full, dropping event: " + String(path));
    return;
  }
  File f = SPIFFS.open(path, FILE_APPEND);
  if (!f) {
    Serial.println("Failed to open for append: " + String(path));
    return;
  }
  f.println(line);
  f.close();
}

void queueCoinEvent(int coinValue) {
  appendLine(COIN_QUEUE_PATH, String(coinValue));
  Serial.println("Coin queued locally (server unreachable): P" + String(coinValue));
}

void queueDeviceLog(const String& message) {
  appendLine(DEVICE_LOG_PATH, String(millis()) + "|" + message);
}

// Reads every line of `path` and POSTs them as a JSON array to `endpoint`
// under `arrayField`, using `lineToJson` to turn each raw line into one
// JSON object. On a confirmed server success, clears the file so nothing
// is sent twice; on any failure (network or otherwise) the file is left
// untouched and this same batch is retried on the next sync pass.
static void syncFile(const char* path, const char* endpoint, const char* arrayField,
                      String (*lineToJson)(const String&)) {
  if (!SPIFFS.exists(path)) return;

  File f = SPIFFS.open(path, FILE_READ);
  if (!f || f.size() == 0) {
    if (f) f.close();
    return;
  }

  String items = "";
  int count = 0;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;
    if (count > 0) items += ",";
    items += lineToJson(line);
    count++;
  }
  f.close();

  if (count == 0) {
    SPIFFS.remove(path);
    return;
  }

  String url = "http://" + config.server_ip + ":" + String(config.server_port) + endpoint;
  String payload = "{\"mac\":\"" + WiFi.macAddress() + "\",";
  payload += "\"device_secret\":\"" + config.device_secret + "\",";
  payload += "\"" + String(arrayField) + "\":[" + items + "]}";

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(8000);
  int code = http.POST(payload);
  String body = (code > 0) ? http.getString() : "";
  http.end();

  if (code == 200 && body.indexOf("\"success\":true") != -1) {
    Serial.println("Synced " + String(count) + " queued event(s) from " + String(path));
    SPIFFS.remove(path);
  } else {
    Serial.println("Queue sync to " + String(endpoint) + " failed (code " + String(code) + "), will retry later");
  }
}

static String coinLineToJson(const String& line) {
  return "{\"value\":" + line + "}";
}

static String logLineToJson(const String& line) {
  int sep = line.indexOf('|');
  String at = (sep == -1) ? "0" : line.substring(0, sep);
  String message = (sep == -1) ? line : line.substring(sep + 1);
  message.replace("\\", "\\\\");
  message.replace("\"", "\\\"");
  return "{\"at\":" + at + ",\"message\":\"" + message + "\"}";
}

void syncQueuedEvents() {
  if (config.server_ip.isEmpty() || WiFi.status() != WL_CONNECTED) return;
  syncFile(COIN_QUEUE_PATH, "/api/admin/vendo/coin-queue-sync", "events", coinLineToJson);
  syncFile(DEVICE_LOG_PATH, "/api/admin/vendo/device-log-sync", "events", logLineToJson);
}
