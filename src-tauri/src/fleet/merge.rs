//! Merging after a split (fleet plan F6.2): what an old main wrote while it was cut
//! off and another machine had taken over, merged into the new main's `duck.db`.
//!
//! The new main kept where it took over from (the old main's id, its log's epoch,
//! the `seq` its copy had: [`set_split`]). Once the old main is linked again, the
//! new main asks for its log after that point and merges it ([`merge_tail`]):
//! - **Messages** are added. Where both sides wrote the same `(thread, seq)`, the
//!   old main's messages of that thread go to a fork, "… (from <machine>)", with the
//!   thread's history up to the split.
//! - **Records** with an id: the newer (`updated_at` / `updated`) wins; this
//!   machine's when there's no telling.
//! - **Usage, timings, recall and the decision log**: both sides' rows are kept.
//! - `meta`: this machine's stays; the other's new keys are added.
//! - Deletes aren't repeated: nothing is lost.

use rusqlite::types::Value as Sql;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use super::repl::{columns_of, is_replicated, quote_ident, sql_value, state_get, state_set, Entry};

/// Tables where every row stands on its own: a merge keeps both sides', the other
/// side's under new ids.
const UNION_TABLES: [&str; 7] = [
    "assistant_usage",
    "assistant_quota",
    "assistant_image_spend",
    "assistant_subscription_usage",
    "turn_timings",
    "recall_log",
    "assistant_decisions",
];

/// What a merge did, for the notice.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    pub messages: usize,
    /// Threads both sides wrote to: the other side's went to a fork, by title.
    pub forked: Vec<String>,
    pub records: usize,
    pub usage: usize,
    /// Deletes the other side made, not repeated here.
    pub skipped_deletes: usize,
}

impl MergeReport {
    pub fn is_empty(&self) -> bool {
        self.messages == 0 && self.records == 0 && self.usage == 0 && self.forked.is_empty()
    }

    /// The notice's words.
    pub fn text(&self, from: &str) -> String {
        let mut parts = vec![format!("{} message(s)", self.messages)];
        if self.records > 0 {
            parts.push(format!("{} newer record(s)", self.records));
        }
        if self.usage > 0 {
            parts.push(format!("{} spend and timing row(s)", self.usage));
        }
        let mut t = format!("Merged what {from} did while it was cut off: {}.", parts.join(", "));
        if !self.forked.is_empty() {
            t += &format!(" Both sides wrote to the same conversation, so {from}'s side is its own thread: {}.", self.forked.join(", "));
        }
        t
    }
}

fn get(c: &Connection, sql: &str, keys: &[Sql]) -> rusqlite::Result<Option<Vec<Sql>>> {
    let mut stmt = c.prepare(sql)?;
    let n = stmt.column_count();
    stmt.query_row(rusqlite::params_from_iter(keys.iter()), |r| (0..n).map(|i| r.get::<_, Sql>(i)).collect())
        .optional()
}

fn insert_row(c: &Connection, table: &str, row: &serde_json::Map<String, Value>, skip: &[&str]) -> rusqlite::Result<usize> {
    let cols: Vec<&String> = row.keys().filter(|k| !skip.contains(&k.as_str())).collect();
    let names: Vec<String> = cols.iter().map(|k| quote_ident(k)).collect();
    let marks = vec!["?"; names.len()].join(", ");
    let values: Vec<Sql> = cols.iter().map(|k| sql_value(&row[k.as_str()])).collect();
    c.execute(
        &format!("INSERT OR REPLACE INTO {} ({}) VALUES ({marks})", quote_ident(table), names.join(", ")),
        rusqlite::params_from_iter(values.iter()),
    )
}

/// The fork of `thread` for the other side's messages from `seq` on: made with the
/// thread's history up to there.
fn fork(c: &Connection, thread: &str, seq: i64, from: &str) -> rusqlite::Result<(String, String)> {
    let tag: String = from.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let id = format!("{thread}~{tag}");
    let title: Option<String> = c
        .query_row("SELECT title FROM assistant_threads WHERE id = ?1", [thread], |r| r.get(0))
        .optional()?
        .flatten();
    let fork_title = format!("{} (from {from})", title.unwrap_or_else(|| "a conversation".into()));
    c.execute(
        "INSERT OR IGNORE INTO assistant_threads (id, title, mode, created, updated, keep)
         SELECT ?1, ?2, mode, created, updated, keep FROM assistant_threads WHERE id = ?3",
        params![id, fork_title, thread],
    )?;
    c.execute(
        "INSERT OR IGNORE INTO assistant_messages (thread_id, seq, ts, role, content, source)
         SELECT ?1, seq, ts, role, content, source FROM assistant_messages WHERE thread_id = ?2 AND seq < ?3",
        params![id, thread, seq],
    )?;
    Ok((id, fork_title))
}

/// Merge `entries` (the other side's log after the split) into `conn`, in one
/// transaction. `from` names the other machine.
pub fn merge_tail(conn: &Connection, entries: &[Entry], from: &str) -> Result<MergeReport, String> {
    let mut report = MergeReport::default();
    let mut forks: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let mut run = || -> rusqlite::Result<()> {
        for e in entries {
            if !is_replicated(&e.tbl) {
                continue;
            }
            if e.op == "d" {
                report.skipped_deletes += 1;
                continue;
            }
            let Some(row) = e.row.as_ref().and_then(|r| r.as_object()) else { continue };
            if e.tbl == "assistant_messages" {
                let thread = row.get("thread_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let seq = row.get("seq").and_then(|v| v.as_i64()).unwrap_or(0);
                let target = match forks.get(&thread) {
                    Some(f) => Some(f.clone()),
                    None => {
                        let here = get(
                            conn,
                            "SELECT content FROM assistant_messages WHERE thread_id = ?1 AND seq = ?2",
                            &[Sql::Text(thread.clone()), Sql::Integer(seq)],
                        )?;
                        match here {
                            None => None,
                            // The same message: both have it.
                            Some(v) if v.first() == Some(&sql_value(row.get("content").unwrap_or(&Value::Null))) => continue,
                            Some(_) => {
                                let (id, title) = fork(conn, &thread, seq, from)?;
                                report.forked.push(title);
                                forks.insert(thread.clone(), id.clone());
                                Some(id)
                            }
                        }
                    }
                };
                let mut row = row.clone();
                if let Some(f) = target {
                    row.insert("thread_id".into(), Value::String(f));
                }
                insert_row(conn, "assistant_messages", &row, &[])?;
                report.messages += 1;
                continue;
            }
            if UNION_TABLES.contains(&e.tbl.as_str()) {
                insert_row(conn, &e.tbl, row, &["id"])?;
                report.usage += 1;
                continue;
            }
            let (cols, pk) = columns_of(conn, &e.tbl)?;
            let keys: Vec<Sql> = e.pk.as_array().map(|a| a.iter().map(sql_value).collect()).unwrap_or_default();
            if keys.len() != pk.len() {
                continue;
            }
            let cond = pk.iter().map(|c| format!("{} IS ?", quote_ident(c))).collect::<Vec<_>>().join(" AND ");
            let stamp = ["updated_at", "updated"].into_iter().find(|c| cols.iter().any(|x| x == c));
            let pick = stamp.map(quote_ident).unwrap_or_else(|| "1".into());
            let mine = get(conn, &format!("SELECT {pick} FROM {} WHERE {cond}", quote_ident(&e.tbl)), &keys)?;
            let take = match (mine, stamp) {
                (None, _) => true,
                (Some(_), None) => false,
                (Some(v), Some(col)) => match (&v[0], &sql_value(row.get(col).unwrap_or(&Value::Null))) {
                    (Sql::Integer(a), Sql::Integer(b)) => b > a,
                    (Sql::Real(a), Sql::Real(b)) => b > a,
                    (Sql::Text(a), Sql::Text(b)) => b > a,
                    _ => false,
                },
            };
            if take {
                conn.execute(&format!("DELETE FROM {} WHERE {cond}", quote_ident(&e.tbl)), rusqlite::params_from_iter(keys.iter()))?;
                insert_row(conn, &e.tbl, row, &[])?;
                report.records += 1;
            }
        }
        Ok(())
    };
    match run() {
        Ok(()) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(report)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e.to_string())
        }
    }
}

/// Where this machine took over from another's copy: whose, of which epoch, at
/// which `seq`. Kept in the log's state until merged.
pub fn set_split(conn: &Connection, origin: &str, epoch: &str, seq: i64) -> rusqlite::Result<()> {
    state_set(conn, "split_origin", origin)?;
    state_set(conn, "split_epoch", epoch)?;
    state_set(conn, "split_seq", &seq.to_string())
}

pub fn split(conn: &Connection) -> rusqlite::Result<Option<(String, String, i64)>> {
    let (Some(o), Some(e), Some(s)) = (state_get(conn, "split_origin")?, state_get(conn, "split_epoch")?, state_get(conn, "split_seq")?) else {
        return Ok(None);
    };
    Ok(Some((o, e, s.parse().unwrap_or(0))))
}

/// Move the split's mark on (merged up to `seq`), or clear it (None).
pub fn advance_split(conn: &Connection, seq: Option<i64>) -> rusqlite::Result<()> {
    match seq {
        Some(s) => state_set(conn, "split_seq", &s.to_string()),
        None => {
            conn.execute("DELETE FROM repl_state WHERE k IN ('split_origin', 'split_epoch', 'split_seq')", [])?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::repl::{install, since};
    use super::*;

    fn duck() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE assistant_threads (id TEXT PRIMARY KEY, title TEXT, mode TEXT, created INTEGER, updated INTEGER, keep INTEGER);
             CREATE TABLE assistant_messages (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER, role TEXT, content TEXT, source TEXT, PRIMARY KEY (thread_id, seq));
             CREATE TRIGGER assistant_messages_append_only BEFORE UPDATE ON assistant_messages BEGIN SELECT RAISE(ABORT, 'append-only'); END;
             CREATE TABLE assistant_usage (id INTEGER PRIMARY KEY, ts INTEGER, cost_usd REAL);
             CREATE TABLE routines (id TEXT PRIMARY KEY, data TEXT, updated_at INTEGER);",
        )
        .unwrap();
        install(&c).unwrap();
        c
    }

    fn texts(c: &Connection, sql: &str) -> Vec<String> {
        c.prepare(sql).unwrap().query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect()
    }

    #[test]
    fn a_split_merges_with_nothing_lost() {
        // Both had thread t (two messages), a quiet thread and a routine at the split.
        let a = duck(); // the old main, cut off
        let b = duck(); // the new main
        for c in [&a, &b] {
            c.execute_batch(
                "INSERT INTO assistant_threads VALUES ('t', 'groceries', 'assistant', 1, 1, 0);
                 INSERT INTO assistant_messages VALUES ('t', 1, 1, 'user', 'milk', 'desktop');
                 INSERT INTO assistant_messages VALUES ('t', 2, 2, 'assistant', 'noted', NULL);
                 INSERT INTO assistant_threads VALUES ('quiet', 'untouched', 'assistant', 1, 1, 0);
                 INSERT INTO assistant_messages VALUES ('quiet', 1, 1, 'user', 'hi', 'desktop');
                 INSERT INTO routines VALUES ('r', 'old', 1);
                 INSERT INTO assistant_usage (ts, cost_usd) VALUES (1, 0.5);",
            )
            .unwrap();
        }
        let split: i64 = a.query_row("SELECT MAX(seq) FROM repl_log", [], |r| r.get(0)).unwrap();
        // Apart: both write to t; A makes a thread, writes to "quiet", edits the
        // routine later than B does, spends, and deletes something.
        a.execute_batch(
            "INSERT INTO assistant_messages VALUES ('t', 3, 3, 'user', 'and eggs', 'desktop');
             INSERT INTO assistant_messages VALUES ('t', 4, 4, 'assistant', 'eggs too', NULL);
             INSERT INTO assistant_threads VALUES ('new', 'made apart', 'assistant', 3, 3, 0);
             INSERT INTO assistant_messages VALUES ('new', 1, 3, 'user', 'remember this', 'phone');
             INSERT INTO assistant_messages VALUES ('quiet', 2, 3, 'user', 'still there?', 'phone');
             UPDATE routines SET data = 'changed on A', updated_at = 5 WHERE id = 'r';
             INSERT INTO assistant_usage (ts, cost_usd) VALUES (3, 0.25);
             DELETE FROM assistant_threads WHERE id = 'new';
             INSERT INTO assistant_threads VALUES ('new', 'made apart', 'assistant', 3, 3, 0);",
        )
        .unwrap();
        b.execute_batch(
            "INSERT INTO assistant_messages VALUES ('t', 3, 3, 'user', 'and bread', 'laptop');
             UPDATE routines SET data = 'changed on B, earlier', updated_at = 4 WHERE id = 'r';
             INSERT INTO assistant_usage (ts, cost_usd) VALUES (3, 1.0);",
        )
        .unwrap();
        let tail = since(&a, state_get(&a, "epoch").unwrap().as_deref(), split).unwrap();
        assert!(!tail.snapshot);
        let r = merge_tail(&b, &tail.entries, "desktop").unwrap();

        // B's thread is as it was; A's side of it is a fork with the history.
        assert_eq!(texts(&b, "SELECT content FROM assistant_messages WHERE thread_id = 't' ORDER BY seq"), ["milk", "noted", "and bread"]);
        assert_eq!(r.forked, ["groceries (from desktop)"]);
        assert_eq!(
            texts(&b, "SELECT content FROM assistant_messages WHERE thread_id LIKE 't~%' ORDER BY seq"),
            ["milk", "noted", "and eggs", "eggs too"]
        );
        // A's new thread, and its message in a thread B didn't touch, are added.
        assert_eq!(texts(&b, "SELECT content FROM assistant_messages WHERE thread_id = 'new'"), ["remember this"]);
        assert_eq!(texts(&b, "SELECT content FROM assistant_messages WHERE thread_id = 'quiet' ORDER BY seq"), ["hi", "still there?"]);
        // The newer record wins; spend is both sides'.
        assert_eq!(texts(&b, "SELECT data FROM routines"), ["changed on A"]);
        let spent: f64 = b.query_row("SELECT SUM(cost_usd) FROM assistant_usage", [], |r| r.get(0)).unwrap();
        assert!((spent - 1.75).abs() < 1e-9, "{spent}");
        assert_eq!(r.skipped_deletes, 1);
        assert_eq!(r.messages, 4);
        assert!(r.text("desktop").contains("groceries (from desktop)"));
        // Merging the same again adds nothing.
        let again = merge_tail(&b, &tail.entries, "desktop").unwrap();
        assert_eq!(again.messages, 2, "only the fork's, which are already there, replaced");
        assert_eq!(texts(&b, "SELECT content FROM assistant_messages WHERE thread_id = 'quiet' ORDER BY seq").len(), 2);
    }

    #[test]
    fn the_split_mark_is_kept_until_merged() {
        let c = duck();
        assert_eq!(split(&c).unwrap(), None);
        set_split(&c, "desk", "e1", 10).unwrap();
        assert_eq!(split(&c).unwrap(), Some(("desk".into(), "e1".into(), 10)));
        advance_split(&c, Some(20)).unwrap();
        assert_eq!(split(&c).unwrap().unwrap().2, 20);
        advance_split(&c, None).unwrap();
        assert_eq!(split(&c).unwrap(), None);
    }
}
