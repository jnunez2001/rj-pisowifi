#ifndef AUDIO_H
#define AUDIO_H

#include <Arduino.h>

// Streams and plays a WAV file from a URL - the file lives on the server,
// never saved to this device's own flash. Non-blocking: starts the stream
// and returns immediately, actual playback happens a chunk at a time via
// audioLoop(), which MUST be called every loop() iteration (same pattern
// as server.handleClient()) or playback will stall/stutter.
void startPlayingSound(const String &url);
void stopPlayingSound();
void audioLoop();
bool isAudioPlaying();

#endif
