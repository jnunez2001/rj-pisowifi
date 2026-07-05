-- Migration 012: Gamification - Leaderboards, Seasons, Badges, Challenges (DOWN)

ALTER TABLE cafes DROP CONSTRAINT IF EXISTS vip_seat_category_valid;

DROP INDEX IF EXISTS idx_challenges_challenged;
DROP INDEX IF EXISTS idx_challenges_challenger;
DROP TABLE IF EXISTS challenges;

DROP INDEX IF EXISTS idx_user_badges_user;
DROP TABLE IF EXISTS user_badges;

DROP TABLE IF EXISTS season_history;

DROP INDEX IF EXISTS idx_leaderboard_entries_season_rank;
DROP INDEX IF EXISTS idx_leaderboard_entries_overall;
DROP INDEX IF EXISTS idx_leaderboard_entries_per_game;
DROP TABLE IF EXISTS leaderboard_entries;

DROP INDEX IF EXISTS idx_leaderboard_seasons_active_global;
DROP INDEX IF EXISTS idx_leaderboard_seasons_active_branch;
DROP TABLE IF EXISTS leaderboard_seasons;
