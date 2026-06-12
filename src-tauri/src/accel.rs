// WebView2 accelerator-key overrides. Two jobs, both rooted in the same fact —
// some `Ctrl+…` chords are *browser-accelerator keys* the WebView2 engine handles
// in its own accelerator path, **before/outside DOM dispatch**, so a JS `keydown`
// + `preventDefault()` in the keymap layer can't reach them. `AcceleratorKeyPressed`
// is the supported interception point:
//
//  1. **Suppress reload** — F5, Ctrl+R, Ctrl+Shift+R would reload the renderer,
//     resetting frontend state and restoring the saved layout as dormant
//     placeholders (silently dropping every live console). `App.tsx` already blocks
//     the matching context-menu "Reload"; this is the keyboard half.
//  2. **Route `Ctrl+Shift+R` → resume** — because the engine eats that chord here
//     (marking it Handled cancels the reload but does *not* re-dispatch it to the
//     page), the keymap's `Ctrl+Shift+R` binding never fires from a DOM event. So we
//     emit a `resume-last-session` event straight from this handler; the frontend
//     listens and runs the same command the keymap would have. (This is why the
//     binding looked dead: every other `Ctrl+Shift+*` reaches the DOM, but this one
//     is consumed by the accelerator path.)
//
// DevTools accelerators (F12 / Ctrl+Shift+I) are deliberately left enabled.

/// Frontend event emitted when `Ctrl+Shift+R` is pressed (the resume shortcut). See
/// `useGlobalKeys` for the listener that turns it into the `resumeLastSession`
/// command.
#[cfg(windows)]
pub const RESUME_EVENT: &str = "resume-last-session";

/// Install the accelerator-key handler on `window`'s WebView2: suppress the reload
/// chords and route `Ctrl+Shift+R` to the resume event. No-op on failure (the app
/// still works; a stray reload just isn't blocked) and on non-Windows targets.
#[cfg(windows)]
pub fn install_accelerator_handler(window: &tauri::WebviewWindow) {
    use tauri::Emitter;
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2AcceleratorKeyPressedEventArgs, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
        COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_SHIFT};

    // Virtual-key codes (winuser.h). VK_F5 = 0x74; 'R' shares its ASCII code 0x52.
    const VK_F5: u32 = 0x74;
    const VK_R: u32 = 0x52;

    // Emitter for the resume event — cloned into the 'static accelerator handler.
    let emitter = window.clone();

    let res = window.with_webview(move |webview| unsafe {
        let controller = webview.controller();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
            move |_controller, args| {
                let Some(args): Option<ICoreWebView2AcceleratorKeyPressedEventArgs> = args else {
                    return Ok(());
                };
                // Only react to key-down (incl. system key-down for Alt-combos);
                // ignore the matching key-up so we don't double-handle.
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                args.KeyEventKind(&mut kind)?;
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                    && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
                {
                    return Ok(());
                }
                let mut vk: u32 = 0;
                args.VirtualKey(&mut vk)?;
                // High-order bit of GetKeyState is set while the key is held.
                let ctrl = (GetKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
                let shift = (GetKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0;

                // Ctrl+Shift+R: fire the resume shortcut *and* suppress the (hard-)
                // reload it would otherwise trigger. Skip auto-repeat (key held down)
                // so one press is one resume, not a relaunch storm.
                if ctrl && shift && vk == VK_R {
                    let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                    args.PhysicalKeyStatus(&mut status)?;
                    if !status.WasKeyDown.as_bool() {
                        let _ = emitter.emit(RESUME_EVENT, ());
                    }
                    args.SetHandled(true)?;
                    return Ok(());
                }

                // Plain reload accelerators: F5 and Ctrl+R (no Shift).
                if vk == VK_F5 || (ctrl && vk == VK_R) {
                    args.SetHandled(true)?;
                }
                Ok(())
            },
        ));
        let mut token = Default::default();
        if let Err(e) = controller.add_AcceleratorKeyPressed(&handler, &mut token) {
            eprintln!("[accel] add_AcceleratorKeyPressed failed: {e}");
        }
    });
    if let Err(e) = res {
        eprintln!("[accel] with_webview failed: {e}");
    }
}

#[cfg(not(windows))]
pub fn install_accelerator_handler(_window: &tauri::WebviewWindow) {}
