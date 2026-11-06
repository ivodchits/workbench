// The autopilot decisions log: one Markdown file per session in the app's data
// folder, with a line for every question, plan or permission prompt Duck settled
// for a session on autopilot (or one handed to it), and every one it left to you.
// Appended from the webview (`src/assistant/decisionsLog.ts`), read by the console
// header's "decisions" panel and Duck's `show_autopilot_decisions`, and pruned by
// the weekly housekeeping once a file hasn't changed for a week.

use std::io::Write;
use std::path::{Path, PathBuf};

pub fn root(app_data: &Path) -> PathBuf {
    app_data.join(if cfg!(debug_assertions) { "duck-decisions.dev" } else { "duck-decisions" })
}

/// A session id is a uuid; anything else could name a path outside the folder.
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(format!("not a session id: {id}"));
    }
    Ok(())
}

pub fn file_of(root: &Path, id: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    Ok(root.join(format!("{id}.md")))
}

/// Add `text` to the session's log; a new file starts with `header`.
pub fn append(root: &Path, id: &str, header: &str, text: &str) -> Result<(), String> {
    let path = file_of(root, id)?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let fresh = !path.exists();
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    let mut out = String::new();
    if fresh {
        out.push_str(header.trim_end());
        out.push_str("\n\n");
    }
    out.push_str(text.trim_end());
    out.push('\n');
    f.write_all(out.as_bytes()).map_err(|e| e.to_string())
}

/// The session's log, or None when nothing was logged for it.
pub fn read(root: &Path, id: &str) -> Result<Option<String>, String> {
    let path = file_of(root, id)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove the logs that haven't changed for `older_ms`; how many went.
pub fn prune(root: &Path, older_ms: u64) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else { return 0 };
    let now = std::time::SystemTime::now();
    let mut n = 0;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".md") else { continue };
        if check_id(id).is_err() || !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let age = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| now.duration_since(t).ok());
        if age.map(|a| a.as_millis() as u64) < Some(older_ms) {
            continue;
        }
        if std::fs::remove_file(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("duck-dec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn appends_under_one_header() {
        let root = tmp().join("logs");
        assert_eq!(read(&root, "abc-1").unwrap(), None);
        append(&root, "abc-1", "# Decisions\n", "- one").unwrap();
        append(&root, "abc-1", "# Decisions\n", "- two\n").unwrap();
        assert_eq!(read(&root, "abc-1").unwrap().unwrap(), "# Decisions\n\n- one\n- two\n");
    }

    #[test]
    fn refuses_ids_that_are_paths() {
        let root = tmp();
        for bad in ["", "../x", "a/b", "a\\b", "C:x", ".hidden", "a.md"] {
            assert!(append(&root, bad, "#", "-").is_err(), "{bad}");
            assert!(read(&root, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn prunes_only_old_logs() {
        let root = tmp();
        append(&root, "old", "#", "-").unwrap();
        append(&root, "new", "#", "-").unwrap();
        std::fs::write(root.join("keep.txt"), "not a log").unwrap();
        let week = std::time::Duration::from_secs(8 * 24 * 3600);
        let f = std::fs::File::options().write(true).open(root.join("old.md")).unwrap();
        f.set_modified(std::time::SystemTime::now() - week).unwrap();
        drop(f);
        assert_eq!(prune(&root, 7 * 24 * 3_600_000), 1);
        assert_eq!(read(&root, "old").unwrap(), None);
        assert!(read(&root, "new").unwrap().is_some());
        assert!(root.join("keep.txt").exists());
        assert_eq!(prune(&tmp().join("missing"), 0), 0);
    }
}
