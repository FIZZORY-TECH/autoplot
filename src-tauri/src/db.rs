//! src-tauri/src/db.rs — SQLite connection + migration runner (A1 / A9)
//!
//! Design decisions:
//! - Migrations are embedded at compile time via `include_str!` macros so the
//!   binary is self-contained (no runtime FS walk needed; the set of migrations
//!   is fixed at build time — new phases just add a new `include_str!` entry).
//! - `run_migrations` is idempotent: it checks `_migrations.version` before
//!   applying each file, so restarting the app is always safe.
//! - On first run the `_migrations` table itself does not exist; we bootstrap it
//!   by catching the "no such table" error and treating it as "version 0".

use rusqlite::{Connection, Result, params};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Embedded migration files — order matters; sorted by version number.
// Add `(N, include_str!("../migrations/000N_*.sql"))` for every new phase.
// ---------------------------------------------------------------------------
const MIGRATIONS: &[(u32, &str)] = &[
    (1, include_str!("../migrations/0001_init.sql")),
    (2, include_str!("../migrations/0002_marks.sql")),
    (3, include_str!("../migrations/0003_watchlist.sql")),
    (4, include_str!("../migrations/0004_bars.sql")),
    (6, include_str!("../migrations/0006_trends.sql")),
    (7, include_str!("../migrations/0007_ai_sessions.sql")),
    (8, include_str!("../migrations/0008_datasets.sql")),
    (9, include_str!("../migrations/0009_strategies.sql")),
    (10, include_str!("../migrations/0010_ai_workspace_tables.sql")),
    (11, include_str!("../migrations/0011_marks_add_provider.sql")),
    (12, include_str!("../migrations/0012_trends_add_provider.sql")),
    (13, include_str!("../migrations/0013_symbols_fts.sql")),
    (14, include_str!("../migrations/0014_bars_v2.sql")),
    (15, include_str!("../migrations/0015_watchlist_v2.sql")),
    (16, include_str!("../migrations/0016_marks_add_quote.sql")),
    (17, include_str!("../migrations/0017_trends_add_quote.sql")),
    (18, include_str!("../migrations/0018_portfolio.sql")),
    (19, include_str!("../migrations/0019_research_overlays.sql")),
];

// ---------------------------------------------------------------------------
// open_db
// ---------------------------------------------------------------------------

/// Open (or create) the app's SQLite database at `{app_data_dir}/db.sqlite`.
/// Creates parent directories if they don't exist.
pub fn open_db(app: &AppHandle) -> Result<Connection> {
    let db_path = db_path(app).expect("could not resolve app data dir");
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .expect("could not create app data directory");
    }
    Connection::open(&db_path)
}

fn db_path(app: &AppHandle) -> Option<PathBuf> {
    let data_dir = app.path().app_data_dir().ok()?;
    Some(data_dir.join("db.sqlite"))
}

// ---------------------------------------------------------------------------
// run_migrations
// ---------------------------------------------------------------------------

/// Apply any pending migrations in version order.
/// Each migration is applied in a transaction; the version row is inserted
/// atomically with the schema change so a crash mid-migration leaves the DB
/// in a known state.
pub fn run_migrations(conn: &Connection) -> Result<()> {
    // Bootstrap: ensure the _migrations table itself exists before we query it.
    // We run the very first migration's SQL (which creates _migrations), or
    // create a minimal bootstrap if version 1 hasn't been applied yet.
    bootstrap_migrations_table(conn)?;

    for &(version, sql) in MIGRATIONS {
        if !is_applied(conn, version)? {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;

            // Apply the SQL + record the version in a single transaction.
            conn.execute_batch(&format!(
                "BEGIN;\n{sql}\nINSERT INTO _migrations (version, applied_at) VALUES ({version}, {now});\nCOMMIT;"
            ))?;

            eprintln!("[db] Applied migration {version:04}");
        }
    }

    Ok(())
}

/// Create the `_migrations` table if it doesn't exist yet.
/// Called once before the main migration loop.
fn bootstrap_migrations_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version    INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );",
    )
}

/// Returns true if the given migration version is already in `_migrations`.
fn is_applied(conn: &Connection, version: u32) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM _migrations WHERE version = ?1",
        params![version],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn in_memory_conn() -> Connection {
        Connection::open_in_memory().expect("in-memory db")
    }

    #[test]
    fn test_migrations_apply_and_are_idempotent() {
        let conn = in_memory_conn();

        // First run: applies every embedded migration.
        run_migrations(&conn).expect("first migration run failed");

        let count_after_first: i64 = conn
            .query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0))
            .expect("query failed");
        assert_eq!(
            count_after_first as usize,
            MIGRATIONS.len(),
            "_migrations should hold one row per embedded migration"
        );

        // Each declared version should have exactly one row.
        for &(version, _sql) in MIGRATIONS {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM _migrations WHERE version = ?1",
                    params![version],
                    |r| r.get(0),
                )
                .expect("query failed");
            assert_eq!(n, 1, "expected one row for version {version}");
        }

        // Second run: idempotent — count must not grow.
        run_migrations(&conn).expect("second migration run failed");
        let count_after_second: i64 = conn
            .query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0))
            .expect("query failed");
        assert_eq!(
            count_after_second, count_after_first,
            "idempotent: row count must not grow on second run"
        );
    }

    #[test]
    fn test_applied_at_is_positive() {
        let conn = in_memory_conn();
        run_migrations(&conn).expect("migration failed");
        let applied_at: i64 = conn
            .query_row(
                "SELECT applied_at FROM _migrations WHERE version = 1",
                [],
                |r| r.get(0),
            )
            .expect("query failed");
        assert!(applied_at > 0, "applied_at should be a positive Unix timestamp");
    }
}
