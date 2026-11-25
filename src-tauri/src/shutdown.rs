//! Quitting (the tray's Exit): stop what Workbench started, in order, so a quit
//! leaves nothing running and a `tauri dev` terminal gets its prompt back.
//!
//! 1. Child processes, each with its whole tree: consoles (`claude` and the MCP
//!    servers it started, shells, tasks), Duck's headless workers and subscription brains, the speech sidecar.
//! 2. This dev build's entries in `~/.claude/settings.json`, and the global shortcuts.
//! 3. The tray icon.
//! 4. Every window, which closes its WebView2 controller while the app is still up.
//!    The last window going ends the event loop; `RunEvent::Exit` follows.
//!
//! A bare `app.exit` only hid the windows: WebView2 found its host gone and logged
//! `Failed to unregister class Chrome_WidgetWin_0. Error = 1412` to the terminal.

use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// How long the windows get to go before the app exits anyway.
const WINDOWS_GRACE: Duration = Duration::from_secs(3);

/// How long the daily log may hold a quit up (J3), and how long the main window has
/// to say it's on it.
const DAYLOG_LIMIT: Duration = Duration::from_secs(185);
const DAYLOG_ACK: Duration = Duration::from_secs(8);

/// The daily log's turn on quitting: not asked yet, running, said yes to (acked),
/// done.
static DAYLOG: AtomicU8 = AtomicU8::new(0);
const LOG_IDLE: u8 = 0;
const LOG_ASKED: u8 = 1;
const LOG_ACKED: u8 = 2;
const LOG_DONE: u8 = 3;

/// Quit as the user asked (the window's close, the tray's Exit). The daily log goes
/// first (J3): the main window brings it up to date, or says there's nothing to, and
/// then the quit carries on ([`daylog_quit_finished`]). It gets [`DAYLOG_LIMIT`],
/// and a window that doesn't answer gets [`DAYLOG_ACK`].
pub fn request_exit(app: &AppHandle) {
    match DAYLOG.load(Ordering::SeqCst) {
        LOG_ASKED | LOG_ACKED => {
            crate::fleet::show_main(app);
            return;
        }
        LOG_DONE => return after_log(app),
        _ => {}
    }
    if app.get_webview_window("main").is_none() || app.emit_to("main", "daylog-quit", ()).is_err() {
        return after_log(app);
    }
    DAYLOG.store(LOG_ASKED, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DAYLOG_ACK).await;
        if DAYLOG.load(Ordering::SeqCst) == LOG_ASKED {
            eprintln!("[exit] the main window didn't answer for the daily log; quitting");
            return log_finished(&app);
        }
        tokio::time::sleep(DAYLOG_LIMIT - DAYLOG_ACK).await;
        if DAYLOG.load(Ordering::SeqCst) == LOG_ACKED {
            eprintln!("[exit] the daily log took too long; quitting");
            log_finished(&app);
        }
    });
}

fn log_finished(app: &AppHandle) {
    // Only a quit that's waiting goes on: after "keep Workbench open" this is nothing.
    let swap = |from| DAYLOG.compare_exchange(from, LOG_DONE, Ordering::SeqCst, Ordering::SeqCst).is_ok();
    if swap(LOG_ASKED) || swap(LOG_ACKED) {
        after_log(app);
    }
}

/// The main window is bringing the daily log up to date for a quit.
#[tauri::command]
pub fn daylog_quit_ack() {
    let _ = DAYLOG.compare_exchange(LOG_ASKED, LOG_ACKED, Ordering::SeqCst, Ordering::SeqCst);
}

/// The quit's daily log run shows its window: bring the main window up (a quit from
/// the tray finds it hidden).
#[tauri::command]
pub fn daylog_quit_show(app: AppHandle) {
    crate::fleet::show_main(&app);
}

/// Keep Workbench open after all: the next quit asks the daily log again.
#[tauri::command]
pub fn daylog_quit_cancel() {
    DAYLOG.store(LOG_IDLE, Ordering::SeqCst);
}

/// A handover on quitting was called off (`fleet_leave_cancel`): the next quit asks
/// the daily log again.
pub fn reset_daylog() {
    DAYLOG.store(LOG_IDLE, Ordering::SeqCst);
}

/// The daily log is up to date (or "Quit anyway"): the quit carries on.
#[tauri::command]
pub fn daylog_quit_finished(app: AppHandle) {
    log_finished(&app);
}

/// The quit, once the daily log has had its turn. When this machine holds Duck and
/// another could run it, Duck is handed over first: the webview shows how it goes
/// (`fleet-leaving`), and the app quits once it's done. A second ask while that runs
/// does nothing; the overlay has "Quit anyway".
fn after_log(app: &AppHandle) {
    let Some(fleet) = crate::fleet::get(app) else { return exit(app) };
    if fleet.is_leaving() {
        crate::fleet::show_main(app);
        return;
    }
    if !fleet.must_hand_over() {
        return exit(app);
    }
    crate::fleet::show_main(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if fleet.leave().await {
            // A moment for the overlay to say where Duck went.
            tokio::time::sleep(Duration::from_millis(900)).await;
            exit(&app);
        }
    });
}

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
    crate::assistant::subscription_brain::kill_all(app);
    crate::assistant::mcp_host::kill_all(app);
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
