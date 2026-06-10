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

use rusqlite::{Connection, OptionalExtension};

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

    /// Read a value from the `meta` key/value table, or `None` if unset.
    pub fn meta_get(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock poisoned");
        conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
    }

    /// Upsert a value into the `meta` key/value table.
    pub fn meta_set(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db lock poisoned");
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )?;
        Ok(())
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
    // v1 -> v2: persisted dockview layouts (step 1.6). One serialized dock tree
    // per workspace key. The MVP uses a single global key; the column is keyed so
    // a later step can persist a layout per project (design §3/§4.6) without a
    // schema change. `tree` holds the JSON blob the frontend (de)serializes.
    r#"
    CREATE TABLE layouts (
        workspace_key  TEXT PRIMARY KEY,
        tree           TEXT NOT NULL,
        updated_at     INTEGER NOT NULL
    );
    "#,
    // v2 -> v3: a small key/value store for backend-owned settings that aren't
    // part of the relational registry and that the frontend doesn't author. The
    // first use (step 2.1) is the persisted hook-server port, so the URL written
    // into `~/.claude/settings.json` stays stable across launches (design §4.4).
    r#"
    CREATE TABLE meta (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );
    "#,
    // v3 -> v4: per-project worktree post-create setup (step 2.5, design §6).
    // `worktree_setup_command` is an optional shell line run in a freshly
    // provisioned worktree (deps install etc.); `worktree_copy_env` re-seeds the
    // repo root's `.env*` files (which worktrees don't share). Both default to
    // off/empty so existing projects keep the no-setup behavior.
    r#"
    ALTER TABLE projects ADD COLUMN worktree_setup_command TEXT;
    ALTER TABLE projects ADD COLUMN worktree_copy_env INTEGER NOT NULL DEFAULT 0;
    "#,
    // v4 -> v5: live-mirror the task note from the agent's terminal title (the
    // OSC title Claude Code emits names its current task — design §7 "live to-do
    // mirroring"). `task_note_auto` tracks whether the note is still following the
    // title; a manual edit flips it off so the user's text is never clobbered.
    // New rows default to on; existing rows that already carry a (manual) note are
    // seeded off so a first run doesn't overwrite it.
    r#"
    ALTER TABLE instances ADD COLUMN task_note_auto INTEGER NOT NULL DEFAULT 1;
    UPDATE instances SET task_note_auto = 0 WHERE task_note <> '';
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
