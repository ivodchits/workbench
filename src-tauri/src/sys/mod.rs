//! OS integration commands (step 1.4).
//!
//! Small platform-agnostic shims over the host OS. Right now this is just
//! "open a working directory in the OS file manager" for the instance rail —
//! `tauri-plugin-opener` already abstracts Explorer (Windows) / the desktop
//! file manager (Linux), so we lean on its Rust API. Calling it from a command
//! (rather than the JS plugin) keeps the call off the ACL path scope: the rail
//! opens arbitrary registered working dirs, which a fixed front-end scope can't
//! enumerate ahead of time.

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
    use super::is_external_link;

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
