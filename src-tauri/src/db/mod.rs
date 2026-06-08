//! SQLite persistence (step 1.2).
//!
//! Owns the single `rusqlite` connection (wrapped in a `Mutex`, since a
//! `Connection` is `Send` but not `Sync`) and the schema migrations. The
//! connection is Tauri-managed state; the registry layer (see `registry`) holds
//! the typed CRUD that runs against it.
//!
//! Migrations are versioned via SQLite's `PRAGMA user_version`: each entry in
//! `MIGRATIONS` bumps the version by one, applied in a transaction. New schema
//! changes are appended to that list and never edited in place, so an existing
//! database upgrades forward cleanly (design §4.6, decision: SQLite via rusqlite).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

/// Tauri-managed handle to the registry database.
pub struct Db {
    pub conn: Mutex<Connection>,
}

impl Db {
    /// Open (creating if absent) the database at `path` and bring its schema up
    /// to date. Enables foreign keys and WAL so concurrent reads while we write
    /// don't block.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// An in-memory database with the schema applied — used by tests.
    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

/// Ordered schema migrations. Append-only: index `i` upgrades `user_version`
/// from `i` to `i + 1`. Never edit a shipped entry.
const MIGRATIONS: &[&str] = &[
    // v0 -> v1: initial Group / Project / Instance schema.
    r#"
    CREATE TABLE groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
    );

    CREATE TABLE projects (
        id              TEXT PRIMARY KEY,
        group_id        TEXT REFERENCES groups(id) ON DELETE SET NULL,
        name            TEXT NOT NULL,
        root_path       TEXT NOT NULL,
        default_branch  TEXT,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL
    );

    CREATE TABLE instances (
        id                    TEXT PRIMARY KEY,
        project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title                 TEXT NOT NULL,
        task_note             TEXT NOT NULL DEFAULT '',
        worktree_on           INTEGER NOT NULL DEFAULT 0,
        branch                TEXT,
        last_session_id       TEXT,
        working_dir           TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'idle',
        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        cost_usd              REAL NOT NULL DEFAULT 0,
        sort_order            INTEGER NOT NULL DEFAULT 0,
        created_at            INTEGER NOT NULL,
        last_activity_at      INTEGER
    );

    CREATE INDEX idx_projects_group ON projects(group_id);
    CREATE INDEX idx_instances_project ON instances(project_id);
    "#,
];

/// Apply any migrations the database hasn't seen yet, advancing
/// `PRAGMA user_version` one step per applied migration.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let mut version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    while (version as usize) < MIGRATIONS.len() {
        let sql = MIGRATIONS[version as usize];
        conn.execute_batch(&format!("BEGIN; {sql} COMMIT;"))?;
        version += 1;
        // `user_version` is a pragma, not a bindable parameter.
        conn.execute_batch(&format!("PRAGMA user_version = {version};"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent_and_set_version() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);

        // Re-running migrate on an up-to-date connection is a no-op.
        migrate(&conn).unwrap();
        let version2: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version2, version);
    }
}
