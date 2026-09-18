// Tests for saved devices, recovery code, and password reset.
// Run: node --test test/adminAuth.test.js
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starkfi-adminauth-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const db = require('../server/config/database');
const svc = require('../server/services/adminAuthService');
const { verifyPassword } = require('../server/utils/passwordHash');

const setting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;

test('describeUserAgent gives a readable label', () => {
  assert.strictEqual(svc.describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'), 'Chrome on macOS');
  assert.strictEqual(svc.describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari on iOS');
  assert.strictEqual(svc.describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0'), 'Edge on Windows');
  assert.strictEqual(svc.describeUserAgent(''), 'Browser on Unknown OS');
});

test('trusted device: create, exchange, list, revoke', () => {
  svc.revokeAllTrustedDevices(db);
  const d = svc.createTrustedDevice(db, { label: 'Chrome on macOS', ip: '127.0.0.1' });
  assert.match(d.token, /^dev_[0-9a-f]{64}$/);

  // The raw token is never stored.
  const stored = db.prepare('SELECT token_hash FROM admin_trusted_devices WHERE id = ?').get(d.id);
  assert.notStrictEqual(stored.token_hash, d.token);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM admin_trusted_devices').all()).includes(d.token));

  assert.deepStrictEqual(svc.exchangeDeviceToken(db, d.token), { ok: true, id: d.id });
  assert.strictEqual(svc.exchangeDeviceToken(db, 'dev_' + 'a'.repeat(64)).ok, false);
  assert.strictEqual(svc.exchangeDeviceToken(db, 'nope').ok, false);
  assert.strictEqual(svc.exchangeDeviceToken(db, undefined).ok, false);
  assert.strictEqual(svc.exchangeDeviceToken(db, {}).ok, false);

  const list = svc.listTrustedDevices(db);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].label, 'Chrome on macOS');
  assert.ok(!('token_hash' in list[0]));

  assert.strictEqual(svc.revokeTrustedDevice(db, d.id), true);
  assert.strictEqual(svc.exchangeDeviceToken(db, d.token).ok, false);
  assert.strictEqual(svc.revokeTrustedDevice(db, d.id), false);
});

test('trusted device: expiry, revoke by token, revoke all, cap', () => {
  svc.revokeAllTrustedDevices(db);
  const a = svc.createTrustedDevice(db, { label: 'A' });
  db.prepare('UPDATE admin_trusted_devices SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, a.id);
  assert.strictEqual(svc.exchangeDeviceToken(db, a.token).ok, false);
  assert.strictEqual(svc.listTrustedDevices(db).length, 0);

  const b = svc.createTrustedDevice(db, { label: 'B' });
  assert.strictEqual(svc.revokeDeviceByToken(db, b.token), true);
  assert.strictEqual(svc.exchangeDeviceToken(db, b.token).ok, false);

  for (let i = 0; i < svc.MAX_TRUSTED_DEVICES + 5; i++) svc.createTrustedDevice(db, { label: `D${i}` });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM admin_trusted_devices').get().n, svc.MAX_TRUSTED_DEVICES);
  assert.ok(svc.revokeAllTrustedDevices(db) > 0);
  assert.strictEqual(svc.listTrustedDevices(db).length, 0);
});

test('recovery code: format, status, verify', () => {
  db.prepare("DELETE FROM settings WHERE key IN ('admin_recovery_code_hash','admin_recovery_code_created_at')").run();
  assert.strictEqual(svc.getRecoveryCodeStatus(db).exists, false);
  assert.strictEqual(svc.verifyRecoveryCode(db, 'ABCD-EFGH-JKLM-NPQR'), false);

  const code = svc.generateRecoveryCode(db);
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  assert.strictEqual(svc.getRecoveryCodeStatus(db).exists, true);
  assert.ok(svc.getRecoveryCodeStatus(db).createdAt > 0);
  assert.ok(!setting('admin_recovery_code_hash').includes(code.replace(/-/g, '')));

  assert.strictEqual(svc.verifyRecoveryCode(db, code), true);
  assert.strictEqual(svc.verifyRecoveryCode(db, code.toLowerCase().replace(/-/g, ' ')), true);
  assert.strictEqual(svc.verifyRecoveryCode(db, 'AAAA-AAAA-AAAA-AAAA'), false);
  assert.strictEqual(svc.verifyRecoveryCode(db, ''), false);
  assert.strictEqual(svc.verifyRecoveryCode(db, undefined), false);
});

test('reset with recovery code: rejections do not consume the code', () => {
  db.prepare("DELETE FROM settings WHERE key = 'admin_recovery_code_hash'").run();
  const noCode = svc.resetPasswordWithRecoveryCode(db, 'ABCD-EFGH-JKLM-NPQR', 'a-good-password');
  assert.strictEqual(noCode.ok, false);
  assert.strictEqual(noCode.reason, 'no_code');

  const code = svc.generateRecoveryCode(db);
  const before = setting('admin_password');
  const weak = svc.resetPasswordWithRecoveryCode(db, code, 'short');
  assert.strictEqual(weak.reason, 'weak_password');
  const bad = svc.resetPasswordWithRecoveryCode(db, 'AAAA-AAAA-AAAA-AAAA', 'a-good-password');
  assert.strictEqual(bad.reason, 'bad_code');
  assert.strictEqual(setting('admin_password'), before);
  assert.strictEqual(svc.verifyRecoveryCode(db, code), true);
});

test('reset with recovery code: success rotates code, revokes devices and sessions', () => {
  const code = svc.generateRecoveryCode(db);
  svc.createTrustedDevice(db, { label: 'X' });
  const epochBefore = svc.getSessionsEpoch(db);
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'must_change_password'").run();

  const r = svc.resetPasswordWithRecoveryCode(db, code, 'brand-new-password');
  assert.strictEqual(r.ok, true);
  assert.match(r.newRecoveryCode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);

  assert.ok(verifyPassword('brand-new-password', setting('admin_password')));
  assert.ok(!verifyPassword('admin123', setting('admin_password')));
  assert.strictEqual(setting('must_change_password'), '0');
  assert.strictEqual(svc.listTrustedDevices(db).length, 0);
  assert.notStrictEqual(svc.getSessionsEpoch(db), epochBefore);

  // Old code is dead, the newly issued one works.
  assert.strictEqual(svc.verifyRecoveryCode(db, code), false);
  assert.strictEqual(svc.verifyRecoveryCode(db, r.newRecoveryCode), true);
  assert.strictEqual(svc.resetPasswordWithRecoveryCode(db, code, 'another-password').ok, false);
});

test('console reset: sets password, revokes devices, bumps epoch, validates length', () => {
  svc.createTrustedDevice(db, { label: 'Y' });
  const epochBefore = svc.getSessionsEpoch(db);
  assert.strictEqual(svc.resetPasswordDirect(db, 'short').ok, false);
  assert.strictEqual(svc.getSessionsEpoch(db), epochBefore);

  assert.strictEqual(svc.resetPasswordDirect(db, 'console-reset-pw').ok, true);
  assert.ok(verifyPassword('console-reset-pw', setting('admin_password')));
  assert.strictEqual(svc.listTrustedDevices(db).length, 0);
  assert.notStrictEqual(svc.getSessionsEpoch(db), epochBefore);
});

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
