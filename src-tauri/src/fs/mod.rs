//! Filesystem commands for the Editor panel (step 1.8).
//!
//! The Editor reads a directory tree scoped to a project's working dir and
//! opens/saves text files in CodeMirror (design §5 Editor). Like `sys::open_path`
//! (step 1.4), these are custom commands rather than `tauri-plugin-fs` calls: the
//! editor browses *arbitrary* registered working dirs chosen at runtime, which a
//! fixed front-end ACL scope can't enumerate ahead of time. They stay deliberately
//! small — list a directory, read a UTF-8 file, write a UTF-8 file — and
//! platform-agnostic (no path-separator assumptions; `PathBuf` does the work).

use std::path::Path;

use serde::Serialize;

/// Refuse to load a file larger than this into the editor. CodeMirror is for the
/// quick edits this app exists for, not multi-megabyte blobs; reading a huge or
/// accidentally-binary file would just freeze the webview. (design §1 non-goals.)
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// One entry in a directory listing. `is_dir` lets the tree render folders first
/// and decide whether a click expands or opens. Serialized camelCase to match the
/// rest of the IPC surface (see `registry`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    /// Final path component — the label shown in the tree.
    name: String,
    /// Absolute path, used as the stable key and to read/expand the entry.
    path: String,
    /// Directory (expandable) vs. file (openable).
    is_dir: bool,
}

/// List the immediate children of `path`, directories first then files, each
/// group sorted case-insensitively. Non-recursive: the tree lazy-loads each
/// folder on expand so a deep repo never blocks on one giant walk.
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = Vec::new();
    let read = std::fs::read_dir(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        // `file_type()` avoids a follow-the-symlink `metadata()` stat where it can;
        // a broken entry is skipped rather than failing the whole listing.
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path().to_string_lossy().into_owned();
        entries.push(DirEntry {
            name,
            path,
            is_dir: file_type.is_dir(),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir) // dirs (true) before files (false)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Read a text file's contents. Rejects oversized files and anything that isn't
/// valid UTF-8 (i.e. binary), so the editor only ever opens what it can edit.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("cannot open {path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} is a directory"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{} is too large to edit ({:.1} MB)",
            file_label(&path),
            meta.len() as f64 / (1024.0 * 1024.0)
        ));
    }
    match std::fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map_err(|_| format!("{} is not a text file", file_label(&path))),
        Err(e) => Err(format!("cannot read {path}: {e}")),
    }
}

/// Write `content` to `path`, replacing it. The file must already exist — the
/// editor only saves files it opened from the tree, never creates new paths
/// (no "new file" affordance in the MVP), so a missing target is an error rather
/// than a silent create.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    if !Path::new(&path).is_file() {
        return Err(format!("{} no longer exists", file_label(&path)));
    }
    std::fs::write(&path, content).map_err(|e| format!("cannot save {path}: {e}"))
}

/// The final path component for user-facing messages, falling back to the whole
/// path if it has no file name.
fn file_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}
