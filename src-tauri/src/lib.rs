// Workbench backend entry point. The hook server and transcript modules (see the
// directory skeleton) get wired in here in later steps. Phase 0 wired the PTY
// bridge (step 0.2); step 1.2 added the SQLite registry (db + registry) and the
// prefs store; step 1.3 adds git inspection for project registration.

mod db;
mod fs;
mod git;
mod layout;
mod pty;
mod registry;
mod sys;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
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
            pty::session_instance,
            pty::default_working_dir,
            git::detect_repo,
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
            layout::get_layout,
            layout::set_layout,
            fs::read_dir,
            fs::read_file,
            fs::write_file,
            sys::open_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
