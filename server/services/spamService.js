const attempts = new Map();

function getSettings() {
  const db = require('../config/database');
  const maxAttempts = parseInt(
    db.prepare("SELECT value FROM settings WHERE key = 'spam_max_attempts'")
      .get()?.value || '3'
  );
  const blockMinutes = parseInt(
    db.prepare("SELECT value FROM settings WHERE key = 'spam_block_minutes'")
      .get()?.value || '1'
  );
  return { maxAttempts, blockMinutes };
}

function checkSpam(identifier) {
  const { maxAttempts, blockMinutes } = getSettings();
  const now = Date.now();
  const data = attempts.get(identifier);

  if (data) {
    if (data.blocked && now < data.blockedUntil) {
      const remaining = Math.ceil((data.blockedUntil - now) / 1000);
      return {
        blocked: true,
        remaining,
        message: `Too many attempts. Try again in ${remaining} seconds.`
      };
    }
    if (data.blocked && now >= data.blockedUntil) {
      attempts.delete(identifier);
    }
  }

  return { blocked: false };
}

function recordAttempt(identifier) {
  const { maxAttempts, blockMinutes } = getSettings();
  const now = Date.now();
  const data = attempts.get(identifier) || { count: 0, firstAttempt: now };

  if (now - data.firstAttempt > 60000) {
    attempts.set(identifier, { count: 1, firstAttempt: now });
    return { blocked: false, count: 1 };
  }

  data.count++;

  if (data.count >= maxAttempts) {
    data.blocked = true;
    data.blockedUntil = now + blockMinutes * 60 * 1000;
    attempts.set(identifier, data);
    return {
      blocked: true,
      remaining: blockMinutes * 60,
      message: `Too many attempts. Blocked for ${blockMinutes} minute(s).`
    };
  }

  attempts.set(identifier, data);
  return {
    blocked: false,
    count: data.count,
    remaining_attempts: maxAttempts - data.count
  };
}

function clearAttempts(identifier) {
  attempts.delete(identifier);
}

module.exports = { checkSpam, recordAttempt, clearAttempts };