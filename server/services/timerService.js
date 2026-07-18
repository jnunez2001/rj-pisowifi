const cron = require('node-cron');

// Track sessions being expired to prevent double expiry
const expiringNow = new Set();

// Lock to prevent cron job overlap (Bug #39)
let cronLock = false;

async function restoreActiveSessions() {
  try {
    const db = require('../config/database');
    const { allowClient, setClientBandwidth } = require('./networkService');
    const { getBurstConfig } = require('./sessionService');

    // Bug: this used to select ALL sessions, including paused ones, and
    // called allowClient() for every row — so a customer who had paused
    // their session (internet deliberately blocked, per pauseSession())
    // got un-paused for free on every reboot, since the fresh nftables
    // table setup-network.sh creates on boot has no memory of who was
    // paused. Only restore sessions that were actually active.
    const activeSessions = db.prepare(`
      SELECT * FROM sessions
      WHERE is_paused = 0
    `).all();

    if (activeSessions.length === 0) {
      console.log('ℹ️ No active sessions to restore');
      return;
    }

    console.log(`🔄 Restoring ${activeSessions.length} active sessions to nftables...`);

    // Check if bandwidth cap is enabled
    const capEnabledSetting = db.prepare("SELECT value FROM settings WHERE key = 'enable_bandwidth_cap'").get();
    const isBandwidthCapEnabled = capEnabledSetting?.value === '1';
    // Same bug as the 30s tick below: burst was never passed here either,
    // so a reboot silently dropped every active session's burst config.
    const burstConfig = getBurstConfig();

    for (const session of activeSessions) {
      try {
        await allowClient(session.mac_address);
        if (session.download_mbps) {
          const upMbps = session.upload_mbps || session.download_mbps;
          await setClientBandwidth(session.mac_address, session.download_mbps, upMbps, burstConfig);
          console.log(`✅ Restored: ${session.voucher_code} → ${session.mac_address} (${session.download_mbps}Mbps down / ${upMbps}Mbps up, voucher override)`);
        } else if (isBandwidthCapEnabled) {
          const maxMbps = db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_cap_download_mbps'").get()?.value || '5';
          const maxUploadMbps = db.prepare("SELECT value FROM settings WHERE key = 'bandwidth_cap_upload_mbps'").get()?.value || '5';
          await setClientBandwidth(session.mac_address, parseInt(maxMbps, 10) || 5, parseInt(maxUploadMbps, 10) || 5, burstConfig);
          console.log(`✅ Restored: ${session.voucher_code} → ${session.mac_address} (${maxMbps}Mbps down / ${maxUploadMbps}Mbps up)`);
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

// Re-applies every trusted device's bypass on startup, same reasoning as
// restoreActiveSessions() above — a router reboot/reconfigure or a fresh
// setup-network.sh run has no memory of who was trusted before, so this
// needs reapplying every time the server starts, not just once when the
// device was originally trusted.
async function restoreTrustedDevices() {
  try {
    const db = require('../config/database');
    const { allowClient } = require('./networkService');

    const devices = db.prepare('SELECT * FROM trusted_devices').all();
    if (devices.length === 0) {
      console.log('ℹ️ No trusted devices to restore');
      return;
    }

    console.log(`🔄 Restoring ${devices.length} trusted device(s)...`);
    for (const device of devices) {
      try {
        await allowClient(device.mac_address);
        console.log(`✅ Trusted device restored: ${device.mac_address} (${device.label || 'no label'})`);
      } catch (e) {
        console.error(`❌ Failed to restore trusted device ${device.mac_address}:`, e.message);
      }
    }
  } catch (err) {
    console.error('Restore trusted devices error:', err.message);
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
    try {
      await restoreTrustedDevices();
    } catch(e) {
      console.error('Failed to restore trusted devices on startup:', e.message);
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
      const { expireSession, resumeSession } = require('./sessionService');

      const now = new Date().toISOString();
      const getSetting = (key, def) => parseInt(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? def, 10) || def;

      // Bug: grace_period_minutes was a real, saved setting ("Extra time
      // before disconnecting after session ends" in Settings > Session
      // Settings) that nothing ever read — sessions were always cut the
      // instant expires_at passed. Shift the expiry cutoff back by the
      // grace period instead of comparing against `now` directly. Defaults
      // to 0, which reproduces the old (no-grace) behavior exactly.
      const graceMinutes = getSetting('grace_period_minutes', 0);
      const expiryCutoff = new Date(Date.now() - graceMinutes * 60000).toISOString();

      // Find expired sessions (past their grace-adjusted cutoff)
      const expiredSessions = db.prepare(`
        SELECT * FROM sessions
        WHERE expires_at <= ?
        AND is_paused = 0
      `).all(expiryCutoff);

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

      // Bug: max_pause_minutes was a real, saved setting ("Auto-resume after
      // this many minutes while paused" in Settings > Session Settings) that
      // nothing ever read — a paused session stayed paused (internet
      // blocked, minutes frozen, slot held) forever with no time limit.
      const maxPauseMinutes = getSetting('max_pause_minutes', 30);
      const pauseCutoff = new Date(Date.now() - maxPauseMinutes * 60000).toISOString();

      const overduePaused = db.prepare(`
        SELECT * FROM sessions
        WHERE is_paused = 1 AND paused_at IS NOT NULL AND paused_at <= ?
      `).all(pauseCutoff);

      for (const session of overduePaused) {
        console.log(`⏯️ Auto-resuming ${session.voucher_code} (paused over ${maxPauseMinutes}min limit)`);
        try {
          await resumeSession(session.voucher_code);
        } catch (e) {
          console.error(`Failed to auto-resume ${session.voucher_code}:`, e.message);
        }
      }

      // Update minutes_remaining for active sessions
      const activeSessions = db.prepare(`
        SELECT * FROM sessions
        WHERE is_paused = 0
      `).all();

      // Bug: access (allowClient) and bandwidth shaping (setClientBandwidth)
      // only ever got applied once - at session creation, or at server
      // boot via restoreActiveSessions(). Nothing re-asserted either one
      // afterward, so a device that forgets and rejoins the WiFi (new DHCP
      // lease, same MAC), roams between multiple APs feeding the same
      // gated lane, or hits any brief nftables/MikroTik state reset, could
      // sit with a perfectly valid session in the database while the
      // actual network-level access had gone stale - internet wouldn't
      // resume, or bandwidth shaping would still be pointed at the old,
      // now-abandoned IP. allowClient()/setClientBandwidth() both resolve
      // the client's CURRENT IP/state fresh on every call and are
      // idempotent (refresh an existing binding rather than erroring), so
      // re-asserting them here on every tick makes an active session
      // self-healing instead of "correct once, then hope nothing changes" -
      // works the same way in both standalone and router mode, since
      // networkService.js already picks the right backend.
      const capEnabledSetting = db.prepare("SELECT value FROM settings WHERE key = 'enable_bandwidth_cap'").get();
      const isBandwidthCapEnabled = capEnabledSetting?.value === '1';
      const { allowClient, setClientBandwidth } = require('./networkService');
      const { getBurstConfig } = require('./sessionService');

      // Bug found live ("burst is not working" even after the shaping
      // fixes below): this used to call setClientBandwidth() with NO
      // burst argument at all - burst.mbps/seconds only ever got applied
      // once, at session creation. This tick runs every 30s for the life
      // of every active session and silently re-created each client's
      // queue/class as a plain non-burst one every single time, wiping out
      // burst within 30 seconds of a customer connecting regardless of
      // what session creation set up. Also now respects a per-session
      // bandwidth override (Create Voucher's optional Mbps fields) instead
      // of always re-asserting the global cap over it.
      const burstConfig = getBurstConfig();

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

          try {
            await allowClient(session.mac_address);
            if (session.download_mbps) {
              await setClientBandwidth(session.mac_address, session.download_mbps, session.upload_mbps || session.download_mbps, burstConfig);
            } else if (isBandwidthCapEnabled) {
              const maxMbps = getSetting('bandwidth_cap_download_mbps', 5);
              const maxUploadMbps = getSetting('bandwidth_cap_upload_mbps', 5);
              await setClientBandwidth(session.mac_address, maxMbps, maxUploadMbps, burstConfig);
            }
          } catch (e) {
            console.error(`Failed to re-assert access for ${session.mac_address}:`, e.message);
          }
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
