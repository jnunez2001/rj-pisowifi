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
  ├─ birthdate (required for player role)
  ├─ is_minor (computed/cached from birthdate, refreshed periodically)
  ├─ social_unlocked (boolean — true only once staff-verified as adult; gates friends/chat/spend-leaderboards)
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

```sql
age_verifications
  ├─ id (PK)
  ├─ user_id (FK → users)
  ├─ verified_by_staff_id (FK → users, role = staff — accountability record)
  ├─ cafe_id (FK → cafes)
  ├─ verified_at
  ├─ id_type_checked
  ├─ notes (encrypted)

admin_notifications
  ├─ id (PK)
  ├─ type (minor_guest_curfew_refund, temporary_account_expiring, etc.)
  ├─ cafe_id (FK → cafes)
  ├─ session_id (nullable, FK → sessions)
  ├─ amount_refunded (nullable)
  ├─ created_at

audit_log
  ├─ id (PK)
  ├─ user_id (FK → users)
  ├─ action (create, update, delete)
  ├─ table_name
  ├─ record_id
  ├─ old_value (JSON)
  ├─ new_value (JSON)
  ├─ timestamp
```

---

## Social

```sql
friends
  ├─ user_id (FK → users)
  ├─ friend_id (FK → users)
  ├─ status (pending, accepted, blocked)
  ├─ created_at

messages
  ├─ id (PK)
  ├─ sender_id (FK → users)
  ├─ receiver_id (nullable, FK → users)
  ├─ room_id (nullable — branch lobby chat)
  ├─ content
  ├─ flagged (boolean)
  ├─ created_at

reports
  ├─ id (PK)
  ├─ reporter_id (FK → users)
  ├─ reported_user_id (FK → users)
  ├─ message_id (nullable, FK → messages)
  ├─ reason
  ├─ resolved (boolean)
  ├─ created_at
```

---

## Gamification

```sql
leaderboard_seasons
  ├─ id (PK)
  ├─ cafe_id (nullable — null means cross-branch/platform-wide)
  ├─ category (hours_total, hours_per_game, streak, diverse_games, top_spender, referral)
  ├─ period_type (weekly, monthly)
  ├─ starts_at / ends_at
  ├─ status (active, closed)

leaderboard_entries
  ├─ season_id (FK → leaderboard_seasons)
  ├─ user_id (FK → users)
  ├─ game_id (nullable, FK → games)
  ├─ score
  ├─ rank

season_history
  ├─ season_id (FK → leaderboard_seasons)
  ├─ user_id (FK → users)
  ├─ final_rank
  ├─ title_awarded

user_badges
  ├─ id (PK)
  ├─ user_id (FK → users)
  ├─ badge_type (former_champion, first_to_achieve, vip_seat_holder, game_pass_subscriber)
  ├─ label
  ├─ awarded_at
  ├─ is_permanent (boolean)

challenges
  ├─ id (PK)
  ├─ challenger_id (FK → users)
  ├─ challenged_id (FK → users)
  ├─ category
  ├─ target_value
  ├─ status (pending, active, won_by_challenger, defended_by_challenged, expired)
  ├─ expires_at
```

---

## Localization & Versioning

```sql
translation_keys
  ├─ key
  ├─ language_code
  ├─ value

server_versions
  ├─ version_number
  ├─ release_notes
  ├─ channel (beta, stable)
  ├─ released_at
  ├─ is_critical_security_update (boolean)

os_versions
  ├─ version_number
  ├─ release_notes
  ├─ channel (beta, stable)
  ├─ released_at
  ├─ is_critical_security_update (boolean)

version_compatibility
  ├─ server_version
  ├─ minimum_os_version_required
  ├─ os_version
  ├─ minimum_server_version_required
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
007_social.up.sql / .down.sql                  -- friends, messages, reports
008_gamification.up.sql / .down.sql            -- leaderboards, seasons, badges, challenges
009_localization_and_versioning.up.sql / .down.sql
```

**On "idempotent":** raw `CREATE TABLE` statements are not naturally idempotent, and adding `IF NOT EXISTS` everywhere would silently mask real schema drift rather than catch it. Instead, idempotency comes from the migration **runner**, not the SQL itself — the runner maintains its own `schema_migrations` tracking table (recording which numbered migrations have already been applied) and skips any migration already marked done. This is the standard approach used by tools like `golang-migrate`/Flyway/Rails, and is what `src/database/` should implement rather than hand-rolling `IF NOT EXISTS` checks in every migration file.

## Indexing Priorities (v1)

- `sessions(pc_id, ended_at)` — fast lookup of active sessions per PC
- `wallets(user_id, cafe_id)` — unique constraint, hot path on every credit check
- `leaderboard_entries(season_id, category, rank)` — leaderboard reads happen constantly
- `transactions(cafe_id, created_at)` — revenue reporting queries
