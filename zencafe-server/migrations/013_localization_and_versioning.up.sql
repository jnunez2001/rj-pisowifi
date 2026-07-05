-- Migration 013: Localization & Versioning (UP)
-- See docs/architecture/localization.md and docs/deployment/update-strategy.md.
--
-- users.preferred_language, cafes.default_language, cafes.update_channel,
-- cafes.maintenance_window_start/end, and pcs.current_os_version/last_update_check_at/
-- last_update_status all already exist (001_foundation) - this migration adds the
-- remaining pieces: translation storage and version/compatibility tracking.
--
-- Design simplification: the originally sketched standalone "version_compatibility" table
-- (server_version, minimum_os_version_required, os_version, minimum_server_version_required)
-- didn't have a clean row-per-what meaning - it read like a per-pair matrix, but a
-- compatibility check is really just "does the OTHER side's version meet MY minimum
-- requirement," which only needs one value per version row. Folded
-- minimum_os_version_required into server_versions and minimum_server_version_required
-- into os_versions instead of a separate table. These are plain TEXT, not FKs to each
-- other's version_number - actual compatibility checks need semver comparison logic
-- (e.g. "1.1.5 satisfies a minimum of 1.1.0"), not exact-match referential integrity, and a
-- minimum requirement can reasonably be set before the referenced version has even shipped.

CREATE TABLE translation_keys (
    key TEXT NOT NULL,
    language_code TEXT NOT NULL, -- free text, not a CHECK enum - the language rollout list
                                  -- grows over phases (see docs/architecture/localization.md)
    value TEXT NOT NULL,

    PRIMARY KEY (key, language_code)
);

CREATE TABLE server_versions (
    version_number TEXT PRIMARY KEY,
    release_notes TEXT,
    channel TEXT NOT NULL CHECK (channel IN ('beta', 'stable')),
    released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_critical_security_update BOOLEAN NOT NULL DEFAULT false,
    minimum_os_version_required TEXT
);

CREATE TABLE os_versions (
    version_number TEXT PRIMARY KEY,
    release_notes TEXT,
    channel TEXT NOT NULL CHECK (channel IN ('beta', 'stable')),
    released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_critical_security_update BOOLEAN NOT NULL DEFAULT false,
    minimum_server_version_required TEXT
);

CREATE INDEX idx_server_versions_channel_released ON server_versions (channel, released_at);
CREATE INDEX idx_os_versions_channel_released ON os_versions (channel, released_at);
