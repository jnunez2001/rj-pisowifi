// ===== DRIVER REGISTRY =====
// One place that maps a network_mode setting value to its driver
// implementation. Adding a new backend (pfSense, Workstream 3) means
// adding one entry here, not editing every function in networkService.js.

const standaloneDriver = require('./standaloneDriver');
const mikrotikDriver = require('./mikrotikDriver');
const openwrtDriver = require('./openwrtDriver');

const DRIVERS = {
  standalone: standaloneDriver,
  mikrotik: mikrotikDriver,
  openwrt: openwrtDriver,
};

function getDriver(mode) {
  return DRIVERS[mode] || DRIVERS.standalone;
}

module.exports = { DRIVERS, getDriver };
