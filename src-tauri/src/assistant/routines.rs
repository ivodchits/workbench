//! Duck's routines (step L4): one record per routine, the engine's JSON
//! (`src/assistant/routines.ts`: its schedule, action, next and last run), kept in
//! `duck.db` so a routine missed while the app was closed is known on the next start.

use rusqlite::{params, Connection};

const MAX_BYTES: usize = 32 * 1024;

pub fn put(conn: &Connection, id: &str, data: &str, now: i64) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("not a routine id".into());
    }
    if data.len() > MAX_BYTES {
        return Err("a routine record is at most 32 KB".into());
    }
    conn.execute(
        "INSERT INTO routines (id, data, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        params![id, data, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Every record, oldest first (the order they were made in).
pub fn list(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare("SELECT data FROM routines ORDER BY rowid").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM routines WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_round_trip_in_order_made() {
        let db = super::super::db::DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        put(&conn, "a", "{1}", 1).unwrap();
        put(&conn, "b", "{2}", 2).unwrap();
        put(&conn, "a", "{3}", 3).unwrap();
        assert_eq!(list(&conn).unwrap(), ["{3}", "{2}"]);
        delete(&conn, "a").unwrap();
        assert_eq!(list(&conn).unwrap(), ["{2}"]);
        assert!(put(&conn, "", "{}", 1).is_err());
    }

    #[test]
    fn a_thread_can_be_kept() {
        let db = super::super::db::DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        super::super::threads::create(&conn, "t", "chat", 1).unwrap();
        assert!(!super::super::threads::get(&conn, "t").unwrap().unwrap().keep);
        super::super::threads::set_keep(&conn, "t", true).unwrap();
        assert!(super::super::threads::list(&conn).unwrap()[0].keep);
        assert!(super::super::threads::set_keep(&conn, "nope", true).is_err());
    }
}
