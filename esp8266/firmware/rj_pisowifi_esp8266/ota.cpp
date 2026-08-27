#include "config.h"
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <Updater.h>

// Bug found live: the old check only asked "is the server's version
// DIFFERENT from mine", not "is it NEWER". A device manually reflashed to
// a newer build (USB/Web Serial, bypassing OTA entirely) would boot, check
// in, see the server still advertising whatever older version was last
// pushed there, treat "different" as "update available", and silently
// re-flash itself back down to that older build within seconds of boot -
// undoing the manual flash every single time, with no error, no warning,
// looking exactly like the version "wouldn't stick". Parses "vX.Y.Z" into
// three ints and only proceeds when the server's version actually outranks
// this device's own - a same-or-older version now correctly does nothing.
// Malformed input degrades to 0.0.0 (never triggers an update), never to
// garbage - a version check that quietly fails is much safer than one
// that quietly flashes the wrong thing.
struct FwVersion { int major, minor, patch; };

FwVersion parseFwVersion(const String &raw) {
  String s = raw;
  if (s.startsWith("v") || s.startsWith("V")) s = s.substring(1);
  FwVersion v = {0, 0, 0};
  int firstDot = s.indexOf('.');
  if (firstDot < 0) { v.major = s.toInt(); return v; }
  int secondDot = s.indexOf('.', firstDot + 1);
  v.major = s.substring(0, firstDot).toInt();
  if (secondDot < 0) { v.minor = s.substring(firstDot + 1).toInt(); return v; }
  v.minor = s.substring(firstDot + 1, secondDot).toInt();
  v.patch = s.substring(secondDot + 1).toInt();
  return v;
}

bool isNewerVersion(const String &serverVersion, const String &localVersion) {
  FwVersion server = parseFwVersion(serverVersion);
  FwVersion local = parseFwVersion(localVersion);
  if (server.major != local.major) return server.major > local.major;
  if (server.minor != local.minor) return server.minor > local.minor;
  return server.patch > local.patch;
}

// Lets the admin panel push a firmware update to this device without a USB
// cable - the same idea as the main app's own "System Update" button, just
// for the vendo side. This device already tells the server its current
// FIRMWARE_VERSION on every register/heartbeat call (wifi_manager.cpp's
// registerVendo()); this is the other half, checking whether the server
// has something newer and pulling it down if so.
void checkForFirmwareUpdate() {
  if (config.server_ip.isEmpty() || WiFi.status() != WL_CONNECTED) return;

  WiFiClient versionClient;
  HTTPClient versionCheck;
  String versionUrl = "http://" + config.server_ip + ":" +
                       String(config.server_port) + "/api/admin/vendo/firmware/version";
  versionCheck.begin(versionClient, versionUrl);
  // Was 5000ms - this is a blocking call inside the main loop() with no
  // yield, so the full timeout duration freezes coin processing, the web
  // server, and setup-button detection on a slow/unreachable server. A
  // real version check response is tiny and fast on a healthy LAN;
  // shortening this reduces worst-case freeze time without meaningfully
  // risking a false "no update" read on a server that's merely a little
  // slow (see also the btnHeld skip added in the main loop for this same
  // reason).
  versionCheck.setTimeout(2000);
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

  if (serverVersion.isEmpty() || !isNewerVersion(serverVersion, String(FIRMWARE_VERSION))) {
    return; // already current, server has nothing configured yet, or server's version is not newer (stale/older push, or a manual reflash already ahead of it)
  }

  Serial.println("New firmware available: " + serverVersion + " (current: " + String(FIRMWARE_VERSION) + ")");
  lcdPrint(0, config.vendo_name);
  lcdPrint(1, "Updating firmware...");
  lcdPrint(2, serverVersion);
  lcdPrint(3, "Do not power off");

  WiFiClient downloadClient;
  HTTPClient downloadHttp;
  String downloadUrl = "http://" + config.server_ip + ":" +
                        String(config.server_port) + "/api/admin/vendo/firmware/download";
  downloadHttp.begin(downloadClient, downloadUrl);
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
