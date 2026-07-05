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
| `003_cosmetics_and_marketplace.up.sql` / `.down.sql` written | ✅ Done | Adds `cafe_branding`, `game_whitelist`, `cosmetics`, `user_cosmetics`; also fixes a real gap — `users.role` never allowed `'designer'` despite it being referenced elsewhere in the docs |
| `003_cosmetics_and_marketplace` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Applied cleanly on top of 001+002. Explicitly tested: (1) a rank-locked cosmetic with a price is rejected by the `rank_locked_pricing` CHECK constraint, (2) a duplicate cafe-wide game-whitelist entry is rejected by the partial unique index (confirms the NULL-handling fix actually works, not just compiles), (3) `cafe_branding` insert works. Rollback and re-apply both confirmed clean. |
| `004_subscriptions.up.sql` / `.down.sql` written | ✅ Done | Redesigned from the original flat sketch into a flexible `platform_features`/`platform_plans`/`platform_plan_features`/`platform_subscriptions` catalog so cafes can subscribe to a single feature OR a bundle (e.g. Game Pass + Cloud Monitoring together) — per user direction to support bundles without pricing being decided yet. Also adds `game_passes`, `game_pass_subscriptions`, `pc_licenses` (kept separate — quantity-based, not a flat toggle). |
| `004_subscriptions` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Applied cleanly on top of 001-003. Explicitly tested: (1) a bundle plan correctly grants two features via the join table, (2) a cafe cannot hold two simultaneously-active subscriptions to the same plan (partial unique index), (3) a player cannot hold two simultaneously-active subscriptions to the same Game Pass, (4) `pc_licenses` insert works. Rollback and re-apply both confirmed clean. |
| `005_subscription_grace_period.up.sql` / `.down.sql` written | ✅ Done | Resolves the open decision below (24h grace period). Adds `lapsed_at` to `platform_subscriptions` and `pc_licenses`. Inserted as its own migration and renumbered the still-unwritten compliance/social/gamification/localization migrations down by one, since nothing beyond 004 existed yet — no rework cost. |
| `005_subscription_grace_period` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Applied cleanly on top of 001-004. Explicitly tested the grace-period math itself, not just that the column exists: a subscription lapsed 1 hour ago correctly computes "don't enforce yet," one lapsed 25 hours ago correctly computes "enforce now." Rollback and re-apply both confirmed clean. |
| `006_compliance.up.sql` / `.down.sql` written | ✅ Done | Resolves the guest-birthdate open decision (widened the constraint to cover all player account types). Adds `age_verifications`, `admin_notifications`, `audit_log`. Also fixed `verified_by_staff_id` → `verified_by_user_id` since `staff`'s PK is composite and can't be FK'd by a single column. |
| `006_compliance` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Applied cleanly on top of 001-005. Explicitly tested: (1) inserting a guest player with no birthdate is now rejected (confirms the widened constraint actually works), (2) `age_verifications`, `admin_notifications`, and a system-triggered (`user_id IS NULL`) `audit_log` row all insert correctly. Rollback and re-apply both confirmed clean. |
| `007_age_verification_requests.up.sql` / `.down.sql` written | ✅ Done | New feature requested mid-build: remote selfie+ID verification workflow, layered on top of `age_verifications` (which now only represents an already-approved outcome). Selfie required alongside ID photo after identifying that photo-only submission would let a minor submit someone else's ID with no face comparison ever happening. |
| `007_age_verification_requests` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Applied cleanly on top of 001-006. Explicitly tested all three CHECK constraints: (1) can't set `rejection_reason` unless status is rejected, (2) can't approve without `resulting_verification_id`, (3) full approval flow correctly links a request to its `age_verifications` outcome row. Also tested `audit_log` accepting the new `'view'` action and the `remote_verification_blocked` column. Rollback and re-apply both clean. |
| `008_content_and_chat_tiers.up.sql` / `.down.sql` written | ✅ Done | Major revision requested mid-build: replaces the earlier "minors fully blocked, no exceptions" rule with a three-tier model (kids <13, teens 13-17, adults 18+). Adds `users.age_tier` (self-reported, restricts content), `users.verified_chat_tier` (staff-verified only, grants chat), `games.age_rating`, and tier fields on `age_verifications`/`age_verification_requests`. |
| `008_content_and_chat_tiers` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Applied cleanly on top of 001-007. Tested: `age_tier` defaults to `kids` (fail-safe), `games.age_rating` defaults to `kids`, `verified_chat_tier` rejects `'kids'` as a value, `age_verifications.verified_tier` is genuinely NOT NULL, `age_verification_requests.approved_tier` can't be set on a pending request. Rollback and re-apply both clean. |
| `009_social.up.sql` / `.down.sql` written | ✅ Done | Tier-aware friends/messages/chat_rooms/reports, built on 008. **Deliberate one-off exception to the project's "cross-table rules belong in the service layer" convention**: teen↔adult tier-matching is enforced by actual PostgreSQL triggers (`trg_friends_tier_match`, `trg_messages_tier_check`), not just app logic — the stakes of an adult contacting a verified minor are too high for a service-layer promise alone. |
| `009_social` executed against a real PostgreSQL instance | ✅ **VERIFIED — all safety-critical paths explicitly tested, not assumed.** | Set up real test accounts (verified teen, verified adult, unverified self-reported-adult, kid) and confirmed: teen→adult friend request rejected, adult→teen friend request rejected (both directions), kid can't add any friend, an unverified account can't add any friend (self-report insufficient), teen posting in the adults room rejected, adult posting in the teens room rejected, teen DMing an adult rejected, duplicate global room per tier rejected, message can't target both a room and a DM recipient at once. All same-tier paths (teen↔teen, adult↔adult) confirmed to work normally. Rollback and re-apply both clean. |
| `010_gamification.up.sql` / `.down.sql` | ❌ Not started | 001-009 all verified — safe to build on top of |

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

## Manual Review + Verification Findings (003_cosmetics_and_marketplace)

- **`'designer'` was missing from `users.role`** — referenced by `cosmetics.designer_id` and the `designer_payout` transaction type since the original schema consolidation, but never actually added to the CHECK constraint in `001_foundation`. Fixed via `ALTER TABLE ... DROP/ADD CONSTRAINT` in this migration rather than editing 001 after the fact (migrations are additive/forward-only once verified, not rewritten retroactively).
- **Simplified the schema during this migration:** the original consolidated doc sketched a separate `rank_locked_cosmetics` table, but it was a pure 1:1 relationship with `cosmetics` (each rank-locked item has exactly one unlock condition) — merged it into `cosmetics` directly as `is_rank_locked` + `unlock_condition` columns, with a CHECK constraint enforcing that rank-locked items have no price and purchasable items have no unlock condition. Removes an unnecessary join.
- **`game_whitelist` NULL-handling required a partial unique index, not a plain UNIQUE constraint** — Postgres treats NULL values as distinct in a regular UNIQUE constraint, so `UNIQUE (cafe_id, game_id, pc_id)` alone would NOT have caught two duplicate cafe-wide entries (both with `pc_id = NULL`). Used two separate partial unique indexes instead — one for per-PC entries, one for cafe-wide entries — and explicitly tested the duplicate-rejection case rather than assuming the constraint worked as intended.

---

## Manual Review + Verification Findings (004_subscriptions)

- **Redesigned platform subscriptions into a bundle-capable catalog, per explicit user direction.** The original design doc sketch had `platform_subscriptions.feature` as a single text field (one row per feature). User asked whether cafes should be able to buy bundles (e.g., Game Pass + Cloud Monitoring together) without pricing being decided yet — the fix was a `platform_features` catalog + `platform_plans` (single-feature or bundle, price nullable) + `platform_plan_features` many-to-many join, so bundling is structurally supported now without needing another schema change once actual bundle contents/pricing are decided later.
- **Cross-table business rule deliberately NOT enforced by a DB constraint:** `game_passes.active` should only be true if the cafe holds an active `platform_subscriptions` row granting the `game_pass` feature. This would require a trigger, and the lapse/grace-period behavior when a subscription expires is still an explicit open decision (see below) — enforcing it in SQL now would mean guessing at a rule that hasn't been decided. Documented as a service-layer responsibility instead of silently deciding the business rule via a trigger.
- **Two double-booking-style protections added, both explicitly tested:** a cafe can't hold two simultaneously-active subscriptions to the same plan, and a player can't hold two simultaneously-active subscriptions to the same Game Pass — both via partial unique indexes on `status = 'active'`, following the same pattern established in 002/003.

---

## Manual Review + Verification Findings (005_subscription_grace_period)

- **Grace period is a hardcoded 24-hour policy constant, not a per-cafe column.** This is deliberately different from `reservations`' grace period (which IS per-cafe-configurable) — reservation no-show leniency is a café owner's call over their own customers, but subscription lapse leniency is Zentry's own leniency policy toward café owners. Same word ("grace period"), two different owners of the decision — worth remembering so a future session doesn't assume they should be modeled the same way.
- **Tested the actual grace-period arithmetic, not just column existence:** inserted a subscription lapsed 1 hour ago and confirmed `now() > lapsed_at + interval '24 hours'` correctly evaluates false; updated it to 25 hours ago and confirmed it flips to true. This is the exact expression the service layer will need to use for enforcement.

---

## Manual Review + Verification Findings (006_compliance)

- **Resolved the guest-birthdate open decision by reasoning from the doc's own logic**, rather than re-asking: `docs/compliance/README.md` describes a guest player's credit being refunded and admin-flagged specifically when curfew hits mid-session — that flow is only possible if the system already knows the guest is a minor, which requires a birthdate on file. Widened `player_requires_birthdate` (`001_foundation` had it scoped to `account_type = 'registered'` only) to cover every player account type, and explicitly tested that a guest player without a birthdate is now rejected by the database.
- **Caught and fixed a design inconsistency before it became a bug:** the schema doc had already (correctly) described `age_verifications.verified_by_staff_id` as an FK to `users`, but `staff`'s primary key is composite (`user_id`, `cafe_id`) — a single-column FK can't reference a composite key. Renamed to `verified_by_user_id` referencing `users(id)` directly, since a staff member's (or owner's) identity for accountability purposes is just their `user_id`.
- **`admin_notifications.type` deliberately left as free text, not a CHECK enum** — unlike `audit_log.action` (a small, genuinely closed CRUD set), notification types are an open/growing taxonomy that other features (social reports, subscription lapses) will keep adding to; a CHECK enum would force editing this migration every time.

---

## Manual Review + Verification Findings (007_age_verification_requests)

- **Identified a real security gap before building this, not after:** the user asked about remote account creation with ID photo submission. A photo of an ID alone doesn't prove the submitter IS the person in it — a minor could submit a sibling's or parent's ID with no one ever comparing faces. Flagged this explicitly and got user confirmation to require a selfie alongside the ID photo (matches standard KYC patterns) before writing any schema, rather than building the weaker version first and fixing it later.
- **`age_verifications` (006) vs `age_verification_requests` (007) are deliberately two different tables, not one.** `age_verifications` only ever represents an ALREADY-APPROVED outcome (accountability log). `age_verification_requests` is the pending workflow (submitted → approved/rejected). Approval creates a row in the former and links back via `resulting_verification_id`; rejection never touches `age_verifications` at all.
- **ID/selfie photos must NOT share the cosmetics R2 bucket** — government ID images are sensitive PII under the PH Data Privacy Act, meaningfully higher-stakes than public marketplace images. Needs its own private bucket, accessed only via short-lived signed URLs, never a permanent link stored in the database. Documented in `docs/deployment/cloud-stack.md`.
- **Retention policy documented but not enforced by this migration** — `photo_purge_at` is just a scheduling column; the actual purge cron job is service-layer work for later. Exact retention window (suggested default: 30 days) is an open business decision, not decided here.
- **Anti-abuse column added (`users.remote_verification_blocked`) without hardcoding the rejection threshold** — the exact number of rejections before lockout (suggested default: 3) is a policy call for later; the schema just supports the mechanism.
- **Renumbered the still-unwritten social/gamification/localization migrations again** (008/009/010, was 007/008/009) — same zero-cost renumbering pattern as when `005_subscription_grace_period` was inserted, since nothing beyond `006` existed yet.

---

## Manual Review + Verification Findings (008_content_and_chat_tiers + 009_social)

**Context:** mid-build, the user requested a significant revision — replacing the earlier "minors fully blocked from chat, no exceptions" rule (documented as a hard, non-configurable rule in `social/README.md`) with a three-tier model: kids (no chat at all), teens (restricted to a teens-only pool), adults (full global chat). This is the single biggest design change since the schema consolidation.

- **Two independent tier fields, deliberately not one** — `age_tier` (self-reported, safe for restricting content like the game menu, same logic already established for curfew) vs. `verified_chat_tier` (staff-verified only, since chat is access-granting). Reused the existing self-report-vs-verified split rather than inventing a new pattern.
- **Fail-safe defaults throughout:** `age_tier` defaults to `'kids'` (most restrictive) rather than `'adults'`, and `games.age_rating` defaults to `'kids'` too — consistent with the OS lockdown philosophy ("if anything breaks, stay locked") already established elsewhere in this project. Both explicitly tested, not just assumed from reading the SQL.
- **Deliberate, flagged exception to the "cross-table rules go in the service layer" convention that's been consistent since `004_subscriptions`:** teen↔adult tier-matching for friends and messages is enforced by actual PostgreSQL triggers (`trg_friends_tier_match`, `trg_messages_tier_check`), not application code. This is the one place in the whole schema where a database trigger was judged worth the added complexity — the risk of an adult contacting a verified minor is categorically higher-stakes than, say, a Game Pass staying active a day longer than it should.
- **All four safety-critical directions were explicitly tested against a live database, not assumed from reading the trigger logic:** teen→adult friend rejected, adult→teen friend rejected, teen→adult DM rejected, teen posting in the adults room rejected (and the adult-in-teens-room mirror case). Also tested that kids and self-reported-but-unverified accounts get rejected identically to a tier mismatch — verification, not self-report, is what unlocks chat.
- **Known gap, explicitly documented, not silently accepted:** the tier-matching triggers only run at INSERT time. If a `verified_chat_tier` is revoked after a friendship or room membership already exists, nothing automatically re-validates the existing rows. Flagged as service-layer follow-up work in both `social/README.md` and here — not something this migration solves.
- **`social_unlocked` (a boolean mentioned in early design docs) was never actually built as a column in any prior migration** — so this wasn't a breaking change to real running code, just a doc-vs-reality correction once the actual tier system was designed.

---

## How 001_foundation Was Verified

Docker Desktop's daemon connection hung in this sandbox (its own diagnostic tool triggered, suggesting a local environment issue, likely WSL2-backend related — never resolved, and not worth resolving just for a one-off test). Instead:

1. User created a free Neon Postgres project and provided the connection string
2. A throwaway Node.js script (`pg` client) applied `001_foundation.up.sql`, listed the resulting tables, applied `.down.sql` to confirm rollback, then re-applied `.up.sql` — all four steps succeeded with no errors
3. The scratch script and connection string were kept out of the repo entirely (temp/scratchpad only) — the connection string is a secret and was never written to any committed file

**For future migrations (002 onward):** reuse this same approach (a real Postgres instance, even a disposable free-tier one, beats manual-only review) rather than re-attempting Docker in this environment unless it gets fixed separately.

---

## Open Decisions (Need Owner Input)

- [x] ~~Do guest-type accounts collect a birthdate for curfew purposes...~~ **RESOLVED: yes.** The compliance doc's own guest-curfew-refund flow only makes sense if guest accounts have a birthdate on file, so `player_requires_birthdate` was widened in `006_compliance` to cover every player account type, not just registered.
- [ ] Confirm target minimum PostgreSQL version (currently assuming 13+, recommend 15+ for a fresh build in 2026 — no real downside to requiring a recent version since this isn't a migration of an existing system)
- [x] ~~What happens when a cafe's `platform_subscriptions` lapses...~~ **RESOLVED: 24-hour grace period** before the service layer enforces lockout (disabling Game Pass / the PC), measured from `lapsed_at`. See `005_subscription_grace_period`.

---

## Migration Build Order (Reference)

Matches `docs/database/README.md` Migration Strategy section — do not skip ahead:

1. ✅ `001_foundation` — users, cafes, pcs, staff, wallets, games, sessions, transactions (verified against live Postgres)
2. ✅ `002_reservations` — reservations table, double-booking prevention (verified against live Postgres)
3. ✅ `003_cosmetics_and_marketplace` — cafe_branding, game_whitelist, cosmetics, user_cosmetics (verified against live Postgres)
4. ✅ `004_subscriptions` — platform_features/plans/subscriptions (bundle-capable), game_passes, pc_licenses (verified against live Postgres)
5. ✅ `005_subscription_grace_period` — lapsed_at + 24h grace period policy (verified against live Postgres)
6. ✅ `006_compliance` — age_verifications, admin_notifications, audit_log (verified against live Postgres)
7. ✅ `007_age_verification_requests` — remote selfie+ID verification workflow (verified against live Postgres)
8. ✅ `008_content_and_chat_tiers` — kids/teens/adults tier system (verified against live Postgres)
9. ✅ `009_social` — tier-aware friends, messages, chat_rooms, reports (verified against live Postgres)
10. ⬜ `010_gamification` — leaderboards, seasons, badges, challenges
11. ⬜ `011_localization_and_versioning`
