// ===== MIKROTIK CAPABILITY DETECTION =====
// Real, read-only discovery of what THIS specific router actually
// supports - never assumed from its RouterOS version or board name alone.
// Per ZENFI_MASTER_DEVELOPER_HANDOFF.md section 2.3/45 ("never assume every
// device supports every feature... the UI must adapt to actual
// capabilities") and its own CAKE example: a queue type or protocol menu
// existing on one router doesn't mean it exists on the next one, so every
// capability here is either read directly off the device (packages, queue
// types) or confirmed by actually calling the relevant menu path and
// checking whether RouterOS accepts or rejects it - never inferred from
// version number or board name.

const { withMikrotik } = require('./mikrotikApiClient');
const { getMikrotikConfig } = require('./mikrotikConfigHelper');

// Calls a RouterOS menu path purely to see whether it exists on this
// device - RouterOS returns a !trap ("no such command") for a menu that
// isn't present (e.g. /routing/bgp/print on a router with no BGP support),
// which the client surfaces as a rejected promise. A real result (even an
// empty list) means the menu exists and the feature is available.
async function probe(client, cmd) {
  try {
    const res = await client.talk(cmd);
    return { available: true, rows: res.re };
  } catch (e) {
    return { available: false, rows: [] };
  }
}

async function detectMikrotikCapabilities() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');

  return withMikrotik(config, async (client) => {
    const [resourceRes, packagesRes] = await Promise.all([
      client.talk(['/system/resource/print']),
      client.talk(['/system/package/print']),
    ]);
    const r = resourceRes.re[0] || {};
    const packages = packagesRes.re.map((p) => ({
      name: p.name,
      version: p.version || '',
      disabled: p.disabled === 'true',
    }));

    // Queue types: the handoff's own worked example - a router with a
    // manually-created CAKE queue type must show CAKE as available, a
    // router without one must not, regardless of RouterOS version.
    const queueTypesProbe = await probe(client, ['/queue/type/print']);
    const queueTypes = queueTypesProbe.rows.map((q) => ({
      name: q.name,
      kind: q.kind || '',
    }));
    const hasCake = queueTypes.some((q) => q.kind.toLowerCase() === 'cake');

    // Each of these is a real menu-path probe, not a package-name guess -
    // RouterOS 6 vs 7 package boundaries for routing protocols differ
    // enough (many merged into a single 'routing' package on v7) that
    // package presence alone isn't a reliable signal; asking the menu
    // directly is.
    const [wireguard, ipsec, bgp6, bgp7, ospf, radius, hotspot, l2tp, ovpn] = await Promise.all([
      probe(client, ['/interface/wireguard/print']),
      probe(client, ['/ip/ipsec/policy/print']),
      probe(client, ['/routing/bgp/instance/print']), // RouterOS 6 path
      probe(client, ['/routing/bgp/print']), // RouterOS 7 path
      probe(client, ['/routing/ospf/instance/print']),
      probe(client, ['/radius/print']),
      probe(client, ['/ip/hotspot/print']),
      probe(client, ['/interface/l2tp-server/print']),
      probe(client, ['/interface/ovpn-server/print']),
    ]);

    return {
      model: r['board-name'] || 'Unknown',
      routerosVersion: r['version'] || 'Unknown',
      architecture: r['architecture-name'] || 'Unknown',
      packages,
      queueTypes,
      capabilities: {
        cake: hasCake,
        wireguard: wireguard.available,
        ipsec: ipsec.available,
        bgp: bgp6.available || bgp7.available,
        ospf: ospf.available,
        radius: radius.available,
        hotspot: hotspot.available,
        l2tp: l2tp.available,
        ovpn: ovpn.available,
      },
    };
  });
}

module.exports = { detectMikrotikCapabilities };
