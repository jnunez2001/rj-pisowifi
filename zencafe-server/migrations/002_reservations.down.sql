-- Migration 002: PC Reservations (DOWN)

ALTER TABLE sessions DROP COLUMN IF EXISTS reservation_id;

DROP INDEX IF EXISTS idx_reservations_user;
DROP INDEX IF EXISTS idx_reservations_pc_start;

DROP TABLE IF EXISTS reservations;

ALTER TABLE cafes
    DROP COLUMN IF EXISTS reservation_min_credit,
    DROP COLUMN IF EXISTS reservation_grace_period_minutes;

-- Not dropping the btree_gist extension - other migrations/features may rely on it,
-- and extensions are cheap/harmless to leave installed.
