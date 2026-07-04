-- Migration 005: Subscription Grace Period (UP)
-- Resolves the open decision from 004_subscriptions: a lapsed platform_subscription or
-- pc_license gets a 24-hour grace period before the service layer fully enforces lockout
-- (disabling the Game Pass toggle / disabling the PC). This is a platform-wide policy
-- constant (Zentry's leniency decision), not a per-cafe configurable setting - so it is
-- documented here and enforced in the service layer using lapsed_at, not stored as a
-- per-cafe column.
--
-- GRACE PERIOD POLICY: 24 hours from lapsed_at before enforcement takes effect.

ALTER TABLE platform_subscriptions
    ADD COLUMN lapsed_at TIMESTAMPTZ; -- set by the service layer when status transitions to 'lapsed'

ALTER TABLE pc_licenses
    ADD COLUMN lapsed_at TIMESTAMPTZ; -- set by the service layer when status transitions to 'lapsed'
