// ===== LICENSE SERVICE (box-side grace-period gate) =====
// Box-side half of Workstream 5/11's licensing architecture. Periodically
// checks in with a central licensing server (zenfi-platform, not built
// yet) using this box's own device identity (deviceIdentity.js), and
// tracks how long it's been since the last SUCCESSFUL check-in.
//
// Deliberately grace-period based, not an instant kill switch: this app's
// actual market (small PisoWiFi operators, often on unreliable rural
// internet) needs vending to keep working through a connectivity blip -
// see zenfiCloudClient.js's own design note ("a box must never depend on
// cloud connectivity to keep vending"). A box that's been unreachable
// LONGER than the grace period is the only case that ever degrades, and
// "degrade" is deliberately left as a hook for the caller to decide what
// that means (see getLicenseStatus() below) rather than this file forcing
// a specific enforcement action - that's a product decision, not a
// service-layer one.
//
// IMPORTANT - current state is intentionally a no-op: LICENSE_SERVER_URL
// is unset until zenfi-platform actually exists, so checkIn() below never
// makes a network call and getLicenseStatus() always reports 'unlicensed'
// (meaning "no license system active," NOT "invalid license" - nothing is
// blocked). Wiring a real server URL in later is the ONLY change needed to
// activate real enforcement; every other piece (grace period tracking,
// persistence, the check-in cadence) is already correct and ready.

const fs = require('fs');
const path = require('path');
const { getDeviceIdentity } = require('./deviceIdentity');

const DATA_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, '../database');
const STATUS_PATH = process.env.LICENSE_STATUS_PATH || path.join(DATA_DIR, '.license-status');

// Unset by design until the central platform exists - see file header.
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || null;

// How long a box can run without a successful check-in before it's
// considered "in grace period" rather than "licensed" - long enough that a
// multi-day rural internet outage doesn't cut anyone off, short enough
// that a genuinely cloned/never-connected box doesn't run forever.
const GRACE_PERIOD_MS = 72 * 60 * 60 * 1000; // 72 hours

let cachedStatus = null;

function loadStatus() {
  if (cachedStatus) return cachedStatus;
  try {
    cachedStatus = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch (e) {
    cachedStatus = { last_successful_checkin: null, last_check_error: null };
  }
  return cachedStatus;
}

function saveStatus() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATUS_PATH, JSON.stringify(cachedStatus, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[License] Failed to persist license status:', e.message);
  }
}

// Attempts a check-in against the central server. No-ops immediately (and
// harmlessly) if LICENSE_SERVER_URL isn't configured - see file header.
// Never throws; a failed check-in is recorded, not fatal, exactly the same
// "log it, don't break vending" discipline as zenfiCloudClient.js's own
// planned design.
async function checkIn() {
  loadStatus();
  if (!LICENSE_SERVER_URL) return { attempted: false };

  try {
    const device = getDeviceIdentity();
    const version = require('../../package.json').version;
    const res = await fetch(`${LICENSE_SERVER_URL}/api/license/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: device.id, version, uptime_seconds: Math.floor(process.uptime()) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    const data = await res.json();
    cachedStatus.last_successful_checkin = new Date().toISOString();
    cachedStatus.last_check_error = null;
    // update_available/latest_version surfaced from the beta portal's
    // response so the admin panel can show an "Update available" banner -
    // pull-based, the operator still clicks Update themselves (System
    // Update tab's existing git-pull mechanism), no remote-execution
    // surface added here.
    cachedStatus.update_available = !!data.update_available;
    cachedStatus.latest_version = data.latest_version || null;
    saveStatus();
    return { attempted: true, success: true };
  } catch (e) {
    console.error('[License] Check-in failed (non-fatal, box keeps vending):', e.message);
    cachedStatus.last_check_error = e.message;
    saveStatus();
    return { attempted: true, success: false, error: e.message };
  }
}

// Returns the current license state without making a network call - safe
// to call frequently (e.g. from an admin dashboard widget).
//   'unlicensed'    - no license server configured yet (current state of
//                      every box today - nothing is restricted)
//   'licensed'      - checked in successfully within the grace period
//   'grace_period'  - hasn't checked in successfully within the grace
//                      period, but a license server IS configured, so this
//                      box is expected to be checking in and isn't
function getLicenseStatus() {
  if (!LICENSE_SERVER_URL) {
    return { state: 'unlicensed', message: 'No license system configured - vending unrestricted.' };
  }
  loadStatus();
  const updateInfo = { update_available: !!cachedStatus.update_available, latest_version: cachedStatus.latest_version || null };
  if (!cachedStatus.last_successful_checkin) {
    return { state: 'grace_period', message: 'Has not checked in with the license server yet.', last_successful_checkin: null, ...updateInfo };
  }
  const elapsedMs = Date.now() - new Date(cachedStatus.last_successful_checkin).getTime();
  if (elapsedMs <= GRACE_PERIOD_MS) {
    return { state: 'licensed', last_successful_checkin: cachedStatus.last_successful_checkin, ...updateInfo };
  }
  const hoursOver = Math.round((elapsedMs - GRACE_PERIOD_MS) / (60 * 60 * 1000));
  return {
    state: 'grace_period',
    message: `Last successful check-in was over ${Math.round(elapsedMs / (60 * 60 * 1000))}h ago (${hoursOver}h past the ${GRACE_PERIOD_MS / (60 * 60 * 1000)}h grace period).`,
    last_successful_checkin: cachedStatus.last_successful_checkin,
    ...updateInfo,
  };
}

module.exports = { checkIn, getLicenseStatus, GRACE_PERIOD_MS };
