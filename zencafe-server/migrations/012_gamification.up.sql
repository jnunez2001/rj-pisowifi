-- Migration 012: Gamification - Leaderboards, Seasons, Badges, Challenges (UP)
-- See docs/gamification/README.md. cafes.vip_seat_pc_id/vip_seat_category and the
-- cosmetics.is_rank_locked/unlock_condition columns already exist (001_foundation,
-- 003_cosmetics_and_marketplace) - this migration adds the remaining pieces.

CREATE TABLE leaderboard_seasons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id UUID REFERENCES cafes(id) ON DELETE CASCADE, -- NULL means cross-branch/platform-wide
    category TEXT NOT NULL CHECK (category IN ('hours_total', 'hours_per_game', 'streak', 'diverse_games', 'top_spender', 'referral')),
    period_type TEXT NOT NULL CHECK (period_type IN ('weekly', 'monthly')),
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),

    CONSTRAINT season_time_valid CHECK (ends_at > starts_at)
);

-- Only one active season per (category, period_type) at a time - split into two indexes
-- since cafe_id can be NULL (global) and a plain UNIQUE constraint treats NULLs as distinct,
-- same NULL-handling issue already caught once in game_whitelist (003).
CREATE UNIQUE INDEX idx_leaderboard_seasons_active_branch ON leaderboard_seasons (cafe_id, category, period_type)
    WHERE status = 'active' AND cafe_id IS NOT NULL;
CREATE UNIQUE INDEX idx_leaderboard_seasons_active_global ON leaderboard_seasons (category, period_type)
    WHERE status = 'active' AND cafe_id IS NULL;

CREATE TABLE leaderboard_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    season_id UUID NOT NULL REFERENCES leaderboard_seasons(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id UUID REFERENCES games(id), -- only set for hours_per_game category
    score NUMERIC(12, 2) NOT NULL DEFAULT 0, -- meaning depends on category: minutes, streak days, pesos spent, etc.
    rank INT
);

-- One entry per player per season for non-per-game categories (game_id NULL), but a player
-- can have multiple entries in an hours_per_game season (one per game) - same NULL-handling
-- split as leaderboard_seasons above.
CREATE UNIQUE INDEX idx_leaderboard_entries_per_game ON leaderboard_entries (season_id, user_id, game_id)
    WHERE game_id IS NOT NULL;
CREATE UNIQUE INDEX idx_leaderboard_entries_overall ON leaderboard_entries (season_id, user_id)
    WHERE game_id IS NULL;
CREATE INDEX idx_leaderboard_entries_season_rank ON leaderboard_entries (season_id, rank);

CREATE TABLE season_history (
    season_id UUID NOT NULL REFERENCES leaderboard_seasons(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    final_rank INT NOT NULL,
    title_awarded TEXT,

    PRIMARY KEY (season_id, user_id)
);

CREATE TABLE user_badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Free text, not a CHECK enum - same reasoning as admin_notifications.type: an
    -- open/growing taxonomy of badge types, not a small fixed set.
    badge_type TEXT NOT NULL,
    label TEXT NOT NULL,
    awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_permanent BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_user_badges_user ON user_badges (user_id);

CREATE TABLE challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challenger_id UUID NOT NULL REFERENCES users(id),
    challenged_id UUID NOT NULL REFERENCES users(id),
    category TEXT NOT NULL CHECK (category IN ('hours_total', 'hours_per_game', 'streak', 'diverse_games', 'top_spender', 'referral')),
    target_value NUMERIC(12, 2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'won_by_challenger', 'defended_by_challenged', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT challenge_not_self CHECK (challenger_id != challenged_id)
);

CREATE INDEX idx_challenges_challenger ON challenges (challenger_id, status);
CREATE INDEX idx_challenges_challenged ON challenges (challenged_id, status);

-- cafes.vip_seat_category was added in 001_foundation as a loose TEXT column with no
-- validation, before the category enum was concretely defined by leaderboard_seasons above.
-- Constraining it now closes that gap.
ALTER TABLE cafes
    ADD CONSTRAINT vip_seat_category_valid CHECK (
        vip_seat_category IS NULL OR vip_seat_category IN ('hours_total', 'hours_per_game', 'streak', 'diverse_games', 'top_spender', 'referral')
    );
