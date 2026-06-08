// Workbench backend entry point. The hook server, git, and transcript modules
// (see the directory skeleton) get wired in here in later steps. Phase 0 wired
// the PTY bridge (step 0.2); step 1.2 adds the SQLite registry (db + registry)
// and the prefs store.

mod db;
mod pty;
mod registry;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // Open the registry database under the OS app-data dir so it
            // survives restarts (design §4.6). Created on first launch.
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = db::Db::open(&dir.join("workbench.db"))?;
            app.manage(db);
            Ok(())
        })
        .manage(pty::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::default_working_dir,
            registry::create_group,
            registry::get_groups,
            registry::edit_group,
            registry::remove_group,
            registry::create_project,
            registry::get_projects,
            registry::edit_project,
            registry::remove_project,
            registry::create_instance,
            registry::get_instances,
            registry::get_instance_cmd,
            registry::edit_instance,
            registry::remove_instance,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
