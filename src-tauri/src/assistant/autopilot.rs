//! Plan autopilot records (step P1): one per session, the engine's JSON
//! (`src/assistant/autopilot.ts`), kept in `duck.db` so a paused autopilot and its
//! step log survive a restart.

use rusqlite::{params, Connection};

/// Records are small: the step log is capped by the engine.
const MAX_BYTES: usize = 128 * 1024;

pub fn put(conn: &Connection, instance_id: &str, data: &str, now: i64) -> Result<(), String> {
    if instance_id.is_empty() || instance_id.len() > 64 {
        return Err("not an instance id".into());
    }
    if data.len() > MAX_BYTES {
        return Err("an autopilot record is at most 128 KB".into());
    }
    conn.execute(
        "INSERT INTO assistant_autopilots (instance_id, data, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(instance_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        params![instance_id, data, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Every record, newest first.
pub fn list(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT data FROM assistant_autopilots ORDER BY updated_at DESC, instance_id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

pub fn delete(conn: &Connection, instance_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM assistant_autopilots WHERE instance_id = ?1", params![instance_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_round_trip_newest_first() {
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
}
