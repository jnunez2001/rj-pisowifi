# WiFi Rental Bridge API

Formalizes a decision that had only existed as verbal agreement: **R&J PisoWifi stays as its own Node.js/Express/SQLite system** (avoiding the risk/cost of rewriting proven, working code), but it needs a small, deliberate bridge to the new C++/PostgreSQL system so that **curfew protection for minors still applies to WiFi customers, not just PC cafe customers.** Without this, a minor could simply use WiFi instead of PC rental to bypass every protection built elsewhere in this project.

**Design goal: minimal integration, not a merge.** This is not shared customer accounts, not a shared database — just one small, specific safety check.

---

## What This Bridge Is NOT

- **Not full customer identity sharing** — WiFi customers don't need `age_verifications`/`verified_chat_tier`/staff-verified accounts. That level of friction doesn't fit "insert a coin, get WiFi."
- **Not a shared database** — R&J PisoWifi keeps its own SQLite database exactly as it is today.
- **Not real-time bidirectional sync** — this is one simple, occasional, one-directional check.

## What It Actually Is

### 1. A Read-Only Curfew Status Endpoint (on the C++ server)

```
GET /api/wifi-bridge/curfew-status?cafe_id=<uuid>

Response:
{
  "curfew_enabled": true,
  "curfew_active_now": true,
  "curfew_start": "22:00",
  "curfew_end": "05:00"
}
```

This reads directly from `cafes.curfew_enabled`/`curfew_start`/`curfew_end` (already in `001_foundation`) — no new table needed for this specific check.

**Security:** this is a server-to-server call (the Node.js WiFi box calling the C++ server, both typically on the same local network/machine), not something exposed to customers. Should still require a shared internal API key, not be fully open — even though the data itself isn't highly sensitive, an unauthenticated endpoint is bad practice regardless.

### 2. A Simple Self-Attestation in the WiFi Captive Portal (on the Node.js side)

The existing `public/portal/` already handles the customer-facing WiFi login flow. Add one simple prompt, shown once per session — **"Are you 18 or older?"** — same pattern already used for PC cafe guest self-attestation (`011_guest_self_attestation`): no ID, no account, just a quick unverified answer, erring toward the restrictive assumption if unanswered.

### 3. The Actual Check, on the WiFi Side

Before granting or renewing a WiFi session:
1. Call the curfew-status endpoint for that café
2. If `curfew_active_now` is `false` — proceed normally, no restriction
3. If `curfew_active_now` is `true` AND the customer self-attested as a minor (or didn't answer) — deny/block the session
4. If `curfew_active_now` is `true` AND the customer self-attested as 18+ — proceed normally

### 4. Mid-Session Curfew Start (Not Just at Login)

Matching how PC cafe sessions get force-ended when curfew begins mid-session (not just blocked at login), the WiFi system should **periodically re-check** curfew status for any active session flagged as a minor (e.g., poll every few minutes), and terminate the session using R&J PisoWifi's own existing session-termination logic if curfew becomes active partway through. The new C++ server doesn't dictate *how* R&J PisoWifi ends a session — just *when* it should, via this status check.

---

## What Stays Entirely on the R&J PisoWifi Side (Unchanged)

- Voucher generation/validation, coin acceptor handling, MikroTik integration, session/timer logic, its own admin panel — none of this needs to change
- Any refund logic for a curfew-cut-short session is R&J PisoWifi's own existing responsibility, not something the bridge dictates

---

## Open Decisions (Need Owner Input)

- [ ] What should the shared internal API key/secret be, and how should it be provisioned (env variable on both systems, likely) — a small but real setup detail once this gets built
- [ ] How often should the WiFi side poll for mid-session curfew checks — every 1 minute? 5 minutes? Trade-off between responsiveness and unnecessary load
- [ ] Should the "18 or older?" prompt be shown every session, or remembered for a device/MAC address for some period (convenience vs. re-confirming each time)?
