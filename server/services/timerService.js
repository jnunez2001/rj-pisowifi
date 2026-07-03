const cron = require('node-cron');

// Track sessions being expired to prevent double expiry
const expiringNow = new Set();

// Lock to prevent cron job overlap (Bug #39)
let cronLock = false;

async function restoreActiveSessions() {
  try {
    const db = require('../config/database');
    const { allowClient, setClientBandwidth } = require('./networkService');

    const activeSessions = db.prepare(`
      SELECT * FROM sessions
    `).all();

    if (activeSessions.length === 0) {
      console.log('ℹ️ No active sessions to restore');
      return;
    }

    console.log(`🔄 Restoring ${activeSessions.length} active sessions to nftables...`);

    // Check if bandwidth cap is enabled
    const capEnabledSetting = db.prepare("SELECT value FROM settings WHERE key = 'enable_bandwidth_cap'").get();
    const isBandwidthCapEnabled = capEnabledSetting?.value === '1';

    for (const session of activeSessions) {
      try {
        await allowClient(session.mac_address);
        if (isBandwidthCapEnabled) {
          const maxMbps = db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_cap_download_mbps'").get()?.value || '5';
          await setClientBandwidth(session.mac_address, parseInt(maxMbps, 10) || 5);
          console.log(`✅ Restored: ${session.voucher_code} → ${session.mac_address} (${maxMbps} Mbps)`);
        } else {
          console.log(`✅ Restored: ${session.voucher_code} → ${session.mac_address} (no cap)`);
        }
      } catch(e) {
        console.error(`❌ Failed to restore ${session.mac_address}:`, e.message);
      }
    }

  } catch(err) {
    console.error('Restore error:', err.message);
  }
}

function checkTcQdisc() {
  try {
    const db = require('../config/database');
    const lanIf = db.prepare("SELECT value FROM settings WHERE key = 'lan_interface'").get()?.value || 'enp0s8';
    const { execSync } = require('child_process');
    const result = execSync(`tc qdisc show dev ${lanIf}`).toString();
    if (result.includes('htb') && result.includes('root')) {
      console.log(`✅ [TC] Traffic control qdisc exists on ${lanIf}`);
      return true;
    }
    console.warn(`⚠️ [TC] Root qdisc not found on ${lanIf}. Bandwidth shaping may not work.`);
    console.warn(`⚠️ [TC] Please run: sudo bash setup-network.sh`);
    return false;
  } catch(e) {
    console.warn(`⚠️ [TC] Could not verify traffic control setup:`, e.message);
    return false;
  }
}

async function startTimer() {
  // Check tc qdisc on startup
  setTimeout(checkTcQdisc, 1000);

  // Restore active sessions on startup (wait for completion, Bug #40)
  setTimeout(async () => {
    try {
      await restoreActiveSessions();
    } catch(e) {
      console.error('Failed to restore sessions on startup:', e.message);
    }
  }, 3000);

  cron.schedule('*/30 * * * * *', async () => {
    // Prevent overlap: skip if previous job still running (Bug #39)
    if (cronLock) {
      console.warn('⚠️ [Timer] Previous cron job still running, skipping this cycle');
      return;
    }

    cronLock = true;
    try {
      const db = require('../config/database');
      const { expireSession } = require('./sessionService');

      const now = new Date().toISOString();

      // Find expired sessions
      const expiredSessions = db.prepare(`
        SELECT * FROM sessions
        WHERE expires_at <= ?
        AND is_paused = 0
      `).all(now);

      for (const session of expiredSessions) {
        // Skip if already being expired
        if (expiringNow.has(session.voucher_code)) continue;

        expiringNow.add(session.voucher_code);
        console.log(`⏰ Expiring: ${session.voucher_code} (${session.mac_address})`);

        try {
          await expireSession(session.voucher_code);
        } finally {
          expiringNow.delete(session.voucher_code);
        }
      }

      // Update minutes_remaining for active sessions
      const activeSessions = db.prepare(`
        SELECT * FROM sessions
        WHERE is_paused = 0
      `).all();

      for (const session of activeSessions) {
        const remaining = (
          new Date(session.expires_at) - new Date()
        ) / 60000;

        if (remaining > 0) {
          db.prepare(`
            UPDATE sessions 
            SET minutes_remaining = ?
            WHERE voucher_code = ?
          `).run(remaining, session.voucher_code);
        }
      }

    } catch (err) {
      console.error('Timer error:', err.message);
    } finally {
      cronLock = false;
    }
  });

  console.log('✅ Timer service started');
}

module.exports = { startTimer };
