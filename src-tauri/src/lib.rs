// Workbench backend entry point. The hook server and transcript modules (see the
// directory skeleton) get wired in here in later steps. Phase 0 wired the PTY
// bridge (step 0.2); step 1.2 added the SQLite registry (db + registry) and the
// prefs store; step 1.3 adds git inspection for project registration.

mod accel;
mod assistant;
mod filedrop;
mod attention;
mod db;
mod fs;
mod git;
mod gitqueue;
mod hooks;
mod layout;
mod mcp;
mod notes;
mod plugins;
mod pty;
mod registry;
mod remote;
mod skills;
mod statusline;
mod sys;
mod transcript;
mod window;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // "Start Workbench at login, minimized to tray" (step A3): the login entry
        // passes the flag `window::build_main` hides the main window for.
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args([window::MINIMIZED_ARG])
                .build(),
        )
        // Paths of files dropped in from the OS (step D2).
        .plugin(filedrop::plugin())
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
            // Which notes folder each project uses (step N3), before anything
            // reads a note.
            if let Ok(conn) = db.conn.lock() {
                notes::refresh_keys(&conn);
            }
            app.manage(db);
            // Duck's own database and API proxy state (step A1). Before the hook
            // server, which mounts the proxy; a failure only leaves Duck without the
            // API.
            if let Err(e) = assistant::init(app.handle(), &dir) {
                eprintln!("[assistant] init failed: {e}");
            }

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
            // Start the remote access subsystem (step 4.3, design §11): an
            // authenticated API + WebSocket server on the tailnet, off by default and
            // auto-started only if previously enabled. Never fails the app — a bind
            // failure just leaves remote access off until re-enabled.
            remote::init(app.handle());
            // Set up the system tray icon (step 2.3). Failures are logged;
            // the tray badge commands degrade gracefully when unavailable.
            attention::setup_tray(app.handle());
            // Start the transcript tailer (step 3.1): follow each live session's
            // JSONL and surface cumulative tokens on its card/console header. A
            // background thread; failures only degrade the token readout.
            transcript::init(app.handle());
            // Watch the notes folders for plugin files changing (step K1), so the
            // project toolbar redraws however the file was saved.
            plugins::init_watcher(app.handle());
            if let Err(e) = plugins::draft::ensure_skill(app.handle()) {
                eprintln!("[plugins] drafting skill not written: {e}");
            }
            // Notes sync (step N3): pull now and commit after changes, when it's
            // set up; otherwise just link the projects whose notes are obvious.
            notes::sync::init(app.handle());
            // Install the WebView2 accelerator handler on the main window: suppress
            // the built-in reload chords (F5 / Ctrl+R / Ctrl+Shift+R) so a stray
            // keypress can't reload the renderer and drop every live console, and
            // route Ctrl+Shift+R to the resume-last-session event (the engine eats
            // that chord before the DOM, so the keymap binding can't see it).
            // DevTools keys stay enabled.
            // The main window is built here, not from the config (`create: false`),
            // so it gets the shared WebView2 profile (step A2, `window.rs`). Last, so
            // everything its page calls into is already managed.
            window::build_main(app.handle())?;
            if let Some(win) = app.get_webview_window("main") {
                accel::install_accelerator_handler(&win);
            }
            Ok(())
        })
        .manage(pty::PtyManager::default())
        // Account-wide usage-limit snapshot, fed by the managed statusline (step 3.2).
        // Managed up front so the ingest route can write it before setup completes.
        .manage(statusline::LimitsState::default())
        // Per-instance transcript follows (step T1); empty until a view asks for one.
        .manage(transcript::stream::Streams::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::claude_permission_modes,
            pty::pty_subscribe,
            pty::pty_unsubscribe,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::session_instance,
            pty::pty_session_live,
            pty::default_working_dir,
            pty::remote_cmd_spawn,
            hooks::hook_server_status,
            hooks::hook_permission_hold,
            hooks::hook_permission_answer,
            assistant::assistant_proxy_info,
            assistant::assistant_key_status,
            assistant::assistant_key_set,
            assistant::assistant_key_clear,
            assistant::assistant_spend,
            assistant::assistant_budget_set,
            assistant::assistant_thread_create,
            assistant::assistant_thread_list,
            assistant::assistant_thread_messages,
            assistant::assistant_thread_title,
            assistant::assistant_thread_delete,
            assistant::assistant_message_append,
            assistant::assistant_pending_put,
            assistant::assistant_pending_list,
            assistant::assistant_pending_clear,
            assistant::assistant_trust_load,
            assistant::assistant_trust_seed,
            assistant::assistant_trust_pause,
            assistant::assistant_rule_add,
            assistant::assistant_rule_remove,
            assistant::assistant_trust_mode_set,
            assistant::assistant_floor_set,
            assistant::assistant_decision_add,
            assistant::assistant_decisions,
            assistant::assistant_mandate_set,
            assistant::assistant_mandate_get,
            assistant::assistant_summary_set,
            assistant::assistant_summary_get,
            assistant::assistant_replay_calls,
            assistant::assistant_workspace_prepare,
            assistant::assistant_task_folder,
            assistant::assistant_task_result,
            assistant::assistant_worker_register,
            assistant::assistant_task_put,
            assistant::assistant_task_list,
            window::window_open_torn,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_status,
            remote::remote_new_pairing_code,
            remote::remote_push_snapshot,
            remote::remote_devices_list,
            remote::remote_approve_device,
            remote::remote_revoke_device,
            remote::remote_auth_log,
            remote::remote_clear_auth_log,
            remote::remote_set_public,
            remote::remote_qr_svg,
            remote::push::remote_push_send,
            remote::push::remote_push_count,
            statusline::usage_limits,
            git::detect_repo,
            git::provision_worktree,
            git::run_worktree_setup,
            git::worktree_teardown_info,
            git::integrate_worktree,
            git::remove_worktree,
            git::instance_diff,
            git::instance_file_diff,
            git::instance_file_versions,
            notes::notes_list,
            notes::notes_read,
            notes::notes_write,
            notes::notes_create,
            notes::notes_create_with,
            notes::notes_rename,
            notes::notes_delete,
            notes::link::notes_link_status,
            notes::link::notes_link,
            notes::link::notes_start_new,
            notes::sync::notes_sync_status,
            notes::sync::notes_sync_create,
            notes::sync::notes_sync_join,
            notes::sync::notes_sync_disable,
            notes::sync::notes_sync_now,
            notes::sync::notes_sync_focus,
            plugins::plugins_read,
            plugins::plugins_write,
            plugins::plugins_init,
            plugins::plugins_text,
            plugins::plugins_check,
            plugins::plugins_remove,
            plugins::plugins_preview,
            plugins::plugins_script_read,
            plugins::plugins_script_write,
            plugins::draft::plugins_draft_start,
            plugins::draft::plugins_draft_read,
            plugins::draft::plugins_draft_clear,
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
            git::git_stash_apply,
            git::git_stash_show,
            git::git_stash_branch,
            git::git_ignore_add,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_commit,
            git::git_head_commit,
            git::git_merge,
            git::git_merge_abort,
            git::git_rebase,
            git::git_rebase_control,
            git::git_set_upstream,
            git::git_delete_remote_branch,
            git::git_repo_state,
            git::git_file_diff,
            git::git_apply_patch,
            git::git_resolve,
            git::git_commit_detail,
            git::git_file_history,
            git::git_range_files,
            git::git_range_file_diff,
            git::git_tags,
            git::git_tag_create,
            git::git_tag_delete,
            git::git_revert,
            git::git_cherry_pick,
            git::git_sequencer_control,
            git::git_reset,
            git::git_watch_start,
            git::git_watch_stop,
            git::git_cancel,
            git::git_command_log,
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
            transcript::list_project_sessions,
            transcript::stream::transcript_follow,
            transcript::stream::transcript_unfollow,
            transcript::stream::transcript_read,
            transcript::stream::transcript_read_back,
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
            sys::reveal_path,
            sys::open_scratchpad,
            sys::open_url,
            sys::pasted::pasted_image_dir,
            sys::pasted::save_pasted_image,
            sys::pasted::delete_pasted_images,
            sys::pasted::prune_pasted_images,
            attention::notify_needs_you,
            attention::notify_alert,
            attention::update_tray_badge,
            attention::update_tray_usage,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                hooks::uninstall_dev(app);
            }
        });
}
