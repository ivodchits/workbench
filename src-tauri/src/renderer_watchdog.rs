// Recovery for a dead or wedged main-window renderer.
//
// The window's page runs in a WebView2 renderer process. When that process dies,
// WebView2 leaves the window showing the last frame and nothing in it responds;
// the app itself (this process, the hook server, every PTY) keeps running, so
// from outside it just looks frozen. Seen on 2026-11-08: the machine ran out of
// commit (rust-analyzer had taken 79 GB), an allocation in the renderer failed,
// and the renderer went into Chromium's out-of-memory crash path (0xE0000008).
// It never exited, because that path waits for a crash-reporting helper that
// wasn't there. So no "process failed" event came either.
//
// Two layers, so both cases recover:
//
//  1. **ProcessFailed.** When the main frame's renderer exits, reload the page.
//     When WebView2 reports it unresponsive, kill it (a reload alone would wait
//     on the same stuck process), and its exit then reloads.
//  2. **Heartbeat watchdog** (release builds). The page calls `ui_heartbeat`
//     every few seconds. If the window is on screen and the page has gone quiet
//     for [`STALE`], its renderer is killed the same way. A debug build skips this:
//     a DevTools breakpoint stops the heartbeat too.
//
// A reload resets the frontend (the saved layout comes back as dormant
// placeholders), but the PTYs live here and keep running. Relaunching a console
// replaces its old PTY, so no session ends up running twice.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// How long the page may go without a heartbeat while the window is visible.
/// The page beats every 5 s (see `src/ipc/heartbeat.ts`). Throttling of a hidden
/// window doesn't count, because the clock only runs while the window is shown.
#[cfg(windows)]
const STALE: Duration = Duration::from_secs(45);

/// How often the watchdog looks.
#[cfg(windows)]
const TICK: Duration = Duration::from_secs(5);

fn epoch() -> Instant {
    static E: OnceLock<Instant> = OnceLock::new();
    *E.get_or_init(Instant::now)
}

fn now_ms() -> u64 {
    epoch().elapsed().as_millis() as u64
}

/// When the main page last beat, in ms since [`epoch`].
static LAST_BEAT_MS: AtomicU64 = AtomicU64::new(0);
/// Armed by a heartbeat, disarmed by a recovery: the watchdog only acts on a
/// page that has shown it's alive, so a page that can't boot isn't killed over
/// and over.
static ARMED: AtomicBool = AtomicBool::new(false);

/// The main page's heartbeat. Torn-off windows and the voice overlay load the same
/// bundle but aren't watched, so only the main window's beat counts.
#[tauri::command]
pub fn ui_heartbeat(window: tauri::WebviewWindow) {
    if window.label() == "main" {
        LAST_BEAT_MS.store(now_ms(), Ordering::Relaxed);
        ARMED.store(true, Ordering::Relaxed);
    }
}

/// Install both layers on the main window. No-op off Windows.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    epoch();
    install_process_failed_handler(window);
    if !cfg!(debug_assertions) {
        spawn_watchdog(window.clone());
    }
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {}

#[cfg(windows)]
fn install_process_failed_handler(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };
    use webview2_com::ProcessFailedEventHandler;

    let res = window.with_webview(move |platform| unsafe {
        let webview = match platform.controller().CoreWebView2() {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[renderer] no CoreWebView2: {e}");
                return;
            }
        };
        let env = platform.environment();
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                eprintln!("[renderer] the page's process exited; reloading");
                ARMED.store(false, Ordering::Relaxed);
                sender.Reload()?;
            } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
                eprintln!("[renderer] the page stopped responding");
                if !cfg!(debug_assertions) {
                    ARMED.store(false, Ordering::Relaxed);
                    kill_renderers(&env);
                }
            } else {
                // GPU and utility processes restart on their own; a dead browser
                // process can't be recovered in place. Log and leave them.
                eprintln!("[renderer] a WebView2 process failed (kind {})", kind.0);
            }
            Ok(())
        }));
        let mut token = Default::default();
        if let Err(e) = webview.add_ProcessFailed(&handler, &mut token) {
            eprintln!("[renderer] add_ProcessFailed failed: {e}");
        }
    });
    if let Err(e) = res {
        eprintln!("[renderer] with_webview failed: {e}");
    }
}

/// Watch for a page that stopped beating while its window is on screen.
#[cfg(windows)]
fn spawn_watchdog(window: tauri::WebviewWindow) {
    std::thread::Builder::new()
        .name("renderer-watchdog".into())
        .spawn(move || {
            // When the window was last seen hidden or minimized: a hidden page's
            // timers are throttled, so silence only counts from when it's shown.
            let mut shown_since: Option<u64> = None;
            loop {
                std::thread::sleep(TICK);
                let shown = window.is_visible().unwrap_or(false)
                    && !window.is_minimized().unwrap_or(true);
                let now = now_ms();
                if !shown {
                    shown_since = None;
                    continue;
                }
                let since = *shown_since.get_or_insert(now);
                if !ARMED.load(Ordering::Relaxed) {
                    continue;
                }
                let quiet_from = LAST_BEAT_MS.load(Ordering::Relaxed).max(since);
                if now.saturating_sub(quiet_from) < STALE.as_millis() as u64 {
                    continue;
                }
                eprintln!(
                    "[renderer] no heartbeat for {}s while shown; restarting the page",
                    (now - quiet_from) / 1000
                );
                ARMED.store(false, Ordering::Relaxed);
                // COM objects must be used on the main thread, which stays free
                // while the page is stuck (the page runs in its own process).
                let res = window.with_webview(|platform| kill_renderers(&platform.environment()));
                if let Err(e) = res {
                    eprintln!("[renderer] with_webview failed: {e}");
                }
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| eprintln!("[renderer] watchdog thread didn't start: {e}"));
}

/// Terminate this WebView2 environment's renderer processes. The main frame's
/// exit raises ProcessFailed(RENDER_PROCESS_EXITED), whose handler reloads.
#[cfg(windows)]
fn kill_renderers(
    env: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment8, COREWEBVIEW2_PROCESS_KIND,
        COREWEBVIEW2_PROCESS_KIND_RENDERER,
    };
    use windows::core::Interface;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    unsafe {
        let infos = match env
            .cast::<ICoreWebView2Environment8>()
            .and_then(|e8| e8.GetProcessInfos())
        {
            Ok(i) => i,
            Err(e) => {
                eprintln!("[renderer] couldn't list WebView2 processes: {e}");
                return;
            }
        };
        let mut count = 0u32;
        if infos.Count(&mut count).is_err() {
            return;
        }
        for i in 0..count {
            let Ok(info) = infos.GetValueAtIndex(i) else { continue };
            let mut kind = COREWEBVIEW2_PROCESS_KIND::default();
            let mut pid = 0i32;
            if info.Kind(&mut kind).is_err() || info.ProcessId(&mut pid).is_err() {
                continue;
            }
            if kind != COREWEBVIEW2_PROCESS_KIND_RENDERER || pid <= 0 {
                continue;
            }
            match OpenProcess(PROCESS_TERMINATE, false, pid as u32) {
                Ok(h) => {
                    if let Err(e) = TerminateProcess(h, 1) {
                        eprintln!("[renderer] couldn't end renderer {pid}: {e}");
                    } else {
                        eprintln!("[renderer] ended renderer {pid}");
                    }
                    let _ = CloseHandle(h);
                }
                Err(e) => eprintln!("[renderer] couldn't open renderer {pid}: {e}"),
            }
        }
    }
}
