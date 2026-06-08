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
