// Workbench backend entry point. The PTY supervisor, hook server, registry, db,
// git, and transcript modules (see the directory skeleton) get wired in here in
// later steps. Phase 0 just boots the Tauri shell.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
