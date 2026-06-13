// Workbench backend entry point. The hook server and transcript modules (see the
// directory skeleton) get wired in here in later steps. Phase 0 wired the PTY
// bridge (step 0.2); step 1.2 added the SQLite registry (db + registry) and the
// prefs store; step 1.3 adds git inspection for project registration.

mod accel;
mod attention;
mod db;
mod fs;
mod git;
mod hooks;
mod layout;
mod mcp;
mod pty;
mod registry;
mod skills;
mod statusline;
mod sys;
mod transcript;

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

            // Seed the account-wide usage meter from the last persisted snapshot so it
            // shows the most recent figures at launch instead of staying blank until a
            // session's statusline fires (step 3.2; the only source of fresh limits).
            statusline::restore(app.handle());

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
            // Start the transcript tailer (step 3.1): follow each live session's
            // JSONL and surface cumulative tokens on its card/console header. A
            // background thread; failures only degrade the token readout.
            transcript::init(app.handle());
            // Install the WebView2 accelerator handler on the main window: suppress
            // the built-in reload chords (F5 / Ctrl+R / Ctrl+Shift+R) so a stray
            // keypress can't reload the renderer and drop every live console, and
            // route Ctrl+Shift+R to the resume-last-session event (the engine eats
            // that chord before the DOM, so the keymap binding can't see it).
            // DevTools keys stay enabled.
            if let Some(win) = app.get_webview_window("main") {
                accel::install_accelerator_handler(&win);
            }
            Ok(())
        })
        .manage(pty::PtyManager::default())
        // Account-wide usage-limit snapshot, fed by the managed statusline (step 3.2).
        // Managed up front so the ingest route can write it before setup completes.
        .manage(statusline::LimitsState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::session_instance,
            pty::pty_session_live,
            pty::default_working_dir,
            hooks::hook_server_status,
            statusline::usage_limits,
            git::detect_repo,
            git::provision_worktree,
            git::run_worktree_setup,
            git::worktree_teardown_info,
            git::integrate_worktree,
            git::remove_worktree,
            git::instance_diff,
            git::instance_file_diff,
            git::git_log,
            git::git_branches,
            git::git_status_entries,
            git::git_stash_list,
            git::git_commit_files,
            git::git_commit_file_diff,
            git::git_checkout,
            git::git_create_branch,
            git::git_rename_branch,
            git::git_delete_branch,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_clean,
            git::git_stash_push,
            git::git_stash_pop,
            git::git_stash_drop,
            git::git_fetch,
            git::git_pull,
            git::git_push,
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
            mcp::mcp_list,
            mcp::mcp_add,
            mcp::mcp_remove,
            mcp::mcp_project_file,
            mcp::mcp_save_project_file,
            skills::skill_list,
            skills::skill_create,
            skills::skill_remove,
            fs::read_dir,
            fs::read_file,
            fs::write_file,
            fs::ensure_claude_md,
            sys::open_path,
            attention::notify_needs_you,
            attention::update_tray_badge,
            attention::update_tray_usage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
