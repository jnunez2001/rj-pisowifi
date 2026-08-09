// Closes the known gap flagged in the roadmap's Production Readiness Master
// Plan: the update mechanism refuses a dirty git tree and takes a pre-update
// DB backup, but had no automatic health-check-and-rollback if new code
// boots without crashing but runs incorrectly (not an outright crash -
// systemd's Restart=always and the watchdog's hang-detection both already
// cover that case). This covers the "boots fine, silently broken" case
// instead.
//
// How it works: /install-update writes a small state file recording the
// git commit it's about to move away from and the DB backup it just took,
// BEFORE pulling. On the next boot, app.js calls checkAndVerify() a few
// seconds after the server starts listening - if this box's own /api/health
// doesn't answer within a few tries, that's strong evidence the update left
// the app in a broken-but-running state, so it rolls git back to the prior
// commit, restores the DB backup, and restarts. If health checks pass, the
// state file is simply removed - nothing else happens, matching this app's
// "never block vending" pattern (a failed rollback attempt only logs, it
// never crashes boot).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, exec } = require('child_process');

function getStatePath(appDir) {
  return path.join(appDir, 'server/database/.update-rollback-state.json');
}

function recordPendingUpdate(appDir, previousCommit, dbBackupPath) {
  try {
    fs.writeFileSync(getStatePath(appDir), JSON.stringify({
      previousCommit,
      dbBackupPath,
      recordedAt: new Date().toISOString(),
    }));
  } catch (e) {
    console.error('[UpdateRollback] Could not record pending-update state (non-fatal):', e.message);
  }
}

function pingHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function checkAndVerify(appDir, port) {
  const statePath = getStatePath(appDir);
  if (!fs.existsSync(statePath)) return; // No pending update to verify - normal boot.

  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    console.warn('[UpdateRollback] Could not read pending-update state, clearing it:', e.message);
    try { fs.unlinkSync(statePath); } catch (e2) {}
    return;
  }

  // A handful of retries with a short wait - the app itself is already up
  // (this function only runs after the server starts listening), this is
  // just giving startup-time async init (DB, watchdog, etc.) a moment to
  // settle before deciding the update is genuinely broken.
  let healthy = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    healthy = await pingHealth(port);
    if (healthy) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (healthy) {
    console.log('✅ [UpdateRollback] Post-update health check passed, update verified good.');
    try { fs.unlinkSync(statePath); } catch (e) {}
    return;
  }

  console.error('');
  console.error('🚨 [UpdateRollback] Post-update health check FAILED after 5 attempts.');
  console.error('   Rolling back to the previous commit and restoring the pre-update database backup.');
  console.error('');

  try {
    if (state.dbBackupPath && fs.existsSync(state.dbBackupPath)) {
      const dbPath = process.env.DB_PATH || path.join(appDir, 'server/database/rjpisowifi.db');
      fs.copyFileSync(state.dbBackupPath, dbPath);
      console.log('[UpdateRollback] Database restored from pre-update backup.');
    }
    if (state.previousCommit) {
      execSync(`git reset --hard ${state.previousCommit}`, { cwd: appDir });
      console.log(`[UpdateRollback] Git reset to previous commit: ${state.previousCommit}`);
    }
  } catch (e) {
    console.error('[UpdateRollback] Rollback attempt itself failed (manual intervention needed):', e.message);
  }

  try { fs.unlinkSync(statePath); } catch (e) {}

  exec('sudo systemctl restart rj-pisowifi', (err) => {
    if (err) console.error('[UpdateRollback] Could not restart service after rollback (manual restart needed):', err.message);
    else console.log('[UpdateRollback] Service restarting on rolled-back code.');
  });
}

module.exports = { recordPendingUpdate, checkAndVerify };
