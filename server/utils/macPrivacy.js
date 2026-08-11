// ===== MAC ADDRESS PRIVACY (long-term logs only) =====
// Real gap from the Phase 8 privacy audit: MAC addresses were written in
// plain text to the financial log (server/services/financialLogService.js,
// up to a year of retention) and, by extension, the Support Bundle export
// (which just reads the tail of those same log files). Combined with
// timestamps, that's a real presence/behavior trail, not classic PII
// alone but worth minimizing where the full address isn't actually
// needed.
//
// Deliberately NOT applied to the live operational database
// (transactions.mac_address, sessions.mac_address, etc.) - those columns
// are read by real business logic (New vs Returning reporting, session
// lookup, spam/attempt tracking keyed by MAC) that genuinely needs the
// real address. This is scoped to the long-term audit trail specifically,
// where a hash is enough to answer "was this the same device as that
// other log line" without ever storing the reversible address.

const crypto = require('crypto');

// Deterministic (same MAC always hashes the same way, so log lines from
// the same device can still be correlated) but one-way - the original MAC
// cannot be recovered from this. Truncated to 12 hex chars (48 bits) -
// still effectively collision-free for any realistic number of devices a
// single box will ever see, while keeping log lines shorter.
function hashMac(mac) {
  if (!mac) return mac;
  return crypto.createHash('sha256').update(String(mac).toLowerCase().trim()).digest('hex').slice(0, 12);
}

module.exports = { hashMac };
