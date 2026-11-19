//! Duck's waiting queue (fleet plan F3.2): work for a machine that's off, kept in
//! `duck.db` until that machine connects. The engine writes each item as JSON (its
//! machine, thread and task, `src/assistant/fleet.ts`); this module only stores,
//! lists and drops them.

use rusqlite::{params, Connection};

const MAX_RECORD: usize = 16 * 1024;
const MAX_ITEMS: i64 = 200;

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 40 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(format!("not a waiting item's id: {id}"));
    }
    Ok(())
}

pub fn put(conn: &Connection, id: &str, data: &str, now: i64) -> Result<(), String> {
    check_id(id)?;
    if data.len() > MAX_RECORD {
        return Err("a waiting item is at most 16 KB".into());
    }
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM assistant_waiting WHERE id <> ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count >= MAX_ITEMS {
        return Err(format!("the waiting queue is full ({MAX_ITEMS} items)"));
    }
    conn.execute(
        "INSERT INTO assistant_waiting (id, data, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        params![id, data, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Every item, oldest first.
pub fn list(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT data FROM assistant_waiting ORDER BY created_at, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Drop an item; true when it was there.
pub fn remove(conn: &Connection, id: &str) -> Result<bool, String> {
    check_id(id)?;
    let n = conn.execute("DELETE FROM assistant_waiting WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::run_migrations(&conn, super::super::db::MIGRATIONS).unwrap();
        conn
    }

    #[test]
    fn keeps_lists_and_drops() {
        let conn = db();
        put(&conn, "b", r#"{"task":"second"}"#, 20).unwrap();
        put(&conn, "a", r#"{"task":"first"}"#, 10).unwrap();
        put(&conn, "a", r#"{"task":"first, edited"}"#, 30).unwrap();
        assert_eq!(list(&conn).unwrap(), vec![r#"{"task":"first, edited"}"#, r#"{"task":"second"}"#]);
        assert!(remove(&conn, "a").unwrap());
        assert!(!remove(&conn, "a").unwrap());
        assert_eq!(list(&conn).unwrap().len(), 1);
        assert!(put(&conn, "../x", "{}", 1).is_err());
        assert!(put(&conn, "big", &"x".repeat(MAX_RECORD + 1), 1).is_err());
    }
}
