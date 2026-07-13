#include "config.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>

// Lets the admin panel push a firmware update to this device without a USB
// cable - the same idea as the main app's own "System Update" button, just
// for the ESP32 side. This device already tells the server its current
// FIRMWARE_VERSION on every register/heartbeat call (wifi_manager.cpp's
// registerVendo()); this is the other half, checking whether the server
// has something newer and pulling it down if so.
void checkForFirmwareUpdate() {
  if (config.server_ip.isEmpty() || WiFi.status() != WL_CONNECTED) return;

  HTTPClient versionCheck;
  String versionUrl = "http://" + config.server_ip + ":" +
                       String(config.server_port) + "/api/admin/vendo/firmware/version";
  versionCheck.begin(versionUrl);
  versionCheck.setTimeout(5000);
  int code = versionCheck.GET();
  if (code != 200) {
    versionCheck.end();
    return;
  }
  String body = versionCheck.getString();
  versionCheck.end();

  // Tiny hand-rolled extraction instead of pulling in a JSON library for
  // one field - body is always exactly {"version":"..."} from the server
  // route this calls.
  int start = body.indexOf(':') + 2; // skip past ":\""
  int end = body.indexOf('"', start);
  if (start < 2 || end < 0) return;
  String serverVersion = body.substring(start, end);

  if (serverVersion.isEmpty() || serverVersion == String(FIRMWARE_VERSION)) {
    return; // already current, or server has nothing configured yet
  }

  Serial.println("New firmware available: " + serverVersion + " (current: " + String(FIRMWARE_VERSION) + ")");
  lcdPrint(0, config.vendo_name);
  lcdPrint(1, "Updating firmware...");
  lcdPrint(2, serverVersion);
  lcdPrint(3, "Do not power off");

  HTTPClient downloadHttp;
  String downloadUrl = "http://" + config.server_ip + ":" +
                        String(config.server_port) + "/api/admin/vendo/firmware/download";
  downloadHttp.begin(downloadUrl);
  downloadHttp.setTimeout(30000);
  int downloadCode = downloadHttp.GET();

  if (downloadCode != 200) {
    Serial.println("Firmware download failed: " + String(downloadCode));
    lcdPrint(1, "Update failed");
    downloadHttp.end();
    ledBlink(5, 50);
    return;
  }

  int contentLength = downloadHttp.getSize();
  if (contentLength <= 0) {
    Serial.println("Firmware download had no content length");
    downloadHttp.end();
    return;
  }

  if (!Update.begin(contentLength)) {
    Serial.println("Not enough space for OTA update");
    lcdPrint(1, "Update failed");
    downloadHttp.end();
    ledBlink(5, 50);
    return;
  }

  WiFiClient* stream = downloadHttp.getStreamPtr();
  size_t written = Update.writeStream(*stream);
  downloadHttp.end();

  if (written != (size_t)contentLength) {
    Serial.println("OTA write incomplete: " + String(written) + "/" + String(contentLength));
    lcdPrint(1, "Update failed");
    ledBlink(5, 50);
    return;
  }

  if (!Update.end(true)) {
    Serial.println("OTA update failed: " + String(Update.getError()));
    lcdPrint(1, "Update failed");
    ledBlink(5, 50);
    return;
  }

  Serial.println("OTA update successful, rebooting...");
  lcdPrint(1, "Update complete!");
  lcdPrint(2, "Rebooting...");
  ledBlink(3, 100);
  delay(1000);
  ESP.restart();
}
