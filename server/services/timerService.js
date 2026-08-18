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

          // Web Push "2 minutes left" alert - only for a customer who
          // actually opted in (push_subscriptions has no row for anyone
          // who didn't, and pushNotificationService.sendPush() just no-ops
          // in that case). push_2min_sent stops this firing again every
          // tick for the same low-time window; addTimeToSession() resets
          // it if they top up, so a later low-time window warns again.
          if (remaining <= 2 && !session.push_2min_sent) {
            db.prepare('UPDATE sessions SET push_2min_sent = 1 WHERE voucher_code = ?').run(session.voucher_code);
            require('./pushNotificationService').sendPush(
              session.mac_address,
              '⏰ 2 Minutes Left',
              'Your WiFi time is almost up. Tap to add more.'
            ).catch(() => {});
          }
        }
      }

      // Bug found live: a customer's bandwidth queue survived on the
      // router pointed at a stale IP long after their session had ended -
      // normal cleanup (expireSession() -> removeClientBandwidth()) only
      // fires when a session ends gracefully; a server restart, crash, or
      // manual DB edit mid-session skips it, leaving an orphaned queue
      // that permanently shadows whatever new IP that MAC gets later since
      // nothing ever tells the router to drop it. Runs every tick so a
      // stale queue is gone within 30s instead of surviving indefinitely.
      const { isMikrotikModeEnabled, pruneOrphanedQueues } = require('./mikrotikService');
      if (isMikrotikModeEnabled()) {
        try {
          // Bug avoidance: activeSessions above excludes paused sessions
          // (is_paused=0) since a paused customer's bandwidth shouldn't be
          // reasserted while blocked - but their queue is still legitimate
          // and shouldn't be pruned as an orphan. Query every session
          // (paused or not) for this allowlist, not just the active ones.
          const allMacs = db.prepare('SELECT mac_address FROM sessions').all().map((s) => s.mac_address);
          await pruneOrphanedQueues(allMacs);
        } catch (e) {
          console.error('Failed to prune orphaned bandwidth queues:', e.message);
        }
      }

      // Premium coin rates (Plans page) grant a temporary bandwidth boost
      // separate from a session's regular minutes_remaining countdown -
      // nothing else ever revisits a session once created/topped-up, so
      // once premium_expires_at passes there'd be no reversion event
      // without this: the customer would just keep whatever speed they
      // had baked into the last setClientBandwidth() call forever.
      const expiredPremium = db.prepare(`
        SELECT mac_address FROM sessions
        WHERE premium_expires_at IS NOT NULL AND premium_expires_at <= ?
      `).all(now);
      if (expiredPremium.length) {
        const { reapplyBandwidth } = require('./sessionService');
        for (const { mac_address } of expiredPremium) {
          console.log(`⚡ Premium speed expired for ${mac_address}, reverting bandwidth`);
          await reapplyBandwidth(mac_address);
        }
        db.prepare(`
          UPDATE sessions
          SET premium_download_mbps = NULL, premium_upload_mbps = NULL, premium_expires_at = NULL
          WHERE premium_expires_at IS NOT NULL AND premium_expires_at <= ?
        `).run(now);
      }

      // Scheduled Vendo restarts (admin panel's per-device restart_schedule,
      // 'HH:MM' 24h). Compared against the minute this tick falls in, not
      // an exact-second match, since this cron only runs every 30s and a
      // tick can land a few seconds either side of :00. last_scheduled_restart
      // (the "YYYY-MM-DD HH:MM" this last actually fired) stops it firing
      // twice within the same minute, or re-firing after a server restart
      // that happens to land in the same minute as an already-completed one.
      //
      // Uses this server's OS-configured timezone, not the admin browser's -
      // the <input type="time"> in the Devices page's Device Details modal
      // is only "3am" in the sense the admin meant if this box's own clock
      // is already set to their local timezone (e.g. `sudo timedatectl
      // set-timezone Asia/Manila`, same as any other server-side scheduled
      // job). A box left on its default UTC install would fire restarts at
      // the wrong real-world hour.
      const dueVendos = db.prepare(`SELECT id, mac_address, ip_address, restart_schedule, last_scheduled_restart FROM vendos WHERE restart_schedule IS NOT NULL`).all();
      if (dueVendos.length) {
        const nowDate = new Date();
        const currentHHMM = `${String(nowDate.getHours()).padStart(2, '0')}:${String(nowDate.getMinutes()).padStart(2, '0')}`;
        const currentStamp = nowDate.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
        for (const v of dueVendos) {
          if (v.restart_schedule !== currentHHMM) continue;
          if (v.last_scheduled_restart === currentStamp) continue; // already fired this minute
          if (!v.ip_address) continue;

          db.prepare('UPDATE vendos SET last_scheduled_restart = ? WHERE id = ?').run(currentStamp, v.id);
          console.log(`⏰ Scheduled restart firing for vendo ${v.mac_address} (${v.restart_schedule})`);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          fetch(`http://${v.ip_address}/restart`, { method: 'POST', signal: controller.signal })
            .catch((e) => console.error(`Scheduled restart failed for vendo ${v.mac_address}:`, e.message))
            .finally(() => clearTimeout(timeout));
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
