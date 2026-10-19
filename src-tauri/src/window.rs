//! Building webviews (step A2). Every window (the main one and each torn-off panel)
//! is built here so they all share one WebView2 profile: the same browser args and
//! the same data folder. WebView2 refuses to open a webview on a data folder that is
//! already in use with different args, and the windows share `localStorage` (composer
//! drafts), so the two must match everywhere.
//!
//! - The args keep timers and the renderer running while the window is hidden or
//!   occluded, which Duck's engine relies on (assistant plan, X0 → Hidden window). They
//!   replace wry's defaults, so those are repeated first.
//! - A debug build gets its own data folder (`…\com.workbench.app\dev`), so it can run
//!   next to an installed release even when their args differ, and the two never share
//!   storage. A release keeps Tauri's default folder.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Passed by the login entry (step A3, `tauri-plugin-autostart`): start with the
/// main window hidden; the tray icon shows it.
pub const MINIMIZED_ARG: &str = "--minimized";

const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
     --disable-background-timer-throttling --disable-renderer-backgrounding \
     --disable-backgrounding-occluded-windows";

fn profile<'a, M: Manager<tauri::Wry>>(
    app: &AppHandle,
    builder: WebviewWindowBuilder<'a, tauri::Wry, M>,
) -> WebviewWindowBuilder<'a, tauri::Wry, M> {
    let builder = builder.additional_browser_args(BROWSER_ARGS);
    if !cfg!(debug_assertions) {
        return builder;
    }
    match app.path().app_local_data_dir() {
        Ok(dir) => builder.data_directory(dir.join("dev")),
        Err(e) => {
            eprintln!("[window] no local data dir for the dev profile: {e}");
            builder
        }
    }
}

/// Build the main window from its `tauri.conf.json` entry (which has
/// `create: false`, so Tauri leaves it to us). Started at login, it stays hidden
/// until the tray icon is clicked; Duck's engine runs either way.
pub fn build_main(app: &AppHandle) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .expect("tauri.conf.json defines the main window");
    let hidden = std::env::args().any(|a| a == MINIMIZED_ARG);
    profile(app, WebviewWindowBuilder::from_config(app, &config)?)
        .visible(!hidden)
        .build()?;
    Ok(())
}

/// Show the main window (the tray icon's click): restored, unminimized, focused.
pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Open a torn-off panel's window (step 4.2) with the main window's profile.
/// `url` is the app page with its query (`index.html?torn=…`). Async: building a
/// window from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn window_open_torn(
    app: AppHandle,
    label: String,
    url: String,
    title: String,
) -> Result<(), String> {
    if !label.starts_with("torn-") {
        return Err(format!("not a torn-off window label: {label}"));
    }
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(900.0, 640.0)
        .min_inner_size(480.0, 320.0)
        // As the main window: the page takes drops itself, so a file from the OS
        // reaches the console with its path (step D2).
        .disable_drag_drop_handler();
    profile(&app, builder)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
