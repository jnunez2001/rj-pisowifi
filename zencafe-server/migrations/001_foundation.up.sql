-- Migration 001: Foundation (UP)
-- Requires PostgreSQL 13+ (gen_random_uuid() is built into core as of PG13;
-- no pgcrypto/uuid-ossp extension needed).
--
-- users, cafes, pcs, staff, wallets, games, sessions, transactions
-- Everything else (reservations, cosmetics, subscriptions, compliance, social,
-- gamification, localization/versioning) builds on top of this in later migrations.

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE,
    password_hash TEXT,
    google_id TEXT UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'player')),
    account_type TEXT NOT NULL DEFAULT 'registered' CHECK (account_type IN ('registered', 'guest', 'temporary')),
    birthdate DATE,
    is_minor BOOLEAN NOT NULL DEFAULT false,
    social_unlocked BOOLEAN NOT NULL DEFAULT false,
    status_visibility TEXT NOT NULL DEFAULT 'friends_only' CHECK (status_visibility IN ('public', 'friends_only', 'private')),
    preferred_language TEXT NOT NULL DEFAULT 'en',
    temporary_expires_at TIMESTAMPTZ,
    temporary_expiry_reminder_sent BOOLEAN NOT NULL DEFAULT false,
    temporary_deactivated BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT player_requires_birthdate CHECK (role != 'player' OR account_type != 'registered' OR birthdate IS NOT NULL)
);

CREATE TABLE cafes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    location TEXT,
    is_staffed BOOLEAN NOT NULL DEFAULT true,
    curfew_enabled BOOLEAN NOT NULL DEFAULT false,
    curfew_start TIME,
    curfew_end TIME,
    min_credit_for_account_transfer NUMERIC(10,2) NOT NULL DEFAULT 0,
    temporary_account_validity_days INT NOT NULL DEFAULT 7,
    lobby_chat_enabled BOOLEAN NOT NULL DEFAULT false,
    vip_seat_pc_id UUID, -- FK added below, after pcs table exists (circular reference)
    vip_seat_category TEXT,
    default_language TEXT NOT NULL DEFAULT 'en',
    update_channel TEXT NOT NULL DEFAULT 'stable' CHECK (update_channel IN ('beta', 'stable')),
    maintenance_window_start TIME NOT NULL DEFAULT '04:00',
    maintenance_window_end TIME NOT NULL DEFAULT '05:00',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pcs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    pc_name TEXT NOT NULL,
    specs JSONB,
    tier TEXT NOT NULL DEFAULT 'regular' CHECK (tier IN ('regular', 'vip')),
    status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'maintenance', 'reserved')),
    current_os_version TEXT,
    last_update_check_at TIMESTAMPTZ,
    last_update_status TEXT CHECK (last_update_status IN ('success', 'failed_rolled_back', 'pending')),

    UNIQUE (cafe_id, pc_name)
);

ALTER TABLE cafes
    ADD CONSTRAINT fk_vip_seat_pc FOREIGN KEY (vip_seat_pc_id) REFERENCES pcs(id) ON DELETE SET NULL;

CREATE TABLE staff (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cafe_id UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    permissions JSONB NOT NULL DEFAULT '{}',

    PRIMARY KEY (user_id, cafe_id)
);

CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cafe_id UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    balance NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (user_id, cafe_id)
);

CREATE TABLE games (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pc_id UUID NOT NULL REFERENCES pcs(id),
    player_id UUID NOT NULL REFERENCES users(id),
    game_id UUID REFERENCES games(id),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    total_minutes INT,
    amount_charged NUMERIC(10,2),
    ended_reason TEXT CHECK (ended_reason IN ('manual', 'credit_depleted', 'curfew_auto_end', 'admin_forced')),
    is_reservation BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    cafe_id UUID REFERENCES cafes(id),
    type TEXT NOT NULL CHECK (type IN (
        'session_billing', 'cosmetic_purchase', 'game_pass_subscription',
        'platform_fee', 'designer_payout', 'pc_license_fee', 'refund'
    )),
    payee TEXT NOT NULL CHECK (payee IN ('platform', 'cafe')),
    amount NUMERIC(10,2) NOT NULL,
    platform_fee NUMERIC(10,2),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexing priorities per docs/database/README.md
-- (wallets(user_id, cafe_id) already covered by its UNIQUE constraint above)
CREATE INDEX idx_sessions_pc_ended ON sessions (pc_id, ended_at);
CREATE INDEX idx_transactions_cafe_created ON transactions (cafe_id, created_at);
