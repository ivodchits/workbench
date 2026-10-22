//! Tray dot for Duck's notifications.
//!
//! The tray shows no number: a red dot on the icon while Duck has anything unread,
//! the plain icon otherwise. The taskbar's numeric overlay is drawn and set from the
//! frontend (`src/state/duckBadge.ts`); this is only the tray half, which needs the
//! handle Rust owns.

use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

use crate::attention::TrayState;

/// `rgba` (w × h) with a red dot, ringed in white, in the bottom-right corner.
fn with_dot(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let side = w.min(h) as f32;
    let r = side * 0.24;
    let (cx, cy) = (w as f32 - r - side * 0.02, h as f32 - r - side * 0.02);
    let ring = (side * 0.04).max(1.0);
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            let px: [u8; 4] = if d <= r {
                [0xe5, 0x39, 0x35, 0xff]
            } else if d <= r + ring {
                [0xff, 0xff, 0xff, 0xff]
            } else {
                continue;
            };
            let i = ((y * w + x) * 4) as usize;
            out[i..i + 4].copy_from_slice(&px);
        }
    }
    out
}

fn apply(app: &AppHandle, state: &Mutex<TrayState>, dot: bool) {
    let Some(base) = app.default_window_icon() else { return };
    let icon = if dot {
        tauri::image::Image::new_owned(
            with_dot(base.rgba(), base.width(), base.height()),
            base.width(),
            base.height(),
        )
    } else {
        tauri::image::Image::new_owned(base.rgba().to_vec(), base.width(), base.height())
    };
    if let Ok(t) = state.lock() {
        t.set_icon(icon);
    }
}

/// Show (`count > 0`) or clear the red dot on the tray icon.
#[tauri::command]
pub fn set_tray_dot(app: AppHandle, state: State<'_, Mutex<TrayState>>, count: u32) {
    apply(&app, &state, count > 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_marks_only_the_corner() {
        let base = vec![0u8; 32 * 32 * 4];
        let out = with_dot(&base, 32, 32);
        let at = |x: u32, y: u32| &out[((y * 32 + x) * 4) as usize..][..4];
        assert_eq!(at(25, 25), [0xe5, 0x39, 0x35, 0xff]);
        assert_eq!(at(2, 2), [0, 0, 0, 0]);
    }
}
