-- Migration 010: Cafe-Level Security Toggles (UP)
-- See docs/compliance/README.md "Owner-Configurable vs. Platform-Fixed Security Settings"
--
-- This migration exists specifically BECAUSE of a request to make ALL safety measures
-- toggleable by café owners, backed by a liability waiver. That request was declined for
-- the mechanisms that prevent adult-minor contact (kids blocked from chat, teens/adults
-- never mixing, staff verification required before any chat unlocks) - a signed waiver
-- does not reliably waive statutory child-protection obligations, and the platform itself
-- would be exposed for having built the bypass. See PROGRESS.md for the full reasoning.
--
-- What IS added here are the legitimate operational toggles that carry no such risk:
-- curfew_enabled and lobby_chat_enabled already existed (001_foundation). This adds the
-- one missing operational toggle - whether a café allows remote (photo-based) verification
-- at all, or requires in-person-only. Turning this OFF just means players at that café
-- must be verified in person; it does NOT weaken what "verified" means or who can chat
-- with whom - the tier system and its triggers (008/009) apply identically either way.

ALTER TABLE cafes
    ADD COLUMN remote_verification_enabled BOOLEAN NOT NULL DEFAULT true;
