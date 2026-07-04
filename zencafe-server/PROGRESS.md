# ZenCafe Server — Build Progress

**Read this file first in any new session before doing anything else.** This project is entirely AI-built with no human developer double-checking the work, so this file is the only reliable memory of what's actually done versus assumed.

---

## Current Phase: Database Foundation

We are consolidating the full design (spread across `docs/`) into a real database schema, one migration at a time, verifying each migration before building the next one on top of it.

---

## Status Table

| Item | Status | Notes |
|---|---|---|
| Design docs (business-model, compliance, social, gamification, deployment, localization) | ✅ Done | All in `docs/` |
| Consolidated schema reference | ✅ Done | `docs/database/README.md` |
| `001_foundation.up.sql` / `.down.sql` written | ✅ Done | Tables: users, cafes, pcs, staff, wallets, games, sessions, transactions |
| `001_foundation` manually reviewed for SQL correctness | ✅ Done | See "Manual Review Findings" below |
| `001_foundation` executed against a real PostgreSQL instance | ❌ **NOT DONE** | Docker Desktop would not start cleanly in this dev sandbox (daemon connection hung, `com.docker.diagnose` triggered). This is an **environment limitation, not a code problem** — see "How to Verify" below. |
| Migration runner (`src/database/`) | ❌ Not started | Needs a `schema_migrations` tracking table + apply/rollback logic — see `docs/database/README.md` Migration Strategy section |
| `002_reservations.up.sql` / `.down.sql` | ❌ Not started | Do not start until 001 is confirmed to actually run (see below) |

---

## Manual Review Findings (001_foundation)

Reviewed line-by-line for table creation order, FK dependencies, and PostgreSQL syntax:

- **Table creation order is correct** — `users` → `cafes` → `pcs` → (ALTER `cafes` to add the `vip_seat_pc_id` FK, since `cafes`↔`pcs` is a circular reference) → `staff` → `wallets` → `games` → `sessions` → `transactions`. Every FK references a table that already exists at the point it's declared.
- **Requires PostgreSQL 13+** — `gen_random_uuid()` is built into core since PG13; no `pgcrypto`/`uuid-ossp` extension needed. Noted in the file header. If the actual deployment target ends up being older than PG13, this will need revisiting.
- **`player_requires_birthdate` CHECK constraint logic verified correct** by De Morgan's law: it only requires `birthdate IS NOT NULL` when `role = 'player' AND account_type = 'registered'` — guest/temporary accounts are not constrained at the DB level.
- **Open gap, not yet resolved (flagging, not deciding):** `docs/compliance/README.md` describes curfew rules applying based on birthdate, but also describes "Guest (no account, walk-in cash session)" players. It's unclear whether guest-type accounts (as modeled in this schema) actually collect a birthdate at all, or whether "guest" in the compliance doc means something with zero account footprint (which wouldn't match having an `account_type = 'guest'` row in `users` with curfew enforcement applied to it). **This needs a decision, not an assumption** — see Open Decisions below.
- **No cascading deletes on `sessions.player_id` or `transactions.user_id`** — intentional. Financial/session history should not disappear if a user is deleted; account-deletion requests (from the earlier "data export / account deletion" feature idea) will need a proper soft-delete or anonymization strategy, not a hard `ON DELETE CASCADE`. Flagging so this isn't "fixed" into a cascade later without realizing why it was left out.

---

## How to Verify 001_foundation (Next Concrete Action)

This environment (Windows sandbox) could not run Docker Desktop cleanly — the daemon connection hung and Docker's own diagnostic tool kicked in, suggesting a local environment issue (possibly WSL2 backend), not something fixable from inside this session. Whoever picks this up next should do ONE of the following, then update this file:

1. **Easiest: free-tier cloud Postgres** — spin up a free instance on Neon or Supabase (matches the free-tier development approach already decided in `docs/deployment/cloud-stack.md`), then run:
   ```
   psql "<connection-string>" -f migrations/001_foundation.up.sql
   ```
   If it applies cleanly, run `.down.sql` after to confirm rollback also works, then re-run `.up.sql` to leave it in a known state.

2. **Local Docker, once fixed** — `docker run --name zencafe-test -e POSTGRES_PASSWORD=test -p 5432:5432 -d postgres:15`, then `psql -h localhost -U postgres -f migrations/001_foundation.up.sql`

3. **Local PostgreSQL install** — if Docker continues to be unreliable on this machine, installing PostgreSQL directly on Windows avoids the container layer entirely.

**Once verified, update the status table above and proceed to `002_reservations`.** Do not add more migrations before this is confirmed — that's exactly the "circle back and fix things later" scenario we're trying to avoid.

---

## Open Decisions (Need Owner Input)

- [ ] Do guest-type accounts (walk-in, no formal registration) actually collect a birthdate for curfew purposes, or is curfew enforcement only possible for players who at least create a lightweight account? This affects whether the `player_requires_birthdate` constraint should be broadened.
- [ ] Confirm target minimum PostgreSQL version (currently assuming 13+, recommend 15+ for a fresh build in 2026 — no real downside to requiring a recent version since this isn't a migration of an existing system)

---

## Migration Build Order (Reference)

Matches `docs/database/README.md` Migration Strategy section — do not skip ahead:

1. ✅ `001_foundation` — users, cafes, pcs, staff, wallets, games, sessions, transactions
2. ⬜ `002_reservations`
3. ⬜ `003_cosmetics_and_marketplace`
4. ⬜ `004_subscriptions` — platform_subscriptions, game_passes, pc_licenses
5. ⬜ `005_compliance` — age_verifications, admin_notifications, audit_log
6. ⬜ `006_social` — friends, messages, reports
7. ⬜ `007_gamification` — leaderboards, seasons, badges, challenges
8. ⬜ `008_localization_and_versioning`
