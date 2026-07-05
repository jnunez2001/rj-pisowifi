-- Migration 010: Cafe-Level Security Toggles (DOWN)

ALTER TABLE cafes DROP COLUMN IF EXISTS remote_verification_enabled;
