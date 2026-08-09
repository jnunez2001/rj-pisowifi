// Web Push (server/config/database.js generates the VAPID keypair once at
// boot). Fails soft everywhere - a customer not getting a push notification
// is a missed nicety, never something that should affect their actual
// internet access or crash a caller that isn't expecting an exception.
const webpush = require('web-push');
const db = require('../config/database');

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const pub = db.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get()?.value;
  const priv = db.prepare("SELECT value FROM settings WHERE key = 'vapid_private_key'").get()?.value;
  if (!pub || !priv) return false;
  webpush.setVapidDetails('mailto:admin@localhost', pub, priv);
  configured = true;
  return true;
}

function getVapidPublicKey() {
  return db.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get()?.value || '';
}

async function sendPush(mac, title, body) {
  if (!ensureConfigured()) return;
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE mac_address = ?').all(mac);
  if (rows.length === 0) return;

  const payload = JSON.stringify({ title, body });
  for (const row of rows) {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload
      );
    } catch (err) {
      // 404/410 = the browser/OS invalidated this subscription (uninstalled,
      // cleared site data, etc.) - stop trying it, everything else is just
      // logged (network hiccup, push service down) since the customer's
      // internet access doesn't depend on this succeeding.
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
      } else {
        console.error(`[Push] Failed to notify ${mac}:`, err.message);
      }
    }
  }
}

module.exports = { sendPush, getVapidPublicKey };
