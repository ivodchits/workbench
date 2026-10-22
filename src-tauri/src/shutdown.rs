//! Quitting (the tray's Exit): stop what Workbench started, in order, so a quit
//! leaves nothing running and a `tauri dev` terminal gets its prompt back.
//!
//! 1. Child processes, each with its whole tree: consoles (`claude` and the MCP
//!    servers it started, shells, tasks), Duck's headless workers, the speech sidecar.
//! 2. This dev build's entries in `~/.claude/settings.json`, and the global shortcuts.
//! 3. The tray icon.
//! 4. Every window, which closes its WebView2 controller while the app is still up.
//!    The last window going ends the event loop; `RunEvent::Exit` follows.
//!
//! A bare `app.exit` only hid the windows: WebView2 found its host gone and logged
//! `Failed to unregister class Chrome_WidgetWin_0. Error = 1412` to the terminal.

use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// How long the windows get to go before the app exits anyway.
const WINDOWS_GRACE: Duration = Duration::from_secs(3);

/// Quit the app, cleanly. From any thread.
pub fn exit(app: &AppHandle) {
    let handle = app.clone();
    // The tray and the windows belong to the main thread.
    if let Err(e) = app.run_on_main_thread(move || quit(&handle)) {
        eprintln!("[exit] {e}");
        stop_children(app);
        app.exit(0);
    }
}

fn quit(app: &AppHandle) {
    stop_children(app);
    crate::hooks::uninstall_dev(app);
    if let Err(e) = app.global_shortcut().unregister_all() {
        eprintln!("[exit] shortcuts: {e}");
    }
    crate::attention::remove_tray(app);
    for (label, win) in app.webview_windows() {
        if let Err(e) = win.destroy() {
            eprintln!("[exit] window {label}: {e}");
        }
    }
    // Should a window not go, exit regardless.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(WINDOWS_GRACE);
        app.exit(0);
    });
}

/// The cleanup every exit gets (`RunEvent::Exit`), however it came about: the tray's
/// Exit has done it already, and doing it twice is harmless.
pub fn on_exit(app: &AppHandle) {
    stop_children(app);
    crate::hooks::uninstall_dev(app);
    crate::attention::remove_tray(app);
}

fn stop_children(app: &AppHandle) {
    crate::assistant::headless::kill_all(app);
    if let Some(pty) = app.try_state::<crate::pty::PtyManager>() {
        pty.kill_all();
    }
    if let Some(tts) = app.try_state::<crate::voice::tts::TtsState>() {
        tts.shutdown();
    }
}

/// Keep the standard handles Workbench was started with (under `tauri dev`, the
/// terminal's pipes) to itself. Windows hands every inheritable handle to every child,
/// and grandchildren pass them on, so an MCP server that outlived its `claude`, or
/// WebView2's browser, held the terminal's pipe open after the app was gone and the
/// terminal never got its prompt back. A child that is meant to share them
/// (`Stdio::inherit`) still gets its own copy. Called first thing.
#[cfg(windows)]
pub fn keep_stdio_to_self() {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT};
    let handles = [
        std::io::stdin().as_raw_handle(),
        std::io::stdout().as_raw_handle(),
        std::io::stderr().as_raw_handle(),
    ];
    for h in handles {
        if h.is_null() {
            continue;
        }
        // SAFETY: our own standard handles, only their inherit flag cleared. A handle
        // that isn't one (no console, a GUI launch) just fails, which is fine.
        let _ = unsafe { SetHandleInformation(HANDLE(h), HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)) };
    }
}

#[cfg(not(windows))]
pub fn keep_stdio_to_self() {}
