-- Migration 008: Content & Chat Age Tiers (UP)
-- Introduces a three-tier model (kids <13, teens 13-17, adults 18+) replacing the old
-- binary minor/adult split for two purposes:
--   1. Game menu filtering by content rating (games.age_rating) - a RESTRICTION, so safe
--      to drive from self-reported age_tier, same logic already used for curfew.
--   2. Chat tier eligibility (users.verified_chat_tier) - ACCESS-GRANTING, so must come
--      from staff verification, not self-report, consistent with the existing rule that
--      self-reported age never unlocks anything (only restricts).
-- Social/chat tables built on top of this in 009_social.

-- Self-reported, cached tier classification - safe for restricting content (like is_minor
-- is safe for curfew), NOT sufficient to unlock chat (see verified_chat_tier below).
-- Defaults to 'kids' (most restrictive) rather than 'adults' - fail-safe if a row is ever
-- created before the app computes the real tier from birthdate.
ALTER TABLE users
    ADD COLUMN age_tier TEXT DEFAULT 'kids' CHECK (age_tier IN ('kids', 'teens', 'adults'));

ALTER TABLE users
    ADD CONSTRAINT player_requires_age_tier CHECK (role != 'player' OR age_tier IS NOT NULL);

-- Replaces the old binary social_unlocked flag from earlier design docs (never actually
-- built as a column - social features hadn't been migrated yet). Null = no verified chat
-- access at all (covers kids unconditionally, and any teen/adult not yet staff-verified).
-- Only 'teens' or 'adults' are valid values - a kid can never hold a verified_chat_tier,
-- since kids get no chat access regardless of what staff verifies them as.
ALTER TABLE users
    ADD COLUMN verified_chat_tier TEXT CHECK (verified_chat_tier IN ('teens', 'adults'));

-- Content rating per game. Defaults to 'kids' (most restrictive) if unset - an unrated
-- game should never accidentally be visible to kids by defaulting the other direction.
ALTER TABLE games
    ADD COLUMN age_rating TEXT NOT NULL DEFAULT 'kids' CHECK (age_rating IN ('kids', 'teens', 'adults'));

-- age_verifications (006_compliance) only ever represents an approved outcome - every row
-- must explicitly state which tier staff verified. Added via temporary default then
-- dropped, so it's NOT NULL with no meaningful default going forward (existing rows, if
-- any, backfill to 'kids' as the safe default; new rows must specify explicitly).
ALTER TABLE age_verifications
    ADD COLUMN verified_tier TEXT DEFAULT 'kids' CHECK (verified_tier IN ('kids', 'teens', 'adults'));
ALTER TABLE age_verifications
    ALTER COLUMN verified_tier SET NOT NULL;
ALTER TABLE age_verifications
    ALTER COLUMN verified_tier DROP DEFAULT;

-- age_verification_requests (007) - the tier is decided by staff AT REVIEW time, not
-- self-declared by the submitter, so this is nullable and only set once approved -
-- mirrors the existing pattern for reviewed_by_user_id/reviewed_at/resulting_verification_id.
ALTER TABLE age_verification_requests
    ADD COLUMN approved_tier TEXT CHECK (approved_tier IN ('teens', 'adults'));

ALTER TABLE age_verification_requests
    ADD CONSTRAINT approved_tier_only_when_approved CHECK (
        (status = 'approved' AND approved_tier IS NOT NULL)
        OR
        (status != 'approved' AND approved_tier IS NULL)
    );
