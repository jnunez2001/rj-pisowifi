-- Migration 014: Client Connection Grace Period (DOWN)

ALTER TABLE cafes DROP COLUMN IF EXISTS connection_grace_period_seconds;
