// ZenCafe Migration Runner
// Applies pending numbered migrations (see /migrations and docs/database/README.md) in
// order, tracking which have already run in a schema_migrations table.

#ifndef ZENCAFE_MIGRATION_RUNNER_H
#define ZENCAFE_MIGRATION_RUNNER_H

#include <QSqlDatabase>
#include <QString>
#include <QStringList>

namespace zencafe {

// Each migration is applied inside a single transaction - if anything in it fails, the
// whole migration rolls back cleanly rather than leaving the schema half-applied.
//
// IMPORTANT: a migration file is executed as ONE whole string, never split by semicolon.
// 008_content_and_chat_tiers.up.sql and 009_social.up.sql define PL/pgSQL trigger
// functions containing semicolons inside $$ ... $$ bodies - naive semicolon-splitting
// would break those mid-function. PostgreSQL's query protocol correctly parses
// multi-statement strings including dollar-quoted bodies when given the whole file at
// once, which is why this class never attempts to split migration files itself.
class MigrationRunner {
public:
    // db must already be configured (host/port/dbname/user/password) but not necessarily
    // open yet - callers are responsible for opening it before use.
    // migrationsDir: path to the folder containing NNN_name.up.sql / .down.sql pairs.
    MigrationRunner(QSqlDatabase db, const QString &migrationsDir);

    // Creates the schema_migrations tracking table if it doesn't already exist.
    // Safe to call repeatedly - idempotent.
    bool ensureTrackingTableExists(QString *errorOut = nullptr);

    // Returns migration versions (e.g. "001_foundation") already recorded as applied.
    QStringList appliedVersions(QString *errorOut = nullptr);

    // Returns migration versions found in migrationsDir that are NOT yet applied,
    // sorted by their numeric prefix (so this keeps working correctly past 999).
    QStringList pendingVersions(QString *errorOut = nullptr);

    // Applies every pending migration in ascending order. Stops at the first failure -
    // does not attempt later migrations if an earlier one fails, since later migrations
    // may depend on it.
    bool applyPending(QString *errorOut = nullptr);

private:
    bool applyOne(const QString &version, QString *errorOut);

    QSqlDatabase m_db;
    QString m_migrationsDir;
};

} // namespace zencafe

#endif
