#include "migration_runner.h"

#include <QDir>
#include <QFile>
#include <QRegularExpression>
#include <QSqlError>
#include <QSqlQuery>
#include <algorithm>

namespace zencafe {

namespace {

bool isUpMigrationFile(const QString &fileName)
{
    return fileName.endsWith(QLatin1String(".up.sql"));
}

QString versionFromUpFileName(const QString &fileName)
{
    return fileName.left(fileName.length() - QLatin1String(".up.sql").length());
}

// Sorts by the leading numeric prefix (001, 002, ... 013, ...) rather than a plain
// string sort, so ordering stays correct once version numbers reach different digit
// counts.
int numericPrefix(const QString &version)
{
    static const QRegularExpression prefixPattern(QStringLiteral("^(\\d+)"));
    const auto match = prefixPattern.match(version);
    if (!match.hasMatch()) {
        return 0;
    }
    return match.captured(1).toInt();
}

} // namespace

MigrationRunner::MigrationRunner(QSqlDatabase db, const QString &migrationsDir)
    : m_db(std::move(db)), m_migrationsDir(migrationsDir)
{
}

bool MigrationRunner::ensureTrackingTableExists(QString *errorOut)
{
    QSqlQuery query(m_db);
    const bool ok = query.exec(
        QStringLiteral("CREATE TABLE IF NOT EXISTS schema_migrations ("
                        "    version TEXT PRIMARY KEY,"
                        "    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()"
                        ")"));
    if (!ok && errorOut) {
        *errorOut = query.lastError().text();
    }
    return ok;
}

QStringList MigrationRunner::appliedVersions(QString *errorOut)
{
    QStringList versions;
    QSqlQuery query(m_db);
    if (!query.exec(QStringLiteral("SELECT version FROM schema_migrations ORDER BY version"))) {
        if (errorOut) {
            *errorOut = query.lastError().text();
        }
        return versions;
    }
    while (query.next()) {
        versions << query.value(0).toString();
    }
    return versions;
}

QStringList MigrationRunner::pendingVersions(QString *errorOut)
{
    QString error;
    const QStringList applied = appliedVersions(&error);
    if (!error.isEmpty()) {
        if (errorOut) {
            *errorOut = error;
        }
        return {};
    }

    QDir dir(m_migrationsDir);
    const QStringList entries = dir.entryList(QDir::Files);

    QStringList pending;
    for (const QString &fileName : entries) {
        if (!isUpMigrationFile(fileName)) {
            continue;
        }
        const QString version = versionFromUpFileName(fileName);
        if (!applied.contains(version)) {
            pending << version;
        }
    }

    std::sort(pending.begin(), pending.end(), [](const QString &a, const QString &b) {
        return numericPrefix(a) < numericPrefix(b);
    });

    return pending;
}

bool MigrationRunner::applyOne(const QString &version, QString *errorOut)
{
    const QString upFilePath = QDir(m_migrationsDir).filePath(version + QStringLiteral(".up.sql"));
    QFile upFile(upFilePath);
    if (!upFile.open(QIODevice::ReadOnly | QIODevice::Text)) {
        if (errorOut) {
            *errorOut = QStringLiteral("Could not open migration file: %1").arg(upFilePath);
        }
        return false;
    }
    const QString sql = QString::fromUtf8(upFile.readAll());
    upFile.close();

    if (!m_db.transaction()) {
        if (errorOut) {
            *errorOut = QStringLiteral("Could not start transaction for %1: %2")
                            .arg(version, m_db.lastError().text());
        }
        return false;
    }

    // Executed as ONE whole-file string - see the header comment on why this must never
    // be split by semicolon (dollar-quoted PL/pgSQL function bodies in 008/009 contain
    // semicolons that aren't statement terminators).
    QSqlQuery migrationQuery(m_db);
    if (!migrationQuery.exec(sql)) {
        const QString queryError = migrationQuery.lastError().text();
        m_db.rollback();
        if (errorOut) {
            *errorOut = QStringLiteral("Migration %1 failed, rolled back: %2").arg(version, queryError);
        }
        return false;
    }

    QSqlQuery recordQuery(m_db);
    recordQuery.prepare(QStringLiteral("INSERT INTO schema_migrations (version) VALUES (:version)"));
    recordQuery.bindValue(QStringLiteral(":version"), version);
    if (!recordQuery.exec()) {
        const QString recordError = recordQuery.lastError().text();
        m_db.rollback();
        if (errorOut) {
            *errorOut = QStringLiteral("Recording migration %1 failed, rolled back: %2")
                            .arg(version, recordError);
        }
        return false;
    }

    if (!m_db.commit()) {
        const QString commitError = m_db.lastError().text();
        m_db.rollback();
        if (errorOut) {
            *errorOut = QStringLiteral("Commit failed for %1, rolled back: %2").arg(version, commitError);
        }
        return false;
    }

    return true;
}

bool MigrationRunner::applyPending(QString *errorOut)
{
    QString error;
    if (!ensureTrackingTableExists(&error)) {
        if (errorOut) {
            *errorOut = error;
        }
        return false;
    }

    const QStringList pending = pendingVersions(&error);
    if (!error.isEmpty()) {
        if (errorOut) {
            *errorOut = error;
        }
        return false;
    }

    for (const QString &version : pending) {
        if (!applyOne(version, &error)) {
            if (errorOut) {
                *errorOut = error;
            }
            return false;
        }
    }

    return true;
}

} // namespace zencafe
