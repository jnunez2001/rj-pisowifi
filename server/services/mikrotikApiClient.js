// ===== MIKROTIK NATIVE API CLIENT =====
// Implements MikroTik's own binary API protocol (TCP port 8728 plain,
// 8729 TLS) — NOT the REST API. This protocol has been stable and
// supported since well before RouterOS 7 and is still fully supported in
// RouterOS 7 today, so this one implementation drives BOTH RouterOS 6 and
// RouterOS 7 routers identically. That's the whole reason this exists
// instead of REST: REST only exists on RouterOS 7.1+, which locks out
// older/cheaper hardware (e.g. hAP lite/mini) that can't run RouterOS 7 at
// all.
//
// Protocol shape, in brief (MikroTik's own published spec):
// - A "word" is a length-prefixed piece of text. The length prefix uses a
//   variable number of bytes depending on how big the length is (1-5
//   bytes) — see encodeLength()/decodeLength() below.
// - A "sentence" is one or more words followed by a zero-length word
//   (a single 0x00 byte), which marks the end of that sentence.
// - Commands look like CLI menu paths: "/ip/hotspot/ip-binding/print",
//   with parameters as their own words prefixed "=key=value", and query
//   filters prefixed "?key=value".
// - Replies come back as one or more "!re" sentences (one per result row)
//   followed by a single "!done" sentence, or a "!trap" sentence on error.
//
// Only the modern single-step login (RouterOS 6.43+, plain =name=/
// =password= on /login) is implemented. Pre-6.43 RouterOS used an older
// two-step MD5-challenge login; given how old that firmware now is, it's a
// known, accepted gap rather than something worth the extra complexity.

const net = require('net');
const tls = require('tls');

const DEFAULT_TIMEOUT_MS = 8000;

function encodeLength(len) {
  if (len < 0x80) {
    return Buffer.from([len]);
  } else if (len < 0x4000) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(len | 0x8000, 0);
    return buf;
  } else if (len < 0x200000) {
    const buf = Buffer.alloc(3);
    buf[0] = (len >> 16) | 0xC0;
    buf[1] = (len >> 8) & 0xFF;
    buf[2] = len & 0xFF;
    return buf;
  } else if (len < 0x10000000) {
    const buf = Buffer.alloc(4);
    buf[0] = (len >> 24) | 0xE0;
    buf[1] = (len >> 16) & 0xFF;
    buf[2] = (len >> 8) & 0xFF;
    buf[3] = len & 0xFF;
    return buf;
  } else {
    const buf = Buffer.alloc(5);
    buf[0] = 0xF0;
    buf.writeUInt32BE(len, 1);
    return buf;
  }
}

function encodeWord(str) {
  const body = Buffer.from(String(str), 'utf8');
  return Buffer.concat([encodeLength(body.length), body]);
}

function encodeSentence(words) {
  return Buffer.concat([...words.map(encodeWord), Buffer.from([0x00])]);
}

// Streaming decoder: fed raw bytes as they arrive over the socket (TCP
// gives no guarantee a whole word — let alone a whole sentence — arrives
// in one chunk), emits one full sentence (array of word strings) at a time
// via onSentence.
class SentenceDecoder {
  constructor(onSentence) {
    this.onSentence = onSentence;
    this.buf = Buffer.alloc(0);
    this.currentWords = [];
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // Keep decoding as many complete words as are currently available.
    for (;;) {
      const word = this._tryReadWord();
      if (word === undefined) break; // not enough bytes yet — wait for more
      if (word === null) {
        // zero-length word — end of sentence
        const sentence = this.currentWords;
        this.currentWords = [];
        this.onSentence(sentence);
      } else {
        this.currentWords.push(word);
      }
    }
  }

  // Returns: a decoded word string, null for a zero-length (end-of-sentence)
  // marker, or undefined if there isn't enough buffered data yet to decode
  // a full word (caller should wait for more bytes).
  _tryReadWord() {
    if (this.buf.length < 1) return undefined;
    const first = this.buf[0];
    let len, headerLen;
    if ((first & 0x80) === 0) {
      len = first;
      headerLen = 1;
    } else if ((first & 0xC0) === 0x80) {
      if (this.buf.length < 2) return undefined;
      len = ((first & 0x3F) << 8) | this.buf[1];
      headerLen = 2;
    } else if ((first & 0xE0) === 0xC0) {
      if (this.buf.length < 3) return undefined;
      len = ((first & 0x1F) << 16) | (this.buf[1] << 8) | this.buf[2];
      headerLen = 3;
    } else if ((first & 0xF0) === 0xE0) {
      if (this.buf.length < 4) return undefined;
      len = ((first & 0x0F) << 24) | (this.buf[1] << 16) | (this.buf[2] << 8) | this.buf[3];
      headerLen = 4;
    } else {
      if (this.buf.length < 5) return undefined;
      len = this.buf.readUInt32BE(1);
      headerLen = 5;
    }

    if (len === 0) {
      this.buf = this.buf.subarray(headerLen);
      return null;
    }

    if (this.buf.length < headerLen + len) return undefined;
    const word = this.buf.subarray(headerLen, headerLen + len).toString('utf8');
    this.buf = this.buf.subarray(headerLen + len);
    return word;
  }
}

// Parses a sentence's words (e.g. ["!re", "=mac-address=AA:BB:CC", ...])
// into { type: '!re'|'!done'|'!trap', attrs: {...} }.
function parseSentence(words) {
  const type = words[0];
  const attrs = {};
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('=')) {
      const eq = w.indexOf('=', 1);
      if (eq > 0) {
        attrs[w.slice(1, eq)] = w.slice(eq + 1);
      }
    }
  }
  return { type, attrs };
}

class MikrotikApiClient {
  constructor({ host, port, ssl, user, pass, timeoutMs }) {
    this.host = host;
    this.port = port || (ssl ? 8729 : 8728);
    this.ssl = !!ssl;
    this.user = user;
    this.pass = pass;
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this.socket = null;
    this.queue = []; // pending { resolve, reject, results, timer }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port };
      let settled = false;
      const onError = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      this.socket = this.ssl
        ? tls.connect({ ...opts, rejectUnauthorized: false }, () => {
          if (settled) return;
          settled = true;
          resolve();
        })
        : net.connect(opts, () => {
          if (settled) return;
          settled = true;
          resolve();
        });

      this.socket.setTimeout(this.timeoutMs);
      this.socket.on('timeout', () => onError(new Error(`MikroTik connection timed out after ${this.timeoutMs}ms`)));
      this.socket.on('error', onError);
      this.socket.on('close', () => this._failAllPending(new Error('MikroTik connection closed')));

      this.decoder = new SentenceDecoder((words) => this._onSentence(words));
      this.socket.on('data', (chunk) => this.decoder.feed(chunk));
    });
  }

  _onSentence(words) {
    const { type, attrs } = parseSentence(words);
    const pending = this.queue[0];
    if (!pending) return; // unsolicited/late sentence — nothing to deliver it to
    if (type === '!re') {
      pending.results.push(attrs);
    } else if (type === '!done') {
      clearTimeout(pending.timer);
      this.queue.shift();
      pending.resolve({ done: attrs, re: pending.results });
    } else if (type === '!trap' || type === '!fatal') {
      clearTimeout(pending.timer);
      this.queue.shift();
      pending.reject(new Error(attrs.message || `MikroTik API error (${type})`));
    }
  }

  _failAllPending(err) {
    const pending = this.queue.splice(0, this.queue.length);
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  // Sends a command sentence and resolves with all rows once !done arrives.
  talk(words) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('MikroTik socket not connected'));
        return;
      }
      const entry = { resolve, reject, results: [] };
      entry.timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error(`MikroTik command timed out after ${this.timeoutMs}ms: ${words[0]}`));
      }, this.timeoutMs);
      this.queue.push(entry);
      this.socket.write(encodeSentence(words));
    });
  }

  async login() {
    const result = await this.talk(['/login', `=name=${this.user}`, `=password=${this.pass}`]);
    return result;
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

// Opens a connection, logs in, runs one command, and closes — the shape
// every caller in mikrotikService.js actually needs (short-lived,
// one-command-at-a-time, matching how the old REST calls worked).
async function withMikrotik(config, fn) {
  const client = new MikrotikApiClient({
    host: config.ip,
    port: config.port,
    ssl: config.ssl,
    user: config.user,
    pass: config.pass,
  });
  try {
    await client.connect();
    await client.login();
    return await fn(client);
  } finally {
    client.close();
  }
}

module.exports = {
  MikrotikApiClient,
  withMikrotik,
  encodeSentence,
  encodeWord,
  encodeLength,
  SentenceDecoder,
  parseSentence,
};
