-- Migration 006: Compliance (DOWN)

DROP INDEX IF EXISTS idx_audit_log_table_record;
DROP TABLE IF EXISTS audit_log;

DROP INDEX IF EXISTS idx_admin_notifications_cafe_created;
DROP TABLE IF EXISTS admin_notifications;

DROP INDEX IF EXISTS idx_age_verifications_user;
DROP TABLE IF EXISTS age_verifications;

ALTER TABLE users DROP CONSTRAINT player_requires_birthdate;
ALTER TABLE users ADD CONSTRAINT player_requires_birthdate CHECK (role != 'player' OR account_type != 'registered' OR birthdate IS NOT NULL);
