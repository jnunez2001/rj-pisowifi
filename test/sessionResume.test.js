// Resume mismatch alert: rounding must not raise it, a real disagreement must.
// Run: node --test test/sessionResume.test.js
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starkfi-resume-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const db = require('../server/config/database');
const svc = require('../server/services/sessionService');

const alertCount = () => db.prepare("SELECT COUNT(*) n FROM alert_events WHERE code = 'resume_mismatch_corrected'").get().n;

function insertSession(code, remainingMinutes) {
  const expires = new Date(Date.now() + svc.grantedMsForMinutes(remainingMinutes)).toISOString();
  const hard = new Date(Date.now() + svc.grantedMsForMinutes(remainingMinutes + 1000)).toISOString();
  db.prepare(`INSERT INTO sessions (voucher_code, mac_address, ip_address, minutes_remaining, expires_at, hard_expires_at)
              VALUES (?, ?, '10.0.0.5', ?, ?, ?)`).run(code, 'aa:bb:cc:dd:ee:01', Math.floor(remainingMinutes), expires, hard);
}

test('evaluateResumeMismatch: rounding slack is not a mismatch, real gaps are', () => {
  const ev = svc.evaluateResumeMismatch;
  assert.deepStrictEqual(ev(170, 170.8), { mismatch: false, effectiveMinutesRemaining: 170 });
  assert.deepStrictEqual(ev(170, 170.999), { mismatch: false, effectiveMinutesRemaining: 170 });
  assert.deepStrictEqual(ev(170, 170), { mismatch: false, effectiveMinutesRemaining: 170 });
  assert.deepStrictEqual(ev(170, 172.5), { mismatch: true, effectiveMinutesRemaining: 172.5 });
  assert.deepStrictEqual(ev(170, 168), { mismatch: true, effectiveMinutesRemaining: 170 });
  assert.deepStrictEqual(ev(100, 170.4), { mismatch: true, effectiveMinutesRemaining: 170.4 });
});

test('pause then resume never raises the alert for any fractional remaining time', async () => {
  const before = alertCount();
  for (let i = 0; i < 50; i++) {
    const frac = (i + 0.5) / 50; // 0.01 .. 0.99
    const code = `RJ-FRAC${i}`;
    insertSession(code, 170 + frac);
    const paused = await svc.pauseSession(code, 'idle');
    assert.ok(paused && paused.is_paused === 1, `paused ${code}`);
    const resumed = await svc.resumeSession(code);
    assert.ok(resumed, `resumed ${code}`);
  }
  assert.strictEqual(alertCount(), before, 'no false mismatch alerts');
});

test('a real disagreement still raises the alert and resumes with the larger value', async () => {
  const before = alertCount();
  insertSession('RJ-REAL01', 170.4);
  await svc.pauseSession('RJ-REAL01', 'idle');
  db.prepare("UPDATE sessions SET minutes_remaining = 100 WHERE voucher_code = 'RJ-REAL01'").run();
  await svc.resumeSession('RJ-REAL01');
  assert.strictEqual(alertCount(), before + 1);
  const row = db.prepare("SELECT expires_at FROM sessions WHERE voucher_code = 'RJ-REAL01'").get();
  const minsLeft = (new Date(row.expires_at).getTime() - Date.now()) / 60000;
  assert.ok(minsLeft > 169 && minsLeft < 171.5, `resumed with the larger value, got ${minsLeft}`);
});

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
