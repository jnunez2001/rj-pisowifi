const cron = require('node-cron');

async function restoreActiveSessions() {
  try {
    const db = require('../config/database');
    const { allowClient } = require('./networkService');

    const activeSessions = db.prepare(`
      SELECT * FROM sessions WHERE status = 'active'
    `).all();

    if (activeSessions.length === 0) {
      console.log('ℹ️ No active sessions to restore');
      return;
    }

    console.log(`🔄 Restoring ${activeSessions.length} active sessions to nftables...`);

    for (const session of activeSessions) {
      try {
        await allowClient(session.mac_address);
        console.log(`✅ Restored: ${session.voucher_code} → ${session.mac_address}`);
      } catch(e) {
        console.error(`❌ Failed to restore ${session.mac_address}:`, e.message);
      }
    }

  } catch(err) {
    console.error('Restore error:', err.message);
  }
}

function startTimer() {
  // Restore active sessions on startup
  setTimeout(restoreActiveSessions, 3000);

  cron.schedule('*/30 * * * * *', async () => {
    try {
      const db = require('../config/database');
      const { expireSession } = require('./sessionService');

      const now = new Date().toISOString();

      // Find expired sessions
      const expiredSessions = db.prepare(`
        SELECT * FROM sessions 
        WHERE expires_at <= ? 
        AND status = 'active'
        AND is_paused = 0
      `).all(now);

      if (expiredSessions.length > 0) {
        console.log(`⏰ Found ${expiredSessions.length} expired session(s)`);
      }

      for (const session of expiredSessions) {
        console.log(`⏰ Expiring: ${session.voucher_code} (${session.mac_address})`);
        await expireSession(session.voucher_code);
      }

      // Update minutes_remaining for active sessions
      const activeSessions = db.prepare(`
        SELECT * FROM sessions 
        WHERE status = 'active' 
        AND is_paused = 0
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
    }
  });

  console.log('✅ Timer service started');
}

module.exports = { startTimer };