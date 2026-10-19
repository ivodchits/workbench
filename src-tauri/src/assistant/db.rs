//! Duck's own database, `duck.db` (`duck.dev.db` for a debug build), next to
//! `workbench.db` (step A1).
//!
//! Duck's state lives in its own file with its own migrations rather than in
//! Workbench's tables (design → Separable, not separate), so Duck can be lifted out
//! later without untangling a shared schema. The rules are Workbench's: `MIGRATIONS`
//! is append-only, each entry bumps `PRAGMA user_version` by one, and a shipped entry
//! is never edited.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

pub const FILE_NAME: &str = if cfg!(debug_assertions) {
    "duck.dev.db"
} else {
    "duck.db"
};

pub struct DuckDb {
    pub conn: Mutex<Connection>,
}

impl DuckDb {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        crate::db::run_migrations(&conn, MIGRATIONS)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        crate::db::run_migrations(&conn, MIGRATIONS)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn meta_get(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().expect("duck db lock poisoned");
        conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
    }

    pub fn meta_set(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("duck db lock poisoned");
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )?;
        Ok(())
    }
}

/// Ordered schema migrations. Append-only: index `i` upgrades `user_version` from
/// `i` to `i + 1`.
const MIGRATIONS: &[&str] = &[
    // v0 -> v1 (step A1): the usage ledger, one row per metered API call, written by
    // the proxy from the response's own `usage`. `ts` is epoch milliseconds; `purpose`
    // is what the caller said the call was for (`x-wb-purpose`); `cache_w` sums the
    // 5-minute and 1-hour cache writes (they're priced apart, which `cost_usd` already
    // reflects); `searches` counts server-side web searches. `meta` holds Duck's
    // backend-owned settings (the budget).
    r#"
    CREATE TABLE assistant_usage (
        id        INTEGER PRIMARY KEY,
        ts        INTEGER NOT NULL,
        model     TEXT NOT NULL,
        purpose   TEXT NOT NULL,
        "in"      INTEGER NOT NULL,
        out       INTEGER NOT NULL,
        cache_w   INTEGER NOT NULL,
        cache_r   INTEGER NOT NULL,
        searches  INTEGER NOT NULL,
        cost_usd  REAL NOT NULL
    );
    CREATE INDEX idx_assistant_usage_ts ON assistant_usage(ts);

    CREATE TABLE meta (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );
    "#,
];
