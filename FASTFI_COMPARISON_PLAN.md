# FastFi Comparison — What rj-pisowifi/Zentry Can Learn and Build

**Status:** Research/planning only, nothing built yet. Based on reading through `FastFi V6` (Orange Pi One + OpenWrt + Lua), the user's first shipped, stable product — this is meant to make the second product (rj-pisowifi/Zentry) more capable, not a literal code port (completely different stack: Lua/OpenWrt vs Node.js/Express, single embedded box vs VM + external MikroTik router).

## Already fixed tonight from FastFi's own documented lessons

- **`SUMMARY_OF_FIXES.md`** documented that MAC-based `tc flower` matching (`match ether dst`) was unreliable across different `tc` builds, fixed by switching to IP-based matching. rj-pisowifi's own standalone-mode shaping (`server/services/networkService.js`) had the exact same MAC-based pattern — converting to IP-based now, proactively, before it becomes a real incident (see the mid-edit before this plan was written).

## Real capabilities FastFi has that rj-pisowifi doesn't (worth building)

1. **Rewards/points balance** (`rewards.lua`, `db/rewards.lua`) — customers earn points, spend them later. This is exactly what `ACCOUNT_REVENUE_PLAN.md` already planned for rj-pisowifi (Phase 1: customer accounts + points balance, daily login claim). FastFi's `points_balance`/`get_config` shape is a useful reference for the data model.
   - **Not porting as-is:** FastFi also has a "spin the wheel" mechanic where points buy a chance at a prize (`spin_wheel`, `spin_cost`). That's real-money-adjacent wagering, same category already declined earlier tonight (fake speed tests, sped-up timers) — a customer's points came from real money, and gambling those away for a *chance* at more time is the same shape as the declined slot-machine idea, just wrapped in a wheel instead of reels. The honest version already planned (guaranteed daily claim, no wagering) stays the direction to build.

2. **Shield — anti-abuse engine** (`shield.lua`, `db/shield.lua`, `fastfi-shield.lua` background service) — an nftables-set-based engine that appears to auto-detect and block abusive clients at the network level (beyond rj-pisowifi's current `spamService.js`, which only rate-limits repeated invalid coin attempts). Worth reading further and adapting the *concept* — automatic network-level blocking for abuse patterns beyond just coin-spam - to router mode's MikroTik address-list/firewall capabilities.

3. **Sub-vendo management** (`subvendo.lua`, 695 lines) — rj-pisowifi already has basic multi-vendo support (the `vendos` table, `POST /api/admin/vendo/register`, heartbeat, Devices page), but FastFi's version is far more developed. Worth a closer read to see what's missing - likely per-vendo remote actions, individual naming/status beyond what's already built.

4. **PPPoE WAN support** (`pppoe.lua`, 460 lines) — a real, legitimate gap. Some ISPs require PPPoE authentication (username/password) rather than plain DHCP for the WAN uplink. rj-pisowifi's router-mode Configure currently only sets up DHCP-based WAN NAT (`mikrotikProvisioner.js`'s WAN lane loop) - no PPPoE option at all. If any deployment (this one or a future customer's) has a PPPoE ISP, router mode literally cannot get online today. Worth prioritizing if this is a real near-term need.

5. **Monitoring/Dashboard depth** (`monitoring.lua`, 564 lines) — likely more detailed real-time stats than rj-pisowifi's current dashboard. Worth a closer read to see what's tracked that isn't yet.

6. **Device licensing** (`license.lua`, `esp_license.lua`) — a real, working HMAC-signed device-activation flow against a cloud service (`fastfi.cloud`). This is precisely what rj-pisowifi's own `SECURITY_PLAN.md` describes as "planning only, nothing built yet." The *architecture* is a solid reference (device ID + HMAC signature + activate/status/remove/recover endpoints), but it depends on a cloud service that doesn't exist for rj-pisowifi - building this means standing up that server-side piece first (a real, separate project), not just porting the device-side Lua.

## Explicitly not prioritizing

- **Messenger/chat** (`messenger.lua`, `chat.lua`) — already discussed and dropped earlier tonight (moderation/safety concerns for a public cafe, possibly used by minors).

## Suggested next steps, in order

1. Finish the tc shaping IP-based-matching fix already in progress (low risk, directly informed by FastFi's own real incident).
2. Decide whether PPPoE WAN support is a real near-term need (only relevant if an ISP actually requires it) - if yes, this is the highest-value gap to close next.
3. Read `shield.lua`/`fastfi-shield.lua` more closely and design a MikroTik-address-list-based equivalent for router mode.
4. Continue `ACCOUNT_REVENUE_PLAN.md`'s Phase 1 (accounts + honest points + daily claim) using FastFi's data model as a reference, without the wagering mechanic.
5. Licensing: only worth starting once there's an actual plan for hosting the server-side activation service - otherwise it's a device-side-only stub with nothing to talk to.

This file intentionally stops at a survey/plan level - going deeper (reading `ops.lua` at 1452 lines, the full `subvendo.lua`, `monitoring.lua`, etc.) is real additional work worth its own focused session rather than continuing to expand this same pass.
