// ===== SHARED TC CLASS ID ALLOCATOR =====
// Extracted from standaloneDriver.js so openwrtDriver.js can share the same
// fix instead of drifting back to a hash-based classId (see the bug this
// closes below) - one allocator, used by every driver that shapes traffic
// via Linux tc HTB classes. Safe to share one table/cache with no
// per-driver namespacing since only one driver is ever active at a time
// (network_mode is a single setting) - two drivers never allocate
// concurrently in the same process.
//
// Bug found via client-capacity audit: classId used to be hash(mac) % 900
// with no collision handling. The birthday paradox makes a collision ~38%
// likely at just 30 concurrent shaped clients on one lane, ~99.6% by 100 -
// a real service bug, not cosmetic: two different customers silently share
// one HTB bandwidth class (whichever setClientBandwidth ran last overwrites
// the other's rate), and if either disconnects, removeClientBandwidth()
// deletes the class both were using, killing the other's still-active
// shaping while they're still connected and paying.
//
// Fixed with a real, persistent, collision-free allocation (tc_class_
// allocations table) instead of a hash - smallest unused id in range gets
// assigned and reused once freed, seeded from the DB once per boot so IDs
// don't reshuffle pointlessly across reconnects within the same uptime.

const CLASS_ID_MIN = 100;
const CLASS_ID_MAX = 65000;
let _classIdCache = null; // Map<mac, classId>, lazily seeded from DB
let _usedClassIds = null; // Set<classId>

function loadClassIdState() {
  if (_classIdCache) return;
  _classIdCache = new Map();
  _usedClassIds = new Set();
  try {
    const db = require('../../config/database');
    const rows = db.prepare('SELECT mac_address, class_id FROM tc_class_allocations').all();
    for (const row of rows) {
      _classIdCache.set(row.mac_address, row.class_id);
      _usedClassIds.add(row.class_id);
    }
  } catch (e) {
    console.error('[TC] Failed to load class ID allocations, starting fresh:', e.message);
  }
}

function getClassId(mac) {
  loadClassIdState();
  const existing = _classIdCache.get(mac);
  if (existing !== undefined) return existing;

  let candidate = CLASS_ID_MIN;
  while (_usedClassIds.has(candidate) && candidate <= CLASS_ID_MAX) candidate++;
  if (candidate > CLASS_ID_MAX) {
    // Practically unreachable (65,000 concurrently-tracked MACs on one
    // lane) but fail loudly rather than silently reintroducing a collision
    // if it somehow ever happens.
    throw new Error('No free tc class IDs available (exhausted 100-65000)');
  }

  _classIdCache.set(mac, candidate);
  _usedClassIds.add(candidate);
  try {
    const db = require('../../config/database');
    db.prepare('INSERT OR REPLACE INTO tc_class_allocations (mac_address, class_id) VALUES (?, ?)').run(mac, candidate);
  } catch (e) {
    console.error(`[TC] Failed to persist class ID allocation for ${mac}:`, e.message);
  }
  return candidate;
}

// Looks up an existing allocation without creating one - removeClientBandwidth
// must never allocate a fresh ID just to immediately try deleting a tc class
// that was never created (e.g. cleanup called on a MAC whose bandwidth cap
// was never applied), which would otherwise leak an allocation forever.
function peekClassId(mac) {
  loadClassIdState();
  return _classIdCache.get(mac);
}

function releaseClassId(mac) {
  loadClassIdState();
  const classId = _classIdCache.get(mac);
  if (classId === undefined) return;
  _classIdCache.delete(mac);
  _usedClassIds.delete(classId);
  try {
    const db = require('../../config/database');
    db.prepare('DELETE FROM tc_class_allocations WHERE mac_address = ?').run(mac);
  } catch (e) {
    console.error(`[TC] Failed to release class ID allocation for ${mac}:`, e.message);
  }
}

module.exports = { getClassId, peekClassId, releaseClassId };
