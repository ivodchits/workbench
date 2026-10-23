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
    // Step D1: the tasks Duck handed to worker sessions. `data` is the engine's
    // JSON record (instance, folder, state, timestamps, the result's headline);
    // `updated_at` (epoch ms) orders the list.
    r#"
    CREATE TABLE assistant_tasks (
        id          TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    "#,
    // Step T4: how a Claude Code permission prompt was answered, `hook` (the
    // PermissionRequest hook's response) or `keys` (keystrokes into its menu); null
    // for one left to you, and for Duck's own calls.
    r#"
    ALTER TABLE assistant_decisions ADD COLUMN answered_by TEXT;
    "#,
    // Step P1: plan autopilots, one per session. `data` is the engine's JSON record
    // (plan, state, steps done, the step log); `updated_at` (epoch ms) orders them.
    r#"
    CREATE TABLE assistant_autopilots (
        instance_id  TEXT PRIMARY KEY,
        data         TEXT NOT NULL,
        updated_at   INTEGER NOT NULL
    );
    "#,
    // Morning routine (phase 3): every Google Drive file Duck created, the only ones
    // its `drive.file` scope lets it change. `kind` is `folder` (the drafts folder,
    // `name` its name) or `draft` (an invoice copy of `source`, for `month`
    // "YYYY-MM": one per source and month). `how` is the way the copy was made
    // (`copy` or `upload`).
    r#"
    CREATE TABLE assistant_google_files (
        file_id  TEXT PRIMARY KEY,
        kind     TEXT NOT NULL CHECK (kind IN ('folder', 'draft')),
        name     TEXT NOT NULL,
        source   TEXT,
        month    TEXT,
        url      TEXT,
        how      TEXT,
        created  INTEGER NOT NULL
    );
    CREATE INDEX idx_assistant_google_files_draft ON assistant_google_files(source, month);
    "#,
    // Step M3: the turns Duck's subscription brain answered, priced as the API would
    // have priced them (`api_usd`): what they spared of the API credits. Never part
    // of the spend, which `assistant_usage` alone makes up.
    r#"
    CREATE TABLE assistant_subscription_usage (
        id       INTEGER PRIMARY KEY,
        ts       INTEGER NOT NULL,
        model    TEXT NOT NULL,
        api_usd  REAL NOT NULL
    );
    CREATE INDEX idx_assistant_subscription_usage_ts ON assistant_subscription_usage(ts);
    "#,
    // Step L1: the index over Duck's long-term memory (`memory/*.md` in the
    // workspace) and, read-only, over the project notes. The files are the truth;
    // these are rebuilt from them (`memory_index_files` says which file was read at
    // which size and time). Trigram, so a substring matches in any language.
    r#"
    CREATE TABLE memory_index_files (
        kind   TEXT NOT NULL,
        path   TEXT NOT NULL,
        mtime  INTEGER NOT NULL,
        size   INTEGER NOT NULL,
        PRIMARY KEY (kind, path)
    ) WITHOUT ROWID;
    CREATE VIRTUAL TABLE memory_fts USING fts5(
        body, path UNINDEXED, line UNINDEXED, entry UNINDEXED, tokenize = 'trigram'
    );
    CREATE VIRTUAL TABLE notes_fts USING fts5(
        body, path UNINDEXED, line UNINDEXED, label UNINDEXED, tokenize = 'trigram'
    );
    "#,
    // Step L2: every automatic recall, what it showed and how much of that the reply
    // used, for the hit rate. `hits` is JSON; rows older than 90 days are pruned.
    r#"
    CREATE TABLE recall_log (
        id           INTEGER PRIMARY KEY,
        at           INTEGER NOT NULL,
        thread_id    TEXT NOT NULL,
        query        TEXT NOT NULL,
        candidates   INTEGER NOT NULL,
        shown        INTEGER NOT NULL,
        used         INTEGER NOT NULL,
        self_recall  INTEGER NOT NULL,
        hits         TEXT NOT NULL
    );
    CREATE INDEX idx_recall_log_at ON recall_log(at);
    "#,
    // Step L3: the prompts each thread started with (`config.rs`): one snapshot per
    // distinct set of prompts, by its hash, and each thread's hash.
    r#"
    CREATE TABLE config_snapshots (
        hash  TEXT PRIMARY KEY,
        json  TEXT NOT NULL
    );
    CREATE TABLE config_pins (
        thread_id  TEXT PRIMARY KEY,
        hash       TEXT NOT NULL
    );
    "#,
    // Step L4: Duck's routines (`routines.rs`), the engine's JSON record each, and
    // the pin that keeps a thread from the clean-up of idle threads.
    r#"
    CREATE TABLE routines (
        id          TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    ALTER TABLE assistant_threads ADD COLUMN keep INTEGER NOT NULL DEFAULT 0;
    "#,
    // Step S1: modes. Every thread so far was the assistant's, stored as "chat",
    // which is now the chat partner's mode.
    r#"
    UPDATE assistant_threads SET mode = 'assistant' WHERE mode = 'chat';
    "#,
    // Step D3: how long each of your turns took, and on which brain (`timings.rs`):
    // the engine's JSON per turn, by when it started (epoch ms).
    r#"
    CREATE TABLE turn_timings (
        id    INTEGER PRIMARY KEY,
        at    INTEGER NOT NULL,
        data  TEXT NOT NULL
    );
    CREATE INDEX idx_turn_timings_at ON turn_timings(at);
    "#,
    // Step B2: an MCP server's tool list (`mcp_host.rs`), by a hash of its command
    // line, so Duck's tools are known at start without spawning the server.
    r#"
    CREATE TABLE mcp_tool_cache (
        key    TEXT PRIMARY KEY,
        tools  TEXT NOT NULL,
        at     INTEGER NOT NULL
    );
    "#,
    // Step H3: the free quotas Duck's searches use (`youtube.rs`): one row per
    // call, in the service's own units, for the spend line's "today".
    r#"
    CREATE TABLE assistant_quota (
        id       INTEGER PRIMARY KEY,
        ts       INTEGER NOT NULL,
        service  TEXT NOT NULL,
        units    INTEGER NOT NULL
    );
    CREATE INDEX idx_assistant_quota_ts ON assistant_quota(ts);
    "#,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s1_threads_from_before_modes_are_the_assistants() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::run_migrations(&conn, &MIGRATIONS[..MIGRATIONS.len() - 4]).unwrap();
        conn.execute("INSERT INTO assistant_threads (id, mode, created, updated) VALUES ('old', 'chat', 1, 1)", []).unwrap();
        crate::db::run_migrations(&conn, MIGRATIONS).unwrap();
        let mode: String = conn.query_row("SELECT mode FROM assistant_threads WHERE id = 'old'", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "assistant");
    }
}
