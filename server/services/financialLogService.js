const fs = require('fs');
const path = require('path');

// Redundant, append-only backup of every row written to the `transactions`
// table — plain text on disk, separate from SQLite, so a corrupted database
// still leaves a readable trail of every peso that moved. One file per day
// (server's local date), JSON-lines format (one event per line).
const LOG_DIR = process.env.FINANCIAL_LOG_DIR || path.join(__dirname, '../logs');

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  console.error('[FinancialLog] Could not create log directory:', e.message);
}

function logFinancialEvent(event) {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const file = path.join(LOG_DIR, `financial-${dateStr}.log`);
    const line = JSON.stringify({ time: now.toISOString(), ...event }) + '\n';
    fs.appendFileSync(file, line);
  } catch (e) {
    // Never let logging failure break the actual transaction (Bug #38 pattern:
    // log the error, don't throw).
    console.error('[FinancialLog] Failed to append event:', e.message);
  }
}

module.exports = { logFinancialEvent };
