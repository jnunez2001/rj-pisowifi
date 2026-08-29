#include "config.h"
#include "audio.h"
#include <ESP8266WiFi.h>
#include <LittleFS.h>

// Bug (serious): setupWebServer() registers every route unconditionally,
// and is called both in setup mode (own isolated AP, admin-only) AND in
// normal mode after the device has joined the live customer WiFi network.
// That meant /save, /reset, /reboot, /scan, /, and /config were reachable,
// completely unauthenticated, by ANY paying customer on that same network
// for as long as the vendo has been running, any of them could factory-
// reset the vendo, overwrite its WiFi/server config (bricking it until
// someone walks over and holds the setup button), or just repeatedly
// reboot it, taking the entire coin-payment mechanism down. /config also
// returned the WiFi password in plaintext to anyone who asked.
// These endpoints are provisioning-only, nothing on the normal-mode
// customer network legitimately needs them, so they're rejected once the
// device has left setup mode.
bool rejectUnlessSetupMode() {
  if (setupMode) return true;
  server.send(403, "application/json", "{\"success\":false,\"message\":\"Not available outside setup mode\"}");
  return false;
}

// Bug: /relay/on and /relay/off had no restriction at all, any device on
// the customer WiFi could toggle the coin acceptor relay directly (deny
// paying customers their coin window, or interfere with the mechanism).
// The backend server is the only legitimate caller (it proxies the
// portal's "Insert Coin" button here) and its IP is already known,
// config.server_ip, so only requests from that IP are allowed.
bool rejectUnlessFromServer() {
  if (config.server_ip.isEmpty() || server.client().remoteIP().toString() == config.server_ip) return true;
  server.send(403, "application/json", "{\"success\":false,\"message\":\"Forbidden\"}");
  return false;
}

void setupWebServer() {

  // Serve setup page
  server.on("/", HTTP_GET, []() {
    if (!rejectUnlessSetupMode()) return;
    if (LittleFS.exists("/index.html")) {
      File f = LittleFS.open("/index.html", "r");
      server.streamFile(f, "text/html");
      f.close();
    } else {
      server.send(200, "text/html", getFallbackHTML());
    }
  });

  // OS captive-portal auto-detection - Android/iOS/Windows each ping one
  // of these the moment they join a WiFi network, specifically to decide
  // whether to pop their own "Sign in to network" prompt. Combined with
  // the DNS hijack in startSetupMode() (every hostname on this AP
  // resolves to this device), any of these requests reaching this device
  // at all is itself the signal something's gating the connection - so
  // every one just serves the setup page directly, same server-side
  // pattern already used for the main portal (server/app.js). Only
  // registered/reachable in setup mode, like every other route here.
  auto serveSetupPage = []() {
    if (!rejectUnlessSetupMode()) return;
    if (LittleFS.exists("/index.html")) {
      File f = LittleFS.open("/index.html", "r");
      server.streamFile(f, "text/html");
      f.close();
    } else {
      server.send(200, "text/html", getFallbackHTML());
    }
  };
  server.on("/generate_204", HTTP_GET, serveSetupPage);       // Android
  server.on("/gen_204", HTTP_GET, serveSetupPage);            // Android (older)
  server.on("/hotspot-detect.html", HTTP_GET, serveSetupPage); // iOS/macOS
  server.on("/library/test/success.html", HTTP_GET, serveSetupPage); // iOS/macOS
  server.on("/ncsi.txt", HTTP_GET, serveSetupPage);           // Windows
  server.on("/connecttest.txt", HTTP_GET, serveSetupPage);    // Windows
  server.on("/redirect", HTTP_GET, serveSetupPage);           // Some Android OEMs
  // Any other path (a random domain the DNS hijack resolved here) - serve
  // the setup page instead of ESP8266WebServer's default 404, so nothing
  // a phone happens to load first dead-ends.
  server.onNotFound(serveSetupPage);

  // GET config as JSON
  server.on("/config", HTTP_GET, []() {
    if (!rejectUnlessSetupMode()) return;
    String json = "{";
    json += "\"vendo_name\":\"" + config.vendo_name + "\",";
    json += "\"wifi_ssid\":\"" + config.wifi_ssid + "\",";
    json += "\"server_ip\":\"" + config.server_ip + "\",";
    json += "\"server_port\":" + String(config.server_port) + ",";
    json += "\"static_ip\":" + String(config.static_ip ? "true" : "false") + ",";
    json += "\"device_ip\":\"" + config.device_ip + "\",";
    json += "\"gateway\":\"" + config.gateway + "\",";
    json += "\"subnet\":\"" + config.subnet + "\",";
    json += "\"mac\":\"" + WiFi.macAddress() + "\",";
    json += "\"firmware\":\"" + String(FIRMWARE_VERSION) + "\"";
    json += "}";
    server.send(200, "application/json", json);
  });

  // GET WiFi scan
  // Bug found live: WiFi.scanNetworks() (blocking/synchronous form) could
  // hang far longer than a scan should ever take - this device is running
  // as an access point (WIFI_AP_STA) the whole time, and scanning while
  // also serving as an AP is a known-flaky combination on ESP8266's SDK.
  // A hung scan blocked EVERYTHING else in loop() too (coin pulses, relay
  // timeout, WiFi reconnect checks), not just this one request. Switched
  // to the async scan API with a hard cap: starts the scan, polls with a
  // short delay, and gives up after SCAN_TIMEOUT_MS rather than waiting
  // indefinitely - the device stays responsive either way, and the admin
  // sees a fast, clear failure to retry instead of a 30-minute hang.
  server.on("/scan", HTTP_GET, []() {
    if (!rejectUnlessSetupMode()) return;
    const unsigned long SCAN_TIMEOUT_MS = 8000;
    WiFi.scanNetworks(true);
    unsigned long start = millis();
    int n;
    while ((n = WiFi.scanComplete()) == WIFI_SCAN_RUNNING) {
      if (millis() - start >= SCAN_TIMEOUT_MS) {
        Serial.println("WiFi scan timed out");
        WiFi.scanDelete();
        server.send(200, "application/json", "[]");
        return;
      }
      delay(100);
    }
    String json = "[";
    for (int i = 0; i < n; i++) {
      if (i > 0) json += ",";
      json += "{";
      json += "\"ssid\":\"" + WiFi.SSID(i) + "\",";
      json += "\"rssi\":" + String(WiFi.RSSI(i)) + ",";
      json += "\"secure\":" + String(WiFi.encryptionType(i) != ENC_TYPE_NONE ? "true" : "false");
      json += "}";
    }
    json += "]";
    WiFi.scanDelete();
    server.send(200, "application/json", json);
  });

  // POST save config
  server.on("/save", HTTP_POST, []() {
    if (!rejectUnlessSetupMode()) return;
    if (server.hasArg("vendo_name"))  config.vendo_name  = server.arg("vendo_name");
    if (server.hasArg("wifi_ssid"))   config.wifi_ssid   = server.arg("wifi_ssid");
    if (server.hasArg("wifi_pass"))   config.wifi_pass   = server.arg("wifi_pass");
    if (server.hasArg("server_ip"))   config.server_ip   = server.arg("server_ip");
    if (server.hasArg("server_port")) config.server_port = server.arg("server_port").toInt();
    if (server.hasArg("static_ip"))   config.static_ip   = server.arg("static_ip") == "true";
    if (server.hasArg("device_ip"))   config.device_ip   = server.arg("device_ip");
    if (server.hasArg("gateway"))     config.gateway     = server.arg("gateway");
    if (server.hasArg("subnet"))      config.subnet      = server.arg("subnet");

    saveConfig();
    server.send(200, "application/json",
      "{\"success\":true,\"message\":\"Saved! Rebooting...\"}");
    delay(1000);
    ESP.restart();
  });

  // POST reboot
  server.on("/reboot", HTTP_POST, []() {
    if (!rejectUnlessSetupMode()) return;
    server.send(200, "application/json",
      "{\"success\":true,\"message\":\"Rebooting...\"}");
    delay(500);
    ESP.restart();
  });

  // POST factory reset
  server.on("/reset", HTTP_POST, []() {
    if (!rejectUnlessSetupMode()) return;
    server.send(200, "application/json",
      "{\"success\":true,\"message\":\"Reset! Rebooting...\"}");
    clearConfig();
    delay(500);
    ESP.restart();
  });

  // POST relay on
  server.on("/relay/on", HTTP_POST, []() {
    if (!rejectUnlessFromServer()) return;
    activateRelay();
    server.send(200, "application/json", "{\"success\":true}");
  });

  // POST relay off
  server.on("/relay/off", HTTP_POST, []() {
    if (!rejectUnlessFromServer()) return;
    deactivateRelay();
    server.send(200, "application/json", "{\"success\":true}");
  });

  // POST /play?sound=name - streams and plays a WAV file the server hosts
  // (public/audio/vendo/name.wav), e.g. a voice prompt when the customer
  // taps "Insert Coin" on the portal. The file is never saved to this
  // device's own flash, it's decoded and played a chunk at a time as it
  // streams in (see audio.cpp). Same server-only restriction as
  // /relay/on|off - not something a random device on the customer
  // network should be able to trigger.
  //
  // Takes a bare sound NAME, not a full URL - this device already knows
  // exactly how to reach the server (config.server_ip/server_port, the
  // same address every other call here already uses), so it builds the
  // URL itself. The alternative (server builds and sends a full URL) only
  // works when there's a live web request to derive that URL from (e.g.
  // "same host the customer's browser used") - the amount-announcement
  // trigger fires from a timer-based credit finalize with no such
  // request in scope, so that approach couldn't cover every trigger
  // point. This one can, since it never depends on where the request
  // that triggered playback came from.
  server.on("/play", HTTP_POST, []() {
    if (!rejectUnlessFromServer()) return;
    if (!server.hasArg("sound") || server.arg("sound").isEmpty()) {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing sound\"}");
      return;
    }
    String url = "http://" + config.server_ip + ":" + String(config.server_port) +
                 "/audio/vendo/" + server.arg("sound") + ".wav";
    startPlayingSound(url);
    server.send(200, "application/json", "{\"success\":true}");
  });

  // POST /coin-power/test?level=high|low - raw pin-level test, bypassing
  // RELAY_ACTIVE_LOW/activateRelay() entirely. Built for exactly this
  // situation: verifying which logic level actually powers a specific
  // board's coin-slot switching circuit, without needing to flip
  // RELAY_ACTIVE_LOW and reflash between every attempt. Same
  // server-only restriction as /relay/on|off - this directly drives
  // hardware, not something to leave reachable from the customer network.
  server.on("/coin-power/test", HTTP_POST, []() {
    if (!rejectUnlessFromServer()) return;
    if (!server.hasArg("level")) {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing ?level=high or ?level=low\"}");
      return;
    }
    String level = server.arg("level");
    level.toLowerCase();
    if (level == "high") {
      digitalWrite(RELAY_PIN, HIGH);
    } else if (level == "low") {
      digitalWrite(RELAY_PIN, LOW);
    } else {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"level must be 'high' or 'low'\"}");
      return;
    }
    Serial.println("Coin-power test: SET pin (D2/GPIO4) driven " + level);
    server.send(200, "application/json", "{\"success\":true,\"pin\":\"D2\",\"level\":\"" + level + "\"}");
  });

  // POST restart, remote restart from the admin panel while the device is
  // in normal (non-setup) operation. Distinct from /reboot above, which is
  // setup-mode-only: this needs to work while the device is live on the
  // customer network, so it's gated the same way as /relay/on|off instead
  // (server-IP-only), not rejectUnlessSetupMode().
  server.on("/restart", HTTP_POST, []() {
    if (!rejectUnlessFromServer()) return;
    server.send(200, "application/json", "{\"success\":true,\"message\":\"Restarting...\"}");
    delay(500);
    ESP.restart();
  });

  // POST rename, updates the name shown on this device's own LCD/status,
  // so a rename from the admin panel actually reaches the hardware instead
  // of only existing in the server's own vendos table. Server-only, same
  // gating as /restart - not something a customer on the same network
  // should be able to trigger.
  server.on("/rename", HTTP_POST, []() {
    if (!rejectUnlessFromServer()) return;
    if (!server.hasArg("name") || server.arg("name").isEmpty()) {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing name\"}");
      return;
    }
    config.vendo_name = server.arg("name");
    saveConfig();
    server.send(200, "application/json", "{\"success\":true}");
  });

  // POST network, switches this device between DHCP and a static IP
  // while it's live on the customer network, without needing to walk over
  // and use the setup-mode page. Always restarts afterward: WiFi.config()
  // only takes effect cleanly applied before WiFi.begin(), not hot-swapped
  // mid-connection, same reason connectWiFi() only ever calls it once at
  // boot. Server-only gated like /restart - a wrong IP here can strand the
  // device, this must never be reachable from the customer network.
  server.on("/network", HTTP_POST, []() {
    if (!rejectUnlessFromServer()) return;
    bool useStatic = server.hasArg("static_ip") && server.arg("static_ip") == "true";
    if (useStatic) {
      if (!server.hasArg("device_ip") || !server.hasArg("gateway") || !server.hasArg("subnet")) {
        server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing device_ip/gateway/subnet\"}");
        return;
      }
      config.device_ip = server.arg("device_ip");
      config.gateway    = server.arg("gateway");
      config.subnet     = server.arg("subnet");
    }
    config.static_ip = useStatic;
    saveConfig();
    server.send(200, "application/json", "{\"success\":true,\"message\":\"Applying new network settings, restarting...\"}");
    delay(500);
    ESP.restart();
  });

  // GET status
  server.on("/status", HTTP_GET, []() {
    String json = "{";
    json += "\"vendo_name\":\"" + config.vendo_name + "\",";
    json += "\"mac\":\"" + WiFi.macAddress() + "\",";
    json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
    json += "\"relay\":" + String(relayActive ? "true" : "false") + ",";
    json += "\"wifi\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false") + ",";
    json += "\"firmware\":\"" + String(FIRMWARE_VERSION) + "\",";
    // millis() overflows/wraps at ~49.7 days of continuous uptime - not
    // corrected for here since a vendo restarting (scheduled or manual)
    // long before that is the realistic case, same "good enough" tradeoff
    // this firmware already takes elsewhere (e.g. the /24 broadcast
    // assumption in discoverServer()) rather than pulling in a 64-bit
    // uptime library for an edge case this hardware won't actually hit.
    json += "\"uptime_seconds\":" + String(millis() / 1000) + ",";
    json += "\"static_ip\":" + String(config.static_ip ? "true" : "false") + ",";
    json += "\"device_ip\":\"" + config.device_ip + "\",";
    json += "\"gateway\":\"" + config.gateway + "\",";
    json += "\"subnet\":\"" + config.subnet + "\"";
    json += "}";
    server.send(200, "application/json", json);
  });
}

void startSetupMode() {
  setupMode = true;
  Serial.println("Starting Setup Mode...");

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASS);

  IPAddress apIP = WiFi.softAPIP();
  Serial.println("AP IP: " + apIP.toString());

  // Bug this fixes: without this, connecting to the setup AP just looked
  // like "connected, no internet" - nothing prompted the phone/laptop to
  // open the setup page, the operator had to already know to type
  // 192.168.4.1 manually. Real captive portal instead: hijack ALL DNS
  // lookups on this AP to resolve to this device's own IP ("*" wildcard),
  // same standard trick used by every commercial hotspot/router setup
  // flow. Combined with the OS captive-portal-detection routes below
  // (server.on("/generate_204" etc), this makes the phone/laptop's OWN
  // "Sign in to network" prompt open the setup page automatically the
  // moment it connects - nothing for the operator to type.
  dnsServer.start(53, "*", apIP);

  lcdClear();
  lcdPrint(0, "=== SETUP MODE ===");
  lcdPrint(1, "WiFi:" + String(AP_SSID));
  lcdPrint(2, "Pass:rjpisowifi");
  lcdPrint(3, "IP:" + apIP.toString());

  setupWebServer();
  server.begin();
  Serial.println("Setup server started.");

  ledBlink(10, 100);
}

String getFallbackHTML() {
  return R"rawhtml(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>R&J Vendo Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
      min-height: 100vh;
      padding: 20px 16px 40px;
    }

    .header {
      text-align: center;
      padding: 30px 0 24px;
    }

    .header-icon {
      width: 64px;
      height: 64px;
      background: rgba(255,255,255,0.2);
      backdrop-filter: blur(20px);
      border-radius: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 30px;
      margin: 0 auto 14px;
      border: 1px solid rgba(255,255,255,0.3);
    }

    .header h1 {
      font-size: 22px;
      font-weight: 700;
      color: #fff;
      letter-spacing: 0.5px;
    }

    .header p {
      font-size: 13px;
      color: rgba(255,255,255,0.7);
      margin-top: 4px;
    }

    .card {
      background: rgba(255,255,255,0.15);
      backdrop-filter: blur(30px);
      -webkit-backdrop-filter: blur(30px);
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,0.25);
      padding: 20px;
      margin-bottom: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.1);
    }

    .card-title {
      font-size: 11px;
      font-weight: 700;
      color: rgba(255,255,255,0.6);
      letter-spacing: 1.5px;
      text-transform: uppercase;
      margin-bottom: 14px;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }

    .info-row:last-child { border-bottom: none; }

    .info-label {
      font-size: 14px;
      color: rgba(255,255,255,0.7);
    }

    .info-value {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      font-variant-numeric: tabular-nums;
    }

    .field-label {
      font-size: 13px;
      font-weight: 500;
      color: rgba(255,255,255,0.8);
      margin-bottom: 8px;
      display: block;
    }

    input[type=text], input[type=password], input[type=number] {
      width: 100%;
      padding: 13px 16px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.12);
      color: #fff;
      font-size: 15px;
      font-family: inherit;
      margin-bottom: 14px;
      outline: none;
      transition: all 0.2s;
    }

    input[type=text]:focus, input[type=password]:focus, input[type=number]:focus {
      border-color: rgba(255,255,255,0.5);
      background: rgba(255,255,255,0.2);
    }

    input::placeholder { color: rgba(255,255,255,0.35); }

    select {
      width: 100%;
      padding: 13px 16px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.12);
      color: #fff;
      font-size: 15px;
      font-family: inherit;
      margin-bottom: 14px;
      outline: none;
      appearance: none;
      cursor: pointer;
    }

    select option {
      background: #4a3f7a;
      color: #fff;
    }

    .wifi-row {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }

    .wifi-row select { flex: 1; margin-bottom: 0; }

    .scan-btn {
      padding: 13px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.15);
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s;
    }

    .scan-btn:active { transform: scale(0.96); }

    .manual-toggle {
      font-size: 13px;
      color: rgba(255,255,255,0.6);
      text-decoration: underline;
      cursor: pointer;
      margin-bottom: 12px;
      display: block;
    }

    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 0;
      margin-bottom: 14px;
    }

    .toggle-label {
      font-size: 14px;
      color: rgba(255,255,255,0.8);
    }

    /* iOS-style toggle */
    .switch {
      position: relative;
      width: 50px;
      height: 28px;
    }

    .switch input { opacity: 0; width: 0; height: 0; }

    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(255,255,255,0.2);
      border-radius: 28px;
      transition: 0.3s;
      border: 1px solid rgba(255,255,255,0.2);
    }

    .slider:before {
      position: absolute;
      content: "";
      height: 22px;
      width: 22px;
      left: 3px;
      bottom: 2px;
      background: white;
      border-radius: 50%;
      transition: 0.3s;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
    }

    input:checked + .slider { background: #34c759; border-color: #34c759; }
    input:checked + .slider:before { transform: translateX(22px); }

    .btn {
      width: 100%;
      padding: 16px;
      border: none;
      border-radius: 14px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      margin-bottom: 10px;
      font-family: inherit;
      letter-spacing: 0.3px;
      transition: all 0.2s;
    }

    .btn:active { transform: scale(0.97); }

    .btn-save {
      background: #fff;
      color: #5a3d9e;
    }

    .btn-reboot {
      background: rgba(255,255,255,0.15);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.25);
    }

    .btn-reset {
      background: rgba(255,59,48,0.3);
      color: #ff6b6b;
      border: 1px solid rgba(255,59,48,0.3);
    }

    .signal-icon {
      font-size: 12px;
      margin-left: 6px;
      opacity: 0.7;
    }

    .toast {
      position: fixed;
      bottom: 30px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(20px);
      color: #fff;
      padding: 12px 24px;
      border-radius: 100px;
      font-size: 14px;
      font-weight: 600;
      display: none;
      z-index: 999;
      white-space: nowrap;
    }

    #staticFields { display: none; }

    .scanning {
      text-align: center;
      color: rgba(255,255,255,0.6);
      font-size: 13px;
      padding: 8px 0;
    }
  </style>
</head>
<body>

  <div class="header">
    <div class="header-icon">📡</div>
    <h1>R&J Vendo Setup</h1>
    <p>Configure your vendo machine</p>
  </div>

  <!-- Device Info -->
  <div class="card">
    <div class="card-title">Device Info</div>
    <div class="info-row">
      <span class="info-label">MAC Address</span>
      <span class="info-value" id="infoMac">-</span>
    </div>
    <div class="info-row">
      <span class="info-label">Firmware</span>
      <span class="info-value" id="infoFw">-</span>
    </div>
    <div class="info-row">
      <span class="info-label">Mode</span>
      <span class="info-value" style="color:#ffd60a;">Setup Mode</span>
    </div>
  </div>

  <!-- Device Name -->
  <div class="card">
    <div class="card-title">Device Name</div>
    <label class="field-label">Vendo Name</label>
    <input type="text" id="vendo_name" placeholder="e.g. Vendo 1">
  </div>

  <!-- WiFi Settings -->
  <div class="card">
    <div class="card-title">WiFi Settings</div>

    <label class="field-label">Select Network</label>
    <div class="wifi-row">
      <select id="wifi_select" onchange="onWifiSelect()">
        <option value="">-- Tap Scan to search --</option>
        <option value="__manual__">Type manually...</option>
      </select>
      <button class="scan-btn" onclick="scanWifi()">Scan</button>
    </div>

    <div id="manualSsidWrap" style="display:none;">
      <label class="field-label">WiFi Name (SSID)</label>
      <input type="text" id="wifi_ssid_manual" placeholder="Enter WiFi name">
    </div>

    <label class="field-label">Password</label>
    <input type="password" id="wifi_pass" placeholder="WiFi Password">
  </div>

  <!-- Server Settings -->
  <div class="card">
    <div class="card-title">Server Settings</div>
    <label class="field-label">Server IP (optional, auto-detected if left blank)</label>
    <input type="text" id="server_ip" placeholder="Leave blank to auto-discover">
    <label class="field-label">Server Port</label>
    <input type="number" id="server_port" placeholder="3000">
  </div>

  <!-- Static IP -->
  <div class="card">
    <div class="card-title">Static IP</div>
    <div class="toggle-row">
      <span class="toggle-label">Enable Static IP</span>
      <label class="switch">
        <input type="checkbox" id="static_ip" onchange="toggleStatic()">
        <span class="slider"></span>
      </label>
    </div>
    <div id="staticFields">
      <label class="field-label">Device IP</label>
      <input type="text" id="device_ip" placeholder="192.168.0.30">
      <label class="field-label">Gateway</label>
      <input type="text" id="gateway" placeholder="192.168.0.1">
      <label class="field-label">Subnet Mask</label>
      <input type="text" id="subnet" placeholder="255.255.255.0">
    </div>
  </div>

  <!-- Actions -->
  <button class="btn btn-save" onclick="saveConfig()">Save &amp; Connect</button>
  <button class="btn btn-reboot" onclick="reboot()">Reboot Device</button>
  <button class="btn btn-reset" onclick="factoryReset()">Factory Reset</button>

  <div class="toast" id="toast"></div>

  <script>
    function showToast(msg, success) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.style.background = success === false
        ? 'rgba(255,59,48,0.85)'
        : 'rgba(0,0,0,0.75)';
      t.style.display = 'block';
      setTimeout(() => t.style.display = 'none', 3000);
    }

    async function loadConfig() {
      try {
        const res = await fetch('/config');
        const d = await res.json();
        document.getElementById('infoMac').textContent = d.mac;
        document.getElementById('infoFw').textContent = d.firmware;
        document.getElementById('vendo_name').value = d.vendo_name || '';
        document.getElementById('wifi_pass').value = d.wifi_pass || '';
        document.getElementById('server_ip').value = d.server_ip || '';
        document.getElementById('server_port').value = d.server_port || 3000;
        document.getElementById('static_ip').checked = d.static_ip;
        document.getElementById('device_ip').value = d.device_ip || '';
        document.getElementById('gateway').value = d.gateway || '';
        document.getElementById('subnet').value = d.subnet || '';
        if (d.static_ip) document.getElementById('staticFields').style.display = 'block';

        // Show saved SSID
        if (d.wifi_ssid) {
          const sel = document.getElementById('wifi_select');
          const opt = document.createElement('option');
          opt.value = d.wifi_ssid;
          opt.textContent = d.wifi_ssid + ' (saved)';
          opt.selected = true;
          sel.insertBefore(opt, sel.firstChild);
        }
      } catch(e) {
        showToast('Failed to load config', false);
      }
    }

    async function scanWifi() {
      const sel = document.getElementById('wifi_select');
      sel.innerHTML = '<option value="">Scanning...</option>';
      showToast('Scanning WiFi networks...');

      try {
        // Real bug found live: this fetch had no timeout, so if the device
        // ever failed to respond at all, the page just sat on "Scanning..."
        // indefinitely - the firmware side now bounds its own scan time,
        // but this belt-and-suspenders timeout means the page recovers
        // quickly no matter what.
        const res = await fetch('/scan', { signal: AbortSignal.timeout(10000) });
        const networks = await res.json();

        sel.innerHTML = '<option value="">-- Select Network --</option>';

        networks
          .sort((a, b) => b.rssi - a.rssi)
          .forEach(n => {
            const opt = document.createElement('option');
            opt.value = n.ssid;
            const signal = n.rssi > -60 ? 'Strong' : n.rssi > -75 ? 'Good' : 'Weak';
            const lock = n.secure ? 'Lock ' : '';
            opt.textContent = n.ssid + '  ' + lock + signal;
            sel.appendChild(opt);
          });

        const manual = document.createElement('option');
        manual.value = '__manual__';
        manual.textContent = 'Type manually...';
        sel.appendChild(manual);

        showToast('Found ' + networks.length + ' networks');
      } catch(e) {
        showToast('Scan failed', false);
        sel.innerHTML = '<option value="">Scan failed, try again</option><option value="__manual__">Type manually...</option>';
      }
    }

    function onWifiSelect() {
      const val = document.getElementById('wifi_select').value;
      const manualWrap = document.getElementById('manualSsidWrap');
      manualWrap.style.display = val === '__manual__' ? 'block' : 'none';
    }

    function getSelectedSsid() {
      const sel = document.getElementById('wifi_select');
      if (sel.value === '__manual__') {
        return document.getElementById('wifi_ssid_manual').value.trim();
      }
      return sel.value;
    }

    function toggleStatic() {
      const checked = document.getElementById('static_ip').checked;
      document.getElementById('staticFields').style.display = checked ? 'block' : 'none';
    }

    async function saveConfig() {
      const ssid = getSelectedSsid();
      if (!ssid) { showToast('Please select or enter a WiFi network', false); return; }

      const body = new URLSearchParams({
        vendo_name:  document.getElementById('vendo_name').value,
        wifi_ssid:   ssid,
        wifi_pass:   document.getElementById('wifi_pass').value,
        server_ip:   document.getElementById('server_ip').value,
        server_port: document.getElementById('server_port').value,
        static_ip:   document.getElementById('static_ip').checked ? 'true' : 'false',
        device_ip:   document.getElementById('device_ip').value,
        gateway:     document.getElementById('gateway').value,
        subnet:      document.getElementById('subnet').value,
      });

      try {
        showToast('Saving...');
        const res = await fetch('/save', { method: 'POST', body });
        const d = await res.json();
        showToast(d.message);
      } catch(e) {
        showToast('Error saving', false);
      }
    }

    async function reboot() {
      if (!confirm('Reboot the device?')) return;
      await fetch('/reboot', { method: 'POST' });
      showToast('Rebooting...');
    }

    async function factoryReset() {
      if (!confirm('This will erase all settings. Continue?')) return;
      await fetch('/reset', { method: 'POST' });
      showToast('Reset complete. Rebooting...');
    }

    loadConfig();
  </script>
</body>
</html>
  )rawhtml";
}
