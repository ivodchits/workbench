// Generated autopilot plans (`src/assistant/generatedPlan.ts`): the plan Duck writes
// when the user describes the steps instead of naming a plan file. One Markdown file
// per session in the app's data folder, never in the project; a session's next
// generated plan replaces it, and the weekly housekeeping removes the files that
// haven't changed for a week, except those of runs that aren't stopped.

use std::path::{Path, PathBuf};

/// The most a generated plan may hold (30 steps of a few paragraphs each).
const MAX_BYTES: usize = 256 * 1024;

pub fn root(app_data: &Path) -> PathBuf {
    app_data.join(if cfg!(debug_assertions) { "duck-plans.dev" } else { "duck-plans" })
}

/// A session id is a uuid; anything else could name a path outside the folder.
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(format!("not a session id: {id}"));
    }
    Ok(())
}

/// Write the session's plan (replacing the last one); its path.
pub fn write(root: &Path, id: &str, text: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    if text.len() > MAX_BYTES {
        return Err(format!("the plan is too long ({} bytes; at most {MAX_BYTES})", text.len()));
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = root.join(format!("{id}.md"));
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Remove the plans that haven't changed for `older_ms`, but those of `keep`; how
/// many went.
pub fn prune(root: &Path, older_ms: u64, keep: &[String]) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else { return 0 };
    let now = std::time::SystemTime::now();
    let mut n = 0;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".md") else { continue };
        if check_id(id).is_err() || keep.iter().any(|k| k == id) || !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
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
        let d = std::env::temp_dir().join(format!("duck-plans-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn writes_and_replaces_one_file_per_session() {
        let root = tmp().join("plans");
        let p = write(&root, "abc-1", "# One\n").unwrap();
        assert_eq!(p, root.join("abc-1.md"));
        write(&root, "abc-1", "# Two\n").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "# Two\n");
    }

    #[test]
    fn refuses_ids_that_are_paths_and_huge_plans() {
        let root = tmp();
        for bad in ["", "../x", "a/b", "a\\b", "C:x", ".hidden", "a.md"] {
            assert!(write(&root, bad, "#").is_err(), "{bad}");
        }
        assert!(write(&root, "big", &"x".repeat(MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn prunes_old_plans_but_kept_ones() {
        let root = tmp();
        for id in ["old", "running", "new"] {
            write(&root, id, "#").unwrap();
        }
        std::fs::write(root.join("keep.txt"), "not a plan").unwrap();
        let week = std::time::Duration::from_secs(8 * 24 * 3600);
        for id in ["old", "running"] {
            let f = std::fs::File::options().write(true).open(root.join(format!("{id}.md"))).unwrap();
            f.set_modified(std::time::SystemTime::now() - week).unwrap();
        }
        assert_eq!(prune(&root, 7 * 24 * 3_600_000, &["running".to_string()]), 1);
        assert!(!root.join("old.md").exists());
        assert!(root.join("running.md").exists());
        assert!(root.join("new.md").exists());
        assert!(root.join("keep.txt").exists());
        assert_eq!(prune(&tmp().join("missing"), 0, &[]), 0);
    }
}
