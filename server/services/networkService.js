const { exec } = require('child_process');

/**
 * Allow a client MAC address to access the internet
 * Adds MAC to nftables allowed_macs set
 */
function allowClient(mac) {
  return new Promise((resolve, reject) => {
    exec(`sudo nft add element ip rj_piso allowed_macs { ${mac} }`,
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[Network] Failed to allow ${mac}:`, error.message);
          reject(error);
        } else {
          console.log(`[Network] Allowed: ${mac}`);
          resolve();
        }
      }
    );
  });
}

/**
 * Block a client MAC address from accessing the internet
 * Removes MAC from nftables allowed_macs set
 */
function blockClient(mac) {
  return new Promise((resolve, reject) => {
    exec(`sudo nft delete element ip rj_piso allowed_macs { ${mac} }`,
      (error, stdout, stderr) => {
        if (error) {
          // Don't reject if MAC wasn't in the set
          console.log(`[Network] Already blocked or not found: ${mac}`);
          resolve();
        } else {
          console.log(`[Network] Blocked: ${mac}`);
          resolve();
        }
      }
    );
  });
}

/**
 * Check if a MAC address is currently allowed
 */
function isClientAllowed(mac) {
  return new Promise((resolve) => {
    exec(`sudo nft list set ip rj_piso allowed_macs`,
      (error, stdout) => {
        if (error) {
          resolve(false);
        } else {
          resolve(stdout.includes(mac));
        }
      }
    );
  });
}

module.exports = { allowClient, blockClient, isClientAllowed };