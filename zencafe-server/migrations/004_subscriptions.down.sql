-- Migration 004: Subscriptions (DOWN)

DROP TABLE IF EXISTS pc_licenses;

DROP INDEX IF EXISTS idx_game_pass_subscriptions_active_unique;
DROP TABLE IF EXISTS game_pass_subscriptions;
DROP TABLE IF EXISTS game_passes;

DROP INDEX IF EXISTS idx_platform_subscriptions_active_unique;
DROP TABLE IF EXISTS platform_subscriptions;
DROP TABLE IF EXISTS platform_plan_features;
DROP TABLE IF EXISTS platform_plans;
DROP TABLE IF EXISTS platform_features;
