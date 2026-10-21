//! The listening sign (2026-10-21): while voice input is on (push-to-talk now, the
//! conversation mode later), Duck's icon with sound waves shows on top of
//! everything, in the main screen's top-right corner.
//!
//! - A small window of its own: transparent, undecorated, always on top, out of the
//!   taskbar, never focused and click-through. It loads the app's page with
//!   `?overlay=voice`, which draws the icon and its waves in the theme's accent
//!   (`src/panels/Assistant/VoiceOverlay.tsx`).
//! - Made hidden at start ([`build`]): building a window later, from the
//!   shortcut's handler, could deadlock. Shown without taking focus
//!   (`SW_SHOWNOACTIVATE`), so what you type keeps going where it was going, and
//!   hidden the same way (`SW_HIDE`): Tauri never learns it was shown, so its own
//!   `hide` would do nothing.
//! - Placed on each show, so it follows a change of the main screen.

use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "voice-overlay";
/// The window's size, logical pixels, and its gap from the screen's edges.
const WIDTH: f64 = 176.0;
const HEIGHT: f64 = 64.0;
const MARGIN: f64 = 14.0;

/// Make the window, hidden. Called once at start.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?overlay=voice".into()))
        .title("Duck is listening")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false);
    let win = crate::window::profile(app, builder).build()?;
    let _ = win.set_ignore_cursor_events(true);
    Ok(())
}

/// Show it (in the main screen's top-right corner) or hide it.
pub fn set(app: &AppHandle, on: bool) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    if !on {
        show_window(&win, false);
        return;
    }
    if let Ok(Some(m)) = app.primary_monitor() {
        let scale = m.scale_factor();
        let (pos, size) = (m.position(), m.size());
        let _ = win.set_size(LogicalSize::new(WIDTH, HEIGHT));
        let x = pos.x + size.width as i32 - ((WIDTH + MARGIN) * scale).round() as i32;
        let y = pos.y + (MARGIN * scale).round() as i32;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    show_window(&win, true);
}

/// Shown (topmost as built, without taking focus) or hidden, by the window's
/// handle, both ways, so the two always match.
#[cfg(windows)]
fn show_window(win: &tauri::WebviewWindow, on: bool) {
    #[link(name = "user32")]
    extern "system" {
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    }
    const SW_HIDE: i32 = 0;
    const SW_SHOWNOACTIVATE: i32 = 4;
    match win.hwnd() {
        // SAFETY: the window's own handle.
        Ok(h) => unsafe {
            ShowWindow(h.0 as isize, if on { SW_SHOWNOACTIVATE } else { SW_HIDE });
        },
        Err(_) => {
            let _ = if on { win.show() } else { win.hide() };
        }
    }
}

#[cfg(not(windows))]
fn show_window(win: &tauri::WebviewWindow, on: bool) {
    let _ = if on { win.show() } else { win.hide() };
}
