//! Duck's state on every machine (fleet plan F5.1): `duck.db` replicated from the
//! main to the others.
//!
//! - **The log.** On every machine, triggers on `duck.db`'s replicated tables write
//!   each change to `repl_log (seq, tbl, pk, op, row)`: the row as JSON (a BLOB as
//!   `{"$blob": hex}`, so no value can make a trigger fail a write), its key as a
//!   JSON array. The triggers are made again on every open, from the schema as it is
//!   then, so a migration's new columns are logged from the next start. The log keeps
//!   its last [`LOG_KEEP`] entries; the log's `epoch` (random, in `repl_state`) says
//!   which history its `seq`s belong to.
//! - **Left out:** `mcp_tool_cache`, the FTS indexes and `memory_index_files` (each
//!   machine builds those from its own files), and `meta` rows that name this
//!   machine's folders (`memory_index_root:…`).
//! - **The replica.** Another machine keeps a copy of the main's `duck.db` in its own
//!   file (`duck.replica.db`), not in its `duck.db`: until the election (F6) every
//!   machine's Duck still writes its own, and the copy is what a machine becomes the
//!   main with. It asks the main for the log after the last `seq` it applied; a copy
//!   of another main, another epoch, or one behind the log's start gets a snapshot
//!   instead (`VACUUM INTO`, sent in chunks), then the log from there.

use std::path::{Path, PathBuf};

use rusqlite::types::Value as Sql;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How many entries the log keeps.
pub const LOG_KEEP: i64 = 100_000;
/// The most entries one answer carries.
pub const BATCH: i64 = 1000;
/// A snapshot travels in chunks of this many bytes.
pub const CHUNK: usize = 256 * 1024;

/// Tables each machine builds for itself.
fn replicated(table: &str) -> bool {
    !(table.starts_with("sqlite_")
        || table.starts_with("repl_")
        || table.contains("_fts")
        || table == "mcp_tool_cache"
        || table == "memory_index_files")
}

/// `meta` keys about this machine's own folders.
const LOCAL_META: &str = "memory_index_root:%";

fn quote(id: &str) -> String {
    format!("\"{}\"", id.replace('"', "\"\""))
}

/// The table's columns, and its key's columns in key order (`rowid` without one).
fn columns(conn: &Connection, table: &str) -> rusqlite::Result<(Vec<String>, Vec<String>)> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote(table)))?;
    let rows: Vec<(String, i64)> =
        stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(5)?)))?.collect::<Result<_, _>>()?;
    let cols: Vec<String> = rows.iter().map(|(c, _)| c.clone()).collect();
    let mut pk: Vec<(i64, String)> = rows.iter().filter(|(_, k)| *k > 0).map(|(c, k)| (*k, c.clone())).collect();
    pk.sort();
    let pk: Vec<String> = if pk.is_empty() { vec!["rowid".into()] } else { pk.into_iter().map(|(_, c)| c).collect() };
    Ok((cols, pk))
}

fn tables(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name")?;
    let names: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(names.into_iter().filter(|t| replicated(t)).collect())
}

/// A value as the log keeps it: JSON, a BLOB wrapped.
fn json_of(side: &str, col: &str) -> String {
    let v = format!("{side}.{}", quote(col));
    format!("CASE WHEN typeof({v}) = 'blob' THEN json_object('$blob', hex({v})) ELSE {v} END")
}

/// Make the log and its triggers (again). Run after the migrations, on every open.
pub fn install(conn: &Connection) -> rusqlite::Result<()> {
    install_keeping(conn, LOG_KEEP)
}

pub fn install_keeping(conn: &Connection, keep: i64) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS repl_log (
            seq  INTEGER PRIMARY KEY AUTOINCREMENT,
            tbl  TEXT NOT NULL,
            pk   TEXT NOT NULL,
            op   TEXT NOT NULL,
            row  TEXT
         );
         CREATE TABLE IF NOT EXISTS repl_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
    )?;
    if state(conn, "epoch")?.is_none() {
        set_state(conn, "epoch", &uuid::Uuid::new_v4().simple().to_string())?;
    }
    drop_triggers(conn)?;
    let mut sql = String::new();
    for t in tables(conn)? {
        let (cols, pk) = columns(conn, &t)?;
        let key = |side: &str| format!("json_array({})", pk.iter().map(|c| json_of(side, c)).collect::<Vec<_>>().join(", "));
        let mut fields: Vec<String> = cols.iter().map(|c| format!("'{}', {}", c.replace('\'', "''"), json_of("NEW", c))).collect();
        if pk == ["rowid"] {
            fields.push("'rowid', NEW.rowid".into());
        }
        let row = format!("json_object({})", fields.join(", "));
        let name = |op: &str| quote(&format!("repl_{t}_{op}"));
        let when = |side: &str| if t == "meta" { format!(" WHEN {side}.key NOT LIKE '{LOCAL_META}'") } else { String::new() };
        let tq = quote(&t);
        let tl = t.replace('\'', "''");
        sql += &format!(
            "CREATE TRIGGER {n} AFTER INSERT ON {tq}{w} BEGIN INSERT INTO repl_log (tbl, pk, op, row) VALUES ('{tl}', {k}, 'i', {row}); END;\n",
            n = name("i"),
            w = when("NEW"),
            k = key("NEW"),
        );
        sql += &format!(
            "CREATE TRIGGER {n} AFTER UPDATE ON {tq}{w} BEGIN INSERT INTO repl_log (tbl, pk, op, row) VALUES ('{tl}', {k}, 'u', {row}); END;\n",
            n = name("u"),
            w = when("NEW"),
            k = key("OLD"),
        );
        sql += &format!(
            "CREATE TRIGGER {n} AFTER DELETE ON {tq}{w} BEGIN INSERT INTO repl_log (tbl, pk, op, row) VALUES ('{tl}', {k}, 'd', NULL); END;\n",
            n = name("d"),
            w = when("OLD"),
            k = key("OLD"),
        );
    }
    conn.execute_batch(&sql)?;
    conn.execute("DELETE FROM repl_log WHERE seq <= (SELECT MAX(seq) FROM repl_log) - ?1", [keep])?;
    Ok(())
}

fn drop_triggers(conn: &Connection) -> rusqlite::Result<()> {
    let names: Vec<String> = {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'repl\\_%' ESCAPE '\\'")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for n in names {
        conn.execute_batch(&format!("DROP TRIGGER IF EXISTS {}", quote(&n)))?;
    }
    Ok(())
}

fn state(conn: &Connection, k: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT v FROM repl_state WHERE k = ?1", [k], |r| r.get(0)).optional()
}

fn set_state(conn: &Connection, k: &str, v: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO repl_state (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, v])?;
    Ok(())
}

/// One change in the log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub seq: i64,
    pub tbl: String,
    pub pk: Value,
    pub op: String,
    pub row: Option<Value>,
}

/// What the main answers a replica that asks for the log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogAnswer {
    pub epoch: String,
    /// The log's last `seq`.
    pub head: i64,
    /// The replica can't continue from where it is: it needs a snapshot.
    pub snapshot: bool,
    pub entries: Vec<Entry>,
}

/// The log after `seq`, for a replica of `epoch` (None: it has no copy yet).
pub fn since(conn: &Connection, epoch: Option<&str>, seq: i64) -> rusqlite::Result<LogAnswer> {
    let mine = state(conn, "epoch")?.unwrap_or_default();
    let (min, head): (Option<i64>, Option<i64>) = conn.query_row("SELECT MIN(seq), MAX(seq) FROM repl_log", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let head = head.unwrap_or(0);
    let gap = min.is_some_and(|m| seq + 1 < m);
    if epoch != Some(mine.as_str()) || gap || seq > head {
        return Ok(LogAnswer { epoch: mine, head, snapshot: true, entries: vec![] });
    }
    let mut stmt = conn.prepare("SELECT seq, tbl, pk, op, row FROM repl_log WHERE seq > ?1 ORDER BY seq LIMIT ?2")?;
    let entries = stmt
        .query_map(params![seq, BATCH], |r| {
            let pk: String = r.get(2)?;
            let row: Option<String> = r.get(4)?;
            Ok(Entry {
                seq: r.get(0)?,
                tbl: r.get(1)?,
                pk: serde_json::from_str(&pk).unwrap_or(Value::Null),
                op: r.get(3)?,
                row: row.and_then(|t| serde_json::from_str(&t).ok()),
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(LogAnswer { epoch: mine, head, snapshot: false, entries })
}

/// A consistent copy of the database, as bytes.
pub fn snapshot(conn: &Connection, scratch: &Path) -> Result<Vec<u8>, String> {
    let _ = std::fs::remove_file(scratch);
    conn.execute("VACUUM INTO ?1", [scratch.to_string_lossy()]).map_err(|e| format!("the snapshot failed: {e}"))?;
    let bytes = std::fs::read(scratch).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(scratch);
    bytes
}

fn sql_of(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => Sql::Text(s.clone()),
        Value::Object(o) if o.len() == 1 && o.contains_key("$blob") => {
            let hex = o["$blob"].as_str().unwrap_or("");
            Sql::Blob((0..hex.len() / 2).filter_map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()).collect())
        }
        other => Sql::Text(other.to_string()),
    }
}

/// Where a replica stands: whose copy it is, of which epoch, up to which `seq`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaState {
    pub origin: Option<String>,
    pub epoch: Option<String>,
    pub seq: i64,
}

/// Another machine's copy of the main's `duck.db`, in its own file.
pub struct Replica {
    path: PathBuf,
    conn: Option<Connection>,
}

impl Replica {
    pub fn new(path: PathBuf) -> Replica {
        Replica { path, conn: None }
    }

    fn conn(&mut self) -> Result<&Connection, String> {
        if self.conn.is_none() {
            if !self.path.exists() {
                return Err("no copy yet".into());
            }
            let c = Connection::open(&self.path).map_err(|e| e.to_string())?;
            c.execute_batch("PRAGMA journal_mode = WAL;").map_err(|e| e.to_string())?;
            self.conn = Some(c);
        }
        Ok(self.conn.as_ref().expect("just opened"))
    }

    /// Close the copy (it's being installed, F6.1) and forget it after: the next
    /// sync starts a new one.
    pub fn close(&mut self) -> &Path {
        self.conn = None;
        &self.path
    }

    pub fn discard(&mut self) {
        self.conn = None;
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", self.path.display()));
        }
    }

    pub fn state(&mut self) -> ReplicaState {
        let Ok(c) = self.conn() else { return ReplicaState::default() };
        let get = |k: &str| state(c, k).ok().flatten();
        ReplicaState {
            origin: get("replica_origin"),
            epoch: get("replica_epoch"),
            seq: get("replica_seq").and_then(|s| s.parse().ok()).unwrap_or(0),
        }
    }

    /// Replace the copy with a snapshot of `origin`'s database.
    pub fn install(&mut self, origin: &str, bytes: &[u8]) -> Result<(), String> {
        self.conn = None;
        let tmp = self.path.with_extension("incoming");
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        {
            let c = Connection::open(&tmp).map_err(|e| e.to_string())?;
            // The main's own: its epoch, and the log the copy came with.
            let epoch = state(&c, "epoch").map_err(|e| e.to_string())?.ok_or("the snapshot has no log")?;
            let head: i64 = c.query_row("SELECT COALESCE(MAX(seq), 0) FROM repl_log", [], |r| r.get(0)).map_err(|e| e.to_string())?;
            drop_triggers(&c).map_err(|e| e.to_string())?;
            c.execute_batch("DELETE FROM repl_log;").map_err(|e| e.to_string())?;
            for (k, v) in [("replica_origin", origin.to_string()), ("replica_epoch", epoch), ("replica_seq", head.to_string())] {
                set_state(&c, k, &v).map_err(|e| e.to_string())?;
            }
        }
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", self.path.display()));
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Apply a batch of the log, in one transaction.
    pub fn apply(&mut self, entries: &[Entry]) -> Result<(), String> {
        let Some(last) = entries.last().map(|e| e.seq) else { return Ok(()) };
        let c = self.conn()?;
        c.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let run = || -> Result<(), String> {
            for e in entries {
                let (_, pk) = columns(c, &e.tbl).map_err(|x| x.to_string())?;
                let keys: Vec<Sql> = e.pk.as_array().map(|a| a.iter().map(sql_of).collect()).unwrap_or_default();
                if keys.len() != pk.len() {
                    return Err(format!("a change to {} with a strange key", e.tbl));
                }
                if e.op == "d" || e.op == "u" {
                    let cond = pk.iter().map(|c| format!("{} IS ?", quote(c))).collect::<Vec<_>>().join(" AND ");
                    c.execute(&format!("DELETE FROM {} WHERE {cond}", quote(&e.tbl)), rusqlite::params_from_iter(keys.iter()))
                        .map_err(|x| x.to_string())?;
                }
                if e.op == "i" || e.op == "u" {
                    let row = e.row.as_ref().and_then(|r| r.as_object()).ok_or("a change with no row")?;
                    let names: Vec<String> = row.keys().map(|k| quote(k)).collect();
                    let marks = vec!["?"; names.len()].join(", ");
                    let values: Vec<Sql> = row.values().map(sql_of).collect();
                    c.execute(
                        &format!("INSERT OR REPLACE INTO {} ({}) VALUES ({marks})", quote(&e.tbl), names.join(", ")),
                        rusqlite::params_from_iter(values.iter()),
                    )
                    .map_err(|x| x.to_string())?;
                }
            }
            set_state(c, "replica_seq", &last.to_string()).map_err(|e| e.to_string())
        };
        match run() {
            Ok(()) => c.execute_batch("COMMIT").map_err(|e| e.to_string()),
            Err(e) => {
                let _ = c.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
}

// For the merge after a split (`merge.rs`).
pub(super) fn columns_of(c: &Connection, table: &str) -> rusqlite::Result<(Vec<String>, Vec<String>)> {
    columns(c, table)
}
pub(super) fn is_replicated(table: &str) -> bool {
    replicated(table)
}
pub(super) fn quote_ident(id: &str) -> String {
    quote(id)
}
pub(super) fn sql_value(v: &Value) -> Sql {
    sql_of(v)
}
pub(super) fn state_get(c: &Connection, k: &str) -> rusqlite::Result<Option<String>> {
    state(c, k)
}
pub(super) fn state_set(c: &Connection, k: &str, v: &str) -> rusqlite::Result<()> {
    set_state(c, k, v)
}

/// The rows that hold absolute paths (audited for F5.1): a folder under Duck's
/// workspace, or a file under the app's data folder.
const PATH_COLUMNS: [(&str, &str); 4] =
    [("assistant_tasks", "data"), ("assistant_drawings", "data"), ("assistant_autopilots", "data"), ("assistant_messages", "content")];

/// Rewrite the paths a copy holds from the machine it came from (`from`: its
/// workspace and data folder) to this one's (`to`), as JSON text and as plain
/// text. For a copy that becomes the main (F6). Returns how many rows changed.
pub fn rebase_paths(conn: &Connection, from: &[&str], to: &[&str]) -> rusqlite::Result<usize> {
    let mut changed = 0;
    for (old, new) in from.iter().zip(to) {
        if old.is_empty() || old == new {
            continue;
        }
        let json = |p: &str| serde_json::to_string(p).expect("a string").trim_matches('"').to_string();
        for (t, col) in PATH_COLUMNS {
            let exists: bool = conn
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", [t], |r| r.get::<_, i64>(0))
                .map(|n| n > 0)?;
            if !exists {
                continue;
            }
            for (o, n) in [(json(old), json(new)), (old.to_string(), new.to_string())] {
                changed += conn.execute(
                    &format!("UPDATE {t} SET {col} = replace({col}, ?1, ?2) WHERE instr({col}, ?1) > 0"),
                    [&o, &n],
                )?;
            }
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE t (a TEXT NOT NULL, b INTEGER NOT NULL, v TEXT, x REAL, bin BLOB, PRIMARY KEY (a, b));
             CREATE TABLE mcp_tool_cache (key TEXT PRIMARY KEY, v TEXT);",
        )
        .unwrap();
        install(&c).unwrap();
        c
    }

    fn rows(c: &Connection, sql: &str) -> Vec<String> {
        let mut stmt = c.prepare(sql).unwrap();
        let n = stmt.column_count();
        stmt.query_map([], |r| {
            Ok((0..n).map(|i| format!("{:?}", r.get::<_, Sql>(i).unwrap())).collect::<Vec<_>>().join("|"))
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    }

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("wb-repl-{}-{name}.db", uuid::Uuid::new_v4().simple()))
    }

    #[test]
    fn the_log_follows_every_change_and_leaves_out_the_local() {
        let c = source();
        c.execute("INSERT INTO t VALUES ('k', 1, 'one', 1.5, x'00ff')", []).unwrap();
        c.execute("UPDATE t SET v = 'uno' WHERE a = 'k'", []).unwrap();
        c.execute("DELETE FROM t", []).unwrap();
        c.execute("INSERT INTO mcp_tool_cache VALUES ('x', 'y')", []).unwrap();
        c.execute("INSERT INTO meta VALUES ('memory_index_root:memory', 'C:/x')", []).unwrap();
        c.execute("INSERT INTO meta VALUES ('trust', '1')", []).unwrap();
        let epoch = state(&c, "epoch").unwrap();
        let a = since(&c, epoch.as_deref(), 0).unwrap();
        assert!(!a.snapshot);
        let ops: Vec<(&str, &str)> = a.entries.iter().map(|e| (e.tbl.as_str(), e.op.as_str())).collect();
        assert_eq!(ops, [("t", "i"), ("t", "u"), ("t", "d"), ("meta", "i")]);
        assert_eq!(a.entries[0].pk, serde_json::json!(["k", 1]));
        assert_eq!(a.entries[0].row.as_ref().unwrap()["bin"], serde_json::json!({"$blob": "00FF"}));
        // Another epoch, or a replica ahead of the log, starts over.
        assert!(since(&c, Some("other"), 0).unwrap().snapshot);
        assert!(since(&c, epoch.as_deref(), 99).unwrap().snapshot);
        assert!(since(&c, None, 0).unwrap().snapshot);
    }

    #[test]
    fn a_replica_matches_after_a_snapshot_and_the_log() {
        let src_path = temp("src");
        let c = Connection::open(&src_path).unwrap();
        c.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, bin BLOB);").unwrap();
        install(&c).unwrap();
        c.execute("INSERT INTO t (v) VALUES ('before')", []).unwrap();

        let mut r = Replica::new(temp("replica"));
        assert_eq!(r.state(), ReplicaState::default());
        let bytes = snapshot(&c, &temp("scratch")).unwrap();
        r.install("desktop", &bytes).unwrap();
        let st = r.state();
        assert_eq!(st.origin.as_deref(), Some("desktop"));
        assert_eq!(st.seq, 1);

        c.execute("INSERT INTO t (v, bin) VALUES ('after', x'0102')", []).unwrap();
        c.execute("UPDATE t SET v = 'changed' WHERE v = 'before'", []).unwrap();
        c.execute("UPDATE t SET id = 10 WHERE v = 'after'", []).unwrap();
        c.execute("INSERT INTO t (v) VALUES ('gone')", []).unwrap();
        c.execute("DELETE FROM t WHERE v = 'gone'", []).unwrap();
        let a = since(&c, st.epoch.as_deref(), st.seq).unwrap();
        assert!(!a.snapshot);
        r.apply(&a.entries).unwrap();
        assert_eq!(r.state().seq, a.head);
        let theirs = rows(r.conn().unwrap(), "SELECT * FROM t ORDER BY id");
        assert_eq!(theirs, rows(&c, "SELECT * FROM t ORDER BY id"));
        // The copy has no triggers of its own: applying didn't log.
        assert_eq!(rows(r.conn().unwrap(), "SELECT COUNT(*) FROM repl_log"), ["Integer(0)"]);

        // A replica that fell behind the log's start needs a snapshot.
        install_keeping(&c, 1).unwrap();
        c.execute("INSERT INTO t (v) VALUES ('x')", []).unwrap();
        c.execute("INSERT INTO t (v) VALUES ('y')", []).unwrap();
        install_keeping(&c, 1).unwrap();
        assert!(since(&c, st.epoch.as_deref(), a.head).unwrap().snapshot);
    }

    #[test]
    fn paths_follow_the_machine() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE assistant_tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);").unwrap();
        let data = serde_json::json!({ "workspace": r"C:\Users\me\Duck", "folder": r"C:\Users\me\Duck\tasks\x" }).to_string();
        c.execute("INSERT INTO assistant_tasks VALUES ('a', ?1)", [&data]).unwrap();
        let n = rebase_paths(&c, &[r"C:\Users\me\Duck"], &["/home/me/Duck"]).unwrap();
        assert_eq!(n, 1);
        let v: serde_json::Value = serde_json::from_str(&c.query_row("SELECT data FROM assistant_tasks", [], |r| r.get::<_, String>(0)).unwrap()).unwrap();
        assert_eq!(v["workspace"], "/home/me/Duck");
        assert_eq!(v["folder"], r"/home/me/Duck\tasks\x");
    }

    #[test]
    fn a_bad_batch_changes_nothing() {
        let src_path = temp("src2");
        let c = Connection::open(&src_path).unwrap();
        c.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);").unwrap();
        install(&c).unwrap();
        let mut r = Replica::new(temp("replica2"));
        r.install("d", &snapshot(&c, &temp("s2")).unwrap()).unwrap();
        let good = Entry { seq: 1, tbl: "t".into(), pk: serde_json::json!([1]), op: "i".into(), row: Some(serde_json::json!({"id": 1, "v": "a"})) };
        let bad = Entry { seq: 2, tbl: "t".into(), pk: serde_json::json!([2]), op: "i".into(), row: Some(serde_json::json!({"id": 2, "nope": "b"})) };
        assert!(r.apply(&[good, bad]).is_err());
        assert_eq!(rows(r.conn().unwrap(), "SELECT COUNT(*) FROM t"), ["Integer(0)"]);
        assert_eq!(r.state().seq, 0);
    }
}

/// Install the log on a copy of a real `duck.db` (`WB_REPL_CHECK=<copy>`) and touch
/// every row of every replicated table: no trigger may fail a write.
#[cfg(test)]
#[test]
#[ignore]
fn on_a_real_copy() {
    let Ok(path) = std::env::var("WB_REPL_CHECK") else { return };
    let c = Connection::open(path).unwrap();
    install(&c).unwrap();
    let mut touched = 0;
    for t in tables(&c).unwrap() {
        let (cols, _) = columns(&c, &t).unwrap();
        let first = quote(&cols[0]);
        match c.execute(&format!("UPDATE {} SET {first} = {first}", quote(&t)), []) {
            Ok(n) => touched += n,
            // The database's own rule (messages are append-only), not the log's.
            Err(e) if e.to_string().contains("append-only") => {}
            Err(e) => panic!("{t}: {e}"),
        }
    }
    let logged: i64 = c.query_row("SELECT COUNT(*) FROM repl_log", [], |r| r.get(0)).unwrap();
    println!("touched {touched} rows, logged {logged}");
    assert!(logged > 0);
    // And the copy of it replicates whole.
    let snap = std::env::temp_dir().join("wb-repl-real-snap.db");
    let bytes = snapshot(&c, &snap).unwrap();
    let mut r = Replica::new(std::env::temp_dir().join(format!("wb-repl-real-{}.db", uuid::Uuid::new_v4().simple())));
    r.install("check", &bytes).unwrap();
    println!("snapshot {} KB, replica at {}", bytes.len() / 1024, r.state().seq);
}
