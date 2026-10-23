//! Duck's subscription brain (step M3): when the API credits run low, a thread's
//! turns run in a headless `claude -p` on your subscription instead, Sonnet at
//! `medium`, with Duck's prompt and only Duck's tools (served over MCP by
//! [`super::mcp_server`], answered by the engine in the webview, so the trust
//! policy and confirmations apply as on the API).
//!
//! One process per thread on this brain, started when a turn needs it and stopped
//! by the engine after a while idle. Its session id is the thread's id, and the
//! session is kept on disk, so a process started again later `--resume`s it.
//!
//! The process is no session of yours: no `WORKBENCH_INSTANCE_ID` (its hooks, if
//! any fired, would be dropped), no `ANTHROPIC_*` variables (it bills the
//! subscription), no settings files (`--setting-sources ""`: no hooks, no
//! statusline), no CLAUDE.md, no auto-memory and no deferred tools. It runs in `<workspace>/brain`,
//! a folder of its own, so its sessions don't show in the Duck project's resume
//! list.
//!
//! What it says goes to the webview as `brain-event` (text deltas, the messages,
//! the turn's `result`) and `brain-exited`. Its `rate_limit_event`s update the
//! usage meter, and each `result` is priced as the API would have priced it into
//! the subscription ledger (the spend line's "saved").

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use rand_core::{OsRng, RngCore};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use super::headless::{control_request, user_message, write_line};
use super::usage::{cost_usd, Usage};
use super::Assistant;

/// Headless, stream-json both ways, partial messages for the text as it comes, no
/// built-in tools, only the MCP server we name, no prompts (anything outside the
/// allow list is refused), and no settings files.
const BRAIN_ARGS: [&str; 17] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "mcp__duck",
    "--setting-sources",
    "",
    "--model",
];
/// The models a brain runs on: Sonnet, or Opus for a mode set to think there
/// (step D3).
const MODELS: [&str; 2] = ["sonnet", "opus"];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
/// The folder in the workspace the brain runs in.
const BRAIN_DIR: &str = "brain";
const EXIT_POLL: Duration = Duration::from_millis(250);
const STDERR_KEEP: usize = 20;
/// A tool call the webview never answers is failed after this long. Tools have
/// their own, shorter budgets; this only guards against a lost answer.
const CALL_TIMEOUT: Duration = Duration::from_secs(600);

struct Proc {
    stdin: ChildStdin,
    child: Arc<Mutex<Child>>,
    gen: u64,
    /// The bearer token its MCP config carries: which thread a tool call is for.
    token: String,
    /// The tools its MCP server lists, as MCP `Tool`s.
    tools: Arc<Vec<Value>>,
}

/// Tauri-managed: the subscription brains running, by thread id, and the tool
/// calls waiting on the webview.
#[derive(Default)]
pub struct BrainManager {
    procs: Mutex<HashMap<String, Proc>>,
    calls: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    /// Drawing workers' tokens (step G4), to their instance ids: their only tool
    /// on Duck's server is `render`.
    workers: Mutex<HashMap<String, String>>,
}

static NEXT_GEN: AtomicU64 = AtomicU64::new(1);
static NEXT_CALL: AtomicU64 = AtomicU64::new(1);

/// Emitted as `brain-event`: one protocol message of thread `thread_id`'s brain.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrainEvent {
    thread_id: String,
    msg: Value,
}

/// Emitted as `brain-exited` when a brain's process ends on its own.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrainExited {
    thread_id: String,
    code: Option<i32>,
    stderr: String,
}

/// Emitted as `worker-render-call` (step G4): a drawing worker asked for a render.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderCall {
    call_id: String,
    instance_id: String,
    input: Value,
}

/// Emitted as `brain-tool-call`: the brain called one of Duck's tools.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCall {
    call_id: String,
    thread_id: String,
    name: String,
    input: Value,
    /// The `tool_use` block's id, which the stored reply carries.
    tool_use_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainSpawned {
    /// The session was on disk and is continued; false: a new one.
    resumed: bool,
}

impl BrainManager {
    fn send(&self, thread_id: &str, msg: &Value) -> Result<(), String> {
        let mut procs = self.procs.lock().unwrap();
        let p = procs.get_mut(thread_id).ok_or("the subscription brain isn't running")?;
        write_line(&mut p.stdin, msg)
    }

    fn kill(&self, thread_id: &str) {
        let removed = self.procs.lock().unwrap().remove(thread_id);
        if let Some(p) = removed {
            let mut child = p.child.lock().unwrap();
            crate::pty::kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// The thread whose brain holds `token`, and the tools it lists.
    pub(crate) fn by_token(&self, token: &str) -> Option<(String, Arc<Vec<Value>>)> {
        let procs = self.procs.lock().unwrap();
        procs
            .iter()
            .find(|(_, p)| !token.is_empty() && p.token == token)
            .map(|(id, p)| (id.clone(), p.tools.clone()))
    }

    /// A drawing worker's token (step G4), kept for as long as the app runs.
    pub(crate) fn register_worker(&self, token: &str, instance_id: &str) {
        self.workers.lock().unwrap().insert(token.to_string(), instance_id.to_string());
    }

    /// The drawing worker holding `token`.
    pub(crate) fn worker_by_token(&self, token: &str) -> Option<String> {
        if token.is_empty() {
            return None;
        }
        self.workers.lock().unwrap().get(token).cloned()
    }

    /// Hand a tool call to the webview and wait for its MCP `CallToolResult`.
    pub(crate) async fn call(
        &self,
        app: &AppHandle,
        thread_id: String,
        name: String,
        input: Value,
        tool_use_id: Option<String>,
    ) -> Value {
        self.answered(app, "brain-tool-call", |call_id| ToolCall { call_id, thread_id, name, input, tool_use_id }).await
    }

    /// A drawing worker's `render` (step G4), answered by the webview's renderer.
    pub(crate) async fn render(&self, app: &AppHandle, instance_id: String, input: Value) -> Value {
        self.answered(app, "worker-render-call", |call_id| RenderCall { call_id, instance_id, input }).await
    }

    /// Emit `event` with a fresh call id and wait for the webview's answer
    /// (`brain_tool_result`).
    async fn answered<P: Serialize + Clone>(&self, app: &AppHandle, event: &str, payload: impl FnOnce(String) -> P) -> Value {
        let call_id = format!("bc-{}", NEXT_CALL.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.calls.lock().unwrap().insert(call_id.clone(), tx);
        let sent = app.emit(event, payload(call_id.clone()));
        let out = match sent {
            Err(e) => Err(format!("Duck couldn't take the call: {e}")),
            Ok(()) => match tokio::time::timeout(CALL_TIMEOUT, rx).await {
                Ok(Ok(v)) => Ok(v),
                Ok(Err(_)) => Err("the call was dropped".into()),
                Err(_) => Err(format!("no answer within {} s", CALL_TIMEOUT.as_secs())),
            },
        };
        self.calls.lock().unwrap().remove(&call_id);
        out.unwrap_or_else(|e| tool_error(&e))
    }
}

/// A `CallToolResult` that failed with `text`.
pub(crate) fn tool_error(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

pub(crate) fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The `--mcp-config` that points the brain (or a drawing worker) at Duck's server
/// with `token`.
pub(crate) fn mcp_config(port: u16, token: &str) -> String {
    json!({
        "mcpServers": {
            "duck": {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}{}", super::mcp_server::MCP_PATH),
                "headers": { "Authorization": format!("Bearer {token}") }
            }
        }
    })
    .to_string()
}

/// Where Claude Code keeps the transcript of session `id` started in `cwd`.
fn transcript(cwd: &Path, id: &str) -> Option<PathBuf> {
    let folder = crate::transcript::encode_cwd_to_folder(&cwd.to_string_lossy());
    crate::transcript::claude_projects_dir().map(|d| d.join(folder).join(format!("{id}.jsonl")))
}

/// What the webview hears of a stdout line: the text as it streams, the messages,
/// the result and the init (`None`: nothing). Everything else, the rest of the
/// stream events included, stays here.
fn forwarded(msg: &Value) -> bool {
    match msg.get("type").and_then(Value::as_str).unwrap_or("") {
        "assistant" | "user" | "result" => true,
        "system" => msg.get("subtype").and_then(Value::as_str) == Some("init"),
        "stream_event" => {
            let ev = &msg["event"];
            ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta"
        }
        _ => false,
    }
}

/// The subscription ledger's row for a `result`: its model and API price.
fn priced(model: &str, result: &Value) -> Option<f64> {
    let u = result.get("usage")?;
    let mut usage = Usage::default();
    usage.merge(u);
    Some(cost_usd(model, &usage))
}

/// Start thread `thread_id`'s brain in the workspace `workspace`, with Duck's
/// system prompt `prompt`, the MCP `tools` its server lists and `effort`.
/// Replaces one already running for the thread. `model` is `sonnet` (the default) or
/// `opus`, for a mode set to think on the subscription (step D3).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn brain_spawn(
    app: AppHandle,
    state: State<'_, BrainManager>,
    thread_id: String,
    workspace: String,
    prompt: String,
    tools: Vec<Value>,
    effort: String,
    model: Option<String>,
) -> Result<BrainSpawned, String> {
    let id = uuid::Uuid::parse_str(&thread_id).map_err(|_| "a thread id is a UUID")?.to_string();
    if !EFFORTS.contains(&effort.as_str()) {
        return Err(format!("unknown effort {effort}"));
    }
    let model = model.unwrap_or_else(|| MODELS[0].to_string());
    if !MODELS.contains(&model.as_str()) {
        return Err(format!("unknown model {model}"));
    }
    let cwd = PathBuf::from(&workspace).join(BRAIN_DIR);
    std::fs::create_dir_all(&cwd).map_err(|e| format!("cannot create {}: {e}", cwd.display()))?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let prompt_file = data.join("duck-brain-prompt.md");
    std::fs::write(&prompt_file, prompt).map_err(|e| format!("cannot write the brain's prompt: {e}"))?;
    let port = crate::hooks::port(&app).ok_or("the local server isn't running")?;
    let token = random_token();
    let resumed = transcript(&cwd, &id).is_some_and(|p| p.is_file());

    let launcher = crate::pty::claude_launcher()?;
    let mut cmd = Command::new(&launcher[0]);
    cmd.args(&launcher[1..])
        .args(BRAIN_ARGS)
        .arg(&model)
        .args(["--effort", effort.as_str()])
        .arg("--mcp-config")
        .arg(mcp_config(port, &token))
        .arg("--system-prompt-file")
        .arg(&prompt_file)
        .args([if resumed { "--resume" } else { "--session-id" }, id.as_str()])
        .current_dir(&cwd)
        .env_remove(crate::hooks::install::INSTANCE_ENV)
        .env("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1")
        .env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1")
        // Every tool loaded up front: with `--tools ""` there is no tool search to
        // reach one Claude Code would otherwise defer.
        .env("ENABLE_TOOL_SEARCH", "false")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, _) in std::env::vars_os() {
        if k.to_string_lossy().to_ascii_uppercase().starts_with("ANTHROPIC_") {
            cmd.env_remove(k);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    state.kill(&thread_id);
    let mut child = cmd.spawn().map_err(|e| format!("claude couldn't be started: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    write_line(&mut stdin, &control_request(json!({ "subtype": "initialize", "hooks": null })))?;

    let gen = NEXT_GEN.fetch_add(1, Ordering::Relaxed);
    let child = Arc::new(Mutex::new(child));
    let tools = Arc::new(tools);
    state.procs.lock().unwrap().insert(
        thread_id.clone(),
        Proc { stdin, child: child.clone(), gen, token, tools },
    );

    let reader_app = app.clone();
    let reader_id = thread_id.clone();
    thread::spawn(move || {
        let mut model = String::from("claude-sonnet-5-5");
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            match msg.get("type").and_then(Value::as_str) {
                Some("rate_limit_event") => {
                    if let Some(info) = msg.get("rate_limit_info") {
                        crate::statusline::ingest_rate_limit_info(&reader_app, info);
                    }
                }
                Some("system") => {
                    if let Some(m) = msg.get("model").and_then(Value::as_str) {
                        model = m.to_string();
                    }
                }
                Some("result") => record(&reader_app, &model, &msg),
                _ => {}
            }
            if forwarded(&msg) {
                let _ = reader_app.emit("brain-event", BrainEvent { thread_id: reader_id.clone(), msg });
            }
        }
    });

    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let err_tail = tail.clone();
    let err_id = thread_id.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            eprintln!("[brain {err_id}] {line}");
            let mut t = err_tail.lock().unwrap();
            t.push(line);
            if t.len() > STDERR_KEEP {
                t.remove(0);
            }
        }
    });

    watch_exit(app, thread_id, gen, child, tail);
    Ok(BrainSpawned { resumed })
}

/// Price a turn's `result` into the subscription ledger.
fn record(app: &AppHandle, model: &str, result: &Value) {
    let Some(usd) = priced(model, result) else { return };
    let Some(ctx) = app.try_state::<Arc<Assistant>>() else { return };
    let saved = super::budget::record_saved(&super::lock(&ctx), super::now_ms(), model, usd);
    if let Err(e) = saved {
        eprintln!("duck: recording a subscription turn failed: {e}");
    }
}

fn watch_exit(app: AppHandle, thread_id: String, gen: u64, child: Arc<Mutex<Child>>, tail: Arc<Mutex<Vec<String>>>) {
    thread::spawn(move || loop {
        thread::sleep(EXIT_POLL);
        let status = match child.lock().unwrap().try_wait() {
            Ok(Some(s)) => s,
            Ok(None) => continue,
            Err(_) => return,
        };
        let Some(mgr) = app.try_state::<BrainManager>() else { return };
        {
            let mut procs = mgr.procs.lock().unwrap();
            // Killed or replaced: whoever did it has dealt with it.
            if procs.get(&thread_id).map(|p| p.gen) != Some(gen) {
                return;
            }
            procs.remove(&thread_id);
        }
        let stderr = tail.lock().unwrap().join("\n");
        let _ = app.emit("brain-exited", BrainExited { thread_id, code: status.code(), stderr });
        return;
    });
}

/// Your message (with whatever the engine put around it) into the thread's brain.
#[tauri::command]
pub fn brain_send(state: State<'_, BrainManager>, thread_id: String, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("the message is empty".into());
    }
    state.send(&thread_id, &user_message(&text))
}

/// Stop the turn the brain is on; it ends in a `result` as usual.
#[tauri::command]
pub fn brain_interrupt(state: State<'_, BrainManager>, thread_id: String) -> Result<(), String> {
    state.send(&thread_id, &control_request(json!({ "subtype": "interrupt" })))
}

/// Stop the thread's brain (idle, the thread deleted, or back on the API).
#[tauri::command]
pub fn brain_kill(state: State<'_, BrainManager>, thread_id: String) {
    state.kill(&thread_id);
}

/// The webview's answer to `brain-tool-call` `call_id`: an MCP `CallToolResult`.
#[tauri::command]
pub fn brain_tool_result(state: State<'_, BrainManager>, call_id: String, result: Value) {
    if let Some(tx) = state.calls.lock().unwrap().remove(&call_id) {
        let _ = tx.send(result);
    }
}

/// Stop every brain as the app quits.
pub fn kill_all(app: &AppHandle) {
    let Some(mgr) = app.try_state::<BrainManager>() else { return };
    let ids: Vec<String> = mgr.procs.lock().unwrap().keys().cloned().collect();
    for id in ids {
        mgr.kill(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_brain_hears_only_duck() {
        let cfg: Value = serde_json::from_str(&mcp_config(48971, "abc")).unwrap();
        let duck = &cfg["mcpServers"]["duck"];
        assert_eq!(duck["url"], "http://127.0.0.1:48971/duck/mcp");
        assert_eq!(duck["headers"]["Authorization"], "Bearer abc");
        assert_eq!(cfg["mcpServers"].as_object().unwrap().len(), 1);
        // No built-in tools, the duck server's tools only, nothing asked.
        let args = BRAIN_ARGS.join(" ");
        assert!(args.contains("--tools  --strict-mcp-config"));
        assert!(args.contains("--allowedTools mcp__duck"));
        assert!(args.contains("--permission-mode dontAsk"));
        assert_ne!(random_token(), random_token());
    }

    #[test]
    fn only_text_deltas_and_messages_reach_the_webview() {
        let delta = json!({ "type": "stream_event", "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "hi" } } });
        let start = json!({ "type": "stream_event", "event": { "type": "message_start" } });
        assert!(forwarded(&delta));
        assert!(!forwarded(&start));
        assert!(forwarded(&json!({ "type": "assistant" })));
        assert!(forwarded(&json!({ "type": "result" })));
        assert!(forwarded(&json!({ "type": "system", "subtype": "init" })));
        assert!(!forwarded(&json!({ "type": "system", "subtype": "status" })));
        assert!(!forwarded(&json!({ "type": "rate_limit_event" })));
    }

    #[test]
    fn a_turn_is_priced_as_the_api_would() {
        let result = json!({ "usage": { "input_tokens": 1000000, "output_tokens": 0 } });
        assert!((priced("claude-sonnet-5-5", &result).unwrap() - 2.0).abs() < 1e-9);
        assert!(priced("claude-sonnet-5-5", &json!({})).is_none());
    }
}
