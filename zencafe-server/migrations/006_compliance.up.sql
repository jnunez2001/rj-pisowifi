-- Migration 006: Compliance (UP)
-- See docs/compliance/README.md and docs/social/README.md (shared age_verifications table)

-- Resolves the open decision from PROGRESS.md: the compliance doc describes a "Guest
-- (no account, walk-in cash session)" whose credit gets refunded and admin-notified when
-- curfew hits mid-session - that flow only works if the system already knows the guest's
-- age, meaning guest accounts must also collect a birthdate, not just registered ones.
-- Widening the constraint from 001_foundation (which only required it for registered players)
-- to cover every player account type, since curfew enforcement applies universally to sessions.
ALTER TABLE users DROP CONSTRAINT player_requires_birthdate;
ALTER TABLE users ADD CONSTRAINT player_requires_birthdate CHECK (role != 'player' OR birthdate IS NOT NULL);

CREATE TABLE age_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- References users(id) directly, not the staff table - staff's PK is composite
    -- (user_id, cafe_id), so a staff member's identity for accountability purposes is
    -- just their user_id. Could be an owner performing verification too, not just staff.
    verified_by_user_id UUID NOT NULL REFERENCES users(id),
    cafe_id UUID NOT NULL REFERENCES cafes(id),
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    id_type_checked TEXT,
    notes TEXT
);

CREATE INDEX idx_age_verifications_user ON age_verifications (user_id);

-- `type` is left as free TEXT rather than a CHECK enum - unlike audit_log.action (a small,
-- genuinely closed CRUD set), notification types are an open/growing taxonomy that will keep
-- expanding as later features (social reports, subscription lapses, etc.) add their own kinds.
-- A CHECK enum here would force editing this migration's constraint every time an unrelated
-- future feature needs a new notification type.
CREATE TABLE admin_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,
    cafe_id UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    session_id UUID REFERENCES sessions(id),
    amount_refunded NUMERIC(10,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_notifications_cafe_created ON admin_notifications (cafe_id, created_at);

CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id), -- nullable: some system-triggered changes have no acting user
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    table_name TEXT NOT NULL,
    record_id UUID, -- polymorphic reference across many tables, so no FK constraint possible
    old_value JSONB,
    new_value JSONB,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_table_record ON audit_log (table_name, record_id);
