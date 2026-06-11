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

/// Managed tray state. The icon is `Option` because creation can fail (headless
/// envs, driver issues); commands degrade gracefully when it's `None`. The tooltip
/// composes two independently-updated signals — the needs-you count (status engine,
/// 2.2/2.3) and the account-wide usage summary (statusline meter, 3.2) — so we keep
/// both here and rebuild the whole tooltip whenever either changes.
pub struct TrayState {
    icon: Option<tauri::tray::TrayIcon>,
    needs_you: u32,
    /// e.g. `"5h 41% · wk 18%"`; `None` until the first statusline POST.
    usage: Option<String>,
}

impl TrayState {
    /// Rebuild and apply the tooltip from the current signals. `Workbench`, plus a
    /// needs-you clause and/or a usage clause when present.
    fn refresh(&self) {
        let Some(ref icon) = self.icon else { return };
        let mut tooltip = String::from("Workbench");
        if self.needs_you > 0 {
            tooltip.push_str(&format!(
                " · {} {} you",
                self.needs_you,
                if self.needs_you == 1 {
                    "agent needs"
                } else {
                    "agents need"
                }
            ));
        }
        if let Some(ref usage) = self.usage {
            tooltip.push_str(" · ");
            tooltip.push_str(usage);
        }
        let _ = icon.set_tooltip(Some(&tooltip));
    }
}

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
    app.manage(Mutex::new(TrayState {
        icon: tray,
        needs_you: 0,
        usage: None,
    }));
}

/// Fire an OS toast notification for one instance that just entered "needs
/// you". Called by the frontend on each fresh `→ needs_you` transition so the
/// user sees an alert even if Workbench is backgrounded.
#[tauri::command]
pub fn notify_needs_you(
    app: AppHandle,
    project_name: String,
    instance_title: String,
    task_note: Option<String>,
) -> Result<(), String> {
    let body = task_note
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "waiting for your input".to_string());
    let headline = if project_name.trim().is_empty() {
        format!("{} needs you", instance_title)
    } else {
        format!("{}.{} needs you", project_name, instance_title)
    };
    app.notification()
        .builder()
        .title(headline)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// Update the tray tooltip to reflect the current aggregate needs-you count.
/// Called by the frontend whenever the count changes (including back to 0).
#[tauri::command]
pub fn update_tray_badge(state: State<'_, Mutex<TrayState>>, count: u32) {
    let Ok(mut s) = state.lock() else { return };
    s.needs_you = count;
    s.refresh();
}

/// Update the tray tooltip's account-wide usage clause (step 3.2). Called by the
/// usage-limit engine on each fresh snapshot; either window may be `None` (absent or
/// not reported yet). A snapshot with no windows clears the clause.
#[tauri::command]
pub fn update_tray_usage(
    state: State<'_, Mutex<TrayState>>,
    five_hour_pct: Option<f64>,
    weekly_pct: Option<f64>,
) {
    let Ok(mut s) = state.lock() else { return };
    let mut parts = Vec::new();
    if let Some(p) = five_hour_pct {
        parts.push(format!("5h {}%", p.round() as i64));
    }
    if let Some(p) = weekly_pct {
        parts.push(format!("wk {}%", p.round() as i64));
    }
    s.usage = (!parts.is_empty()).then(|| parts.join(" · "));
    s.refresh();
}
