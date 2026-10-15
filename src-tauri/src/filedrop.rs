//! Paths of files dropped from the OS (step D2).
//!
//! Tauri's own drag-drop handling (`dragDropEnabled`) is off: on Windows it takes
//! over the window's drop target and with it the HTML5 drag and drop that dockview
//! docks panels with. So a file dragged in from Explorer reaches the page as an
//! HTML5 drop whose `File` objects carry no path.
//!
//! WebView2 can hand those `File` objects to the host: the page posts them with
//! `chrome.webview.postMessageWithAdditionalObjects`, and each arrives here as an
//! `ICoreWebView2File` whose `Path` is the real one. The paths go back to the page
//! as a [`DROP_EVENT`], tagged with the token the page sent, so the drop that
//! asked gets them.
//!
//! The message is a string holding `{"workbenchFileDrop": "<token>"}`; this
//! handler reads only messages of that shape. It has to be a string: wry's IPC
//! handler, registered first, fails on any other message, and a failing handler
//! keeps WebView2 from calling the ones after it. Tauri's IPC then reads the
//! string too, finds no command in it and logs that to the page's console.
//!
//! Other platforms have no such route yet: there a drop from the OS does nothing.

/// Frontend event carrying a drop's paths: `{ token, paths }`.
#[cfg(windows)]
pub const DROP_EVENT: &str = "file-drop-paths";

/// The token of a drop message, or `None` for any other message.
#[cfg_attr(not(windows), allow(dead_code))]
fn drop_token(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    Some(value.get("workbenchFileDrop")?.as_str()?.to_owned())
}

#[cfg(windows)]
#[derive(Clone, serde::Serialize)]
struct DropPaths {
    token: String,
    paths: Vec<String>,
}

/// A plugin that installs the handler on every webview as it is created — the
/// main window and the torn-off console windows alike.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("workbench-filedrop")
        .on_webview_ready(|webview| install(&webview))
        .build()
}

#[cfg(windows)]
fn install<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    use tauri::Emitter;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows::core::{Interface, PWSTR};

    let emitter = webview.clone();
    let res = webview.with_webview(move |platform| unsafe {
        let core = match platform.controller().CoreWebView2() {
            Ok(core) => core,
            Err(e) => {
                eprintln!("[filedrop] no CoreWebView2: {e}");
                return;
            }
        };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut text = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut text).is_err() {
                return Ok(());
            }
            let Some(token) = drop_token(&take_pwstr(text)) else {
                return Ok(());
            };
            let mut paths = Vec::new();
            if let Ok(args) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() {
                if let Ok(objects) = args.AdditionalObjects() {
                    let mut count = 0u32;
                    objects.Count(&mut count)?;
                    for i in 0..count {
                        let Ok(file) = objects
                            .GetValueAtIndex(i)
                            .and_then(|o| o.cast::<ICoreWebView2File>())
                        else {
                            continue;
                        };
                        let mut path = PWSTR::null();
                        if file.Path(&mut path).is_ok() {
                            let path = take_pwstr(path);
                            if !path.is_empty() {
                                paths.push(path);
                            }
                        }
                    }
                }
            }
            let _ = emitter.emit_to(emitter.label(), DROP_EVENT, DropPaths { token, paths });
            Ok(())
        }));
        let mut token = Default::default();
        if let Err(e) = core.add_WebMessageReceived(&handler, &mut token) {
            eprintln!("[filedrop] add_WebMessageReceived failed: {e}");
        }
    });
    if let Err(e) = res {
        eprintln!("[filedrop] with_webview failed: {e}");
    }
}

#[cfg(not(windows))]
fn install<R: tauri::Runtime>(_webview: &tauri::Webview<R>) {}

#[cfg(test)]
mod tests {
    use super::drop_token;

    #[test]
    fn reads_only_drop_messages() {
        assert_eq!(
            drop_token(r#"{"workbenchFileDrop":"abc"}"#).as_deref(),
            Some("abc")
        );
        assert_eq!(drop_token(r#""workbenchFileDrop""#), None);
        assert_eq!(drop_token(r#"{"cmd":"x"}"#), None);
        assert_eq!(drop_token("not json"), None);
    }
}
