-- Migration 013: Localization & Versioning (DOWN)

DROP INDEX IF EXISTS idx_os_versions_channel_released;
DROP INDEX IF EXISTS idx_server_versions_channel_released;

DROP TABLE IF EXISTS os_versions;
DROP TABLE IF EXISTS server_versions;
DROP TABLE IF EXISTS translation_keys;
