-- Migration 008: Content & Chat Age Tiers (DOWN)

ALTER TABLE age_verification_requests DROP CONSTRAINT IF EXISTS approved_tier_only_when_approved;
ALTER TABLE age_verification_requests DROP COLUMN IF EXISTS approved_tier;

ALTER TABLE age_verifications DROP COLUMN IF EXISTS verified_tier;

ALTER TABLE games DROP COLUMN IF EXISTS age_rating;

ALTER TABLE users DROP COLUMN IF EXISTS verified_chat_tier;
ALTER TABLE users DROP CONSTRAINT IF EXISTS player_requires_age_tier;
ALTER TABLE users DROP COLUMN IF EXISTS age_tier;
