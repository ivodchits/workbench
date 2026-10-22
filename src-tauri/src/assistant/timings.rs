//! How long Duck's turns take (step D3): one row per turn you started, the
//! engine's JSON (`src/assistant/timings.ts`: the thread's mode, the brain that
//! answered, the time to the first words and the whole reply, what it cost), so the
//! API and the subscription brain can be compared over days. Rows older than 90
//! days are pruned as new ones come.

use rusqlite::{params, Connection};

const MAX_BYTES: usize = 4 * 1024;
const KEEP_MS: i64 = 90 * 24 * 3_600_000;

pub fn add(conn: &Connection, at: i64, data: &str, now: i64) -> Result<(), String> {
    if data.len() > MAX_BYTES {
        return Err("a turn's timing is at most 4 KB".into());
    }
    conn.execute("INSERT INTO turn_timings (at, data) VALUES (?1, ?2)", params![at, data])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM turn_timings WHERE at < ?1", params![now - KEEP_MS])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The rows since `since` (epoch ms), oldest first.
pub fn since(conn: &Connection, since: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT data FROM turn_timings WHERE at >= ?1 ORDER BY at, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![since], |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_come_back_in_order_and_old_ones_go() {
        let db = super::super::db::DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let day = 24 * 3_600_000;
        add(&conn, 5, "{old}", 5).unwrap();
        add(&conn, 100 * day, "{b}", 100 * day).unwrap();
        add(&conn, 99 * day, "{a}", 100 * day).unwrap();
        assert_eq!(since(&conn, 0).unwrap(), ["{a}", "{b}"]);
        assert_eq!(since(&conn, 100 * day).unwrap(), ["{b}"]);
        assert!(add(&conn, 1, &"x".repeat(5000), 1).is_err());
    }
}
