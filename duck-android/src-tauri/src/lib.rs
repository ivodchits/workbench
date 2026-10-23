// Duck on the phone (assistant plan R4, H5): a Tauri app whose webview opens the
// desktop's own page (its Funnel address), with the `duck` plugin for what a page
// can't do: the assistant role, the tile, the widget, the mic with the screen off,
// the Keystore, and the `phone` host's tools. All of that is Kotlin
// (`gen/android/app/src/main/java/com/workbench/duck/`); this only registers it.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

fn duck<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("duck")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("com.workbench.duck", "DuckPlugin")?;
            Ok(())
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(duck())
        .run(tauri::generate_context!())
        .expect("error while running Duck");
}
