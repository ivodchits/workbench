//! OS integration commands (step 1.4).
//!
//! Small platform-agnostic shims over the host OS. Right now this is just
//! "open a working directory in the OS file manager" for the instance rail —
//! `tauri-plugin-opener` already abstracts Explorer (Windows) / the desktop
//! file manager (Linux), so we lean on its Rust API. Calling it from a command
//! (rather than the JS plugin) keeps the call off the ACL path scope: the rail
//! opens arbitrary registered working dirs, which a fixed front-end scope can't
//! enumerate ahead of time.

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Open `path` (typically an instance's working dir) in the OS file manager.
#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Reveal `path` in the OS file manager with the item itself *selected* (G3 — the
/// Git panel's "reveal in Explorer" on a file row). Distinct from `open_path`,
/// which would launch a file in its default application rather than show it in
/// place; for a directory the two land in much the same spot.
#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

/// Open the project's scratchpad folder: Claude Code keeps each session's
/// scratchpad at `<temp>/claude/<encoded cwd>/<session id>/scratchpad`, so this
/// opens the `<encoded cwd>` folder that holds every session of the project root.
#[tauri::command]
pub fn open_scratchpad(app: AppHandle, root_path: String) -> Result<(), String> {
    let base = std::env::temp_dir().join("claude");
    let dir = find_scratchpad_dir(&base, &root_path)
        .ok_or("no scratchpad yet — Claude creates one in the project's first session")?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Claude Code's cwd→folder encoding: every non-alphanumeric char becomes `-`.
fn encode_cwd(cwd: &str, keep: &[char]) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() || keep.contains(&c) { c } else { '-' })
        .collect()
}

/// The project's folder under `base`. Tries the exact name first, then a
/// case-insensitive match (a drive letter recorded as `c:`) and the variant that
/// keeps `_`, in case the encoding differs from ours.
fn find_scratchpad_dir(base: &Path, root_path: &str) -> Option<PathBuf> {
    let root = root_path.trim_end_matches(['\\', '/']);
    let names = [encode_cwd(root, &[]), encode_cwd(root, &['_'])];
    let exact = base.join(&names[0]);
    if exact.is_dir() {
        return Some(exact);
    }
    std::fs::read_dir(base).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.is_dir()
            && p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| names.iter().any(|want| n.eq_ignore_ascii_case(want)))
    })
}

/// Open a link from rendered transcript text in the user's browser (step T3).
/// Transcript content is untrusted, so only web and mail links get through — never
/// a `file:` URL or a custom scheme that would launch a local program.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !is_external_link(&url) {
        return Err(format!("refusing to open {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

fn is_external_link(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    ["http://", "https://", "mailto:"].iter().any(|scheme| lower.starts_with(scheme))
        && !url.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::{find_scratchpad_dir, is_external_link};

    #[test]
    fn finds_the_project_scratchpad_folder() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("wb-scratch-{nanos}"));
        std::fs::create_dir_all(base.join("C--Users-me-repos-my-app")).unwrap();
        std::fs::create_dir_all(base.join("c--Users-me-repos--hidden-x")).unwrap();

        let found = |root: &str| find_scratchpad_dir(&base, root).map(|p| p.file_name().unwrap().to_owned());
        assert_eq!(found(r"C:\Users\me\repos\my_app").unwrap(), "C--Users-me-repos-my-app");
        assert_eq!(found(r"C:\Users\me\repos\my.app\").unwrap(), "C--Users-me-repos-my-app");
        // Matched regardless of case (on Windows the exact lookup already is).
        let hidden = found(r"C:\Users\me\repos\.hidden\x").unwrap();
        assert!(hidden.eq_ignore_ascii_case("c--Users-me-repos--hidden-x"));
        assert!(found(r"C:\Users\me\repos\other").is_none());
        assert!(find_scratchpad_dir(&base.join("missing"), r"C:\x").is_none());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn only_web_and_mail_links_open() {
        assert!(is_external_link("https://example.com/a?b=c"));
        assert!(is_external_link("HTTP://example.com"));
        assert!(is_external_link("mailto:someone@example.com"));
        assert!(!is_external_link("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_external_link("javascript:alert(1)"));
        assert!(!is_external_link("ms-settings:"));
        assert!(!is_external_link(r"C:\Windows\System32\calc.exe"));
        assert!(!is_external_link("https://example.com/\n--flag"));
    }
}
