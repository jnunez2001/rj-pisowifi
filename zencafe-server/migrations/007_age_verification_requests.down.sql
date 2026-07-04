-- Migration 007: Remote Age Verification Requests (DOWN)

DROP INDEX IF EXISTS idx_age_verification_requests_user;
DROP INDEX IF EXISTS idx_age_verification_requests_cafe_status;
DROP TABLE IF EXISTS age_verification_requests;

ALTER TABLE users DROP COLUMN IF EXISTS remote_verification_blocked;

ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (action IN ('create', 'update', 'delete'));
