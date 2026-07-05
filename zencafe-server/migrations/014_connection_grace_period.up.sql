-- Migration 014: Client Connection Grace Period (UP)
-- See zencafe-os/docs/architecture/communication-protocol.md
--
-- How long a client PC's session keeps running seamlessly after losing contact with the
-- server before pausing (not locking - see the doc above for why pause, not lock, and why
-- not letting the client keep running/billing itself indefinitely while disconnected).
-- Bounded 5-30 seconds: long enough to absorb normal cafe network blips, short enough that
-- even at the most generous owner-configured setting there's nothing meaningful to gain by
-- deliberately triggering a disconnect.

ALTER TABLE cafes
    ADD COLUMN connection_grace_period_seconds INT NOT NULL DEFAULT 15
        CHECK (connection_grace_period_seconds BETWEEN 5 AND 30);
