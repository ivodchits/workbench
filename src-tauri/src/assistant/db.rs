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
    // v1 -> v2 (step A2): conversation threads. `assistant_messages` is append-only
    // (thinking blocks are bound to the history they were made in, and the prompt
    // cache is a prefix match), so an UPDATE is refused outright; `seq` counts from 0
    // per thread. `content` is the message's API content blocks as JSON; `role` is
    // `user` / `assistant` / `system` (a mid-conversation system message, sent to the
    // API) or `notice` (shown in the thread, never sent). `assistant_pending` holds one
    // row per tool batch waiting on a confirmation, so a reload doesn't lose it.
    r#"
    CREATE TABLE assistant_threads (
        id       TEXT PRIMARY KEY,
        title    TEXT NOT NULL DEFAULT '',
        mode     TEXT NOT NULL DEFAULT 'chat',
        created  INTEGER NOT NULL,
        updated  INTEGER NOT NULL
    );

    CREATE TABLE assistant_messages (
        thread_id  TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        ts         INTEGER NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        source     TEXT NOT NULL,
        PRIMARY KEY (thread_id, seq)
    ) WITHOUT ROWID;
    CREATE TRIGGER assistant_messages_append_only BEFORE UPDATE ON assistant_messages
    BEGIN
        SELECT RAISE(ABORT, 'assistant_messages is append-only');
    END;

    CREATE TABLE assistant_pending (
        id         TEXT PRIMARY KEY,
        thread_id  TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
        created    INTEGER NOT NULL,
        data       TEXT NOT NULL
    );
    "#,
    // v2 -> v3 (step T1): the trust engine. `assistant_rules` holds your rules in
    // Claude Code's syntax (`assistant:write_note`, `Bash(npm test:*)`); a null
    // `project_id` is global. `assistant_decisions` is the audit log: every call the
    // engine decided, kept after its thread is deleted (no foreign key). `shadow` = it
    // was only logged, the card still showed. `assistant_trust_modes` holds a
    // project's mode when it isn't the default (`live`).
    r#"
    CREATE TABLE assistant_rules (
        id          TEXT PRIMARY KEY,
        effect      TEXT NOT NULL CHECK (effect IN ('allow', 'ask', 'deny')),
        pattern     TEXT NOT NULL,
        project_id  TEXT,
        created     INTEGER NOT NULL
    );

    CREATE TABLE assistant_decisions (
        id           INTEGER PRIMARY KEY,
        ts           INTEGER NOT NULL,
        thread_id    TEXT NOT NULL,
        tool_use_id  TEXT NOT NULL,
        project_id   TEXT,
        tool         TEXT NOT NULL,
        summary      TEXT NOT NULL,
        input        TEXT NOT NULL,
        decision     TEXT NOT NULL,
        layer        TEXT NOT NULL,
        reason       TEXT NOT NULL,
        rule_id      TEXT,
        shadow       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_assistant_decisions_ts ON assistant_decisions(ts);

    CREATE TABLE assistant_trust_modes (
        project_id  TEXT PRIMARY KEY,
        mode        TEXT NOT NULL CHECK (mode IN ('off', 'shadow', 'live'))
    );
    "#,
];
