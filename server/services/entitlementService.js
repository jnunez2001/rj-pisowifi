// ===== ENTITLEMENT SERVICE (Free / Grow / Pro capability gate) =====
// Real gap found while building this: the ONLY tier check in the whole
// app (admin.js's Router Mode gate) read a plain `account_tier` row from
// `settings` - and that row is set through the exact same generic
// POST /api/admin/settings loop every other setting goes through, with no
// special-casing at all. Any admin could grant themselves Premium by
// sending {"account_tier": "premium"} to their own settings endpoint,
// no payment required - the gate existed but wasn't actually backed by
// anything.
//
// This replaces the raw settings read with a real derivation: once a
// license server is configured (LICENSE_SERVER_URL set - see
// licenseService.js), the tier comes from the server-verified
// subscription_tier learned via check-in (ultimately backed by a real
// Xendit payment, see zentry-hub/functions's createSubscriptionOrder/
// xenditWebhook). The local `account_tier` setting is now only a
// fallback for installs with no license server configured yet (matches
// the existing "unlicensed = unrestricted, nothing blocks anyone until a
// license system actually exists" philosophy) - once a license server IS
// configured, the locally-editable setting can no longer promote itself
// to a paid tier.
//
// Capability-based, not scattered `if (tier === 'pro')` checks throughout
// the app (the dev handoff's own explicit rule on this) - callers ask
// canUse('capability_name'), this is the one place that knows which
// tiers grant which capability.

const db = require('../config/database');

const TIER_CAPABILITIES = {
  free: [],
  grow: ['router_mode'],
  pro: ['router_mode', 'multi_wan', 'bandwidth_profiles', 'firewall_zones'],
  premium: ['router_mode'], // legacy value some existing installs may already have set locally - treated as equivalent to 'grow'
};

function getCurrentTier() {
  const licenseService = require('./licenseService');
  const status = licenseService.getLicenseStatus();

  if (status.state !== 'unlicensed') {
    // A license server IS configured - the server-verified tier is
    // authoritative, even if the box hasn't checked in recently (in
    // which case it's whatever the last successful check-in reported,
    // same grace-period reasoning licenseService.js already applies to
    // "is this box licensed at all").
    return status.subscription_tier || 'free';
  }

  // No license server configured yet (current state of every box in the
  // field today) - fall back to the local setting so existing
  // installs/beta testers who manually set account_tier keep working
  // exactly as before.
  const row = db.prepare("SELECT value FROM settings WHERE key = 'account_tier'").get();
  return row ? row.value : 'free';
}

function canUse(capability) {
  const tier = getCurrentTier();
  const caps = TIER_CAPABILITIES[tier] || [];
  return caps.includes(capability);
}

module.exports = { getCurrentTier, canUse, TIER_CAPABILITIES };
