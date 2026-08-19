const fs = require('fs');
const path = require('path');
const { hashMac } = require('../utils/macPrivacy');

// Redundant, append-only backup of every row written to the `transactions`
// table, plain text on disk, separate from SQLite, so a corrupted database
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
    // Hash the MAC before it hits disk here - this log keeps up to a year
    // of history and feeds the Support Bundle export, so a plaintext MAC
    // here is a real presence/behavior trail combined with the timestamp
    // already on every line. The live DB (transactions.mac_address etc.)
    // is untouched - that's a separate, operationally-needed store.
    const safeEvent = event.mac ? { ...event, mac: hashMac(event.mac) } : event;
    const line = JSON.stringify({ time: now.toISOString(), ...safeEvent }) + '\n';
    fs.appendFileSync(file, line);
  } catch (e) {
    // Never let logging failure break the actual transaction (Bug #38 pattern:
    // log the error, don't throw).
    console.error('[FinancialLog] Failed to append event:', e.message);
  }
}

// These are money-audit records, not debug noise, so retention is generous
// (a year) - the goal is only to stop unbounded growth from slowly filling
// the disk (the same class of problem as the SD card silently running out
// of space), not to prune anything an operator might still need to see.
const RETENTION_DAYS = parseInt(process.env.FINANCIAL_LOG_RETENTION_DAYS, 10) || 365;

function rotateOldLogs() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    fs.readdirSync(LOG_DIR)
      .filter((f) => /^financial-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .forEach((f) => {
        const filePath = path.join(LOG_DIR, f);
        try {
          if (fs.statSync(filePath).mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            console.log(`🗑️  [FinancialLog] Rotated out old log (past ${RETENTION_DAYS}-day retention): ${f}`);
          }
        } catch (e) {
          // Non-fatal - skip this file, keep checking the rest.
        }
      });
  } catch (e) {
    console.warn('[FinancialLog] Log rotation check failed (non-fatal):', e.message);
  }
}

module.exports = { logFinancialEvent, rotateOldLogs };
