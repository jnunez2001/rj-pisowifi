# ZenCafe OS — Server Communication & Disconnection Handling

The client PC never trusts itself — the server is the only source of truth for time, credit, curfew, and every other rule. This document defines what happens when a client PC briefly can't reach the server, a real design decision reasoned through directly with the owner (not left as a vague "handle disconnections gracefully" placeholder).

---

## The Core Rule

**The client PC is a "dumb terminal."** It displays what the server says and enforces what the server decides — it does not independently track time, credit, or age/curfew rules on its own authority. This is intentional: if the client could keep running or billing itself while disconnected, someone could deliberately cut their network connection to get free playtime, or a minor's session could silently continue past curfew with nothing checking it.

## Disconnection Behavior — Two Stages

### Stage 1: Short Grace Period (Seamless)

If the connection drops for a **short window — default 15 seconds** — nothing visible happens. The session keeps running exactly as normal. This absorbs the reality of café networks: a brief WiFi blip, a switch hiccup, a router reboot. The window is short enough that nothing meaningful can be gained by triggering it deliberately.

**Configurable per café**, within a bounded range (**5-30 seconds**) — an owner with a particularly unreliable network can extend it slightly, but the upper bound keeps the window too short to be worth exploiting even at its most generous setting.

### Stage 2: Beyond the Grace Period — Pause, Not Lock

If the disconnection outlasts the grace period, the session **pauses** rather than fully locking the customer out:

- Gameplay freezes, a "Reconnecting..." message displays
- **No credit is deducted during the pause** — the customer shouldn't be billed for a problem that isn't their fault
- **But nothing progresses during the pause either** — no gameplay, no time counted, nothing to gain by staying disconnected. This is what keeps the design safe: a long outage is fair to the customer (no charge) without being exploitable (no free play)
- The moment the connection returns, the session automatically un-pauses and resumes exactly where it left off — no manual staff intervention needed for a normal reconnect

## Why Not "Keep Running and Reconcile Later"?

An alternative design was considered and rejected: let the client keep tracking time/credit locally while disconnected, then report it to the server once reconnected. This was rejected because it would require trusting the client's own report of how long it was disconnected and what happened during that time — exactly the kind of client-side trust this whole system is built to avoid. It would also reopen the curfew-enforcement gap for minors (a session could silently continue past curfew if the client is allowed to keep running unsupervised during a disconnection).

## What If the Server Itself Goes Down (Not Just a Network Blip)?

Every client PC in the café pauses (per Stage 2 above) until the server is back — this is the real single point of failure of this architecture, and it's exactly why server reliability work matters so much: running as an auto-restarting Windows Service (or the Linux equivalent), with a watchdog, on hardware that isn't overloaded. See `zencafe-server/docs/deployment/hardware-requirements.md`.

## Data Model Note (for the server side)

`cafes` needs a per-café setting for this grace period, e.g. `connection_grace_period_seconds` (default 15, bounded 5-30) — analogous to the already-existing `reservation_grace_period_minutes`. Not yet added to any migration; this is a note for whenever session/connection handling gets built into the server's service layer.
