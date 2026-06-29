const { exec } = require('child_process');

function allowClient(mac) {
  return new Promise((resolve, reject) => {
    const normalizedMac = mac.toLowerCase();
    exec(`sudo nft add element ip rj_piso allowed_macs { ${normalizedMac} }`,
      (error, stdout, stderr) => {
        if (error) {
          if (stderr && stderr.includes('already')) {
            console.log(`[Network] Already allowed: ${normalizedMac}`);
            resolve();
          } else {
            console.error(`[Network] Failed to allow ${normalizedMac}:`, error.message);
            reject(error);
          }
        } else {
          console.log(`[Network] Allowed: ${normalizedMac}`);
          resolve();
        }
      }
    );
  });
}

function blockClient(mac) {
  return new Promise((resolve) => {
    const normalizedMac = mac.toLowerCase();
    exec(`sudo nft delete element ip rj_piso allowed_macs { ${normalizedMac} }`,
      (error, stdout, stderr) => {
        if (error) {
          console.log(`[Network] Already blocked or not found: ${normalizedMac}`);
        } else {
          console.log(`[Network] Blocked: ${normalizedMac}`);
        }
        resolve();
      }
    );
  });
}

function isClientAllowed(mac) {
  return new Promise((resolve) => {
    exec(`sudo nft list set ip rj_piso allowed_macs`,
      (error, stdout) => {
        if (error) resolve(false);
        else resolve(stdout.toLowerCase().includes(mac.toLowerCase()));
      }
    );
  });
}

module.exports = { allowClient, blockClient, isClientAllowed };