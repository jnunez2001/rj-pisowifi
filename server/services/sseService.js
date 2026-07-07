// ===== REAL-TIME SESSION PUSH (Server-Sent Events) =====
// Bug: the portal only ever found out about a coin credit by polling
// (every 8s normally, every 1.5s while the Insert Coin modal was open) —
// noticeably slower than competitors, since even the fast path meant
// waiting up to ~1.5s for the next tick. This lets sessionService push an
// instant "something changed, refetch now" signal to a MAC's open portal
// tab(s) the moment a coin/promo/free-claim actually lands, instead of it
// waiting on the next poll. Polling stays in place client-side as a
// fallback (e.g. if a browser's connection to the stream drops silently).

const connections = new Map(); // mac -> Set<res>

function subscribe(mac, res) {
  if (!connections.has(mac)) connections.set(mac, new Set());
  connections.get(mac).add(res);
}

function unsubscribe(mac, res) {
  const set = connections.get(mac);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) connections.delete(mac);
}

function notify(mac) {
  const set = connections.get(mac);
  if (!set || set.size === 0) return;
  for (const res of set) {
    try {
      res.write('data: update\n\n');
    } catch (e) {
      // connection already dead; req.on('close') will clean it up
    }
  }
}

module.exports = { subscribe, unsubscribe, notify };
