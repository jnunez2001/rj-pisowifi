-- Migration 005: Subscription Grace Period (DOWN)

ALTER TABLE pc_licenses DROP COLUMN IF EXISTS lapsed_at;
ALTER TABLE platform_subscriptions DROP COLUMN IF EXISTS lapsed_at;
