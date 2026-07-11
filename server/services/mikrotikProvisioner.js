// ===== MIKROTIK AUTO-PROVISIONING ===== (ROUTER_MODE_PLAN.md Stage 4,
// extended Stage 7 for flexible VLAN tagging)
//
// Turns the saved lane definitions (router_ports table) into an actual
// RouterOS configuration, pushed live over the same binary API connection
// as everything else in mikrotikService.js. This is the "Configure" button.
//
// One row in router_ports = one LANE, not one port. A physical port can
// carry several lanes at once: one untagged lane (vlan_id = 0) plus any
// number of VLAN-tagged lanes sharing the same wire. Any lane can join any
// other lane (same port or a different one, tagged or not) via
// bridge_with_id - this is deliberately general rather than hardcoded to
// one topology, so an operator can wire things however their location
// actually needs.
//
// For each lane that's a "primary" (not itself joining another lane):
// - Its bridge picks up every lane joined to it (bridge_with_id points at
//   the primary's row id), plus itself.
// - Each member's actual router-side interface is either the raw physical
//   port (vlan_id 0) or a VLAN sub-interface created on top of that port
//   (vlan_id > 0, e.g. "ether2-vlan13") - created fresh each time, never
//   assumed to already exist.
// - "gated" lanes get a full Hotspot; "open" lanes just get DHCP + NAT
//   sharing, no Hotspot at all.
// Subnets are auto-allocated as 10.50.<n>.0/24, deliberately different
// from standalone mode's 10.0.0.x convention so the two are never
// confusable even though they're mutually exclusive modes.

const os = require('os');
const db = require('../config/database');
const { getMikrotikConfig } = require('./mikrotikConfigHelper');
const { withMikrotik } = require('./mikrotikApiClient');
const { encryptSecret } = require('../utils/secretCrypto');

const API_USER_GROUP = 'rj-pisowifi-api';
const API_USER_NAME = 'rj-pisowifi-api';

function subnetFor(index) {
  return { network: `10.50.${index}.0`, gateway: `10.50.${index}.1`, cidr: 24 };
}

function generatedPassword() {
  return require('crypto').randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
}

// The actual RouterOS interface name for a lane's port+vlan combination -
// the raw port itself when untagged, or a VLAN sub-interface name when
// tagged. Kept as one helper so bridge-membership and VLAN-creation code
// always agree on the same naming.
function laneInterfaceName(lane) {
  return lane.vlan_id ? `${lane.port_name}-vlan${lane.vlan_id}` : lane.port_name;
}

// Lists this server's own local network interfaces (name + MAC), for the
// admin to explicitly pick which one is plugged into the gated lane.
function listLocalInterfaces() {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (!iface.internal && iface.family === 'IPv4' && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        result.push({ name, mac: iface.mac, address: iface.address });
        break; // one entry per interface name is enough
      }
    }
  }
  return result;
}

// Bug (real, not just theoretical): a machine with more than one network
// connection - exactly the topology this project's own planning worked
// through (built-in LAN for one VM, a USB-to-LAN adapter for another) -
// has no reliable "first" interface. Guessing risked reserving the wrong
// device's address, silently breaking the "server is always reachable at
// a fixed address" guarantee the walled-garden rule depends on. The admin
// must explicitly pick the right one (server_lan_mac setting, set from the
// Connection card); auto-guessing a single candidate is only used as a
// last resort when there's truly only one option and nothing was chosen.
function getOwnMac() {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'server_lan_mac'").get();
  if (setting && setting.value) return setting.value;

  const candidates = listLocalInterfaces();
  if (candidates.length === 1) return candidates[0].mac;
  return null;
}

// Parses a RouterOS /system/resource/print "version" string (e.g.
// "7.15 (stable)" or "6.49.10 (long-term)") down to the major version
// number. Returns null if it can't be parsed (treated as "unknown" by
// callers, not as a specific version).
function parseRouterOsMajor(versionString) {
  const match = String(versionString || '').match(/^(\d+)\./);
  return match ? parseInt(match[1], 10) : null;
}

// Builds the full ordered list of RouterOS commands. Returns
// [{ description, words }] - description is what the preview UI shows,
// words is what actually gets sent via client.talk(words).
// routerOsMajor: pass 6 or 7 if known (detected live in apply(), or
// best-effort in preview()) - null means unknown, and CAKE is assumed
// (documented as an assumption in a warning, not silently guessed).
// ownPortName: the physical port this server's own connection is currently
// arriving through, if known (detected live in apply()/preview() via
// detectOwnPort()) - see the reordering below for why this matters.
function buildPlan(routerOsMajor, ownPortName) {
  const allLanes = db.prepare('SELECT * FROM router_ports WHERE role != ? ORDER BY id').all('unused');
  const wanLanes = allLanes.filter((l) => l.role === 'wan');
  const laneCandidates = allLanes.filter((l) => l.role === 'gated' || l.role === 'open');

  // Primaries: lanes not themselves joining another lane. Members: lanes
  // whose bridge_with_id points at a primary's row id.
  const primaryLanes = laneCandidates.filter((l) => !l.bridge_with_id);
  const membersByPrimaryId = {};
  for (const l of laneCandidates) {
    if (l.bridge_with_id) {
      (membersByPrimaryId[l.bridge_with_id] = membersByPrimaryId[l.bridge_with_id] || []).push(l);
    }
  }

  // Bug #98 follow-up: freeing+rebuilding a port that happens to carry this
  // app's own connection to the router (a real topology - the server
  // plugged straight into the port it's also reconfiguring) is inherently
  // risky, since the control connection issuing every subsequent command
  // travels over that same wire. Freeing it can't be avoided entirely (it's
  // still part of the plan), but the *risk window* can be minimized: process
  // whichever lane owns that port dead last, after every other lane has
  // already been fully built and confirmed working. That way, if anything
  // in this run is going to fail, it fails on some other port first, before
  // ever touching the one this app itself depends on - and that port's own
  // brief disconnection happens right at the very end, with nothing left
  // afterward that could be aborted by losing it early.
  if (ownPortName) {
    // A single physical port can anchor more than one lane at once (its
    // own untagged lane plus a VLAN-tagged lane sharing the same wire, e.g.
    // ether2 carrying both a plain lane and a VLAN 13 lane) - every lane
    // touching that port needs to move, not just the first one found.
    const ownsPort = (l) => l.port_name === ownPortName
      || (membersByPrimaryId[l.id] || []).some((m) => m.port_name === ownPortName);
    const notOwning = primaryLanes.filter((l) => !ownsPort(l));
    const owning = primaryLanes.filter(ownsPort);
    primaryLanes.length = 0;
    primaryLanes.push(...notOwning, ...owning);
  }

  const steps = [];
  const warnings = [];

  const ownMac = getOwnMac();
  if (!ownMac && primaryLanes.some((l) => l.role === 'gated')) {
    const candidates = listLocalInterfaces();
    const consequence = 'the DHCP reservation for the server itself AND the fix that replaces MikroTik\'s own login page with your portal will both be skipped - customers would see MikroTik\'s default login screen instead of your portal';
    if (candidates.length > 1) {
      warnings.push(`This server has ${candidates.length} network connections (${candidates.map((c) => c.name).join(', ')}) and none is selected as "Server's network connection" in Connection settings - ${consequence}. Pick the right one there before configuring.`);
    } else {
      warnings.push(`Could not determine this server's own MAC address - ${consequence}.`);
    }
  }

  // CAKE (ROUTER_MODE_PLAN.md §9) only exists as a queue type starting in
  // RouterOS 7 - on RouterOS 6 it falls back to PCQ (a much older, still
  // widely-used MikroTik fairness queue, built in on every version), which
  // shares bandwidth fairly between clients but doesn't specifically fight
  // bufferbloat the way CAKE does. Unknown version (router unreachable
  // during Preview) assumes CAKE and says so, rather than silently guessing.
  const useCake = routerOsMajor !== 6;
  if (routerOsMajor == null) {
    warnings.push('Could not confirm the router\'s RouterOS version, so this preview assumes CAKE (RouterOS 7+) for the smart queue. If this router is actually on RouterOS 6, Configure will detect that live and use the RouterOS 6 fallback (PCQ) automatically instead.');
  } else if (routerOsMajor === 6) {
    warnings.push('This router is on RouterOS 6, which doesn\'t have the CAKE queue type - using PCQ instead for the smart queue. It still shares bandwidth fairly between clients, but doesn\'t fight bufferbloat as specifically as CAKE does on RouterOS 7.');
  }

  // WAN: NAT masquerade out each WAN-role port (WAN lanes are always
  // untagged - VLAN tagging a WAN uplink isn't something this build supports).
  for (const w of wanLanes) {
    steps.push({
      description: `Enable internet sharing (NAT) out ${w.port_name} (WAN)`,
      words: ['/ip/firewall/nat/add', '=chain=srcnat', `=out-interface=${w.port_name}`, '=action=masquerade', `=comment=rj-piso-wan-${w.port_name}`],
    });
  }

  // Bug (found on the first real-hardware run, not just theoretical): a
  // brand-new router isn't actually blank - MikroTik's own factory-default
  // config usually already bridges most LAN ports together, and a port can
  // only belong to one bridge at a time, so each port needs freeing from
  // whatever bridge currently holds it before it can join one of ours.
  // This USED to run as one global pass freeing every port before building
  // ANY new bridge - which meant a port could sit completely disconnected
  // for the entire rest of that pass, and worse, if the very server running
  // this app is reachable through one of those ports (a very real topology,
  // not an edge case - a laptop plugged straight into the port it's also
  // configuring), freeing it early cut this app's own connection to the
  // router before the run could finish, stranding that port indefinitely
  // and aborting the whole Configure with no way to recover except a manual
  // fix on the router itself. Fixed by freeing each port immediately before
  // its own bridge attachment, interleaved per-lane, so the gap between
  // "disconnected" and "back on a working bridge" is a couple of API calls,
  // not the rest of the entire run. freedPorts tracks what's already been
  // freed this run so a port used by two different lanes (its own untagged
  // lane plus a VLAN-tagged lane on the same wire) only gets freed once -
  // freeing it again after it's already a member of its first bridge would
  // rip it right back out.
  const freedPorts = new Set();
  function freeStepFor(portName) {
    if (freedPorts.has(portName)) return null;
    freedPorts.add(portName);
    return { type: 'free-port', portName, description: `Free ${portName} from any existing bridge (factory default or a previous run)` };
  }

  primaryLanes.forEach((lane, index) => {
    const { network, gateway, cidr } = subnetFor(index);
    const laneLabel = lane.lane_name || `${lane.port_name}${lane.vlan_id ? ` (VLAN ${lane.vlan_id})` : ''}`;
    const bridgeName = `rj-${lane.port_name}${lane.vlan_id ? `-v${lane.vlan_id}` : ''}`;
    const poolName = `${bridgeName}-pool`;
    const dhcpName = `${bridgeName}-dhcp`;
    const members = membersByPrimaryId[lane.id] || [];
    const allMembers = [lane, ...members];

    const freeSteps = allMembers.map((m) => freeStepFor(m.port_name)).filter(Boolean);
    steps.push(...freeSteps);

    steps.push({
      description: `[${laneLabel}] Create bridge for ${allMembers.map((m) => m.vlan_id ? `${m.port_name} VLAN ${m.vlan_id}` : m.port_name).join(' + ')}`,
      words: ['/interface/bridge/add', `=name=${bridgeName}`, `=comment=rj-piso-${laneLabel}`],
    });
    for (const member of allMembers) {
      if (member.vlan_id) {
        const vlanIface = laneInterfaceName(member);
        steps.push({
          description: `[${laneLabel}] Create VLAN ${member.vlan_id} on ${member.port_name}`,
          words: ['/interface/vlan/add', `=interface=${member.port_name}`, `=vlan-id=${member.vlan_id}`, `=name=${vlanIface}`],
        });
        steps.push({ description: `[${laneLabel}] Attach VLAN ${member.vlan_id} on ${member.port_name} to its bridge`, words: ['/interface/bridge/port/add', `=bridge=${bridgeName}`, `=interface=${vlanIface}`] });
      } else {
        steps.push({ description: `[${laneLabel}] Attach ${member.port_name} to its bridge`, words: ['/interface/bridge/port/add', `=bridge=${bridgeName}`, `=interface=${member.port_name}`] });
      }
    }
    steps.push({ description: `[${laneLabel}] Assign ${gateway}/${cidr} to the bridge`, words: ['/ip/address/add', `=address=${gateway}/${cidr}`, `=interface=${bridgeName}`] });
    steps.push({ description: `[${laneLabel}] Create DHCP address pool`, words: ['/ip/pool/add', `=name=${poolName}`, `=ranges=10.50.${index}.10-10.50.${index}.250`] });
    steps.push({ description: `[${laneLabel}] Start DHCP server on the bridge`, words: ['/ip/dhcp-server/add', `=name=${dhcpName}`, `=interface=${bridgeName}`, `=address-pool=${poolName}`, '=lease-time=2h', '=disabled=no'] });
    steps.push({ description: `[${laneLabel}] Configure DHCP network`, words: ['/ip/dhcp-server/network/add', `=address=${network}/${cidr}`, `=gateway=${gateway}`, '=dns-server=8.8.8.8'] });

    // Smart queue (ROUTER_MODE_PLAN.md §9) - always on, per lane, using the
    // guaranteed/burst caps saved for this lane. CAKE on RouterOS 7+, PCQ
    // fallback on RouterOS 6 (see useCake above).
    if (lane.speed_mbps > 0) {
      const maxMbps = lane.speed_mbps + (lane.burst_mbps || 0);
      const queueType = useCake ? 'cake/cake' : 'pcq-upload-default/pcq-download-default';
      steps.push({
        description: `[${laneLabel}] Smart queue (lag protection${useCake ? '' : ', RouterOS 6 fallback'}): ${lane.speed_mbps}Mbps guaranteed, up to ${maxMbps}Mbps burst`,
        words: ['/queue/simple/add', `=name=${bridgeName}-queue`, `=target=${network}/${cidr}`, `=max-limit=${maxMbps}M/${maxMbps}M`, `=burst-limit=${maxMbps}M/${maxMbps}M`, `=queue=${queueType}`],
      });
    }

    if (lane.role === 'gated') {
      const profileName = `${bridgeName}-profile`;
      const hotspotName = `${bridgeName}-hotspot`;
      const htmlDir = `${bridgeName}-hotspot-html`;
      const serverIp = `10.50.${index}.5`;

      if (ownMac) {
        // Reserve and allow-list the server's address before the Hotspot
        // starts pointing at it, so both are already true the moment the
        // fetch step below tries to reach it.
        steps.push({ description: `[${laneLabel}] Reserve a fixed address for this server`, words: ['/ip/dhcp-server/lease/add', `=address=${serverIp}`, `=mac-address=${ownMac}`, `=server=${dhcpName}`, '=comment=rj-piso-server'] });
        steps.push({ description: `[${laneLabel}] Allow the portal page through the walled garden (always)`, words: ['/ip/hotspot/walled-garden/add', `=dst-host=${serverIp}`, '=action=allow', '=comment=rj-piso-portal'] });
      }

      // Bug fix: without this, MikroTik shows its own generic built-in
      // login page to new customers instead of this app's portal - the
      // walled-garden rule above only let the *portal* through, it never
      // told Hotspot to actually send anyone there first. Point this
      // lane's Hotspot at its own html directory, then have the router
      // itself fetch this app's redirect stub (server/app.js's
      // /hotspot-login) and save it as that directory's login.html,
      // overwriting MikroTik's default.
      steps.push({ description: `[${laneLabel}] Create Hotspot profile`, words: ['/ip/hotspot/profile/add', `=name=${profileName}`, `=hotspot-address=${gateway}`, `=html-directory=${htmlDir}`] });
      if (ownMac) {
        steps.push({ description: `[${laneLabel}] Replace the router's default login page with a redirect to the portal`, words: ['/tool/fetch', `=url=http://${serverIp}:3000/hotspot-login`, `=dst-path=${htmlDir}/login.html`] });
      }
      steps.push({ description: `[${laneLabel}] Start Hotspot server on the bridge`, words: ['/ip/hotspot/add', `=name=${hotspotName}`, `=interface=${bridgeName}`, `=address-pool=${poolName}`, `=profile=${profileName}`, '=disabled=no'] });
    }
  });

  // Dedicated least-privilege API user (SECURITY_PLAN.md Tier 1) - the
  // app switches to using this instead of the admin login that was used
  // to run the Configure step itself.
  const apiPassword = generatedPassword();
  steps.push({ description: 'Create a limited-permission group for this app to use going forward', words: ['/user/group/add', `=name=${API_USER_GROUP}`, '=policy=read,write,api,!local,!telnet,!ssh,!ftp,!reboot,!policy,!winbox,!password,!web,!sniff,!sensitive,!romon'] });
  steps.push({ description: 'Create a dedicated API user in that group (not the router\'s real admin login)', words: ['/user/add', `=name=${API_USER_NAME}`, `=password=${apiPassword}`, `=group=${API_USER_GROUP}`] });

  return { steps, warnings, apiPassword };
}

// Best-effort live version check for Preview, so the shown plan matches
// what Configure will actually do when possible - falls back to "unknown"
// (buildPlan() then assumes CAKE and says so) if the router can't be
// reached right now, rather than failing the whole preview over it.
async function detectRouterOsMajor() {
  const config = getMikrotikConfig();
  if (!config.ip) return null;
  try {
    return await withMikrotik(config, async (client) => {
      const res = await client.talk(['/system/resource/print']);
      return parseRouterOsMajor((res.re[0] || {}).version);
    });
  } catch (e) {
    return null;
  }
}

// Finds which physical port this server's own MAC is currently arriving
// through, via the router's bridge host table (which port last saw traffic
// from that MAC) - so buildPlan() can deliberately save that lane for last.
// Falls back to null (buildPlan() then just uses natural DB order, same as
// before this existed) if ownMac is unknown or the router can't answer.
async function detectOwnPort(client, ownMac) {
  if (!ownMac) return null;
  try {
    const res = await client.talk(['/interface/bridge/host/print', `?mac-address=${ownMac}`]);
    return (res.re[0] || {})['on-interface'] || null;
  } catch (e) {
    return null;
  }
}

async function preview() {
  const routerOsMajor = await detectRouterOsMajor();
  let ownPortName = null;
  try {
    const config = getMikrotikConfig();
    if (config.ip) {
      ownPortName = await withMikrotik(config, (client) => detectOwnPort(client, getOwnMac()));
    }
  } catch (e) {
    // Best-effort, same as detectRouterOsMajor() above - Preview should
    // still work even if this specific lookup fails.
  }
  const { steps, warnings } = buildPlan(routerOsMajor, ownPortName);
  return { steps: steps.map((s) => s.description), warnings };
}

async function apply() {
  const config = getMikrotikConfig();
  if (!config.ip) throw new Error('MikroTik IP not configured');

  const log = [];
  let backedUp = false;
  let steps, warnings, apiPassword;

  await withMikrotik(config, async (client) => {
    // Always back up the router's current config before pushing anything
    // (ROUTER_MODE_PLAN.md §4.6 - folded into Stage 4's own scope, not an
    // optional add-on, since it protects this new provisioning code
    // specifically).
    try {
      const backupName = `rj-pisowifi-pre-configure-${Date.now()}`;
      await client.talk(['/system/backup/save', `=name=${backupName}`]);
      log.push({ step: 'Backup current router config', ok: true, detail: backupName });
      backedUp = true;
    } catch (err) {
      log.push({ step: 'Backup current router config', ok: false, detail: err.message });
      throw new Error('Refusing to continue without a successful backup: ' + err.message);
    }

    // Detect the real RouterOS version on this exact connection, so the
    // queue-type choice (CAKE vs the RouterOS 6 fallback) is never a guess
    // for the actual run, even if Preview couldn't reach the router earlier.
    let routerOsMajor = null;
    try {
      const resourceRes = await client.talk(['/system/resource/print']);
      routerOsMajor = parseRouterOsMajor((resourceRes.re[0] || {}).version);
      log.push({ step: `Detected RouterOS ${routerOsMajor || 'version (unrecognized)'}`, ok: true });
    } catch (err) {
      log.push({ step: 'Detect RouterOS version', ok: false, detail: err.message + ' - assuming RouterOS 7+ (CAKE)' });
    }

    // Bug #98 follow-up: find which physical port this app's own connection
    // is arriving through (if its MAC is known), so buildPlan() can process
    // that lane dead last - see the reordering logic there for why.
    const ownPortName = await detectOwnPort(client, getOwnMac());
    if (ownPortName) {
      log.push({ step: `This app's own connection is arriving via ${ownPortName} - that lane will be configured last`, ok: true });
    }

    ({ steps, warnings, apiPassword } = buildPlan(routerOsMajor, ownPortName));

    // Port-freeing (a brand-new router isn't actually blank - MikroTik's
    // factory-default config usually already bridges most LAN ports
    // together, and a port can only belong to one bridge at a time) is now
    // interleaved into `steps` itself, immediately before each port's own
    // bridge attachment - see buildPlan()'s freeStepFor(). That keeps any
    // gap between "freed" and "back on a working bridge" to a couple of API
    // calls instead of a whole separate pass across every port first, which
    // used to be able to strand this app's own connection (if it happens to
    // reach the router through one of the ports being freed) for the entire
    // rest of that pass before anything got rebuilt.
    for (const step of steps) {
      try {
        if (step.type === 'free-port') {
          const existing = await client.talk(['/interface/bridge/port/print', `?interface=${step.portName}`]);
          for (const row of existing.re) {
            await client.talk(['/interface/bridge/port/remove', `=.id=${row['.id']}`]);
          }
          log.push({ step: step.description, ok: true, detail: `${existing.re.length} removed` });
        } else {
          await client.talk(step.words);
          log.push({ step: step.description, ok: true });
        }
      } catch (err) {
        log.push({ step: step.description, ok: false, detail: err.message });
        throw Object.assign(new Error(`Provisioning stopped at "${step.description}": ${err.message}`), { log, warnings, backedUp });
      }
    }
  });

  // Switch this app's own stored credentials to the new dedicated API user
  // now that it exists, so ongoing operation never uses the router's real
  // admin login again.
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  upsert.run('mikrotik_user', API_USER_NAME);
  upsert.run('mikrotik_pass', encryptSecret(apiPassword));
  log.push({ step: 'Switched this app to the new dedicated API user', ok: true });

  return { log, warnings, backedUp };
}

module.exports = { preview, apply, buildPlan, listLocalInterfaces };
