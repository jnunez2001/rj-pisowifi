// Tells the coin-slot vendo device to stream and play one of the WAV
// files this server hosts (public/audio/vendo/*.wav) - the file is
// never sent to/stored by the caller of this function, only a short
// NAME is. The device itself builds the actual fetch URL from its own
// known server address (esp8266/firmware's web_server.cpp), so this
// works identically whether it's called from a live web request (e.g.
// portal.js's /play-sound, tapping Insert Coin) or from a background
// timer with no request in scope at all (coin.js's finalizePendingCoins,
// where a coin's pending window closes on its own after the customer
// stops inserting).
//
// Best-effort by design, same as activateVendoRelay()/deactivateVendoRelay
// already are elsewhere - a vendo that isn't configured, or has no
// speaker wired up yet, should never be treated as an error for whatever
// feature triggered the sound. Callers that want to know success/failure
// still get the boolean return value; nothing here throws.
const db = require('../config/database');

async function playVendoSound(soundName) {
  const vendoIp = db.prepare("SELECT value FROM settings WHERE key = 'vendo_ip'").get()?.value;
  if (!vendoIp) return false;

  try {
    const res = await fetch(`http://${vendoIp}/play?sound=${encodeURIComponent(soundName)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000)
    });
    return res.ok;
  } catch (e) {
    console.error(`[Vendo Audio] play "${soundName}" failed:`, e.message);
    return false;
  }
}

// Amount-announcement clips only exist for whole pesos 1-300 (see
// public/audio/vendo/amounts/ - pre-generated files, not live TTS).
// Returns false (silently skips) for anything outside that range or a
// non-integer amount, rather than trying to play a file that doesn't
// exist.
async function playVendoAmount(pesos) {
  const amount = Math.round(Number(pesos));
  if (!Number.isFinite(amount) || amount < 1 || amount > 300) return false;
  return playVendoSound(`amounts/amount-${amount}`);
}

module.exports = { playVendoSound, playVendoAmount };
