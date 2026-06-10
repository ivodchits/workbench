//! Notifications and tray badge (step 2.3).
//!
//! OS toast notifications fire when the frontend status engine reports an
//! instance transitioning into "needs you". The system tray icon's tooltip
//! is updated to show the current needs-you count. Both are driven by Tauri
//! commands the frontend calls — Rust owns the tray handle, the only way to
//! mutate it after creation.

use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;

/// Managed tray state. `Option` because creation can fail (headless envs,
/// driver issues); commands degrade gracefully when the inner is `None`.
pub struct TrayState(Option<tauri::tray::TrayIcon>);

/// Create the system-tray icon and manage its handle on `app`. Called once
/// from `lib.rs` setup. Failures are logged; the app continues without a tray.
///
/// We copy the window icon's raw RGBA bytes into an owned `Image<'static>` so
/// the borrow on `app` (from `default_window_icon`) ends before we pass `app`
/// into `TrayIconBuilder::build`.
pub fn setup_tray(app: &AppHandle) {
    let icon_opt = app.default_window_icon().map(|img| {
        tauri::image::Image::new_owned(img.rgba().to_vec(), img.width(), img.height())
    });
    let tray = icon_opt
        .and_then(|icon| {
            tauri::tray::TrayIconBuilder::new()
                .tooltip("Workbench")
                .icon(icon)
                .build(app)
                .map_err(|e| eprintln!("[tray] build: {e}"))
                .ok()
        })
        .or_else(|| {
            // Fall back to a tray without an icon if the window icon isn't set
            // (shouldn't happen in a real build, but fine to degrade gracefully).
            tauri::tray::TrayIconBuilder::new()
                .tooltip("Workbench")
                .build(app)
                .map_err(|e| eprintln!("[tray] build (no icon): {e}"))
                .ok()
        });
    app.manage(Mutex::new(TrayState(tray)));
}

/// Fire an OS toast notification for one instance that just entered "needs
/// you". Called by the frontend on each fresh `→ needs_you` transition so the
/// user sees an alert even if Workbench is backgrounded.
#[tauri::command]
pub fn notify_needs_you(
    app: AppHandle,
    instance_title: String,
    task_note: Option<String>,
) -> Result<(), String> {
    let body = task_note
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "waiting for your input".to_string());
    app.notification()
        .builder()
        .title(format!("{} needs you", instance_title))
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// Update the tray tooltip to reflect the current aggregate needs-you count.
/// Called by the frontend whenever the count changes (including back to 0).
#[tauri::command]
pub fn update_tray_badge(state: State<'_, Mutex<TrayState>>, count: u32) {
    let Ok(s) = state.lock() else { return };
    let Some(ref icon) = s.0 else { return };
    let tooltip = if count == 0 {
        "Workbench".to_string()
    } else {
        format!(
            "Workbench · {} {} you",
            count,
            if count == 1 { "agent needs" } else { "agents need" }
        )
    };
    let _ = icon.set_tooltip(Some(&tooltip));
}
