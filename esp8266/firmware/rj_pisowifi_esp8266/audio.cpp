#include "config.h"
#include "audio.h"
#include <AudioFileSourceHTTPStream.h>
#include <AudioGeneratorWAV.h>
#include <AudioOutputI2SNoDAC.h>

// AudioOutputI2SNoDAC drives the ESP8266's real I2S hardware in a
// "delta-sigma" software mode to fake an analog line-out with no external
// DAC chip needed - just a cheap class-D amp (e.g. PAM8403) on the output.
// This uses the chip's dedicated I2S peripheral, which is hardwired to
// specific pins, not a free choice - the actual audio signal comes out on
// GPIO3 (labeled "RX"/"RXD0" on most boards), confirmed directly from this
// library's own AudioOutputI2S.cpp (ESP8266 branch touches
// PERIPHS_IO_MUX_GPIO2_U for the WS line as part of I2S setup, with the
// data line on GPIO3). Not a pin this firmware was already using for
// anything else, so no conflict with COIN_PIN/RELAY_PIN/SETUP_BTN.
static AudioFileSourceHTTPStream *audioFile = nullptr;
static AudioGeneratorWAV *audioGen = nullptr;
static AudioOutputI2SNoDAC *audioOut = nullptr;

void stopPlayingSound() {
  if (audioGen) {
    if (audioGen->isRunning()) audioGen->stop();
    delete audioGen;
    audioGen = nullptr;
  }
  if (audioFile) {
    delete audioFile;
    audioFile = nullptr;
  }
  if (audioOut) {
    delete audioOut;
    audioOut = nullptr;
  }
}

void startPlayingSound(const String &url) {
  // Only one sound at a time - a second request while one is already
  // playing replaces it, same "latest instruction wins" behavior as
  // activateRelay() elsewhere in this firmware, rather than queuing.
  stopPlayingSound();

  audioOut = new AudioOutputI2SNoDAC();
  audioFile = new AudioFileSourceHTTPStream(url.c_str());
  audioGen = new AudioGeneratorWAV();

  if (!audioGen->begin(audioFile, audioOut)) {
    Serial.println("Audio: failed to start playback for " + url);
    stopPlayingSound();
  } else {
    Serial.println("Audio: playing " + url);
  }
}

bool isAudioPlaying() {
  return audioGen && audioGen->isRunning();
}

void audioLoop() {
  if (!audioGen || !audioGen->isRunning()) return;
  // AudioGeneratorWAV::loop() decodes and plays one more chunk, then
  // returns - never blocks for the whole file, safe to call every loop()
  // iteration alongside server.handleClient()/processCoinPulses()/etc.
  // Returns false once the file is finished (or on a real stream error),
  // at which point playback is done and resources should be released.
  if (!audioGen->loop()) {
    Serial.println("Audio: playback finished");
    stopPlayingSound();
  }
}
