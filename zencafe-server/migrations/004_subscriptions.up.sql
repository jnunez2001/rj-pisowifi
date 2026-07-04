-- Migration 004: Subscriptions (UP)
-- See docs/business-model/README.md sections 3 (Game Pass) and 4 (Per-PC Licensing)
--
-- Two independent systems here:
-- 1. platform_features / platform_plans / platform_plan_features / platform_subscriptions -
--    a flexible catalog so cafe owners can subscribe to a single feature OR a bundle
--    (e.g. a future "Pro" plan granting game_pass + cloud_monitoring together), without
--    needing a schema change later once actual bundles/pricing are decided.
-- 2. pc_licenses - kept separate because it's quantity-based (per PC), not a flat toggle,
--    so it doesn't fit the plan/feature shape above.

CREATE TABLE platform_features (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL UNIQUE, -- e.g. 'game_pass', 'cloud_monitoring', 'multi_location_dashboard'
    description TEXT
);

CREATE TABLE platform_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    price NUMERIC(10,2), -- nullable: pricing not decided yet
    billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly')),
    is_bundle BOOLEAN NOT NULL DEFAULT false -- informational only: true if this plan grants 2+ features
);

CREATE TABLE platform_plan_features (
    plan_id UUID NOT NULL REFERENCES platform_plans(id) ON DELETE CASCADE,
    feature_id UUID NOT NULL REFERENCES platform_features(id) ON DELETE CASCADE,

    PRIMARY KEY (plan_id, feature_id)
);

CREATE TABLE platform_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES platform_plans(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lapsed', 'cancelled')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);

-- A cafe shouldn't be double-billed for the same plan twice at once
CREATE UNIQUE INDEX idx_platform_subscriptions_active_unique
    ON platform_subscriptions (cafe_id, plan_id) WHERE status = 'active';

-- Each cafe's own Game Pass product. `active` should only be settable to true when the
-- cafe holds an active platform_subscriptions row granting the 'game_pass' feature - this
-- cross-table rule is NOT enforced by a DB constraint/trigger here (would need one, and the
-- lapse/grace-period business rule is still an open decision - see PROGRESS.md). Enforce in
-- the application/service layer for now.
CREATE TABLE game_passes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    perks JSONB NOT NULL DEFAULT '{}',
    active BOOLEAN NOT NULL DEFAULT false,
    billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly'))
);

CREATE TABLE game_pass_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_pass_id UUID NOT NULL REFERENCES game_passes(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
    renewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);

-- A player shouldn't hold two simultaneously-active subscriptions to the same Game Pass
CREATE UNIQUE INDEX idx_game_pass_subscriptions_active_unique
    ON game_pass_subscriptions (player_id, game_pass_id) WHERE status = 'active';

-- Per-PC base licensing fee - mandatory, quantity-based, separate from the feature/plan system above
CREATE TABLE pc_licenses (
    pc_id UUID PRIMARY KEY REFERENCES pcs(id) ON DELETE CASCADE,
    cafe_id UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    monthly_fee NUMERIC(10,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lapsed')),
    renewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
