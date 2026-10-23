//! Drawings (assistant plan G3): what a drawing worker writes, and the records.
//!
//! - **Sources.** A worker writes each version of a drawing into its task folder as
//!   `drawings/<id>/v<n>.<ext>` (`mmd` Mermaid, `svg`, `json` Vega or Vega-Lite).
//!   [`read_source`] reads one back, and only from a task folder of the workspace;
//!   [`write_source`] writes one for a worker that can't (the API worker, which
//!   hands its source in `result.md`).
//! - **Records.** `assistant_drawings` in `duck.db`, as JSON the engine writes: the
//!   drawing's thread, task, kind and versions, each version with its rendered PNG
//!   and SVG as attachments. This module only stores and lists them.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;

use super::workspace::task_folder;

/// The source kinds, by file extension.
pub const EXTS: [&str; 3] = ["mmd", "svg", "json"];
/// A drawing's source is at most this big.
const MAX_SOURCE: u64 = 1024 * 1024;
const MAX_RECORD: usize = 64 * 1024;
const DRAWINGS: &str = "drawings";

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(format!("not a drawing id: {id}"));
    }
    Ok(())
}

/// Where version `n` of drawing `id` goes in a task folder.
pub fn source_path(folder: &Path, id: &str, n: u32, ext: &str) -> PathBuf {
    folder.join(DRAWINGS).join(id).join(format!("v{n}.{ext}"))
}

/// A version's source as the worker left it.
#[derive(Serialize, Debug, PartialEq)]
pub struct Source {
    pub ext: String,
    pub text: String,
    pub path: String,
}

/// Version `n` of drawing `id` in the task folder `folder`, whichever kind it was
/// written as; `None` when there is none yet.
pub fn read_source(dir: &Path, folder: &str, id: &str, n: u32) -> Result<Option<Source>, String> {
    check_id(id)?;
    let f = task_folder(dir, folder)?;
    for ext in EXTS {
        let path = source_path(&f, id, n, ext);
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if meta.len() > MAX_SOURCE {
            return Err(format!("v{n}.{ext} is over {} KB", MAX_SOURCE / 1024));
        }
        let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read v{n}.{ext}: {e}"))?;
        return Ok(Some(Source { ext: ext.into(), text, path: path.to_string_lossy().into_owned() }));
    }
    Ok(None)
}

/// Write version `n` of drawing `id` into the task folder; returns its path.
pub fn write_source(dir: &Path, folder: &str, id: &str, n: u32, ext: &str, text: &str) -> Result<String, String> {
    check_id(id)?;
    if !EXTS.contains(&ext) {
        return Err(format!("not a drawing kind: {ext}"));
    }
    if text.len() as u64 > MAX_SOURCE {
        return Err("the drawing is too large".into());
    }
    let f = task_folder(dir, folder)?;
    let path = source_path(&f, id, n, ext);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, text).map_err(|e| format!("cannot write v{n}.{ext}: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Store a drawing's record.
pub fn put(conn: &Connection, id: &str, data: &str, now: i64) -> Result<(), String> {
    check_id(id)?;
    if data.len() > MAX_RECORD {
        return Err("a drawing record is at most 64 KB".into());
    }
    conn.execute(
        "INSERT INTO assistant_drawings (id, data, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        params![id, data, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The most recently updated `limit` drawing records, newest first.
pub fn list(conn: &Connection, limit: u32) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT data FROM assistant_drawings ORDER BY updated_at DESC, id LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![limit], |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> (PathBuf, String) {
        let ws = std::env::temp_dir().join(format!("wb-drawings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&ws).unwrap();
        let folder = super::super::workspace::new_task(&ws, "2026-10-23", "Draw", "# brief").unwrap();
        (ws, folder.to_string_lossy().into_owned())
    }

    #[test]
    fn a_version_is_read_back_in_whichever_kind_it_was_written() {
        let (ws, folder) = workspace();
        assert_eq!(read_source(&ws, &folder, "abc", 1).unwrap(), None);
        let f = PathBuf::from(&folder);
        std::fs::create_dir_all(f.join("drawings/abc")).unwrap();
        std::fs::write(f.join("drawings/abc/v1.svg"), "<svg/>").unwrap();
        let s = read_source(&ws, &folder, "abc", 1).unwrap().unwrap();
        assert_eq!((s.ext.as_str(), s.text.as_str()), ("svg", "<svg/>"));
        let p = write_source(&ws, &folder, "abc", 2, "mmd", "flowchart LR").unwrap();
        assert!(p.ends_with("v2.mmd"));
        assert_eq!(read_source(&ws, &folder, "abc", 2).unwrap().unwrap().ext, "mmd");
        std::fs::remove_dir_all(ws).unwrap();
    }

    #[test]
    fn only_task_folders_and_plain_ids() {
        let (ws, folder) = workspace();
        assert!(read_source(&ws, &folder, "../x", 1).is_err());
        assert!(write_source(&ws, &folder, "abc", 1, "html", "<b/>").is_err());
        assert!(write_source(&ws, ws.to_str().unwrap(), "abc", 1, "svg", "<svg/>").is_err());
        std::fs::remove_dir_all(ws).unwrap();
    }

    #[test]
    fn records_round_trip_newest_first() {
        let db = super::super::db::DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        put(&conn, "a", "{1}", 1).unwrap();
        put(&conn, "b", "{2}", 2).unwrap();
        put(&conn, "a", "{3}", 3).unwrap();
        assert_eq!(list(&conn, 10).unwrap(), ["{3}", "{2}"]);
    }
}
