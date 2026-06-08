//! PTY supervisor (step 1.5).
//!
//! Owns every `portable-pty` child and streams each one's output to the frontend
//! over a per-PTY Tauri `Channel<Vec<u8>>`. Keystrokes and resize flow back
//! through `#[tauri::command]`s. The PTY↔webview bridge is the de-risk for going
//! Tauri-native (design §4.1); Phase 0 proved it with one PTY.
//!
//! Step 1.5 generalizes the single-PTY spike into a supervisor keyed by
//! **`instance_id`**, so many consoles run side by side. Each `claude` child is
//! launched with a Workbench-minted `--session-id <uuid>` (design §4.2, decision
//! 12) and the supervisor keeps a `session_id → instance_id` map alongside the
//! `instance_id → PTY` map — the lookup the Phase-2 hook server needs to route an
//! event (which only carries `session_id`) back to its card.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

/// A live PTY child plus the handles needed to write to it, resize it, and kill
/// it. The reader runs on its own detached thread and isn't tracked here. For a
/// `claude` child, `session_id` is the minted UUID (so it can be unmapped from
/// the `session_id → instance_id` index on teardown); a shell has none.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    session_id: Option<String>,
}

/// Tauri-managed state holding every active PTY, keyed by `instance_id`, plus the
/// reverse `session_id → instance_id` index (design §4.4 / decision 10: the hook
/// server filters incoming events by `session_id`, dropping any session Workbench
/// didn't mint).
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    by_session: Mutex<HashMap<String, String>>,
}

/// What to run in the PTY. `Shell` is the 0.2 spike path (debugging convenience);
/// `Claude` is the real target — an interactive `claude` TUI for one instance.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpawnKind {
    Shell,
    Claude,
}

/// Returned to the frontend at spawn. For `Claude`, `session_id` is the UUID we
/// minted and passed as `--session-id`, so the card↔PTY mapping is known before
/// the first hook fires. `Shell` carries no session id.
#[derive(Debug, Serialize)]
pub struct SpawnResult {
    session_id: Option<String>,
    /// The resolved working directory the child was launched in.
    cwd: String,
}

/// Spawn `kind` for `instance_id` in `cwd` inside a fresh PTY and stream its
/// output to `on_output`. Relaunches cleanly: any existing PTY for the same
/// instance is killed first.
#[tauri::command]
pub fn pty_spawn(
    state: State<'_, PtyManager>,
    instance_id: String,
    on_output: Channel<Vec<u8>>,
    kind: SpawnKind,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<SpawnResult, String> {
    let cwd = cwd
        .map(PathBuf::from)
        .or_else(home_dir)
        .ok_or("no working directory given and no home dir found")?;
    if !cwd.is_dir() {
        return Err(format!("working directory does not exist: {}", cwd.display()));
    }

    // Build the command up front so a resolution failure (e.g. `claude` not on
    // PATH) reports cleanly before we touch the PTY.
    let session_id = match kind {
        SpawnKind::Claude => Some(uuid::Uuid::new_v4().to_string()),
        SpawnKind::Shell => None,
    };
    let candidates = match kind {
        SpawnKind::Claude => vec![claude_command(session_id.as_deref().unwrap(), &cwd)?],
        SpawnKind::Shell => shell_candidates(&cwd),
    };

    // Tear down any prior PTY for this instance only once we know we can spawn.
    kill_instance(state.inner(), &instance_id);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // Try each candidate until one spawns (shell has fallbacks; claude is one).
    let mut child = None;
    let mut last_err = String::new();
    for cmd in candidates {
        match pair.slave.spawn_command(cmd) {
            Ok(c) => {
                child = Some(c);
                break;
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    let child = child.ok_or_else(|| format!("nothing could be spawned: {last_err}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    // Pump PTY output to the frontend until the child exits or the pipe closes.
    // `Channel::send` over IPC serializes `Vec<u8>` as a JS number array; the
    // frontend reassembles it into a Uint8Array. (Raw-ArrayBuffer streaming is a
    // later optimization; correctness first.)
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if on_output.send(buf[..n].to_vec()).is_err() {
                        break; // frontend dropped the channel
                    }
                }
                Err(_) => break,
            }
        }
    });

    if let Some(sid) = &session_id {
        state
            .by_session
            .lock()
            .unwrap()
            .insert(sid.clone(), instance_id.clone());
    }
    state.sessions.lock().unwrap().insert(
        instance_id,
        PtySession {
            master: pair.master,
            writer,
            child,
            session_id: session_id.clone(),
        },
    );

    Ok(SpawnResult {
        session_id,
        cwd: cwd.to_string_lossy().into_owned(),
    })
}

/// Forward keystrokes (UTF-8 bytes from xterm `onData`) to an instance's PTY.
#[tauri::command]
pub fn pty_write(
    state: State<'_, PtyManager>,
    instance_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().unwrap();
    let session = guard.get_mut(&instance_id).ok_or("no active PTY")?;
    session
        .writer
        .write_all(&data)
        .map_err(|e| format!("pty write failed: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("pty flush failed: {e}"))
}

/// Resize an instance's PTY so the child reflows to the new terminal dimensions.
#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    instance_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.sessions.lock().unwrap();
    let session = guard.get(&instance_id).ok_or("no active PTY")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

/// Kill an instance's PTY child (if any) and drop the session.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, instance_id: String) -> Result<(), String> {
    kill_instance(state.inner(), &instance_id);
    Ok(())
}

/// Resolve a `session_id` back to the `instance_id` that owns it, or `None` if
/// Workbench didn't mint it. The Phase-2 hook server uses this to route events
/// (which carry only `session_id`) to the right card, and to drop foreign ones.
#[tauri::command]
pub fn session_instance(state: State<'_, PtyManager>, session_id: String) -> Option<String> {
    state.by_session.lock().unwrap().get(&session_id).cloned()
}

/// Default working directory offered to the launcher form (the home dir).
#[tauri::command]
pub fn default_working_dir() -> Option<String> {
    home_dir().map(|p| p.to_string_lossy().into_owned())
}

/// Build the command that launches interactive `claude` with a minted session id.
///
/// `claude` is resolved off PATH (honoring `PATHEXT` on Windows). A native
/// executable (`.exe`/`.com` or a Unix binary) is exec'd directly for full TUI
/// fidelity; a `.cmd`/`.bat` shim can't be handed to `CreateProcess` directly, so
/// it's run through `cmd.exe /c`, and a `.ps1` shim through PowerShell. We pass
/// `TERM`/`COLORTERM` so the Ink TUI renders color under ConPTY.
fn claude_command(session_id: &str, cwd: &Path) -> Result<CommandBuilder, String> {
    let exe = which::which("claude")
        .map_err(|e| format!("`claude` not found on PATH ({e}). Is Claude Code installed?"))?;
    let ext = exe
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);

    let mut cmd = match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/c");
            c.arg(&exe);
            c.arg("--session-id");
            c.arg(session_id);
            c
        }
        Some("ps1") => {
            let mut c = CommandBuilder::new("pwsh.exe");
            c.arg("-NoLogo");
            c.arg("-File");
            c.arg(&exe);
            c.arg("--session-id");
            c.arg(session_id);
            c
        }
        _ => {
            let mut c = CommandBuilder::new(&exe);
            c.arg("--session-id");
            c.arg(session_id);
            c
        }
    };
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    Ok(cmd)
}

/// Shell candidates to try in order, each rooted at `cwd`. On Windows we prefer
/// PowerShell 7 (`pwsh`), fall back to Windows PowerShell, then `cmd`. On Unix we
/// honor `$SHELL`.
fn shell_candidates(cwd: &Path) -> Vec<CommandBuilder> {
    let build = |program: &str| {
        let mut cmd = CommandBuilder::new(program);
        cmd.cwd(cwd);
        cmd
    };

    #[cfg(windows)]
    {
        vec![build("pwsh.exe"), build("powershell.exe"), build("cmd.exe")]
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        vec![build(&shell), build("/bin/bash"), build("/bin/sh")]
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Shared teardown: kill the instance's child, drop the session, and unmap its
/// `session_id`. Take the session out from under the `sessions` lock before
/// touching `by_session` so the two mutexes are never held nested.
fn kill_instance(mgr: &PtyManager, instance_id: &str) {
    let removed = mgr.sessions.lock().unwrap().remove(instance_id);
    if let Some(mut session) = removed {
        let _ = session.child.kill();
        if let Some(sid) = session.session_id {
            mgr.by_session.lock().unwrap().remove(&sid);
        }
    }
}
