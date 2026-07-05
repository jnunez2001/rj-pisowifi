-- Migration 011: Guest Self-Attestation (DOWN)

ALTER TABLE users DROP CONSTRAINT IF EXISTS chat_tier_requires_registered;

ALTER TABLE users ALTER COLUMN is_minor SET DEFAULT false;

ALTER TABLE users DROP CONSTRAINT player_requires_birthdate;
ALTER TABLE users ADD CONSTRAINT player_requires_birthdate CHECK (role != 'player' OR birthdate IS NOT NULL);
