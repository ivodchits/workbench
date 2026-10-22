//! Conversation threads (step A2): the storage behind the engine in
//! `src/assistant/`. The engine runs in the webview; this only persists what it
//! produces, in `duck.db`.
//!
//! Messages are append-only. [`append`] takes the `seq` the caller expects to write
//! and refuses anything but the next one, so a doubled or out-of-order write fails
//! loudly instead of forking the history.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub title: String,
    pub mode: String,
    pub created: i64,
    pub updated: i64,
    /// Kept from L4's clean-up of idle threads (the pin in the thread list).
    pub keep: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub thread_id: String,
    pub seq: i64,
    pub ts: i64,
    pub role: String,
    pub content: Value,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub id: String,
    pub thread_id: String,
    pub created: i64,
    pub data: Value,
}

const ROLES: &[&str] = &["user", "assistant", "system", "notice"];

fn thread_row(r: &rusqlite::Row) -> rusqlite::Result<Thread> {
    Ok(Thread {
        id: r.get(0)?,
        title: r.get(1)?,
        mode: r.get(2)?,
        created: r.get(3)?,
        updated: r.get(4)?,
        keep: r.get::<_, i64>(5)? != 0,
    })
}

fn json(text: String) -> Value {
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

pub fn create(conn: &Connection, id: &str, mode: &str, now: i64) -> Result<Thread, String> {
    if id.is_empty() {
        return Err("a thread needs an id".into());
    }
    conn.execute(
        "INSERT INTO assistant_threads (id, mode, created, updated) VALUES (?1, ?2, ?3, ?3)",
        (id, mode, now),
    )
    .map_err(|e| e.to_string())?;
    get(conn, id)?.ok_or_else(|| "the new thread vanished".into())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Thread>, String> {
    conn.query_row(
        "SELECT id, title, mode, created, updated, keep FROM assistant_threads WHERE id = ?1",
        [id],
        thread_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Most recently active first.
pub fn list(conn: &Connection) -> Result<Vec<Thread>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, mode, created, updated, keep FROM assistant_threads
             ORDER BY updated DESC, created DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], thread_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())
}

/// Pin a thread so the clean-up of idle threads (L4) leaves it, or unpin it.
pub fn set_keep(conn: &Connection, id: &str, keep: bool) -> Result<(), String> {
    let n = conn
        .execute("UPDATE assistant_threads SET keep = ?2 WHERE id = ?1", (id, keep as i64))
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no thread {id}"));
    }
    Ok(())
}

pub fn set_title(conn: &Connection, id: &str, title: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE assistant_threads SET title = ?2 WHERE id = ?1",
            (id, title.trim()),
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no thread {id}"));
    }
    Ok(())
}

pub fn messages(conn: &Connection, thread_id: &str) -> Result<Vec<Message>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT thread_id, seq, ts, role, content, source FROM assistant_messages
             WHERE thread_id = ?1 ORDER BY seq",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([thread_id], |r| {
            Ok(Message {
                thread_id: r.get(0)?,
                seq: r.get(1)?,
                ts: r.get(2)?,
                role: r.get(3)?,
                content: json(r.get(4)?),
                source: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())
}

/// Append `m` as the thread's next message. `m.seq` must be exactly the next one.
pub fn append(conn: &mut Connection, m: &Message) -> Result<(), String> {
    if !ROLES.contains(&m.role.as_str()) {
        return Err(format!("unknown role {:?}", m.role));
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let next: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(seq) + 1, 0) FROM assistant_messages WHERE thread_id = ?1",
            [&m.thread_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if m.seq != next {
        return Err(format!(
            "out of order: thread {} expects seq {next}, got {}",
            m.thread_id, m.seq
        ));
    }
    tx.execute(
        "INSERT INTO assistant_messages (thread_id, seq, ts, role, content, source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (
            &m.thread_id,
            m.seq,
            m.ts,
            &m.role,
            m.content.to_string(),
            &m.source,
        ),
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE assistant_threads SET updated = MAX(updated, ?2) WHERE id = ?1",
        (&m.thread_id, m.ts),
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn pending_put(
    conn: &Connection,
    id: &str,
    thread_id: &str,
    data: &Value,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO assistant_pending (id, thread_id, created, data) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        (id, thread_id, now, data.to_string()),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn pending_list(conn: &Connection) -> Result<Vec<Pending>, String> {
    let mut stmt = conn
        .prepare("SELECT id, thread_id, created, data FROM assistant_pending ORDER BY created")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Pending {
                id: r.get(0)?,
                thread_id: r.get(1)?,
                created: r.get(2)?,
                data: json(r.get(3)?),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())
}

pub fn pending_clear(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM assistant_pending WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a thread with its messages and parked batches (step A4), in one
/// transaction. Append-only means no message is ever changed; a whole conversation
/// can still go. Spend rows stay: they belong to the month, not the thread.
pub fn delete(conn: &mut Connection, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM assistant_pending WHERE thread_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM assistant_messages WHERE thread_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    // Its pin on the prompts it started with (step L3); the snapshot may be shared.
    tx.execute("DELETE FROM config_pins WHERE thread_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    let n = tx
        .execute("DELETE FROM assistant_threads WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no thread {id}"));
    }
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::db::DuckDb;
    use super::*;
    use serde_json::json;

    fn msg(seq: i64, role: &str, ts: i64) -> Message {
        Message {
            thread_id: "t1".into(),
            seq,
            ts,
            role: role.into(),
            content: json!([{"type": "text", "text": format!("m{seq}")}]),
            source: "desktop".into(),
        }
    }

    #[test]
    fn appends_in_order_and_refuses_everything_else() {
        let db = DuckDb::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        create(&conn, "t1", "chat", 100).unwrap();
        append(&mut conn, &msg(0, "user", 110)).unwrap();
        append(&mut conn, &msg(1, "assistant", 120)).unwrap();
        // A repeat, a gap and an unknown role are all refused.
        assert!(append(&mut conn, &msg(1, "assistant", 130)).is_err());
        assert!(append(&mut conn, &msg(3, "user", 130)).is_err());
        assert!(append(&mut conn, &msg(2, "tool", 130)).is_err());
        // So is editing a stored message, whoever tries.
        assert!(conn
            .execute(
                "UPDATE assistant_messages SET content = '[]' WHERE seq = 0",
                []
            )
            .is_err());

        let ms = messages(&conn, "t1").unwrap();
        assert_eq!(ms.len(), 2);
        assert_eq!(ms[1].role, "assistant");
        assert_eq!(ms[1].content[0]["text"], "m1");
        assert_eq!(get(&conn, "t1").unwrap().unwrap().updated, 120);
    }

    #[test]
    fn lists_threads_by_activity_and_keeps_pending_batches() {
        let db = DuckDb::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        create(&conn, "old", "chat", 1).unwrap();
        create(&conn, "t1", "chat", 2).unwrap();
        append(&mut conn, &msg(0, "user", 50)).unwrap();
        set_title(&conn, "t1", "  Groceries ").unwrap();
        let ts = list(&conn).unwrap();
        assert_eq!(ts[0].id, "t1");
        assert_eq!(ts[0].title, "Groceries");
        assert!(set_title(&conn, "nope", "x").is_err());

        pending_put(&conn, "b1", "t1", &json!({"calls": [1]}), 60).unwrap();
        pending_put(&conn, "b1", "t1", &json!({"calls": [1, 2]}), 70).unwrap();
        let p = pending_list(&conn).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].created, 60);
        assert_eq!(p[0].data["calls"][1], 2);
        pending_clear(&conn, "b1").unwrap();
        assert!(pending_list(&conn).unwrap().is_empty());
    }

    #[test]
    fn deletes_a_thread_with_its_messages_and_batches_only() {
        let db = DuckDb::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        create(&conn, "t1", "chat", 1).unwrap();
        create(&conn, "keep", "chat", 1).unwrap();
        append(&mut conn, &msg(0, "user", 10)).unwrap();
        append(&mut conn, &msg(1, "assistant", 20)).unwrap();
        let mut other = msg(0, "user", 30);
        other.thread_id = "keep".into();
        append(&mut conn, &other).unwrap();
        pending_put(&conn, "b1", "t1", &json!({}), 40).unwrap();
        pending_put(&conn, "b2", "keep", &json!({}), 40).unwrap();

        delete(&mut conn, "t1").unwrap();
        assert!(get(&conn, "t1").unwrap().is_none());
        assert!(messages(&conn, "t1").unwrap().is_empty());
        assert_eq!(messages(&conn, "keep").unwrap().len(), 1);
        let p = pending_list(&conn).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].thread_id, "keep");
        assert!(delete(&mut conn, "t1").is_err());
        // A new thread may reuse nothing of the old one: seq starts over.
        create(&conn, "t1", "chat", 50).unwrap();
        append(&mut conn, &msg(0, "user", 60)).unwrap();
    }
}
