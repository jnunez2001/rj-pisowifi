const cron = require('node-cron');

function startTimer() {
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const db = require('../config/database');
      const { expireSession } = require('./sessionService');

      const now = new Date().toISOString();

      const expiredSessions = db.prepare(`
        SELECT * FROM sessions 
        WHERE expires_at <= ? AND status = 'active'
      `).all(now);

      for (const session of expiredSessions) {
        console.log(`⏰ Session expired: ${session.voucher_code}`);
        await expireSession(session.voucher_code);
      }

      const activeSessions = db.prepare(`
        SELECT * FROM sessions WHERE status = 'active'
      `).all();

      activeSessions.forEach(session => {
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
      });

    } catch (err) {
      console.error('Timer error:', err.message);
    }
  });

  console.log('✅ Timer service started');
}

module.exports = { startTimer };