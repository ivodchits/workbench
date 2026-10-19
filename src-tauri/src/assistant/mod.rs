//! Duck's backend (track A). Step A1: the API key in the keychain ([`key`]), the
//! loopback proxy that is the only way to the API ([`proxy`]), the usage ledger
//! ([`usage`]) and the monthly budget ([`budget`]), over Duck's own database
//! ([`db`]). Step A2: conversation threads ([`threads`]), stored for the engine that
//! runs in the webview (`src/assistant/`).
//!
//! The webview never holds the key. It asks [`assistant_proxy_info`] for the proxy's
//! base URL and a per-launch token, and calls the API through the hook server with
//! that token. See `documentation/assistant-plan.md`, "Calling the API without
//! exposing the key".

mod budget;
mod db;
mod key;
mod proxy;
mod threads;
mod usage;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

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
