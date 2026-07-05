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
| `010_cafe_security_toggles.up.sql` / `.down.sql` written | ✅ Done | Direct response to a request to make ALL safety measures toggleable by café owners, backed by a liability waiver. **Declined for the core minor-protection mechanisms** (kids blocked from chat, teen/adult separation, mandatory staff verification) — a signed waiver doesn't reliably waive statutory child-protection obligations, and would expose the platform itself, not just the café. Owner deferred the final call to this judgment. Only added the one legitimate operational toggle: `cafes.remote_verification_enabled` (photo verification vs. in-person-only — doesn't weaken what "verified" means). Full reasoning locked in at `docs/compliance/README.md` "Owner-Configurable vs. Platform-Fixed Security Settings" so this isn't quietly reversed in a future session without the same context. |
| `010_cafe_security_toggles` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Confirmed `remote_verification_enabled` defaults to `true`. Then explicitly confirmed the important thing: toggling it OFF has zero effect on the `009_social` tier-matching triggers — a teen still cannot friend an adult regardless of this cafe-level setting. Rollback and re-apply both clean. |
| `011_guest_self_attestation.up.sql` / `.down.sql` written | ✅ Done | Reverses part of `006_compliance`: guests no longer require a birthdate (registration friction was the wrong call once the actual desired guest experience — walk-up, zero-friction, no membership features — was clarified). Guests instead get a single unverified "18+?" prompt setting `age_tier`/`is_minor` directly. **Found and fixed a real bug while building this:** `is_minor` defaulted to `false` (unsafe direction) since `001_foundation` — harmless before because every player always had immediate birthdate computation, but a real inconsistency risk now that guests can skip that step and rely on the raw default. Also added `chat_tier_requires_registered`, a DB constraint ensuring guest/temporary accounts can never get chat access no matter what. |
| `011_guest_self_attestation` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Confirmed: a guest can be created with no birthdate at all, defaulting consistently to `is_minor=true` + `age_tier='kids'` (the bug fix actually works). Confirmed registered accounts still require a birthdate (unchanged). Confirmed a guest self-attesting "18+" correctly sets `age_tier='adults'`. **Confirmed a guest can never get `verified_chat_tier` set, even via direct UPDATE** — the database itself refuses it. Confirmed a registered account can still get it set normally. Rollback and re-apply both clean. |
| `012_gamification.up.sql` / `.down.sql` written | ✅ Done | Adds `leaderboard_seasons`, `leaderboard_entries`, `season_history`, `user_badges`, `challenges`. `cafes.vip_seat_pc_id`/`vip_seat_category` and `cosmetics.is_rank_locked`/`unlock_condition` already existed from earlier migrations. Caught and fixed two of the same NULL-in-unique-constraint bugs already seen once in `game_whitelist` (003) — both `leaderboard_seasons` (cafe_id nullable) and `leaderboard_entries` (game_id nullable) needed split partial indexes, not a plain UNIQUE. Also tightened `cafes.vip_seat_category`, an unvalidated loose `TEXT` column since `001_foundation`, now that the category enum is concretely defined. |
| `012_gamification` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Applied cleanly on top of 001-011. Explicitly tested: duplicate active global season rejected, duplicate active branch season rejected, invalid season time range (`ends_at` before `starts_at`) rejected, duplicate overall leaderboard entry rejected while multiple per-game entries for the same player succeed, self-challenge rejected, invalid `vip_seat_category` rejected. Rollback and re-apply both clean. |
| `013_localization_and_versioning.up.sql` / `.down.sql` written | ✅ Done | Adds `translation_keys`, `server_versions`, `os_versions`. All the per-record language/update-channel columns (`users.preferred_language`, `cafes.default_language`/`update_channel`/`maintenance_window_*`, `pcs.current_os_version`/etc.) already existed from `001_foundation`. **Simplified the design:** the originally sketched standalone `version_compatibility` table read like a per-pair matrix with no clean row-per-what meaning — folded `minimum_os_version_required`/`minimum_server_version_required` directly into `server_versions`/`os_versions` instead, since a compatibility check only ever needs one value per version row, and semver comparison logic doesn't want a strict FK anyway. |
| `013_localization_and_versioning` executed against a real PostgreSQL instance | ✅ **VERIFIED** | Confirmed the same translation key works across two languages, confirmed a true duplicate `(key, language_code)` pair is rejected, confirmed `server_versions`/`os_versions` insert correctly with their new minimum-version columns, confirmed duplicate `version_number` is rejected. Rollback and re-apply both clean. |
| **This completes the original migration build order (001-013).** | ✅ | Every migration planned in `docs/database/README.md`'s Migration Strategy section is now written and verified against live Postgres. Next phase is service-layer code (`src/`), not more schema — see "What's Next" below. |

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

## Manual Review + Verification Findings (010_cafe_security_toggles)

- **This migration exists because of a request that was partially declined, not fully implemented.** The user asked to make ALL safety measures toggleable per café, backed by a liability waiver. Explained why a waiver doesn't reliably waive statutory child-protection obligations and would expose the platform itself, not just the café — the owner deferred the final call to that judgment. Only the one legitimate operational setting (`remote_verification_enabled`) was added; no toggle exists for the core minor-protection mechanisms, and none should be added without redoing this risk analysis. Full reasoning locked into `compliance/README.md`.
- **Explicitly tested that the new toggle has zero effect on the safety triggers** — not assumed from the fact that the two features live in different migrations. A teen still cannot friend an adult with `remote_verification_enabled = false`.

---

## Manual Review + Verification Findings (011_guest_self_attestation)

- **This migration reverses a decision made in `006_compliance`**, once the actual desired guest experience was clarified mid-build: guests should have zero registration friction (no birthdate, no verification, no social features) — not the "guest still needs a birthdate for curfew" model built earlier. Documented as a reversal, not silently overwritten, so a future session understands why `006`'s reasoning no longer applies to guests.
- **Found and fixed a real bug while building this, not after:** `is_minor` defaulted to `false` since `001_foundation` — the unsafe direction. This was harmless before because every player always had an immediate birthdate-driven computation overwriting the default, so the raw default value was never actually exercised in practice. Guests skipping that computation entirely made this a live risk: a guest who never answers the self-attestation prompt would previously have defaulted to `is_minor=false` (curfew doesn't apply) while `age_tier` correctly defaulted to `'kids'` (game menu is restricted) — two fields disagreeing about the same person. Fixed by changing the default to `true`, and explicitly tested that a guest with no birthdate now gets consistent fail-safe values on both fields.
- **Added `chat_tier_requires_registered` as a defensive DB constraint**, not just a service-layer assumption — guests and temporary accounts can never get `verified_chat_tier` set, tested by attempting a direct `UPDATE` and confirming the database itself refuses it, not just the application flow.
- **No new column was needed for the self-attestation itself** — it reuses the existing `age_tier`/`is_minor` fields, which were already self-reported and already fail-safe by design. The only real change was loosening the birthdate constraint and fixing the default-value inconsistency it exposed.

---

## Manual Review + Verification Findings (012_gamification)

- **Proactively caught the same NULL-in-unique-constraint bug class twice, before it shipped, having already learned the lesson once in `game_whitelist` (003):** both `leaderboard_seasons` (nullable `cafe_id` for global seasons) and `leaderboard_entries` (nullable `game_id` for non-per-game categories) needed split partial unique indexes rather than a single plain `UNIQUE`, since Postgres treats NULLs as distinct values. Applied the fix proactively during design this time instead of discovering it via a failed test.
- **Closed a loose end left over from `001_foundation`:** `cafes.vip_seat_category` was added as an unvalidated `TEXT` column back when the category enum didn't concretely exist yet. Added a `CHECK` constraint now that `leaderboard_seasons.category` defines the real valid values, and explicitly tested that an invalid category string gets rejected.
- **`top_spender` challenges/leaderboards and minors:** the gamification design doc says spend-based leaderboards should exclude minors. Deliberately NOT enforced by a DB constraint here — judged lower-stakes than the teen/adult chat-contact issue (a fairness/pressure concern, not a contact-safety one), so left to the service layer, consistent with how most cross-table rules in this schema are handled. Documented so this isn't mistaken for an oversight.
- **Season closing (computing final ranks, freezing `season_history`, opening the next season) is explicitly out of scope for this migration** — service-layer/cron work, same pattern as the subscription lapse enforcement and photo-purge job.

---

## Manual Review + Verification Findings (013_localization_and_versioning)

- **Simplified a design that didn't hold up under scrutiny:** the originally sketched `version_compatibility` table (four columns: `server_version`, `minimum_os_version_required`, `os_version`, `minimum_server_version_required`) read like a per-pair compatibility matrix, but that's not actually how version checks work — each side just needs to state its own minimum requirement for the other, one value per version row. Folded both minimums directly into `server_versions`/`os_versions` instead of building a table whose row-per-what meaning was never actually clear. Deliberately not FKs to each other's `version_number`, since real compatibility checks need semver comparison (e.g. "1.1.5 satisfies a minimum of 1.1.0"), not exact-match referential integrity — and a minimum requirement can reasonably be declared before the version it points to has even shipped.
- **Confirmed most of the per-record columns this migration might have needed were already built** in `001_foundation` (`users.preferred_language`, `cafes.default_language`/`update_channel`/`maintenance_window_*`, `pcs.current_os_version`/`last_update_check_at`/`last_update_status`) — checked before writing anything, rather than assuming they still needed to be added.
- **This is the last migration in the original build order.** All 13 planned migrations are now written and verified against live Postgres. See "What's Next" below for the actual next phase.

---

## What's Next (Beyond the Original Migration Build Order)

The database schema is now complete and fully verified — 13 migrations, every one tested against live Postgres, not just reviewed on paper. The next phase is **service-layer code** (`src/` — api, auth, sessions, games, database, admin, billing, analytics), not more schema:

- A real **migration runner** (`src/database/`) with its own `schema_migrations` tracking table — needed before any of the `.up.sql`/`.down.sql` files here can be applied automatically rather than by hand through a scratch script
- The cross-table business rules explicitly deferred to "the service layer" throughout these migrations now need to actually be written there — e.g., `game_passes.active` consistency, subscription lapse/grace-period enforcement, the photo-purge cron job, season-closing logic, minor-exclusion from spend-based leaderboards
- Authentication (`src/auth/`) — Google Sign-In, session tokens, staff/owner login
- The actual API surface (`src/api/`) that the ZenCafe OS client and admin dashboard will call

**Before starting service code — both now decided:**
- **Minimum PostgreSQL version: 16.** No legacy system to support, and PG16 already covers everything used across all 13 migrations (`gen_random_uuid()`, `EXCLUDE USING gist`, partial indexes, `plpgsql` triggers).
- **Migration runner: a small custom one written in C++** (likely using `libpqxx`), not an existing tool like `golang-migrate`/Flyway — those require installing a separate language runtime (Go/Java) purely to run migrations, when the server itself is already C++. A minimal runner (read the numbered `.up.sql` files, track applied ones in a `schema_migrations` table, apply what's missing in order) is a small amount of code and keeps the deployment footprint to just the C++ server binary.

## Hardware Requirements (Server + Client OS) — See Dedicated Docs

Raised directly: many target café PCs are low-spec, older Windows 10/11 machines, and the "server" is sometimes a cheap single-board computer (e.g., Orange Pi), not a proper server box. This was worth reconsidering seriously, not just noting in passing:

- **Server:** `docs/deployment/hardware-requirements.md` — recommends 4GB+ RAM minimum (8GB comfortable), Linux over Windows for the server role specifically (lighter footprint), PostgreSQL tuning guidance for low-spec hardware (`shared_buffers`, `max_connections`, `work_mem`). **Orange Pi with only 1GB RAM is explicitly NOT recommended for production** — 2GB minimum, tested/reasoned through, not just asserted.
- **Client OS:** `zencafe-os/docs/setup/system-requirements.md` — gaming PC specs are dictated by whichever games a café offers, not by our software; but the OS's own footprint (shell, launcher, lockdown, watchdog) must stay minimal so it doesn't compete with the game for resources on low-spec machines. **Windows 10 must be a first-class supported target, not just Windows 11** — Windows 11's stricter hardware requirements (TPM 2.0, etc.) would exclude real customers' older machines.
- **This reconsidered, but did not reverse, the `cloud-stack.md` decision to self-host PostgreSQL everywhere** (rather than SQLite locally, as the original company proposal had planned). Rewriting all 13 already-verified migrations for SQLite (no `EXCLUDE` constraint, no native UUID/JSONB, different triggers) was judged not worth it once it was clear PostgreSQL can be tuned to run comfortably on the hardware actually being discussed. Full reasoning in `docs/deployment/hardware-requirements.md`.

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
- [x] ~~Confirm target minimum PostgreSQL version...~~ **RESOLVED: PostgreSQL 16.** No legacy system to support, and PG16 covers everything used across all 13 migrations. See "Hardware Requirements" section above.
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
10. ✅ `010_cafe_security_toggles` — remote_verification_enabled, owner-configurable settings policy (verified against live Postgres)
11. ✅ `011_guest_self_attestation` — reverts guest birthdate requirement, fixes is_minor default, guest chat exclusion (verified against live Postgres)
12. ✅ `012_gamification` — leaderboards, seasons, badges, challenges (verified against live Postgres)
13. ✅ `013_localization_and_versioning` — translation_keys, server_versions, os_versions (verified against live Postgres)

---

## Current Phase: Service-Layer Code (src/)

First real service code, not more schema. Started with the migration runner, since everything else depends on migrations being applicable automatically rather than by hand through a scratch script.

### Migration Runner — Status: WRITTEN, **NOT COMPILED, NOT TESTED**

**Read this carefully before trusting this code works.** This environment has no C++ compiler, no CMake, no Qt toolchain available (checked: `cmake`, `g++`, `cl`, `qmake` all absent) — the same limitation that blocked local Docker testing earlier in this project. Unlike every one of the 13 SQL migrations (all genuinely verified against live Postgres), **this C++ code has never been built or run.** It is carefully reasoned through, not verified.

**Files:**
- `src/database/migration_runner.h` / `.cpp` — `MigrationRunner` class: ensures a `schema_migrations` tracking table exists, finds pending migrations by scanning `migrations/*.up.sql`, applies each one inside its own transaction (rolls back cleanly on failure), records it as applied
- `src/main.cpp` — entry point; `zencafe-server --migrate` runs the migration runner and exits. Normal server mode isn't implemented yet.
- `CMakeLists.txt` updated — now actually builds an executable (was fully commented out before), linking only `Qt6::Core` + `Qt6::Sql` (Network/Concurrent deliberately not linked yet — nothing in this build uses them)

**Key design decision, worth understanding before touching this code:** each migration file is executed as **one whole string**, never split by semicolon. `008_content_and_chat_tiers.up.sql` and `009_social.up.sql` define PL/pgSQL trigger functions with semicolons *inside* `$$ ... $$` bodies — naive semicolon-splitting would break mid-function. PostgreSQL's own query protocol (used by the `QPSQL` driver) correctly parses multi-statement strings including dollar-quoted bodies when given the whole file at once. This is reasoned from how PostgreSQL's `PQexec` is documented to behave and how the earlier Node.js test scripts (`pg` library) successfully executed entire migration files as single calls throughout this project's testing — but it has NOT been specifically confirmed against Qt's `QPSQL` driver implementation. **This is the single most important thing to verify first** once a real build environment is available.

**Also unverified:** whether `QSqlDatabase`/`QSqlQuery`'s error-handling/transaction methods behave exactly as assumed (e.g., that `m_db.transaction()`/`commit()`/`rollback()` interact correctly with `QPSQL` the way they do with other Qt SQL drivers).

### How To Verify (Next Concrete Action)

Needs an actual Qt6 + CMake + C++ compiler environment, which this sandbox doesn't have:

1. Install Qt6 (Core + Sql modules, with the `QPSQL` plugin — on Windows this usually means building/obtaining the PostgreSQL driver plugin, which isn't always bundled by default with prebuilt Qt installers; may need `libpq` available at build time)
2. `cmake -B build && cmake --build build` from `zencafe-server/`
3. Set environment variables: `ZENCAFE_DB_HOST`, `ZENCAFE_DB_NAME`, `ZENCAFE_DB_USER`, `ZENCAFE_DB_PASSWORD` (and optionally `ZENCAFE_DB_PORT`, `ZENCAFE_MIGRATIONS_DIR`)
4. Run `./ZenCafeServer --migrate` against a **fresh, empty** test database (a new free Neon project works well, same approach used throughout this project's SQL testing) and confirm all 13 migrations apply successfully in order
5. Run it a second time immediately after — it should report success with **zero** migrations applied the second time (proves the `schema_migrations` tracking actually prevents re-running)
6. Update this section with real results once done — replace "NOT COMPILED, NOT TESTED" with what was actually confirmed working
