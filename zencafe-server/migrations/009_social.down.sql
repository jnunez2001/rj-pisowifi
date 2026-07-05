-- Migration 009: Social - Tier-Aware Chat (DOWN)

DROP INDEX IF EXISTS idx_reports_resolved;
DROP TABLE IF EXISTS reports;

DROP INDEX IF EXISTS idx_messages_receiver;
DROP INDEX IF EXISTS idx_messages_room;
DROP TRIGGER IF EXISTS trg_messages_tier_check ON messages;
DROP FUNCTION IF EXISTS enforce_message_tier_access();
DROP TABLE IF EXISTS messages;

DROP TRIGGER IF EXISTS trg_friends_tier_match ON friends;
DROP FUNCTION IF EXISTS enforce_friend_tier_match();
DROP TABLE IF EXISTS friends;

DROP INDEX IF EXISTS idx_chat_rooms_local_per_cafe_tier;
DROP INDEX IF EXISTS idx_chat_rooms_global_per_tier;
DROP TABLE IF EXISTS chat_rooms;
