-- Migration 003: Cosmetics & Marketplace (DOWN)

DROP TABLE IF EXISTS user_cosmetics;
DROP TABLE IF EXISTS cosmetics;

DROP INDEX IF EXISTS idx_game_whitelist_cafewide;
DROP INDEX IF EXISTS idx_game_whitelist_per_pc;
DROP TABLE IF EXISTS game_whitelist;

DROP TABLE IF EXISTS cafe_branding;

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'staff', 'player'));
