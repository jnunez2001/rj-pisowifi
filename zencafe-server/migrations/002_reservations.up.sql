-- Migration 002: PC Reservations (UP)
-- Requires the btree_gist extension for the double-booking exclusion constraint below.
-- See docs/business-model/README.md "1. PC Reservation System (Credit-Burn Model)"

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE cafes
    ADD COLUMN reservation_grace_period_minutes INT NOT NULL DEFAULT 30,
    ADD COLUMN reservation_min_credit NUMERIC(10,2) NOT NULL DEFAULT 0;

CREATE TABLE reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    pc_id UUID NOT NULL REFERENCES pcs(id),
    cafe_id UUID NOT NULL REFERENCES cafes(id),
    reserved_start TIMESTAMPTZ NOT NULL,
    reserved_end TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'no_show_released', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT reservation_time_valid CHECK (reserved_end > reserved_start),

    -- Prevents two overlapping pending/active reservations on the same PC at the DB level,
    -- not just in application code - closes the race-condition window under concurrent booking.
    -- Completed/cancelled/no_show_released reservations don't block new bookings for that slot.
    EXCLUDE USING gist (
        pc_id WITH =,
        tstzrange(reserved_start, reserved_end) WITH &&
    ) WHERE (status IN ('pending', 'active'))
);

CREATE INDEX idx_reservations_pc_start ON reservations (pc_id, reserved_start);
CREATE INDEX idx_reservations_user ON reservations (user_id);

-- Links a session back to the reservation that spawned it (nullable - most sessions
-- are still walk-in, not reserved)
ALTER TABLE sessions
    ADD COLUMN reservation_id UUID REFERENCES reservations(id);
