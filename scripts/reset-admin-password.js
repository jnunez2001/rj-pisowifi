#!/usr/bin/env node
// Resets the admin panel password from the box's own console. This is the
// way back in when the password is forgotten and no recovery code was set
// up (or the code was lost). Needs shell access to the box, so it doesn't
// ask for a code.
//
//   node scripts/reset-admin-password.js
//
// It uses the same database the running server uses: DB_PATH if set,
// otherwise the standard install location, otherwise the in-repo default.
// On success every saved device is revoked and every logged-in admin
// session is signed out (the running server notices on its next request,
// no restart needed).

const fs = require('fs');
const readline = require('readline');

const STANDARD_DB = '/var/lib/rj-pisowifi/database/rjpisowifi.db';
if (!process.env.DB_PATH && fs.existsSync(STANDARD_DB)) {
  process.env.DB_PATH = STANDARD_DB;
}

const { MIN_PASSWORD_LENGTH } = require('../server/services/adminAuthService');

// Reads a line without echoing it when attached to a terminal.
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) {
      const write = rl._writeToOutput;
      rl._writeToOutput = function (str) {
        if (rl.line === undefined || str.includes(question)) write.call(rl, str);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden && process.stdin.isTTY) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// Interactive terminal: two hidden prompts. Piped input (scripts, tests):
// the first two lines of stdin. One shared interface for piped input, since
// separate ones would swallow the second line.
async function readPasswordTwice() {
  if (process.stdin.isTTY) {
    const password = await ask(`New admin password (at least ${MIN_PASSWORD_LENGTH} characters): `, { hidden: true });
    const confirmation = await ask('Repeat the new password: ', { hidden: true });
    return [password, confirmation];
  }
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) {
    lines.push(line);
    if (lines.length === 2) break;
  }
  rl.close();
  return [lines[0] || '', lines[1] || ''];
}

async function main() {
  const db = require('../server/config/database');
  const { resetPasswordDirect } = require('../server/services/adminAuthService');

  console.log(`Database: ${process.env.DB_PATH || '(in-repo default)'}`);
  const [password, confirmation] = await readPasswordTwice();

  if (password !== confirmation) {
    console.error('The two passwords do not match. Nothing was changed.');
    process.exitCode = 1;
    return;
  }
  const result = resetPasswordDirect(db, password);
  if (!result.ok) {
    console.error(`${result.message} Nothing was changed.`);
    process.exitCode = 1;
    return;
  }
  console.log('Admin password reset. All saved devices and logged-in sessions were signed out.');
  db.close();
}

main().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
