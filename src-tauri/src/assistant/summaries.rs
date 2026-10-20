//! Session summaries (step W3): the last summary Duck made of each session, as JSON
//! (`{summary, at, made}`), in duck.db's `meta` under the instance id. The next
//! summary reads the transcript from `at` on, with this one as its background.

use rusqlite::Connection;

use super::trust::{meta, set_meta};

const PREFIX: &str = "assistant_summary:";
/// A summary is a headline and a few short lists; anything this big isn't one.
const SUMMARY_MAX: usize = 64 * 1024;

/// Store (or with `None`, drop) a session's last summary.
pub fn set(conn: &Connection, instance_id: &str, summary: Option<&str>) -> Result<(), String> {
    let key = format!("{PREFIX}{instance_id}");
    match summary {
        Some(s) if s.len() > SUMMARY_MAX => Err("the summary is too long".into()),
        Some(s) => set_meta(conn, &key, s),
        None => conn
            .execute("DELETE FROM meta WHERE key = ?1", [&key])
            .map(|_| ())
            .map_err(|e| e.to_string()),
    }
}

pub fn get(conn: &Connection, instance_id: &str) -> Result<Option<String>, String> {
    meta(conn, &format!("{PREFIX}{instance_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::db::DuckDb;

    #[test]
    fn keeps_a_summary_per_session() {
        let db = DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(get(&conn, "a").unwrap(), None);
        set(&conn, "a", Some(r#"{"at":1}"#)).unwrap();
        set(&conn, "b", Some("x")).unwrap();
        set(&conn, "a", Some(r#"{"at":2}"#)).unwrap();
        assert_eq!(get(&conn, "a").unwrap().as_deref(), Some(r#"{"at":2}"#));
        set(&conn, "a", None).unwrap();
        assert_eq!(get(&conn, "a").unwrap(), None);
        assert_eq!(get(&conn, "b").unwrap().as_deref(), Some("x"));
        assert!(set(&conn, "c", Some(&"x".repeat(SUMMARY_MAX + 1))).is_err());
    }
}
