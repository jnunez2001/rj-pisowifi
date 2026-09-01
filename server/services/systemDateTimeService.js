// ===== SYSTEM DATE & TIME =====
// Lets an operator fix a wrong server clock/timezone from the admin
// panel instead of needing shell access. Deliberately NTP-first (a
// "keep time synced automatically" toggle + timezone dropdown), not
// free-text manual date entry - letting the clock sync itself over the
// internet is the safer, self-correcting fix, and avoids ever needing
// to parse/validate an arbitrary operator-typed date/time string that
// gets shelled out to `date -s`.
//
// Requires the service account this app runs as to have passwordless
// sudo for exactly these two timedatectl subcommands - see this
// project's README/deployment notes for the sudoers snippet. Every
// value written here is validated first (timezone checked against
// `timedatectl list-timezones`' own real output, ntp_enabled coerced
// to a strict boolean) before ever reaching execFile, and always
// passed as separate argv entries (never through a shell), so nothing
// operator-supplied can inject extra commands.
const { execFile } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout.trim());
    });
  });
}

async function getStatus() {
  const raw = await run('timedatectl', ['show', '-p', 'Timezone', '-p', 'NTP', '-p', 'NTPSynchronized']);
  const props = Object.fromEntries(
    raw.split('\n').filter(Boolean).map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx), line.slice(idx + 1)];
    })
  );
  return {
    timezone: props.Timezone || 'UTC',
    ntp_enabled: props.NTP === 'yes',
    ntp_synchronized: props.NTPSynchronized === 'yes',
    current_time: new Date().toISOString()
  };
}

let cachedTimezones = null;
async function listTimezones() {
  if (cachedTimezones) return cachedTimezones;
  const raw = await run('timedatectl', ['list-timezones']);
  cachedTimezones = raw.split('\n').filter(Boolean);
  return cachedTimezones;
}

async function setNtpEnabled(enabled) {
  await run('sudo', ['timedatectl', 'set-ntp', enabled ? 'true' : 'false']);
}

async function setTimezone(timezone) {
  const valid = await listTimezones();
  if (!valid.includes(timezone)) {
    throw new Error('Unknown timezone');
  }
  await run('sudo', ['timedatectl', 'set-timezone', timezone]);
}

module.exports = { getStatus, listTimezones, setNtpEnabled, setTimezone };
