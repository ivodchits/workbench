// Suppress WebView2's built-in *reload* accelerators — F5, Ctrl+R, and
// Ctrl+Shift+R — so a stray keypress can't reload the renderer and silently drop
// every live console. A full-page reload resets the frontend state and restores the
// saved layout as dormant placeholders; `App.tsx` already blocks the matching
// context-menu "Reload" for exactly this reason, and this is the keyboard half.
//
// Why at the WebView2 controller level rather than a JS `keydown` + `preventDefault`
// in the keymap layer: reload is a *browser-accelerator key* the engine handles in
// its own accelerator path, before/outside DOM dispatch, so `preventDefault()`
// doesn't reliably reach it. The `AcceleratorKeyPressed` event is the supported
// interception point. We mark only the reload chords handled; DevTools accelerators
// (F12 / Ctrl+Shift+I) are deliberately left enabled for debugging.

/// Install the reload-key suppressor on `window`'s WebView2. No-op on failure (the
/// app still works; a stray reload just isn't blocked) and on non-Windows targets.
#[cfg(windows)]
pub fn block_reload_accelerators(window: &tauri::WebviewWindow) {
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2AcceleratorKeyPressedEventArgs, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
        COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL};

    // Virtual-key codes (winuser.h). VK_F5 = 0x74; 'R' shares its ASCII code 0x52.
    const VK_F5: u32 = 0x74;
    const VK_R: u32 = 0x52;

    let res = window.with_webview(|webview| unsafe {
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
                // High-order bit of GetKeyState is set while the key is held. Shift
                // state is irrelevant — Ctrl+R and Ctrl+Shift+R both mean reload.
                let ctrl = (GetKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
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
pub fn block_reload_accelerators(_window: &tauri::WebviewWindow) {}
