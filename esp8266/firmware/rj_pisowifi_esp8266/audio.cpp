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

// Small FIFO so a sound requested while one is already playing waits its
// turn instead of cutting the first one off mid-sentence - real case:
// coin.js announces the peso total the moment the pending window closes,
// then portal.js's next poll notices the session just went active and
// asks for "connected" right after. Both calls land close together, and
// without a queue the second one (whichever arrives second) would kill
// the first one's playback partway through. Sized generously above the
// realistic case (never more than 2-3 sounds pile up in practice).
#define AUDIO_QUEUE_SIZE 4
static String audioQueue[AUDIO_QUEUE_SIZE];
static int audioQueueCount = 0;

static void playNow(const String &url) {
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
  if (isAudioPlaying()) {
    if (audioQueueCount < AUDIO_QUEUE_SIZE) {
      audioQueue[audioQueueCount++] = url;
      Serial.println("Audio: queued " + url);
    } else {
      Serial.println("Audio: queue full, dropping " + url);
    }
    return;
  }
  playNow(url);
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
    if (audioQueueCount > 0) {
      String next = audioQueue[0];
      for (int i = 1; i < audioQueueCount; i++) audioQueue[i - 1] = audioQueue[i];
      audioQueueCount--;
      playNow(next);
    }
  }
}
