//! Duck's prompts as data (step L3): the files in `<workspace>/config/` that Duck's
//! system prompt and spoken-reply note are read from, and each thread's pin on the
//! version it started with.
//!
//! - The files are `system.md` and `voice.md`, nothing else. A missing one is
//!   `None`, and Duck uses its built-in default (and writes it, as the seed).
//! - A write goes over the text it was read as (`expected`), like the core memory,
//!   and is committed in the workspace's repo by the caller.
//! - The seed: when Duck writes a built-in default into a file, it records that
//!   text's hash in `meta` (`config_seed:<file>`), so a file nobody has edited
//!   since can follow a new build's default.
//! - A pin: the prompts a thread started with, as JSON, under their hash
//!   (`config_snapshots`), and the thread's hash (`config_pins`). A thread's system
//!   prompt then stays byte-identical for its life, for the prompt cache, and a
//!   change reaches the threads started after it.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use super::trust;

pub const DIR: &str = "config";
pub const FILES: [&str; 2] = ["system.md", "voice.md"];
const MAX_BYTES: usize = 128 * 1024;
/// A snapshot holds every file's text, and a little more.
const MAX_SNAPSHOT_BYTES: usize = FILES.len() * MAX_BYTES + 4096;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub file: String,
    /// `config/<file>`, the path in the workspace.
    pub path: String,
    pub text: Option<String>,
    /// The hash Duck recorded when it last wrote a default into it.
    pub seed: Option<String>,
}

/// `config/<file>` for a file Duck reads; an error for anything else.
pub fn check(file: &str) -> Result<String, String> {
    if FILES.contains(&file) {
        Ok(format!("{DIR}/{file}"))
    } else {
        Err(format!("not one of Duck's config files: {file} (they are {})", FILES.join(", ")))
    }
}

fn path(ws: &Path, file: &str) -> Result<PathBuf, String> {
    Ok(ws.join(check(file)?))
}

fn seed_key(file: &str) -> String {
    format!("config_seed:{file}")
}

fn read_one(ws: &Path, file: &str) -> Result<Option<String>, String> {
    let p = path(ws, file)?;
    match std::fs::read(&p) {
        Ok(b) if b.len() > MAX_BYTES => Err(format!("{} is larger than 128 KB", p.display())),
        Ok(b) => Ok(Some(String::from_utf8_lossy(&b).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", p.display())),
    }
}

/// Every config file as it is on disk, with its seed.
pub fn read(conn: &Connection, ws: &Path) -> Result<Vec<ConfigFile>, String> {
    FILES
        .iter()
        .map(|f| {
            Ok(ConfigFile {
                file: f.to_string(),
                path: check(f)?,
                text: read_one(ws, f)?,
                seed: trust::meta(conn, &seed_key(f))?,
            })
        })
        .collect()
}

/// Write `file` over the text it was read as (`expected`, `None`: there was no
/// file). `seed` records the hash of a default Duck is writing. Returns the path
/// to commit.
pub fn write(
    conn: &Connection,
    ws: &Path,
    file: &str,
    text: &str,
    expected: Option<&str>,
    seed: Option<&str>,
) -> Result<String, String> {
    if text.len() > MAX_BYTES {
        return Err(format!("{file} would be larger than 128 KB"));
    }
    if read_one(ws, file)?.as_deref() != expected {
        return Err(format!("stale: config/{file} changed since it was read"));
    }
    let p = path(ws, file)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(&p, text).map_err(|e| format!("cannot write {}: {e}", p.display()))?;
    if let Some(s) = seed {
        trust::set_meta(conn, &seed_key(file), s)?;
    }
    check(file)
}

/// Pin `thread_id` on the prompts `json` (hashed as `hash`); a thread pinned
/// already keeps its pin.
pub fn pin(conn: &Connection, thread_id: &str, hash: &str, json: &str) -> Result<(), String> {
    if json.len() > MAX_SNAPSHOT_BYTES {
        return Err("the prompts are too large to pin".into());
    }
    conn.execute(
        "INSERT OR IGNORE INTO config_snapshots (hash, json) VALUES (?1, ?2)",
        (hash, json),
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO config_pins (thread_id, hash) VALUES (?1, ?2)",
        (thread_id, hash),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The prompts `thread_id` is pinned on, as JSON; `None` when it isn't pinned.
pub fn pinned(conn: &Connection, thread_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT s.json FROM config_pins p JOIN config_snapshots s ON s.hash = p.hash WHERE p.thread_id = ?1",
        [thread_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::db::DuckDb;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wb-config-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn files_write_over_what_was_read_and_keep_their_seed() {
        let db = DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let ws = temp("write");
        let files = read(&conn, &ws).unwrap();
        assert_eq!(files.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(), FILES);
        assert!(files.iter().all(|f| f.text.is_none() && f.seed.is_none()));

        assert_eq!(write(&conn, &ws, "system.md", "You are Duck.", None, Some("abc")).unwrap(), "config/system.md");
        let f = &read(&conn, &ws).unwrap()[0];
        assert_eq!((f.text.as_deref(), f.seed.as_deref()), (Some("You are Duck."), Some("abc")));

        // Over a newer text: refused, and the file is left alone.
        let stale = write(&conn, &ws, "system.md", "x", Some("You were Duck."), None).unwrap_err();
        assert!(stale.starts_with("stale:"), "{stale}");
        write(&conn, &ws, "system.md", "You are Duck, brief.", Some("You are Duck."), None).unwrap();
        let f = &read(&conn, &ws).unwrap()[0];
        assert_eq!((f.text.as_deref(), f.seed.as_deref()), (Some("You are Duck, brief."), Some("abc")));

        // Only Duck's files.
        assert!(write(&conn, &ws, "../memory/core.md", "x", None, None).is_err());
        assert!(write(&conn, &ws, "tiers.json", "x", None, None).is_err());
    }

    #[test]
    fn a_thread_keeps_the_prompts_it_was_pinned_on() {
        let db = DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(pinned(&conn, "t1").unwrap(), None);
        pin(&conn, "t1", "h1", r#"{"system":"one"}"#).unwrap();
        pin(&conn, "t2", "h1", r#"{"system":"one"}"#).unwrap();
        pin(&conn, "t1", "h2", r#"{"system":"two"}"#).unwrap();
        assert_eq!(pinned(&conn, "t1").unwrap().as_deref(), Some(r#"{"system":"one"}"#));
        assert_eq!(pinned(&conn, "t2").unwrap().as_deref(), Some(r#"{"system":"one"}"#));
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM config_snapshots", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }
}
