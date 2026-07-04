-- Migration 007: Remote Age Verification Requests (UP)
-- See docs/compliance/README.md "Remote Verification (Selfie + ID)" section.
--
-- Adds a pending-review workflow layered on top of the existing age_verifications
-- accountability log (006_compliance) - that table only ever represented an ALREADY
-- APPROVED verification. This table represents the submission/review workflow: a player
-- submits an ID photo AND a selfie (required together - a photo of an ID alone doesn't
-- prove the submitter is the person in it), staff reviews, and only on approval does a
-- row get written into age_verifications.

-- Widen audit_log.action to include 'view', since viewing a submitted ID/selfie photo is
-- a sensitive read-access event worth logging, not just create/update/delete.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (action IN ('create', 'update', 'delete', 'view'));

-- Set by the service layer after N rejected requests (N is an app-level policy threshold,
-- not hardcoded here) - blocks further remote submissions, forcing in-person-only
-- verification going forward. Anti-abuse control against repeated fake/borrowed-ID attempts.
ALTER TABLE users
    ADD COLUMN remote_verification_blocked BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE age_verification_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cafe_id UUID NOT NULL REFERENCES cafes(id),

    -- Object keys into a PRIVATE storage bucket (never the public cosmetics R2 bucket) -
    -- these are stable references, not signed URLs, since signed URLs expire. Access is via
    -- short-lived signed URLs generated on demand when staff needs to view them.
    id_photo_key TEXT NOT NULL,
    selfie_photo_key TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    rejection_reason TEXT,
    reviewed_by_user_id UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,

    -- Set only on approval - links this request to the permanent accountability record
    -- created in age_verifications (006_compliance) at that moment.
    resulting_verification_id UUID REFERENCES age_verifications(id),

    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Scheduled deletion time for the photos themselves (set once reviewed) - the outcome
    -- record is kept permanently, but the raw photos don't need to live indefinitely once
    -- their job is done. Actual purge job is a service-layer/cron responsibility, not this
    -- migration's concern - this column just schedules it.
    photo_purge_at TIMESTAMPTZ,

    CONSTRAINT review_fields_consistent CHECK (
        (status = 'pending' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND resulting_verification_id IS NULL)
        OR
        (status != 'pending' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
    CONSTRAINT rejection_reason_only_when_rejected CHECK (
        (status = 'rejected' AND rejection_reason IS NOT NULL)
        OR
        (status != 'rejected' AND rejection_reason IS NULL)
    ),
    CONSTRAINT resulting_verification_only_when_approved CHECK (
        (status = 'approved' AND resulting_verification_id IS NOT NULL)
        OR
        (status != 'approved' AND resulting_verification_id IS NULL)
    )
);

CREATE INDEX idx_age_verification_requests_cafe_status ON age_verification_requests (cafe_id, status);
CREATE INDEX idx_age_verification_requests_user ON age_verification_requests (user_id);
