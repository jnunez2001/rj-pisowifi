# ZenCafe Backend Database Design (Consolidated Schema)

This reconciles every table sketched across the design docs (business-model, compliance, social, gamification, deployment, architecture/localization) into one authoritative reference. Individual docs still explain *why* a field exists — this doc is the single source of truth for *what* the schema actually looks like.

## Key Design Principles

1. **ACID Guarantees** — financial transactions must not fail or double-apply
2. **Normalization** — reduce data duplication
3. **Audit Trail** — every sensitive change is traceable (who, when, where)
4. **Encryption** — passwords, tokens, and staff verification notes encrypted at rest
5. **Per-branch scoping** — most café-specific settings (curfew, pricing, update channel) live on `cafes`, not globally

---

## Core Identity & Café Structure

```sql
users
  ├─ id (PK)
  ├─ email (unique, nullable for guest accounts)
  ├─ password_hash (nullable — Google-only accounts won't have one)
  ├─ google_id (nullable, unique — for "Sign in with Google")
  ├─ role (owner, staff, player)
  ├─ account_type (registered, guest, temporary)
  ├─ birthdate (required only for role=player AND account_type='registered' — see
    011_guest_self_attestation, which reversed an earlier decision requiring it for guests
    too, once the desired zero-friction guest experience was clarified)
  ├─ is_minor (computed/cached from birthdate for registered players; for guests, set
    directly from a single unverified "18+?" self-attestation prompt instead. Defaults to
    `true` — fixed in 011_guest_self_attestation from an earlier unsafe `false` default that
    only seemed harmless because every player previously always had an immediate
    birthdate-driven computation, so the raw default was never actually relied upon until
    guests could skip that step entirely)
  ├─ age_tier (kids <13, teens 13-17, adults 18+ — self-reported/cached, added in
    008_content_and_chat_tiers; safe for RESTRICTING content like the game menu, same logic
    as is_minor/curfew, NOT sufficient to unlock chat. Defaults to 'kids', the fail-safe
    direction, consistent with is_minor's default above)
  ├─ verified_chat_tier (teens, adults, nullable — staff-verified only, added in
    008_content_and_chat_tiers; replaces the earlier conceptual "social_unlocked" boolean,
    which was never actually built as a column before this. Null = no chat access at all,
    covering kids unconditionally and any unverified teen/adult. Can only ever be set for
    `account_type = 'registered'` — enforced by the `chat_tier_requires_registered`
    constraint added in 011_guest_self_attestation, since guests/temporary accounts are
    excluded from social features entirely)
  ├─ remote_verification_blocked (boolean — see age_verification_requests section below)
  ├─ status_visibility (public, friends_only, private)
  ├─ preferred_language (e.g., "en", "fil", "id", "vi", "th", "ms")
  ├─ temporary_expires_at (nullable — only for temporary accounts)
  ├─ temporary_expiry_reminder_sent (boolean)
  ├─ temporary_deactivated (boolean)
  ├─ created_at

cafes
  ├─ id (PK)
  ├─ owner_id (FK → users)
  ├─ name
  ├─ location
  ├─ is_staffed (boolean — determines refund vs temp-account flow on forced session end)
  ├─ curfew_enabled (boolean)
  ├─ curfew_start / curfew_end (time)
  ├─ min_credit_for_account_transfer (₱ threshold)
  ├─ temporary_account_validity_days
  ├─ lobby_chat_enabled (boolean, opt-in)
  ├─ remote_verification_enabled (boolean, default true — added in
    010_cafe_security_toggles; whether this café allows photo-based remote verification vs
    in-person-only. See "Owner-Configurable vs. Platform-Fixed Security Settings" in
    compliance/README.md for what is and is NOT toggleable, and why)
  ├─ connection_grace_period_seconds (default 15, bounded 5-30 — added in
    014_connection_grace_period; how long a client PC keeps running seamlessly after
    losing contact with the server before pausing. See
    zencafe-os/docs/architecture/communication-protocol.md)
  ├─ reservation_grace_period_minutes (default 30 — auto-release unclaimed reservation)
  ├─ reservation_min_credit (₱ minimum balance required to reserve a PC)
  ├─ vip_seat_pc_id (nullable, FK → pcs)
  ├─ vip_seat_category (which leaderboard category grants the VIP seat)
  ├─ default_language
  ├─ update_channel (beta, stable)
  ├─ maintenance_window_start / maintenance_window_end
  ├─ created_at

pcs
  ├─ id (PK)
  ├─ cafe_id (FK → cafes)
  ├─ pc_name
  ├─ specs (CPU, RAM, GPU — JSON)
  ├─ tier (regular, vip — drives hourly rate for credit-burn conversion)
  ├─ status (online, offline, maintenance, reserved)
  ├─ current_os_version
  ├─ last_update_check_at
  ├─ last_update_status (success, failed_rolled_back, pending)

staff
  ├─ user_id (FK → users, role = staff)
  ├─ cafe_id (FK → cafes)
  ├─ permissions (JSON — e.g., can_verify_age, can_manage_pricing)
```

---

## Wallet, Sessions & Billing

Credit is **per café** (not a single global balance), since pricing and revenue both route to the specific café a player is at.

```sql
wallets
  ├─ id (PK)
  ├─ user_id (FK → users)
  ├─ cafe_id (FK → cafes)
  ├─ balance (₱, decimal — never float, for exact money math)
  ├─ updated_at

sessions
  ├─ id (PK)
  ├─ pc_id (FK → pcs)
  ├─ player_id (FK → users)
  ├─ game_id (FK → games, nullable)
  ├─ started_at
  ├─ ended_at
  ├─ total_minutes
  ├─ amount_charged
  ├─ ended_reason (manual, credit_depleted, curfew_auto_end, admin_forced)
  ├─ is_reservation (boolean)
  ├─ reservation_id (nullable, FK → reservations — links session back to the booking that spawned it)

reservations
  ├─ id (PK)
  ├─ user_id (FK → users)
  ├─ pc_id (FK → pcs)
  ├─ cafe_id (FK → cafes)
  ├─ reserved_start / reserved_end
  ├─ status (pending, active, completed, no_show_released, cancelled)
  ├─ created_at
  ├─ DB-level EXCLUDE constraint (pc_id, time range overlap) prevents double-booking the same
    PC for overlapping pending/active reservations — enforced at the database, not just app code

transactions
  ├─ id (PK)
  ├─ user_id (FK → users)
  ├─ cafe_id (FK → cafes, nullable — null for pure platform transactions)
  ├─ type (session_billing, cosmetic_purchase, game_pass_subscription, platform_fee, designer_payout, pc_license_fee, refund)
  ├─ payee (platform, cafe)
  ├─ amount
  ├─ platform_fee (nullable — cut taken on café-owned revenue like Game Pass)
  ├─ description
  ├─ created_at
```

---

## Games & Cosmetics

```sql
games
  ├─ id (PK)
  ├─ title
  ├─ description
  ├─ metadata (JSON)
  ├─ age_rating (kids, teens, adults — added in 008_content_and_chat_tiers; defaults to
    'kids', the most restrictive, if unset — an unrated game should never accidentally be
    visible to kids by defaulting the other direction. Drives game-menu filtering: a
    player's menu shows games rated at or below their own age_tier, intersected with
    whatever the café has whitelisted)

game_whitelist
  ├─ id (PK)
  ├─ cafe_id (FK → cafes)
  ├─ game_id (FK → games)
  ├─ pc_id (nullable, FK → pcs — null means whitelisted cafe-wide)
  ├─ unique per (cafe_id, game_id, pc_id) when pc_id set; unique per (cafe_id, game_id) when
    pc_id is null (a plain UNIQUE constraint doesn't catch the null case, needs a partial index)

cafe_branding (cafe's visibility in the platform-owned cosmetics marketplace UI — not a cut of revenue)
  ├─ cafe_id (PK, FK → cafes)
  ├─ logo_url
  ├─ display_position (banner, corner)
  ├─ enabled (boolean)

cosmetics
  ├─ id (PK)
  ├─ designer_id (FK → users, nullable — null for platform-created items; requires users.role
    to allow 'designer', added as a role option in migration 003)
  ├─ name
  ├─ type (skin, theme, profile)
  ├─ price (set only for purchasable items)
  ├─ is_rank_locked (boolean)
  ├─ unlock_condition (e.g., "hold #1 in hours_total at any branch" — set only when rank-locked)
  ├─ sales_count
  ├─ CHECK: rank-locked items have unlock_condition + no price; purchasable items have price +
    no unlock_condition (mutually exclusive — merged what was originally sketched as a separate
    rank_locked_cosmetics table, since it was a pure 1:1 relationship not worth a join)

user_cosmetics (ownership)
  ├─ user_id (FK → users)
  ├─ cosmetic_id (FK → cosmetics)
  ├─ acquired_at
```

---

## Subscriptions (Two-Layer Model)

The platform side (`platform_features`/`platform_plans`/`platform_plan_features`/`platform_subscriptions`) is a flexible catalog rather than one row per feature — this lets a café subscribe to a single feature OR a bundle (e.g. a future "Pro" plan granting Game Pass + Cloud Monitoring together) without a schema change once actual bundles/pricing are decided. Per-PC licensing stays separate since it's quantity-based, not a flat on/off toggle.

```sql
platform_features (catalog of toggleable platform capabilities)
  ├─ id (PK)
  ├─ key (unique — e.g. 'game_pass', 'cloud_monitoring', 'multi_location_dashboard')
  ├─ description

platform_plans (a single-feature plan OR a bundle — same shape either way)
  ├─ id (PK)
  ├─ name
  ├─ price (nullable — pricing not decided yet)
  ├─ billing_cycle (monthly, yearly)
  ├─ is_bundle (informational — true if this plan grants 2+ features)

platform_plan_features (many-to-many: which features a plan grants)
  ├─ plan_id (FK → platform_plans)
  ├─ feature_id (FK → platform_features)

platform_subscriptions (a cafe's actual subscription to one plan)
  ├─ id (PK)
  ├─ cafe_id (FK → cafes)
  ├─ plan_id (FK → platform_plans)
  ├─ status (active, lapsed, cancelled)
  ├─ started_at / expires_at
  ├─ lapsed_at (set when status transitions to lapsed — starts the 24h grace-period clock,
    see "Grace Period Policy" below)
  ├─ unique per (cafe_id, plan_id) while status = active — prevents double-billing

game_passes (each cafe's own Game Pass product)
  ├─ id (PK)
  ├─ cafe_id (FK → cafes)
  ├─ name
  ├─ price
  ├─ perks (JSON)
  ├─ active (boolean — should only be true if the cafe holds an active platform_subscriptions
    row granting the 'game_pass' feature, or is within its 24h grace period; NOT enforced by
    a DB constraint — enforce in the service layer)
  ├─ billing_cycle

game_pass_subscriptions (a player subscribing to a specific cafe's Game Pass)
  ├─ id (PK)
  ├─ player_id (FK → users)
  ├─ game_pass_id (FK → game_passes)
  ├─ status (active, expired, cancelled)
  ├─ renewed_at / expires_at
  ├─ unique per (player_id, game_pass_id) while status = active

pc_licenses (per-PC base licensing fee — mandatory, quantity-based, not part of the plan system above)
  ├─ pc_id (PK, FK → pcs)
  ├─ cafe_id (FK → cafes)
  ├─ monthly_fee
  ├─ status (active, lapsed)
  ├─ renewed_at
  ├─ lapsed_at (same 24h grace-period policy as platform_subscriptions above)
```

**Grace Period Policy (decided):** when a `platform_subscriptions` or `pc_licenses` row transitions to `lapsed`, the café gets a **24-hour grace period** (measured from `lapsed_at`) before the service layer fully enforces lockout (disabling the Game Pass toggle, disabling the PC). This is a platform-wide policy constant set by Zentry, not a per-café configurable setting, so it isn't stored as a column — the service layer computes `now() > lapsed_at + interval '24 hours'` to decide whether to enforce.

---

## Compliance

**Superseded by `011_guest_self_attestation`:** an earlier decision widened `player_requires_birthdate` to require every account type (including guest) to have a birthdate, so curfew could apply to guests. That was reversed once the actual desired guest experience was clarified — guests should have zero registration friction. `player_requires_birthdate` is back to `registered`-only; guests instead get a single unverified "18 or older?" prompt that sets `age_tier`/`is_minor` directly (see [compliance/README.md](../compliance/README.md) "Guest Access"). Falling back to the fail-safe defaults (`kids`/`true`) if unanswered is an accepted, documented limitation, not a gap that was missed.

```sql
age_verifications
  ├─ id (PK)
  ├─ user_id (FK → users)
  ├─ verified_by_user_id (FK → users — not the staff table, since staff's PK is composite
    (user_id, cafe_id); a staff member's or owner's identity for accountability is just their
    user_id)
  ├─ cafe_id (FK → cafes)
  ├─ verified_at
  ├─ id_type_checked
  ├─ notes
  ├─ verified_tier (kids, teens, adults — added in 008_content_and_chat_tiers; staff states
    which tier they confirmed, not just a binary adult check. NOT NULL, no meaningful
    default — every insert must be an explicit staff decision)

admin_notifications
  ├─ id (PK)
  ├─ type (free text, not a CHECK enum — this is a growing/open taxonomy across many features,
    unlike audit_log.action below which is a genuinely closed CRUD set)
  ├─ cafe_id (FK → cafes)
  ├─ session_id (nullable, FK → sessions)
  ├─ amount_refunded (nullable)
  ├─ created_at

audit_log
  ├─ id (PK)
  ├─ user_id (FK → users, nullable — some system-triggered changes have no acting user)
  ├─ action (create, update, delete, view — 'view' added for logging sensitive photo access,
    see age_verification_requests below)
  ├─ table_name
  ├─ record_id (no FK — polymorphic reference across many different tables)
  ├─ old_value (JSON)
  ├─ new_value (JSON)
  ├─ timestamp

age_verification_requests (pending-review workflow for REMOTE verification — distinct from
  age_verifications above, which only ever represents an ALREADY-APPROVED outcome)
  ├─ id (PK)
  ├─ user_id (FK → users)
  ├─ cafe_id (FK → cafes)
  ├─ id_photo_key (private bucket object key — NOT the public cosmetics R2 bucket, NOT a
    permanent URL; access via short-lived signed URLs generated on demand)
  ├─ selfie_photo_key (required alongside id_photo_key — a photo of an ID alone doesn't
    prove the submitter is the person in it; staff compares selfie to ID before approving)
  ├─ status (pending, approved, rejected)
  ├─ rejection_reason (set only when rejected)
  ├─ reviewed_by_user_id (FK → users, set only once reviewed)
  ├─ reviewed_at (set only once reviewed)
  ├─ resulting_verification_id (FK → age_verifications, set only on approval — links the
    request to the permanent accountability record it created)
  ├─ submitted_at
  ├─ photo_purge_at (scheduled deletion time for the raw photos once decided — actual purge
    job is a service-layer/cron responsibility, not enforced by the schema itself)
  ├─ approved_tier (teens, adults — added in 008_content_and_chat_tiers; set only when
    status = approved, flows into age_verifications.verified_tier and then
    users.verified_chat_tier)

users — addition
  ├─ remote_verification_blocked (boolean — set by the service layer after a policy-defined
    number of rejected requests; forces in-person-only verification going forward, an
    anti-abuse control against repeated fake/borrowed-ID submission attempts)
```

---

## Social (Tier-Aware Chat)

Added in `009_social`, built on top of the tier system from `008_content_and_chat_tiers`. **Deliberate exception to how this schema normally handles cross-table rules:** everywhere else (Game Pass activation, subscription lapses), those are left to the service layer. Here, tier-matching for friends and messages is enforced by actual PostgreSQL triggers (`trg_friends_tier_match`, `trg_messages_tier_check`) — the stakes of an adult contacting a verified teen are high enough to warrant defense in depth, not just an app-layer promise.

```sql
chat_rooms
  ├─ id (PK)
  ├─ cafe_id (nullable, FK → cafes — null means a global, cross-branch room)
  ├─ tier (teens, adults — kids never get a room, no chat at all)
  ├─ room_type (local, global)
  ├─ exactly one global room per tier; exactly one local room per (cafe_id, tier)

friends
  ├─ user_id (FK → users)
  ├─ friend_id (FK → users)
  ├─ status (pending, accepted, blocked)
  ├─ created_at
  ├─ PK (user_id, friend_id)
  ├─ TRIGGER: rejects insert unless both users hold a matching, non-null
    verified_chat_tier (both teens, or both adults)

messages
  ├─ id (PK)
  ├─ sender_id (FK → users)
  ├─ receiver_id (nullable, FK → users — set for a DM)
  ├─ room_id (nullable, FK → chat_rooms — set for a room post; exactly one of
    receiver_id/room_id is set, never both, never neither)
  ├─ content
  ├─ flagged (boolean)
  ├─ created_at
  ├─ TRIGGER: rejects insert if sender isn't verified, or if sender/room or
    sender/receiver verified_chat_tier don't match

reports
  ├─ id (PK)
  ├─ reporter_id (FK → users)
  ├─ reported_user_id (FK → users)
  ├─ message_id (nullable, FK → messages)
  ├─ reason
  ├─ resolved (boolean)
  ├─ created_at
```

**Known limitation:** the triggers only validate at insert time. If a `verified_chat_tier` is revoked or changed after a friendship/room membership already exists, nothing automatically re-validates existing rows — periodic re-validation is service-layer follow-up work, not part of this migration.

---

## Gamification

`cafes.vip_seat_pc_id`/`vip_seat_category` and `cosmetics.is_rank_locked`/`unlock_condition` were already added in `001_foundation`/`003_cosmetics_and_marketplace` — `012_gamification` adds the rest, plus a constraint tightening `vip_seat_category` (previously an unvalidated loose `TEXT` column) now that the category enum is concretely defined below.

```sql
leaderboard_seasons
  ├─ id (PK)
  ├─ cafe_id (nullable, FK → cafes — null means cross-branch/platform-wide)
  ├─ category (hours_total, hours_per_game, streak, diverse_games, top_spender, referral)
  ├─ period_type (weekly, monthly)
  ├─ starts_at / ends_at (CHECK: ends_at > starts_at)
  ├─ status (active, closed)
  ├─ only one active season per (category, period_type) — two partial unique indexes, split
    on cafe_id IS NULL vs NOT NULL, since a plain UNIQUE treats NULLs as distinct (same
    NULL-handling issue already caught once in game_whitelist, 003)

leaderboard_entries
  ├─ id (PK)
  ├─ season_id (FK → leaderboard_seasons)
  ├─ user_id (FK → users)
  ├─ game_id (nullable, FK → games — only set for hours_per_game category)
  ├─ score (NUMERIC — meaning depends on category: minutes, streak days, pesos spent, etc.)
  ├─ rank
  ├─ one entry per (season_id, user_id) when game_id is null; one per (season_id, user_id,
    game_id) when set — same split-partial-index pattern as leaderboard_seasons above

season_history
  ├─ season_id (FK → leaderboard_seasons)
  ├─ user_id (FK → users)
  ├─ final_rank
  ├─ title_awarded
  ├─ PK (season_id, user_id)

user_badges
  ├─ id (PK)
  ├─ user_id (FK → users)
  ├─ badge_type (free text, not a CHECK enum — same reasoning as admin_notifications.type:
    an open/growing taxonomy, e.g. former_champion, first_to_achieve, vip_seat_holder,
    game_pass_subscriber)
  ├─ label
  ├─ awarded_at
  ├─ is_permanent (boolean)

challenges
  ├─ id (PK)
  ├─ challenger_id (FK → users)
  ├─ challenged_id (FK → users)
  ├─ category (same enum as leaderboard_seasons.category)
  ├─ target_value
  ├─ status (pending, active, won_by_challenger, defended_by_challenged, expired)
  ├─ expires_at
  ├─ CHECK: challenger_id != challenged_id (can't challenge yourself)
```

**Note on `top_spender` challenges/leaderboards and minors:** per `gamification/README.md`, spend-based leaderboards should exclude minors (financial-pressure risk). This is NOT enforced by a DB constraint here — unlike the teen/adult chat separation, this is judged lower-stakes (a fairness/pressure concern, not a contact-safety one), so it's left to the service layer, consistent with how most cross-table business rules in this schema are handled.

**Season closing (recalculating final ranks, freezing into `season_history`, opening the next season) is service-layer/cron work**, not enforced by this migration — same pattern as subscription lapse enforcement and the photo-purge job.

---

## Localization & Versioning

`users.preferred_language`, `cafes.default_language`, `cafes.update_channel`,
`cafes.maintenance_window_start`/`end`, and `pcs.current_os_version`/`last_update_check_at`/
`last_update_status` all already exist (`001_foundation`). `013_localization_and_versioning`
adds the rest.

**Design simplification:** the originally sketched standalone `version_compatibility` table didn't have a clean row-per-what meaning — it read like a per-pair matrix, but a compatibility check is really just "does the other side's version meet my own minimum requirement," which only needs one value per version row. Folded `minimum_os_version_required` into `server_versions` and `minimum_server_version_required` into `os_versions` instead. These are plain `TEXT`, not FKs to each other's `version_number` — actual compatibility checks need semver comparison logic (e.g. "1.1.5 satisfies a minimum of 1.1.0"), not exact-match referential integrity, and a minimum requirement can reasonably be set before the referenced version has even shipped.

```sql
translation_keys
  ├─ key
  ├─ language_code (free text, not a CHECK enum — the language rollout list grows over
    phases, see architecture/localization.md)
  ├─ value
  ├─ PK (key, language_code)

server_versions
  ├─ version_number (PK)
  ├─ release_notes
  ├─ channel (beta, stable)
  ├─ released_at
  ├─ is_critical_security_update (boolean)
  ├─ minimum_os_version_required (nullable — see design simplification above)

os_versions
  ├─ version_number (PK)
  ├─ release_notes
  ├─ channel (beta, stable)
  ├─ released_at
  ├─ is_critical_security_update (boolean)
  ├─ minimum_server_version_required (nullable — see design simplification above)
```

---

## Migration Strategy

Migrations live in `/migrations/`, applied in phases matching build order rather than one giant file. Each numbered migration is a **pair of files** — `NNN_name.up.sql` (apply) and `NNN_name.down.sql` (reverse it, in the opposite order of creation to respect foreign keys):

```
001_foundation.up.sql / .down.sql              -- users, cafes, pcs, staff, wallets, games, sessions, transactions
002_reservations.up.sql / .down.sql
003_cosmetics_and_marketplace.up.sql / .down.sql
004_subscriptions.up.sql / .down.sql           -- platform_subscriptions (bundle-capable), game_passes, pc_licenses
005_subscription_grace_period.up.sql / .down.sql  -- lapsed_at columns, 24h grace period policy
006_compliance.up.sql / .down.sql              -- age_verifications, admin_notifications, audit_log
007_age_verification_requests.up.sql / .down.sql  -- remote selfie+ID verification workflow
008_content_and_chat_tiers.up.sql / .down.sql  -- kids/teens/adults tier system (games.age_rating, users tier fields)
009_social.up.sql / .down.sql                  -- tier-aware friends, messages, chat_rooms, reports
010_cafe_security_toggles.up.sql / .down.sql   -- remote_verification_enabled (owner-configurable settings, see compliance/README.md)
011_guest_self_attestation.up.sql / .down.sql  -- reverts birthdate requirement for guests, fixes is_minor default, adds chat_tier_requires_registered
012_gamification.up.sql / .down.sql            -- leaderboards, seasons, badges, challenges
013_localization_and_versioning.up.sql / .down.sql
014_connection_grace_period.up.sql / .down.sql -- cafes.connection_grace_period_seconds
```

**On "idempotent":** raw `CREATE TABLE` statements are not naturally idempotent, and adding `IF NOT EXISTS` everywhere would silently mask real schema drift rather than catch it. Instead, idempotency comes from the migration **runner**, not the SQL itself — the runner maintains its own `schema_migrations` tracking table (recording which numbered migrations have already been applied) and skips any migration already marked done. This is the standard approach used by tools like `golang-migrate`/Flyway/Rails, and is what `src/database/` should implement rather than hand-rolling `IF NOT EXISTS` checks in every migration file.

## Indexing Priorities (v1)

- `sessions(pc_id, ended_at)` — fast lookup of active sessions per PC
- `wallets(user_id, cafe_id)` — unique constraint, hot path on every credit check
- `leaderboard_entries(season_id, category, rank)` — leaderboard reads happen constantly
- `transactions(cafe_id, created_at)` — revenue reporting queries
