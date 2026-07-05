// ZenCafe Server entry point.
// Currently only supports `--migrate` (applies pending database migrations and exits).
// Normal server mode (API/WebSocket) is not yet implemented - see PROGRESS.md "What's Next".

#include "database/migration_runner.h"

#include <QCoreApplication>
#include <QSqlDatabase>
#include <QSqlError>
#include <QTextStream>

namespace {

// Connection settings come from environment variables, never hardcoded or committed to
// a file - same handling as every Neon test credential used throughout this project's
// migration testing.
bool configureConnectionFromEnvironment(QSqlDatabase &db, QTextStream &out)
{
    const QString host = qEnvironmentVariable("ZENCAFE_DB_HOST");
    const QString port = qEnvironmentVariable("ZENCAFE_DB_PORT", QStringLiteral("5432"));
    const QString name = qEnvironmentVariable("ZENCAFE_DB_NAME");
    const QString user = qEnvironmentVariable("ZENCAFE_DB_USER");
    const QString password = qEnvironmentVariable("ZENCAFE_DB_PASSWORD");

    if (host.isEmpty() || name.isEmpty() || user.isEmpty()) {
        out << "Missing required environment variables: ZENCAFE_DB_HOST, ZENCAFE_DB_NAME, ZENCAFE_DB_USER\n";
        return false;
    }

    db.setHostName(host);
    db.setPort(port.toInt());
    db.setDatabaseName(name);
    db.setUserName(user);
    db.setPassword(password);
    return true;
}

} // namespace

int main(int argc, char *argv[])
{
    QCoreApplication app(argc, argv);
    QTextStream out(stdout);

    if (!app.arguments().contains(QStringLiteral("--migrate"))) {
        out << "ZenCafe Server\n";
        out << "Usage: zencafe-server --migrate   (applies pending database migrations and exits)\n";
        out << "Normal server mode is not yet implemented.\n";
        return 0;
    }

    QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QPSQL"));
    if (!configureConnectionFromEnvironment(db, out)) {
        return 1;
    }

    if (!db.open()) {
        out << "Could not connect to database: " << db.lastError().text() << "\n";
        return 1;
    }

    // During development this points at the repo's migrations/ folder directly;
    // production deployment should place migrations alongside the server binary.
    const QString migrationsDir = qEnvironmentVariable("ZENCAFE_MIGRATIONS_DIR", QStringLiteral("migrations"));

    zencafe::MigrationRunner runner(db, migrationsDir);
    QString error;
    if (!runner.applyPending(&error)) {
        out << "Migration failed: " << error << "\n";
        db.close();
        return 1;
    }

    out << "All pending migrations applied successfully.\n";
    db.close();
    return 0;
}
