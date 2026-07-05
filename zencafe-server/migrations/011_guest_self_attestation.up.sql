-- Migration 011: Guest Self-Attestation (UP)
-- See docs/compliance/README.md "Guest Access (Lightweight, No Verification)"
--
-- Guests should NOT go through the full birthdate/registration flow - that's friction
-- appropriate for a member, not someone who just wants to use a PC. Reverts part of
-- 006_compliance (which required birthdate for every account_type, reasoning that guest
-- curfew enforcement needed it) back to registered-only, replacing it with a lightweight,
-- unverified self-attestation ("are you 18 or older?") that just sets the EXISTING
-- age_tier/is_minor fields directly - no new column needed, since those fields were
-- already designed to be self-reported and fail-safe.

-- Only registered accounts must provide a birthdate. Guest/temporary use self-attestation.
ALTER TABLE users DROP CONSTRAINT player_requires_birthdate;
ALTER TABLE users ADD CONSTRAINT player_requires_birthdate CHECK (role != 'player' OR account_type != 'registered' OR birthdate IS NOT NULL);

-- Bug fix: is_minor defaulted to false (the unsafe direction), which was harmless while
-- every player always had an immediate birthdate-driven computation - it never stayed at
-- the raw default in practice. Now that guests can skip birthdate/computation entirely,
-- this default matters for real: it must agree with age_tier's existing fail-safe default
-- ('kids'), not contradict it.
ALTER TABLE users ALTER COLUMN is_minor SET DEFAULT true;

-- Guests and temporary accounts are excluded from social features entirely - not just
-- because verified_chat_tier happens to never get set for them, but as an explicit,
-- defensible rule: staff verification establishes a persistent identity, which doesn't fit
-- an account that may not even outlive the current visit.
ALTER TABLE users ADD CONSTRAINT chat_tier_requires_registered CHECK (account_type = 'registered' OR verified_chat_tier IS NULL);
