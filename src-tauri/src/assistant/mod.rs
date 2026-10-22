//! Duck's backend (track A). Step A1: the API key in the keychain ([`key`]), the
//! loopback proxy that is the only way to the API ([`proxy`]), the usage ledger
//! ([`usage`]) and the monthly budget ([`budget`]), over Duck's own database
//! ([`db`]). Step A2: conversation threads ([`threads`]), stored for the engine that
//! runs in the webview (`src/assistant/`). Step T1: the trust engine's rules, modes,
//! kill switch and decision log ([`trust`]). Step D1: the worker sessions' workspace,
//! task folders, launch flags and task records ([`workspace`]). Step D4: headless
//! workers over stream-json ([`headless`]). Step P1: plan autopilot records
//! ([`autopilot`]). Step X1: a client for external MCP servers ([`mcp_client`]).
//! Step M3: the subscription brain ([`subscription_brain`]) and the MCP server
//! that serves it Duck's tools ([`mcp_server`]). Step L1: long-term memory, its
//! index and its commits ([`memory`]); step L2 its consolidation and recall log.
//! Step L3: Duck's prompts as files, and each thread's pin on them ([`config`]).
//! Step S2: Duck's skills, `skills/*/SKILL.md` in its workspace ([`skills`]).
//! The morning routine: Google access ([`google`]) and the invoice sheet ([`sheets`]).
//!
//! The webview never holds the key. It asks [`assistant_proxy_info`] for the proxy's
//! base URL and a per-launch token, and calls the API through the hook server with
//! that token. See `documentation/assistant-plan.md`, "Calling the API without
//! exposing the key".

mod autopilot;
mod budget;
pub mod config;
mod db;
pub mod gitlane;
pub mod google;
pub mod headless;
mod key;
pub mod mcp_client;
mod mcp_server;
pub mod memory;
mod proxy;
mod routines;
pub mod skills;
mod summaries;
pub mod replay;
pub mod sheets;
pub mod subscription_brain;
mod threads;
mod timings;
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
pub use key::google_tts as google_tts_key;
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
    app.manage(mcp_client::McpSessions::default());
    app.manage(google::GoogleAuth::default());
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
    // The subscription brain's MCP server (step M3) shares it.
    app.try_state::<Arc<Assistant>>()
        .map(|ctx| proxy::router(ctx.inner().clone()).merge(mcp_server::router(app.clone())))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Step V2: the ledger's model name for Google Chirp 3 HD speech; `in` counts
/// characters, at no cost (the free 1M a month is never passed).
pub const CHIRP_MODEL: &str = "chirp-3-hd";

/// Characters sent to Chirp this calendar month.
pub fn chirp_chars_this_month(app: &AppHandle) -> u64 {
    let Some(ctx) = app.try_state::<Arc<Assistant>>() else { return 0 };
    let conn = lock(&ctx);
    let n = conn.query_row(
        &format!(
            r#"SELECT COALESCE(SUM("in"), 0) FROM assistant_usage WHERE model = ?1 AND ts >= {}"#,
            budget::MONTH_START
        ),
        [CHIRP_MODEL],
        |r| r.get::<_, i64>(0),
    );
    n.map(|n| n.max(0) as u64).unwrap_or(0)
}

/// Record one Chirp call of `chars` characters.
pub fn record_chirp(app: &AppHandle, chars: u64) {
    let Some(ctx) = app.try_state::<Arc<Assistant>>() else { return };
    let record = usage::Record {
        ts: now_ms(),
        model: CHIRP_MODEL.into(),
        purpose: "tts".into(),
        usage: usage::Usage { input: chars, ..Default::default() },
        cost_usd: 0.0,
    };
    let saved = usage::insert(&lock(&ctx), &record);
    if let Err(e) = saved {
        eprintln!("duck: recording a chirp call failed: {e}");
    }
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

/// Keep a thread from the clean-up of idle threads (step L4), or stop keeping it.
#[tauri::command]
pub fn assistant_thread_keep(ctx: Db<'_>, thread_id: String, keep: bool) -> Result<(), String> {
    threads::set_keep(&lock(&ctx), &thread_id, keep)
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

/// A session's last summary (step W3), as stored JSON `{summary, at, made}`;
/// `None` removes it.
#[tauri::command]
pub fn assistant_summary_set(ctx: Db<'_>, instance_id: String, summary: Option<String>) -> Result<(), String> {
    summaries::set(&lock(&ctx), &instance_id, summary.as_deref())
}

#[tauri::command]
pub fn assistant_summary_get(ctx: Db<'_>, instance_id: String) -> Result<Option<String>, String> {
    summaries::get(&lock(&ctx), &instance_id)
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

/// Write a task's result files (the API worker's, step D2).
#[tauri::command]
pub fn assistant_task_write_result(workspace: String, folder: String, md: String, json: String) -> Result<(), String> {
    workspace::write_result(&workspace::resolve(Some(&workspace))?, &folder, &md, &json)
}

/// Duck's core memory (step W4): `memory/core.md`'s path in the workspace and its
/// text (`None`: no file yet).
#[tauri::command]
pub fn assistant_core_read(workspace: Option<String>) -> Result<(String, Option<String>), String> {
    let d = workspace::resolve(workspace.as_deref())?;
    Ok((workspace::core_path(&d).to_string_lossy().into_owned(), workspace::read_core(&d)?))
}

/// Write the core memory over the text it was read as (`expected`), and commit it
/// (step L1) with `message` (`memory: …`).
#[tauri::command]
pub fn assistant_core_write(
    workspace: Option<String>,
    text: String,
    expected: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    let d = workspace::resolve(workspace.as_deref())?;
    workspace::write_core(&d, &text, expected.as_deref())?;
    let msg = message.unwrap_or_else(|| "memory: core memory edited".into());
    memory::commit(&d, vec!["memory/core.md".into()], msg);
    Ok(())
}

// ── long-term memory (step L1) ──

/// The workspace, and the notes root (indexed read-only) when there is one.
fn memory_roots(
    app: &AppHandle,
    workspace: Option<&str>,
) -> Result<(std::path::PathBuf, Option<std::path::PathBuf>), String> {
    Ok((workspace::resolve(workspace)?, crate::notes::notes_root(app).ok()))
}

/// Run file and index work off the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Duck changed these memory files: index them now and commit them.
fn memory_changed(ctx: &Assistant, ws: &std::path::Path, files: Vec<String>, message: String) {
    if let Err(e) = memory::reindex(&lock(ctx), ws, &files) {
        eprintln!("duck: reindexing memory failed: {e}");
    }
    memory::commit(ws, files, message);
}

/// The best `k` memory entries and note pieces for `query`.
#[tauri::command]
pub async fn assistant_memory_search(
    app: AppHandle,
    ctx: Db<'_>,
    workspace: Option<String>,
    query: String,
    k: usize,
) -> Result<Vec<memory::Hit>, String> {
    let ctx = ctx.inner().clone();
    blocking(move || {
        let (ws, notes) = memory_roots(&app, workspace.as_deref())?;
        let conn = lock(&ctx);
        memory::ensure(&conn, &ws, notes.as_deref())?;
        memory::search(&conn, &ws, notes.as_deref(), &query, k.min(20))
    })
    .await
}

/// Remember an entry under `topic`; secrets are refused.
#[tauri::command]
pub async fn assistant_memory_write(
    ctx: Db<'_>,
    workspace: Option<String>,
    topic: String,
    entry: memory::NewEntry,
) -> Result<memory::Written, String> {
    let ctx = ctx.inner().clone();
    blocking(move || {
        let ws = workspace::resolve(workspace.as_deref())?;
        let w = memory::write(&ws, &topic, &entry)?;
        if let Some(e) = &w.edit {
            memory_changed(&ctx, &ws, vec![e.file.clone()], memory::subject("", &entry.fact));
        }
        Ok(w)
    })
    .await
}

/// The memory entries holding every word of `query` (what a forget would take).
#[tauri::command]
pub async fn assistant_memory_matching(
    app: AppHandle,
    ctx: Db<'_>,
    workspace: Option<String>,
    query: String,
) -> Result<Vec<memory::Entry>, String> {
    let ctx = ctx.inner().clone();
    blocking(move || {
        let (ws, notes) = memory_roots(&app, workspace.as_deref())?;
        let conn = lock(&ctx);
        memory::ensure(&conn, &ws, notes.as_deref())?;
        memory::matching(&conn, &ws, &query)
    })
    .await
}

/// Remove these entries from their files, as one commit (`message`).
#[tauri::command]
pub async fn assistant_memory_forget(
    ctx: Db<'_>,
    workspace: Option<String>,
    entries: Vec<memory::Forget>,
    message: String,
) -> Result<Vec<memory::FileEdit>, String> {
    let ctx = ctx.inner().clone();
    blocking(move || {
        let ws = workspace::resolve(workspace.as_deref())?;
        let edits = memory::forget(&ws, &entries)?;
        if !edits.is_empty() {
            memory_changed(&ctx, &ws, edits.iter().map(|e| e.file.clone()).collect(), message);
        }
        Ok(edits)
    })
    .await
}

/// Put a memory file back (an undo): only over `expected`; `text: None` removes it.
#[tauri::command]
pub async fn assistant_memory_restore(
    ctx: Db<'_>,
    workspace: Option<String>,
    file: String,
    text: Option<String>,
    expected: Option<String>,
    message: String,
) -> Result<(), String> {
    let ctx = ctx.inner().clone();
    blocking(move || {
        let ws = workspace::resolve(workspace.as_deref())?;
        memory::restore(&ws, &file, text.as_deref(), expected.as_deref())?;
        memory_changed(&ctx, &ws, vec![file.replace('\\', "/")], message);
        Ok(())
    })
    .await
}

/// Make one consolidation's changes (step L2) and commit them as one (`message`).
#[tauri::command]
pub async fn assistant_memory_apply(
    ctx: Db<'_>,
    workspace: Option<String>,
    plan: memory::Apply,
    message: String,
) -> Result<memory::Applied, String> {
    let ctx = ctx.inner().clone();
    blocking(move || {
        let ws = workspace::resolve(workspace.as_deref())?;
        let done = memory::apply(&ws, &plan)?;
        if !done.edits.is_empty() {
            memory_changed(&ctx, &ws, done.edits.iter().map(|e| e.file.clone()).collect(), message);
        }
        Ok(done)
    })
    .await
}

/// The consolidation's own state (step L2), as JSON in `meta`: its last run, the
/// contradictions waiting to be asked, the skill ideas, and (step L3) the changes
/// to Duck it may suggest. `None` removes it.
const MEMORY_STATE_KEYS: [&str; 4] = ["consolidation", "questions", "skill_offers", "improve_offers"];
const MEMORY_STATE_MAX: usize = 256 * 1024;

fn memory_state_key(key: &str) -> Result<String, String> {
    if MEMORY_STATE_KEYS.contains(&key) {
        Ok(format!("memory_state:{key}"))
    } else {
        Err(format!("not a memory state: {key}"))
    }
}

#[tauri::command]
pub fn assistant_memory_state_get(ctx: Db<'_>, key: String) -> Result<Option<String>, String> {
    trust::meta(&lock(&ctx), &memory_state_key(&key)?)
}

#[tauri::command]
pub fn assistant_memory_state_set(ctx: Db<'_>, key: String, value: Option<String>) -> Result<(), String> {
    let k = memory_state_key(&key)?;
    let conn = lock(&ctx);
    match value {
        Some(v) if v.len() > MEMORY_STATE_MAX => Err(format!("the {key} state is too large")),
        Some(v) => trust::set_meta(&conn, &k, &v),
        None => conn.execute("DELETE FROM meta WHERE key = ?1", [&k]).map(|_| ()).map_err(|e| e.to_string()),
    }
}

/// Log one automatic recall (step L2).
#[tauri::command]
pub fn assistant_recall_log(ctx: Db<'_>, row: memory::RecallRow) -> Result<(), String> {
    memory::log_recall(&lock(&ctx), &row)
}

/// The recall hit rate since `since` (epoch ms).
#[tauri::command]
pub fn assistant_recall_stats(ctx: Db<'_>, since: i64) -> Result<memory::RecallStats, String> {
    memory::recall_stats(&lock(&ctx), since)
}

// ── Duck's prompts as data (step L3) ──

/// Duck's config files (`config/system.md`, `config/voice.md`) as they are on disk.
#[tauri::command]
pub fn assistant_config_read(ctx: Db<'_>, workspace: Option<String>) -> Result<Vec<config::ConfigFile>, String> {
    let ws = workspace::resolve(workspace.as_deref())?;
    config::read(&lock(&ctx), &ws)
}

/// Write a config file over the text it was read as, and commit it with `message`.
/// `seed`: the hash of the built-in default being written.
#[tauri::command]
pub fn assistant_config_write(
    ctx: Db<'_>,
    workspace: Option<String>,
    file: String,
    text: String,
    expected: Option<String>,
    seed: Option<String>,
    message: String,
) -> Result<(), String> {
    let ws = workspace::resolve(workspace.as_deref())?;
    let path = config::write(&lock(&ctx), &ws, &file, &text, expected.as_deref(), seed.as_deref())?;
    memory::commit(&ws, vec![path], message);
    Ok(())
}

// ── Duck's skills (step S2) ──

/// Duck's skills (`skills/*/SKILL.md`), read again only after a change.
#[tauri::command]
pub fn assistant_skills_list(workspace: Option<String>) -> Result<Vec<skills::SkillFile>, String> {
    let ws = workspace::resolve(workspace.as_deref())?;
    skills::list(&ws)
}

/// Write a skill's `SKILL.md` over the text it was read as, and commit it with
/// `message`.
#[tauri::command]
pub fn assistant_skill_write(
    workspace: Option<String>,
    name: String,
    text: String,
    expected: Option<String>,
    message: String,
) -> Result<(), String> {
    let ws = workspace::resolve(workspace.as_deref())?;
    let path = skills::write(&ws, &name, &text, expected.as_deref())?;
    memory::commit(&ws, vec![path], message);
    Ok(())
}

/// Where Duck's data is backed up, and how far behind (step L4).
#[tauri::command]
pub async fn assistant_backup_status(workspace: Option<String>) -> Result<gitlane::BackupStatus, String> {
    let ws = workspace::resolve(workspace.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || gitlane::status(&ws)).await.map_err(|e| e.to_string())
}

/// Push Duck's data to its backup remote, behind the repo's other git jobs. Never forced.
#[tauri::command]
pub async fn assistant_backup_push(workspace: Option<String>) -> Result<gitlane::PushOutcome, String> {
    let ws = workspace::resolve(workspace.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || gitlane::push(&ws)).await.map_err(|e| e.to_string())
}

/// Create a private GitHub repo as the backup remote (the caller asked first).
#[tauri::command]
pub async fn assistant_backup_create(workspace: Option<String>, name: String) -> Result<String, String> {
    let ws = workspace::resolve(workspace.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || gitlane::create(&ws, &name)).await.map_err(|e| e.to_string())?
}

/// Housekeeping's mechanical part: task folders dated before `cutoff` folded into
/// the index, leftovers committed, `git gc --auto`.
#[tauri::command]
pub async fn assistant_housekeep(workspace: Option<String>, cutoff: String) -> Result<gitlane::HousekeepReport, String> {
    let ws = workspace::resolve(workspace.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || gitlane::housekeep(&ws, &cutoff)).await.map_err(|e| e.to_string())?
}

/// What a branch of Duck's data changes: its files and the memory entries it drops.
#[tauri::command]
pub async fn assistant_branch_review(workspace: Option<String>, branch: String) -> Result<gitlane::BranchReview, String> {
    let ws = workspace::resolve(workspace.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || gitlane::review_branch(&ws, &branch)).await.map_err(|e| e.to_string())?
}

/// Pin a thread on the prompts it starts with (a pinned thread keeps its pin).
#[tauri::command]
pub fn assistant_config_pin(ctx: Db<'_>, thread_id: String, hash: String, json: String) -> Result<(), String> {
    config::pin(&lock(&ctx), &thread_id, &hash, &json)
}

/// The prompts a thread is pinned on, as JSON.
#[tauri::command]
pub fn assistant_config_pinned(ctx: Db<'_>, thread_id: String) -> Result<Option<String>, String> {
    config::pinned(&lock(&ctx), &thread_id)
}

/// Every long-term memory entry, for the drawer's Memory view.
#[tauri::command]
pub async fn assistant_memory_list(workspace: Option<String>) -> Result<Vec<memory::Entry>, String> {
    blocking(move || memory::list(&workspace::resolve(workspace.as_deref())?)).await
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

/// Store a routine's record (step L4).
#[tauri::command]
pub fn assistant_routine_put(ctx: Db<'_>, id: String, data: String) -> Result<(), String> {
    routines::put(&lock(&ctx), &id, &data, now_ms())
}

/// Every routine's record.
#[tauri::command]
pub fn assistant_routine_list(ctx: Db<'_>) -> Result<Vec<String>, String> {
    routines::list(&lock(&ctx))
}

#[tauri::command]
pub fn assistant_routine_delete(ctx: Db<'_>, id: String) -> Result<(), String> {
    routines::delete(&lock(&ctx), &id)
}

/// Keep a turn's timing (step D3).
#[tauri::command]
pub fn assistant_timing_add(ctx: Db<'_>, at: i64, data: String) -> Result<(), String> {
    timings::add(&lock(&ctx), at, &data, now_ms())
}

/// The turns' timings since `since` (epoch ms), oldest first.
#[tauri::command]
pub fn assistant_timings(ctx: Db<'_>, since: i64) -> Result<Vec<String>, String> {
    timings::since(&lock(&ctx), since)
}

/// Store a session's autopilot record (step P1).
#[tauri::command]
pub fn assistant_autopilot_put(ctx: Db<'_>, instance_id: String, data: String) -> Result<(), String> {
    autopilot::put(&lock(&ctx), &instance_id, &data, now_ms())
}

/// Every autopilot record, newest first.
#[tauri::command]
pub fn assistant_autopilot_list(ctx: Db<'_>) -> Result<Vec<String>, String> {
    autopilot::list(&lock(&ctx))
}

#[tauri::command]
pub fn assistant_autopilot_delete(ctx: Db<'_>, instance_id: String) -> Result<(), String> {
    autopilot::delete(&lock(&ctx), &instance_id)
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
