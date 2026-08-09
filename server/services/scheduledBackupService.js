// Nightly automatic database backup, separate from the on-demand Backup &
// Restore JSON export and the pre-update snapshot in admin.js's
// /install-update route. Same "plain file copy, not JSON export" reasoning
// as the pre-update backup (correct even if the app's own routes are what's
// broken) - so an operator never has to remember to click "Backup"
// themselves to avoid losing everything to a corrupted DB or bad SD card.
const fs = require('fs');
const path = require('path');

const KEEP_COUNT = 7;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

function getDbPath() {
  return process.env.DB_PATH || path.join(__dirname, '../database/rjpisowifi.db');
}

function getBackupDir() {
  return process.env.BACKUP_DIR || path.join(path.dirname(getDbPath()), 'auto-backups');
}

function runBackup() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.warn('[ScheduledBackup] Database file not found, skipping:', dbPath);
    return;
  }

  const backupDir = getBackupDir();
  try {
    fs.mkdirSync(backupDir, { recursive: true });
  } catch (e) {
    console.error('[ScheduledBackup] Could not create backup directory (non-fatal):', e.message);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destPath = path.join(backupDir, `rjpisowifi-${stamp}.db.bak`);

  try {
    fs.copyFileSync(dbPath, destPath);
    console.log(`💾 [ScheduledBackup] Nightly backup saved: ${destPath}`);
  } catch (e) {
    console.error('[ScheduledBackup] Backup failed (non-fatal, will retry next cycle):', e.message);
    return;
  }

  rotateOldBackups(backupDir);
}

function rotateOldBackups(backupDir) {
  try {
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.endsWith('.db.bak'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    files.slice(KEEP_COUNT).forEach((f) => {
      try {
        fs.unlinkSync(path.join(backupDir, f.name));
        console.log(`🗑️  [ScheduledBackup] Rotated out old backup: ${f.name}`);
      } catch (e) {
        console.warn('[ScheduledBackup] Could not remove old backup (non-fatal):', f.name, e.message);
      }
    });
  } catch (e) {
    console.warn('[ScheduledBackup] Rotation check failed (non-fatal):', e.message);
  }
}

function listBackups() {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter((f) => f.endsWith('.db.bak'))
    .map((f) => {
      const stat = fs.statSync(path.join(backupDir, f));
      return { name: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function start() {
  // Run once shortly after boot (covers boxes that reboot daily and might
  // otherwise never hit the 24h interval at a consistent time), then every
  // 24 hours after that.
  setTimeout(runBackup, 60 * 1000);
  setInterval(runBackup, INTERVAL_MS);
}

module.exports = { start, runBackup, listBackups };
