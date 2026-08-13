// ===== VENDO PUBLIC ROUTES =====
// Unauthenticated by design (a not-yet-adopted device has no credential to
// authenticate with) - matches the spec's "Discovery must NOT establish
// trust by itself". Registering as a candidate only makes the device
// visible to an admin for approval; it grants no access to anything.

const express = require('express');
const router = express.Router();
const { registerCandidate } = require('../services/satelliteKioskService');

// POST /api/vendo/announce — a Vendo calls this after discovering this
// box's address (see vendoDiscoveryService.js), announcing itself as a
// candidate for an admin to review/adopt.
router.post('/announce', (req, res) => {
  try {
    const { mac, firmware_version, hardware } = req.body;
    const result = registerCandidate({ mac, firmwareVersion: firmware_version, hardware });
    return res.json({ success: true, status: result.status });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
