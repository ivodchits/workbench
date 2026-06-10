// Workbench backend entry point. The hook server and transcript modules (see the
// directory skeleton) get wired in here in later steps. Phase 0 wired the PTY
// bridge (step 0.2); step 1.2 added the SQLite registry (db + registry) and the
// prefs store; step 1.3 adds git inspection for project registration.

mod attention;
mod db;
mod fs;
mod git;
mod hooks;
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
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Open the registry database under the OS app-data dir so it
            // survives restarts (design §4.6). Created on first launch.
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            // A debug build (`tauri dev`) uses a separate database file so it can
            // run alongside an installed release without sharing the registry,
            // layouts, or persisted hook port. The frontend isolates `prefs.json`
            // the same way via `import.meta.env.DEV`; the hook bridge isolates its
            // settings.json entry + port range via `cfg!(debug_assertions)`.
            let db_name = if cfg!(debug_assertions) {
                "workbench.dev.db"
            } else {
                "workbench.db"
            };
            let db = db::Db::open(&dir.join(db_name))?;
            app.manage(db);

            // Start the Phase-2 hook bridge: a local endpoint that receives Claude
            // Code's hooks and filters them by session id (design §4.4, decision
            // 10). A failure here must not stop the app — it only degrades the
            // status engine — so we log and continue.
            if let Err(e) = hooks::init(app.handle()) {
                eprintln!("[hooks] init failed: {e}");
            }
            // Set up the system tray icon (step 2.3). Failures are logged;
            // the tray badge commands degrade gracefully when unavailable.
            attention::setup_tray(app.handle());
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
            hooks::hook_server_status,
            git::detect_repo,
            git::provision_worktree,
            git::run_worktree_setup,
            git::worktree_teardown_info,
            git::integrate_worktree,
            git::remove_worktree,
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
            registry::mirror_instance_task_note,
            registry::remove_instance,
            layout::get_layout,
            layout::set_layout,
            fs::read_dir,
            fs::read_file,
            fs::write_file,
            sys::open_path,
            attention::notify_needs_you,
            attention::update_tray_badge,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
