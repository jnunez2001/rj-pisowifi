-- Migration 003: Cosmetics & Marketplace (UP)
-- See docs/business-model/README.md "2. Cosmetics Marketplace (Platform-Owned)"
-- games table already exists from 001_foundation.

-- 'designer' was referenced by docs/database/README.md (cosmetics.designer_id,
-- transactions.type = designer_payout) but never added as a valid role in 001 - fixing that gap here.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'staff', 'player', 'designer'));

-- Per-cafe branding shown in the cosmetics marketplace UI - the cafe earns no cut of
-- cosmetics revenue, this is branding/visibility only (docs/business-model/README.md section 2).
CREATE TABLE cafe_branding (
    cafe_id UUID PRIMARY KEY REFERENCES cafes(id) ON DELETE CASCADE,
    logo_url TEXT,
    display_position TEXT CHECK (display_position IN ('banner', 'corner')),
    enabled BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE game_whitelist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    pc_id UUID REFERENCES pcs(id) ON DELETE CASCADE -- NULL means whitelisted cafe-wide
);

-- Per-PC whitelist entries: no duplicate (cafe, game, specific PC)
CREATE UNIQUE INDEX idx_game_whitelist_per_pc ON game_whitelist (cafe_id, game_id, pc_id)
    WHERE pc_id IS NOT NULL;
-- Cafe-wide whitelist entries: no duplicate (cafe, game) when pc_id IS NULL
-- (a plain UNIQUE constraint would NOT catch this, since Postgres treats NULLs as distinct)
CREATE UNIQUE INDEX idx_game_whitelist_cafewide ON game_whitelist (cafe_id, game_id)
    WHERE pc_id IS NULL;

CREATE TABLE cosmetics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    designer_id UUID REFERENCES users(id), -- nullable: null means platform-created item
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('skin', 'theme', 'profile')),
    price NUMERIC(10,2),
    is_rank_locked BOOLEAN NOT NULL DEFAULT false,
    unlock_condition TEXT, -- e.g. "hold #1 in hours_total at any branch" - only set when rank-locked
    sales_count INT NOT NULL DEFAULT 0,

    -- Rank-locked cosmetics are earned, never purchased: no price, but must state how it's unlocked.
    -- Purchasable cosmetics are the opposite: must have a price, no unlock_condition.
    CONSTRAINT rank_locked_pricing CHECK (
        (is_rank_locked = true AND price IS NULL AND unlock_condition IS NOT NULL)
        OR
        (is_rank_locked = false AND price IS NOT NULL AND unlock_condition IS NULL)
    )
);

CREATE TABLE user_cosmetics (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cosmetic_id UUID NOT NULL REFERENCES cosmetics(id) ON DELETE CASCADE,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, cosmetic_id)
);
