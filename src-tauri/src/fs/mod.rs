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

/// Resolve a project's `CLAUDE.md`, creating an empty one if it doesn't exist yet,
/// and return its absolute path (step 3.6 — the in-app CLAUDE.md quick-editor).
///
/// The join happens here, in Rust, so the frontend never has to guess the path
/// separator for a registered root (Windows `\` vs `/`). "Create if missing" makes
/// the editor's open-then-save loop work even for a project that has no memory file
/// yet — `write_file` refuses to create new paths, so we seed an empty file first.
#[tauri::command]
pub fn ensure_claude_md(root_path: String) -> Result<String, String> {
    let path = Path::new(&root_path).join("CLAUDE.md");
    if !path.exists() {
        std::fs::write(&path, "")
            .map_err(|e| format!("cannot create {}: {e}", path.display()))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// A project's `.claude/settings.local.json` (step T3, promoting an approval to
/// Claude Code's own allow list): its text, or `None` when there is none yet.
#[tauri::command]
pub fn claude_local_settings_read(root_path: String) -> Result<Option<String>, String> {
    let path = local_settings(&root_path);
    match std::fs::read_to_string(&path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Replace it with `content`, made with its folder when missing. Refused
/// (`stale:`) when the file isn't what the preview was made from (`expected`,
/// `None`: no file), so a change made meanwhile is never lost.
#[tauri::command]
pub fn claude_local_settings_write(
    root_path: String,
    content: String,
    expected: Option<String>,
) -> Result<(), String> {
    if !Path::new(&root_path).is_dir() {
        return Err(format!("{root_path} isn't a folder"));
    }
    if claude_local_settings_read(root_path.clone())? != expected {
        return Err("stale: .claude/settings.local.json changed since it was read".into());
    }
    let path = local_settings(&root_path);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

fn local_settings(root: &str) -> std::path::PathBuf {
    Path::new(root).join(".claude").join("settings.local.json")
}

/// The final path component for user-facing messages, falling back to the whole
/// path if it has no file name.
fn file_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_settings_are_made_and_never_overwritten_stale() {
        let d = std::env::temp_dir().join(format!("wb-fs-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let root = d.to_string_lossy().into_owned();
        assert_eq!(claude_local_settings_read(root.clone()).unwrap(), None);
        // Made with its folder.
        claude_local_settings_write(root.clone(), "{}\n".into(), None).unwrap();
        assert_eq!(claude_local_settings_read(root.clone()).unwrap().as_deref(), Some("{}\n"));
        // Written from a stale read: refused, the file kept.
        let err = claude_local_settings_write(root.clone(), "{\"a\":1}".into(), None).unwrap_err();
        assert!(err.starts_with("stale:"), "{err}");
        claude_local_settings_write(root.clone(), "{\"a\":1}".into(), Some("{}\n".into())).unwrap();
        assert_eq!(claude_local_settings_read(root.clone()).unwrap().as_deref(), Some("{\"a\":1}"));
        // No such project folder.
        assert!(claude_local_settings_write(d.join("gone").to_string_lossy().into_owned(), "{}".into(), None).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
