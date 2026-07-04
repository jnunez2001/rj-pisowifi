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
| `001_foundation` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Ran against a live Neon (free-tier) Postgres instance: applied `.up.sql` cleanly, confirmed all 8 tables created, applied `.down.sql` to confirm rollback works with no errors, then re-applied `.up.sql` to leave the DB in a known state. Full pass, no errors at any step. (Docker Desktop was abandoned as the test method — its daemon connection hung in this sandbox; Neon's hosted Postgres was used instead, which also matches the free-tier dev approach already decided in `docs/deployment/cloud-stack.md`.) |
| Migration runner (`src/database/`) | ❌ Not started | Needs a `schema_migrations` tracking table + apply/rollback logic — see `docs/database/README.md` Migration Strategy section |
| `002_reservations.up.sql` / `.down.sql` written | ✅ Done | Adds `reservations` table, `cafes.reservation_grace_period_minutes` / `reservation_min_credit`, `sessions.reservation_id` |
| `002_reservations` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Applied cleanly on top of 001. Explicitly tested the double-booking exclusion constraint by inserting two overlapping reservations for the same PC — the second insert was correctly rejected by the database itself (`conflicting key value violates exclusion constraint`), not just caught in application code. Rollback (`.down.sql`) and re-apply also confirmed clean. |
| `003_cosmetics_and_marketplace.up.sql` / `.down.sql` | ❌ Not started | 001 + 002 both verified — safe to build on top of |

---

## Manual Review Findings (001_foundation)

Reviewed line-by-line for table creation order, FK dependencies, and PostgreSQL syntax:

- **Table creation order is correct** — `users` → `cafes` → `pcs` → (ALTER `cafes` to add the `vip_seat_pc_id` FK, since `cafes`↔`pcs` is a circular reference) → `staff` → `wallets` → `games` → `sessions` → `transactions`. Every FK references a table that already exists at the point it's declared.
- **Requires PostgreSQL 13+** — `gen_random_uuid()` is built into core since PG13; no `pgcrypto`/`uuid-ossp` extension needed. Noted in the file header. If the actual deployment target ends up being older than PG13, this will need revisiting.
- **`player_requires_birthdate` CHECK constraint logic verified correct** by De Morgan's law: it only requires `birthdate IS NOT NULL` when `role = 'player' AND account_type = 'registered'` — guest/temporary accounts are not constrained at the DB level.
- **Open gap, not yet resolved (flagging, not deciding):** `docs/compliance/README.md` describes curfew rules applying based on birthdate, but also describes "Guest (no account, walk-in cash session)" players. It's unclear whether guest-type accounts (as modeled in this schema) actually collect a birthdate at all, or whether "guest" in the compliance doc means something with zero account footprint (which wouldn't match having an `account_type = 'guest'` row in `users` with curfew enforcement applied to it). **This needs a decision, not an assumption** — see Open Decisions below.
- **No cascading deletes on `sessions.player_id` or `transactions.user_id`** — intentional. Financial/session history should not disappear if a user is deleted; account-deletion requests (from the earlier "data export / account deletion" feature idea) will need a proper soft-delete or anonymization strategy, not a hard `ON DELETE CASCADE`. Flagging so this isn't "fixed" into a cascade later without realizing why it was left out.

---

## Manual Review + Verification Findings (002_reservations)

- **Double-booking prevention is enforced at the database level**, not just application code — a PostgreSQL `EXCLUDE` constraint (using `btree_gist`) rejects any two `pending`/`active` reservations for the same PC with overlapping time ranges. `completed`/`cancelled`/`no_show_released` reservations don't count, so a freed-up slot can be rebooked. This was explicitly tested (see above), not just written and assumed correct.
- **`sessions.reservation_id`** links a session back to the reservation that spawned it, added via `ALTER TABLE` since `sessions` already existed from 001 — nullable, since most sessions are still walk-in, not reserved.
- **Grace period and minimum-credit-to-reserve are per-café settings** (`cafes.reservation_grace_period_minutes`, `cafes.reservation_min_credit`), defaulting to 30 minutes / ₱0 — actual defaults are a business decision, not locked in permanently, just reasonable starting values.

---

## How 001_foundation Was Verified

Docker Desktop's daemon connection hung in this sandbox (its own diagnostic tool triggered, suggesting a local environment issue, likely WSL2-backend related — never resolved, and not worth resolving just for a one-off test). Instead:

1. User created a free Neon Postgres project and provided the connection string
2. A throwaway Node.js script (`pg` client) applied `001_foundation.up.sql`, listed the resulting tables, applied `.down.sql` to confirm rollback, then re-applied `.up.sql` — all four steps succeeded with no errors
3. The scratch script and connection string were kept out of the repo entirely (temp/scratchpad only) — the connection string is a secret and was never written to any committed file

**For future migrations (002 onward):** reuse this same approach (a real Postgres instance, even a disposable free-tier one, beats manual-only review) rather than re-attempting Docker in this environment unless it gets fixed separately.

---

## Open Decisions (Need Owner Input)

- [ ] Do guest-type accounts (walk-in, no formal registration) actually collect a birthdate for curfew purposes, or is curfew enforcement only possible for players who at least create a lightweight account? This affects whether the `player_requires_birthdate` constraint should be broadened.
- [ ] Confirm target minimum PostgreSQL version (currently assuming 13+, recommend 15+ for a fresh build in 2026 — no real downside to requiring a recent version since this isn't a migration of an existing system)

---

## Migration Build Order (Reference)

Matches `docs/database/README.md` Migration Strategy section — do not skip ahead:

1. ✅ `001_foundation` — users, cafes, pcs, staff, wallets, games, sessions, transactions (verified against live Postgres)
2. ✅ `002_reservations` — reservations table, double-booking prevention (verified against live Postgres)
3. ⬜ `003_cosmetics_and_marketplace`
4. ⬜ `004_subscriptions` — platform_subscriptions, game_passes, pc_licenses
5. ⬜ `005_compliance` — age_verifications, admin_notifications, audit_log
6. ⬜ `006_social` — friends, messages, reports
7. ⬜ `007_gamification` — leaderboards, seasons, badges, challenges
8. ⬜ `008_localization_and_versioning`
