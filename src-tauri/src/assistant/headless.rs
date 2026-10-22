//! Headless workers (step D4): Duck's worker sessions run as `claude -p` speaking
//! stream-json on stdin and stdout, the protocol the Agent SDK uses, instead of a
//! TUI in a PTY. Duck sends prompts and interrupts as messages and answers
//! permission requests as data: no screen to read, no keys to time.
//!
//! The session is otherwise any session's: it is launched with the same arguments
//! as its terminal would be ([`crate::pty::session_args`]), its id is mapped in the
//! [`PtyManager`] so its hooks pass the filter and its transcript is followed, and
//! it carries `WORKBENCH_INSTANCE_ID`. The status engine, summaries, the trust
//! watcher (whose `PermissionRequest` hook races the protocol's own request, the
//! first answer winning) and the transcript view work on it unchanged.
//!
//! What was checked against Claude Code 2.1.304 (D4's check-first):
//! - `can_use_tool` control requests arrive for anything that would prompt, alongside
//!   the `PermissionRequest` hook; a hook decision makes the CLI cancel the request
//!   (`control_cancel_request`), an empty hook reply leaves it to the host.
//!   `AskUserQuestion` is answered by allowing it with `updatedInput.answers`.
//! - A user message between turns starts the next one; each turn ends in a `result`.
//! - An `interrupt` control request stops a turn (`error_during_execution`) and kills
//!   a foreground tool; the session takes the next message as usual.
//! - `/compact` and `/cost` work as messages; `--resume` keeps the conversation and
//!   the session id. `SessionStart` and `Notification` hooks don't fire.
//! - Memory: about 300 MB at the start, as a TUI session.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::pty::PtyManager;

/// The arguments that make `claude` headless and speak stream-json both ways, with
/// permission requests coming to us over the protocol.
const HEADLESS_ARGS: [&str; 8] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
];

/// How often an exit watcher looks at its child.
const EXIT_POLL: Duration = Duration::from_millis(250);
/// The stderr lines kept, for the error a failed start reports.
const STDERR_KEEP: usize = 20;

/// The message types the webview hears. The conversation itself comes from the
/// transcript, as for a terminal session; these are what it can't get there.
const FORWARDED: [&str; 4] = ["control_request", "control_cancel_request", "result", "system"];

struct Proc {
    stdin: ChildStdin,
    child: Arc<Mutex<Child>>,
    gen: u64,
}

/// Tauri-managed: the headless workers running, by instance id.
#[derive(Default)]
pub struct HeadlessManager {
    procs: Mutex<HashMap<String, Proc>>,
}

static NEXT_GEN: AtomicU64 = AtomicU64::new(1);
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

/// Emitted as `headless-event`: one protocol message of worker `id`.
#[derive(Clone, Serialize)]
struct HeadlessEvent {
    id: String,
    msg: Value,
}

/// Emitted as `headless-exited` when a worker's process ends on its own; one
/// Workbench stopped emits nothing.
#[derive(Clone, Serialize)]
struct HeadlessExited {
    id: String,
    code: Option<i32>,
    /// Its last stderr lines, for a process that ended at once.
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessSpawned {
    session_id: String,
    cwd: String,
}

pub(crate) fn user_message(text: &str) -> Value {
    json!({ "type": "user", "message": { "role": "user", "content": text } })
}

pub(crate) fn control_request(request: Value) -> Value {
    let id = format!("wb-{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed));
    json!({ "type": "control_request", "request_id": id, "request": request })
}

pub(crate) fn write_line(stdin: &mut ChildStdin, msg: &Value) -> Result<(), String> {
    let mut line = msg.to_string();
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("the worker's input is closed: {e}"))
}

impl HeadlessManager {
    fn send(&self, instance_id: &str, msg: &Value) -> Result<(), String> {
        let mut procs = self.procs.lock().unwrap();
        let p = procs.get_mut(instance_id).ok_or("that worker isn't running")?;
        write_line(&mut p.stdin, msg)
    }

    /// Stop `instance_id`'s worker and its tools; quiet (no `headless-exited`).
    fn kill(&self, pty: &PtyManager, instance_id: &str) {
        let removed = self.procs.lock().unwrap().remove(instance_id);
        if let Some(p) = removed {
            let mut child = p.child.lock().unwrap();
            crate::pty::kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        pty.forget_instance(instance_id);
    }
}

/// Start `instance_id`'s worker in `cwd`: a fresh session, or `resume_session_id`
/// continued. `prompt`, when given, is its first message.
// The managed states and the IPC contract's fields, as `pty_spawn` has them.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn headless_spawn(
    app: AppHandle,
    state: State<'_, HeadlessManager>,
    pty: State<'_, PtyManager>,
    db: State<'_, crate::db::Db>,
    instance_id: String,
    cwd: String,
    resume_session_id: Option<String>,
    prompt: Option<String>,
) -> Result<HeadlessSpawned, String> {
    let dir = PathBuf::from(&cwd);
    if !dir.is_dir() {
        return Err(format!("working directory does not exist: {cwd}"));
    }
    let (model, mode) = match db.conn.lock() {
        Ok(conn) => (
            crate::registry::launch_model(&conn, &instance_id),
            crate::registry::launch_permission_mode(&conn, &instance_id),
        ),
        Err(_) => (None, None),
    };
    let session_id = resume_session_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let flag = if resume_session_id.is_some() { "--resume" } else { "--session-id" };

    let launcher = crate::pty::claude_launcher()?;
    let mut cmd = Command::new(&launcher[0]);
    cmd.args(&launcher[1..])
        .args(HEADLESS_ARGS)
        .args([flag, session_id.as_str()])
        .args(crate::pty::session_args(&app, &db, &instance_id, model.as_deref(), mode.as_deref()))
        .current_dir(&dir)
        .env(crate::hooks::install::INSTANCE_ENV, &instance_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // One worker per instance: a relaunch replaces the old one.
    state.kill(&pty, &instance_id);
    let mut child = cmd.spawn().map_err(|e| format!("claude couldn't be started: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // As the SDK does: initialize, then the first prompt. Claude Code reads them once
    // it is up; nothing has to wait for a prompt box.
    write_line(&mut stdin, &control_request(json!({ "subtype": "initialize", "hooks": null })))?;
    if let Some(p) = prompt.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        write_line(&mut stdin, &user_message(p))?;
    }

    let gen = NEXT_GEN.fetch_add(1, Ordering::Relaxed);
    let child = Arc::new(Mutex::new(child));
    pty.register_session(&session_id, &instance_id);
    state.procs.lock().unwrap().insert(instance_id.clone(), Proc { stdin, child: child.clone(), gen });

    let reader_app = app.clone();
    let reader_id = instance_id.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
            if FORWARDED.contains(&kind) {
                let _ = reader_app.emit("headless-event", HeadlessEvent { id: reader_id.clone(), msg });
            }
        }
    });

    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let err_tail = tail.clone();
    let err_id = instance_id.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            eprintln!("[headless {err_id}] {line}");
            let mut t = err_tail.lock().unwrap();
            t.push(line);
            if t.len() > STDERR_KEEP {
                t.remove(0);
            }
        }
    });

    watch_exit(app, instance_id, gen, child, tail);
    Ok(HeadlessSpawned { session_id, cwd })
}

/// Report worker `gen` ending on its own, and drop it.
fn watch_exit(app: AppHandle, instance_id: String, gen: u64, child: Arc<Mutex<Child>>, tail: Arc<Mutex<Vec<String>>>) {
    thread::spawn(move || loop {
        thread::sleep(EXIT_POLL);
        let status = match child.lock().unwrap().try_wait() {
            Ok(Some(s)) => s,
            Ok(None) => continue,
            Err(_) => return,
        };
        let (Some(mgr), Some(pty)) = (app.try_state::<HeadlessManager>(), app.try_state::<PtyManager>()) else {
            return;
        };
        {
            let mut procs = mgr.procs.lock().unwrap();
            // Killed or replaced: whoever did it has dealt with it.
            if procs.get(&instance_id).map(|p| p.gen) != Some(gen) {
                return;
            }
            procs.remove(&instance_id);
        }
        pty.forget_instance(&instance_id);
        let stderr = tail.lock().unwrap().join("\n");
        let _ = app.emit("headless-exited", HeadlessExited { id: instance_id, code: status.code(), stderr });
        return;
    });
}

/// A prompt into the worker: the next turn, or (mid-turn) for its next step.
#[tauri::command]
pub fn headless_send(state: State<'_, HeadlessManager>, instance_id: String, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("the prompt is empty".into());
    }
    state.send(&instance_id, &user_message(&text))
}

/// Stop the worker's turn, as Esc does in the TUI.
#[tauri::command]
pub fn headless_interrupt(state: State<'_, HeadlessManager>, instance_id: String) -> Result<(), String> {
    state.send(&instance_id, &control_request(json!({ "subtype": "interrupt" })))
}

/// Answer the worker's control request `request_id` (a `can_use_tool`) with
/// `response`: `{"behavior": "allow", "updatedInput": …}` or `{"behavior": "deny",
/// "message": …}`.
#[tauri::command]
pub fn headless_answer(
    state: State<'_, HeadlessManager>,
    instance_id: String,
    request_id: String,
    response: Value,
) -> Result<(), String> {
    let behavior = response.get("behavior").and_then(Value::as_str);
    if !matches!(behavior, Some("allow") | Some("deny")) {
        return Err("an answer allows or denies".into());
    }
    state.send(
        &instance_id,
        &json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } }),
    )
}

/// Stop the worker (its console closed, or it's being taken over in a terminal).
#[tauri::command]
pub fn headless_kill(state: State<'_, HeadlessManager>, pty: State<'_, PtyManager>, instance_id: String) {
    state.kill(&pty, &instance_id);
}

/// Stop every worker as the app quits, so none outlives it.
pub fn kill_all(app: &AppHandle) {
    let (Some(mgr), Some(pty)) = (app.try_state::<HeadlessManager>(), app.try_state::<PtyManager>()) else {
        return;
    };
    let ids: Vec<String> = mgr.procs.lock().unwrap().keys().cloned().collect();
    for id in ids {
        mgr.kill(&pty, &id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_the_protocols() {
        assert_eq!(
            user_message("hi"),
            json!({ "type": "user", "message": { "role": "user", "content": "hi" } })
        );
        let r = control_request(json!({ "subtype": "interrupt" }));
        assert_eq!(r["type"], "control_request");
        assert_eq!(r["request"]["subtype"], "interrupt");
        assert!(r["request_id"].as_str().unwrap().starts_with("wb-"));
        assert_ne!(r["request_id"], control_request(json!({}))["request_id"]);
    }
}
