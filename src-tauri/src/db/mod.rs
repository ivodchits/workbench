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
    // v5 -> v6: per-instance accent color (step 3.9, design §5.x / §7 "per-instance
    // color"). An optional CSS color string that overlays the theme's structural
    // accent on that instance's card + console; NULL ⇒ inherit the active theme's
    // accent. New rows default to NULL so existing instances keep the theme accent.
    r#"
    ALTER TABLE instances ADD COLUMN accent TEXT;
    "#,
    // v6 -> v7: remote projects over SSH+tmux (step 3.12, design §3/§4.2). A remote
    // project points at a host instead of a local folder: `remote_ssh_dest` is the
    // SSH destination (an alias from `~/.ssh/config`, or `user@host`) — NULL flags a
    // local project — and `remote_dir` is the working directory on that host (also
    // mirrored into the NOT NULL `root_path` so display code that reads it keeps
    // working). A remote instance runs as a persistent tmux session named in
    // `remote_tmux_session` (`wb-<short id>`, or an adopted name) — NULL for local.
    r#"
    ALTER TABLE projects ADD COLUMN remote_ssh_dest TEXT;
    ALTER TABLE projects ADD COLUMN remote_dir TEXT;
    ALTER TABLE instances ADD COLUMN remote_tmux_session TEXT;
    "#,
    // v7 -> v8: paired devices for the remote access server (step 4.3, design §11).
    // Each row is a device that paired over the tailnet: `token` is the long-lived
    // bearer secret it presents on every API/WS call (minted as a UUID on a
    // successful `/pair`), `name` is the user-facing label it sent, and `last_seen`
    // tracks the most recent authenticated use (NULL until first use after pairing).
    // Revoking a device deletes its row (and drops it from the in-memory token set).
    r#"
    CREATE TABLE remote_devices (
        token      TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        paired_at  INTEGER NOT NULL,
        last_seen  INTEGER
    );
    "#,
    // v8 -> v9: harder pairing (step R2). A device now has an `id` the desktop UI
    // names it by (the token never leaves the backend), the address it last used,
    // and whether the desktop has `approved` it — a new pairing waits for that before
    // its token works. Devices paired before this were confirmed by typing a code at
    // the desktop, so they stay approved.
    r#"
    ALTER TABLE remote_devices ADD COLUMN id TEXT;
    ALTER TABLE remote_devices ADD COLUMN last_addr TEXT;
    ALTER TABLE remote_devices ADD COLUMN approved INTEGER NOT NULL DEFAULT 1;
    UPDATE remote_devices SET id = lower(hex(randomblob(8))) WHERE id IS NULL;
    "#,
    // v9 -> v10: Web Push (step R6). One subscription per paired device: where its
    // push service takes messages (`endpoint`) and the keys to encrypt them for it
    // (`p256dh`, `auth`, base64url as the browser gave them). `muted` keeps the
    // subscription but sends nothing. Unpairing a device drops its row in code (the
    // device table has no foreign key to hang a cascade on).
    r#"
    CREATE TABLE push_subscriptions (
        device_id  TEXT PRIMARY KEY,
        endpoint   TEXT NOT NULL,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        muted      INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
    "#,
    // v10 -> v11: the model a session runs on (step M1). `instances.model` is passed
    // to `claude --model` at every launch and resume; NULL inherits the project's
    // `default_model`, and NULL there leaves Claude Code's own default.
    r#"
    ALTER TABLE instances ADD COLUMN model TEXT;
    ALTER TABLE projects ADD COLUMN default_model TEXT;
    "#,
    // v11 -> v12: the folder a project's notes live in, shared across machines (step
    // N3). It starts empty: a project with no key uses its own id's folder, and one
    // that has such a folder is linked to it at start. A project with no folder stays
    // unlinked, so it can still match another machine's notes once they arrive.
    r#"
    ALTER TABLE projects ADD COLUMN notes_key TEXT;
    "#,
    // v12 -> v13: the sessions Duck started to draft a project's toolbar (assistant
    // plan W5). Each launch of one adds the drafting skill and its draft folder
    // (`plugins::draft::launch_args`). No foreign key: a row outliving its instance
    // is never read again.
    r#"
    CREATE TABLE plugin_draft_sessions (
        instance_id TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL
    );
    "#,
    // v13 -> v14: the permission mode a session starts in (assistant plan M4),
    // passed to `claude --permission-mode` at every launch and resume and inherited
    // like the model: NULL takes the project's default, NULL there Claude Code's own.
    r#"
    ALTER TABLE instances ADD COLUMN permission_mode TEXT;
    ALTER TABLE projects ADD COLUMN default_permission_mode TEXT;
    "#,
];

/// Apply any migrations the database hasn't seen yet, advancing
/// `PRAGMA user_version` one step per applied migration.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    run_migrations(conn, MIGRATIONS)
}

/// The migration runner itself, shared with Duck's own `duck.db` (step A1), which
/// keeps its own append-only list under the same rules.
pub(crate) fn run_migrations(conn: &Connection, migrations: &[&str]) -> rusqlite::Result<()> {
    let mut version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    while (version as usize) < migrations.len() {
        let sql = migrations[version as usize];
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
