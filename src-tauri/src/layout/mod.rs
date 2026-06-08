//! Layout persistence (step 1.6).
//!
//! Stores one serialized `dockview` tree per **workspace key** so the panel
//! arrangement (splits / tabs / floats / sizes) survives a restart (design §5,
//! §4.6). The frontend owns the blob's shape — to the backend it's an opaque
//! JSON string — so the dock format can evolve without touching SQLite.
//!
//! The MVP writes under a single global key; keying by workspace leaves room for
//! a later step to persist a layout *per project* (design §3) with no migration.

use rusqlite::{Connection, OptionalExtension};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::db::Db;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Read the saved dock tree for `key`, or `None` if nothing has been stored yet.
pub fn read_layout(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT tree FROM layouts WHERE workspace_key = ?1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .optional()
}

/// Upsert the dock tree for `key`.
pub fn write_layout(conn: &Connection, key: &str, tree: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO layouts (workspace_key, tree, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(workspace_key) DO UPDATE SET tree = excluded.tree, updated_at = excluded.updated_at",
        (key, tree, now()),
    )?;
    Ok(())
}

fn lock(db: &Db) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| format!("db lock poisoned: {e}"))
}

#[tauri::command]
pub fn get_layout(db: State<'_, Db>, key: String) -> Result<Option<String>, String> {
    let conn = lock(&db)?;
    read_layout(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_layout(db: State<'_, Db>, key: String, tree: String) -> Result<(), String> {
    let conn = lock(&db)?;
    write_layout(&conn, &key, &tree).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_round_trips_and_upserts() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();

        assert_eq!(read_layout(&conn, "global").unwrap(), None);

        write_layout(&conn, "global", "{\"v\":1}").unwrap();
        assert_eq!(read_layout(&conn, "global").unwrap().as_deref(), Some("{\"v\":1}"));

        // A second write for the same key replaces, not duplicates.
        write_layout(&conn, "global", "{\"v\":2}").unwrap();
        assert_eq!(read_layout(&conn, "global").unwrap().as_deref(), Some("{\"v\":2}"));

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM layouts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
