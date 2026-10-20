//! Duck's backend (track A). Step A1: the API key in the keychain ([`key`]), the
//! loopback proxy that is the only way to the API ([`proxy`]), the usage ledger
//! ([`usage`]) and the monthly budget ([`budget`]), over Duck's own database
//! ([`db`]). Step A2: conversation threads ([`threads`]), stored for the engine that
//! runs in the webview (`src/assistant/`). Step T1: the trust engine's rules, modes,
//! kill switch and decision log ([`trust`]). Step D1: the worker sessions' workspace,
//! task folders, launch flags and task records ([`workspace`]).
//!
//! The webview never holds the key. It asks [`assistant_proxy_info`] for the proxy's
//! base URL and a per-launch token, and calls the API through the hook server with
//! that token. See `documentation/assistant-plan.md`, "Calling the API without
//! exposing the key".

mod budget;
mod db;
mod key;
mod proxy;
pub mod replay;
mod threads;
mod trust;
mod usage;
pub mod workspace;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

pub use budget::{Limits, Spend};
use db::DuckDb;
pub use threads::{Message, Pending, Thread};

/// Tauri-managed (as `Arc<Assistant>`): the proxy's shared state.
pub struct Assistant {
    app: AppHandle,
    db: DuckDb,
    /// The per-launch token the webview presents as its API key: 32 random bytes,
    /// hex. It is worthless outside this run of the app.
    token: String,
    client: reqwest::Client,
}

/// Open `duck.db` beside `workbench.db` and mint this launch's token. Runs before
/// the hook server starts, which mounts [`router`].
pub fn init(app: &AppHandle, data_dir: &std::path::Path) -> Result<(), String> {
    let db = DuckDb::open(&data_dir.join(db::FILE_NAME))
        .map_err(|e| format!("opening {}: {e}", db::FILE_NAME))?;
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("building the HTTP client: {e}"))?;
    app.manage(Arc::new(Assistant {
        app: app.clone(),
        db,
        token,
        client,
    }));
    Ok(())
}

/// The proxy routes, for the hook server to merge; `None` if [`init`] failed.
pub fn router(app: &AppHandle) -> Option<Router> {
    app.try_state::<Arc<Assistant>>()
        .map(|ctx| proxy::router(ctx.inner().clone()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyInfo {
    base_url: String,
    token: String,
}

/// Where the webview's SDK points: `{baseUrl, token}`.
#[tauri::command]
pub fn assistant_proxy_info(
    app: AppHandle,
    ctx: State<'_, Arc<Assistant>>,
) -> Result<ProxyInfo, String> {
    let port = crate::hooks::port(&app).ok_or("the local server isn't running")?;
    Ok(ProxyInfo {
        base_url: format!("http://127.0.0.1:{port}/anthropic"),
        token: ctx.token.clone(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    present: bool,
    /// The credential name, so the UI can show the `cmdkey` line to run.
    target: &'static str,
}

/// Whether a key is stored. Never returns the key.
#[tauri::command]
pub fn assistant_key_status() -> KeyStatus {
    KeyStatus {
        present: key::get().is_some(),
        target: key::TARGET,
    }
}

#[tauri::command]
pub fn assistant_key_set(key: String) -> Result<KeyStatus, String> {
    key::set(&key)?;
    Ok(assistant_key_status())
}

#[tauri::command]
pub fn assistant_key_clear() -> Result<KeyStatus, String> {
    key::clear()?;
    Ok(assistant_key_status())
}

/// Today / this month / by model and purpose, with the limits.
#[tauri::command]
pub fn assistant_spend(ctx: State<'_, Arc<Assistant>>) -> Result<Spend, String> {
    let limits = budget::limits(&ctx.db);
    let conn = ctx.db.conn.lock().expect("duck db lock poisoned");
    budget::spend(&conn, limits).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn assistant_budget_set(
    ctx: State<'_, Arc<Assistant>>,
    limits: Limits,
) -> Result<Limits, String> {
    budget::set_limits(&ctx.db, limits)
}

type Db<'a> = State<'a, Arc<Assistant>>;

fn lock(ctx: &Assistant) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
    ctx.db.conn.lock().expect("duck db lock poisoned")
}

#[tauri::command]
pub fn assistant_thread_create(ctx: Db<'_>, id: String, mode: String) -> Result<Thread, String> {
    threads::create(&lock(&ctx), &id, &mode, now_ms())
}

#[tauri::command]
pub fn assistant_thread_list(ctx: Db<'_>) -> Result<Vec<Thread>, String> {
    threads::list(&lock(&ctx))
}

#[tauri::command]
pub fn assistant_thread_messages(ctx: Db<'_>, thread_id: String) -> Result<Vec<Message>, String> {
    threads::messages(&lock(&ctx), &thread_id)
}

#[tauri::command]
pub fn assistant_thread_title(ctx: Db<'_>, thread_id: String, title: String) -> Result<(), String> {
    threads::set_title(&lock(&ctx), &thread_id, &title)
}

/// Append one message; `message.seq` must be the thread's next (append-only).
#[tauri::command]
pub fn assistant_message_append(ctx: Db<'_>, message: Message) -> Result<(), String> {
    threads::append(&mut lock(&ctx), &message)
}

/// Write (or rewrite) a tool batch waiting on a confirmation.
#[tauri::command]
pub fn assistant_pending_put(
    ctx: Db<'_>,
    id: String,
    thread_id: String,
    data: Value,
) -> Result<(), String> {
    threads::pending_put(&lock(&ctx), &id, &thread_id, &data, now_ms())
}

#[tauri::command]
pub fn assistant_pending_list(ctx: Db<'_>) -> Result<Vec<Pending>, String> {
    threads::pending_list(&lock(&ctx))
}

#[tauri::command]
pub fn assistant_pending_clear(ctx: Db<'_>, id: String) -> Result<(), String> {
    threads::pending_clear(&lock(&ctx), &id)
}

/// Delete a thread, its messages and its parked batches (step A4).
#[tauri::command]
pub fn assistant_thread_delete(ctx: Db<'_>, thread_id: String) -> Result<(), String> {
    threads::delete(&mut lock(&ctx), &thread_id)
}

// ── trust (step T1) ─────────────────────────────────────────────────────────

/// Whether Duck's trust is paused (the kill switch), for the tray at startup.
pub fn trust_paused(app: &AppHandle) -> bool {
    app.try_state::<Arc<Assistant>>()
        .is_some_and(|ctx| trust::paused(&ctx.db))
}

/// Flip the kill switch from anywhere (the drawer, the palette, the tray): store
/// it, tick the tray item, and tell the webview.
pub fn set_trust_paused(app: &AppHandle, paused: bool) -> Result<bool, String> {
    let ctx = app
        .try_state::<Arc<Assistant>>()
        .ok_or("Duck's database isn't open")?;
    trust::set_paused_flag(&ctx.db, paused)?;
    crate::attention::set_trust_check(app, paused);
    let _ = app.emit("assistant-trust-paused", paused);
    Ok(paused)
}

#[tauri::command]
pub fn assistant_trust_load(ctx: Db<'_>) -> Result<trust::TrustState, String> {
    trust::load(&lock(&ctx))
}

/// Write the starter rules if they never were; returns the state either way.
#[tauri::command]
pub fn assistant_trust_seed(ctx: Db<'_>, rules: Vec<trust::Rule>) -> Result<trust::TrustState, String> {
    trust::seed(&mut lock(&ctx), &rules)
}

#[tauri::command]
pub fn assistant_trust_pause(app: AppHandle, paused: bool) -> Result<bool, String> {
    set_trust_paused(&app, paused)
}

#[tauri::command]
pub fn assistant_rule_add(ctx: Db<'_>, rule: trust::Rule) -> Result<(), String> {
    trust::add_rule(&lock(&ctx), &rule)
}

#[tauri::command]
pub fn assistant_rule_remove(ctx: Db<'_>, id: String) -> Result<(), String> {
    trust::remove_rule(&lock(&ctx), &id)
}

#[tauri::command]
pub fn assistant_trust_mode_set(
    ctx: Db<'_>,
    project_id: String,
    mode: Option<String>,
) -> Result<(), String> {
    trust::set_mode(&lock(&ctx), &project_id, mode.as_deref())
}

/// Turn a floor entry off or back on; returns the entries now off.
#[tauri::command]
pub fn assistant_floor_set(ctx: Db<'_>, id: String, enabled: bool) -> Result<Vec<String>, String> {
    trust::set_floor(&lock(&ctx), &id, enabled)
}

#[tauri::command]
pub fn assistant_decision_add(ctx: Db<'_>, decision: trust::Decision) -> Result<i64, String> {
    trust::add_decision(&lock(&ctx), &decision)
}

/// A session's mandate (step T2): the request Duck started it for, as JSON
/// `{text, threadId}`. In `meta` under the instance id; `None` removes it.
#[tauri::command]
pub fn assistant_mandate_set(ctx: Db<'_>, instance_id: String, mandate: Option<String>) -> Result<(), String> {
    trust::set_mandate(&lock(&ctx), &instance_id, mandate.as_deref())
}

#[tauri::command]
pub fn assistant_mandate_get(ctx: Db<'_>, instance_id: String) -> Result<Option<String>, String> {
    trust::mandate(&lock(&ctx), &instance_id)
}

// ── worker sessions (step D1) ──

/// Make Duck's workspace (`dir`, else the default) and return its path.
#[tauri::command]
pub fn assistant_workspace_prepare(dir: Option<String>) -> Result<String, String> {
    let d = workspace::resolve(dir.as_deref())?;
    workspace::prepare(&d)?;
    Ok(d.to_string_lossy().into_owned())
}

/// A new task folder in the workspace, with its brief; returns the folder.
#[tauri::command]
pub fn assistant_task_folder(workspace: String, date: String, title: String, brief: String) -> Result<String, String> {
    let d = workspace::resolve(Some(&workspace))?;
    Ok(workspace::new_task(&d, &date, &title, &brief)?.to_string_lossy().into_owned())
}

/// A task's result files.
#[tauri::command]
pub fn assistant_task_result(workspace: String, folder: String) -> Result<workspace::TaskResult, String> {
    workspace::result(&workspace::resolve(Some(&workspace))?, &folder)
}

/// Register a new instance as a worker, before its first launch.
#[tauri::command]
pub fn assistant_worker_register(
    app: AppHandle,
    db: State<'_, crate::db::Db>,
    instance_id: String,
    spec: workspace::WorkerSpec,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|_| "database lock poisoned")?;
    workspace::register(&app, &conn, &instance_id, &spec)
}

#[tauri::command]
pub fn assistant_task_put(ctx: Db<'_>, id: String, data: String) -> Result<(), String> {
    workspace::put_task(&lock(&ctx), &id, &data, now_ms())
}

/// The latest task records, newest first.
#[tauri::command]
pub fn assistant_task_list(ctx: Db<'_>, limit: u32) -> Result<Vec<String>, String> {
    workspace::list_tasks(&lock(&ctx), limit.clamp(1, 500))
}

/// The past `days`' Claude Code tool calls for the trust replay (step T2), at most
/// `max`, newest kept. Read off the transcripts on a worker thread.
#[tauri::command]
pub async fn assistant_replay_calls(days: u32, max: usize) -> Result<Vec<replay::ReplayCall>, String> {
    let dir = crate::transcript::claude_projects_dir().ok_or("no home folder")?;
    tauri::async_runtime::spawn_blocking(move || replay::scan(&dir, days.clamp(1, 31), max.clamp(1, 20_000)))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn assistant_decisions(
    ctx: Db<'_>,
    before: Option<i64>,
    limit: u32,
) -> Result<Vec<trust::Decision>, String> {
    trust::decisions(&lock(&ctx), before, limit)
}
