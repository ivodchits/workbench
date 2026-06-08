//! PTY bridge (Phase 0 spike).
//!
//! Owns a single `portable-pty` child and streams its output to the frontend
//! over a Tauri `Channel<Vec<u8>>`. Keystrokes and resize flow back through
//! `#[tauri::command]`s. This is the de-risk for going Tauri-native (design
//! §4.1): prove the PTY↔webview bridge before building on it.
//!
//! Step 0.2 proved this with the user's shell. Step 0.3 generalizes it to launch
//! the real interactive `claude` TUI in a chosen working directory with a
//! Workbench-minted `--session-id <uuid>` (design §4.2, decision 12): correlate
//! the PTY to a session *at spawn*, never by racing `SessionStart`.
//!
//! Scope is still one PTY. The multi-PTY supervisor and the `session_id → card`
//! registry arrive in later steps (1.5).

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
/// it. The reader runs on its own detached thread and isn't tracked here.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Tauri-managed state holding the (single) active PTY session.
#[derive(Default)]
pub struct PtyManager {
    session: Mutex<Option<PtySession>>,
}

/// What to run in the PTY. `Shell` is the 0.2 spike path (debugging convenience);
/// `Claude` is the real target — an interactive `claude` TUI for one session.
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

/// Spawn `kind` in `cwd` (defaulting to the home dir) inside a fresh PTY and
/// stream its output to `on_output`. Replaces any existing session (kills it
/// first) so the frontend can relaunch.
#[tauri::command]
pub fn pty_spawn(
    state: State<'_, PtyManager>,
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

    // Tear down any prior session only once we know we have something to spawn.
    kill_session(state.inner());

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
    // later optimization; correctness first for the spike.)
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

    *state.session.lock().unwrap() = Some(PtySession {
        master: pair.master,
        writer,
        child,
    });

    Ok(SpawnResult {
        session_id,
        cwd: cwd.to_string_lossy().into_owned(),
    })
}

/// Forward keystrokes (UTF-8 bytes from xterm `onData`) to the PTY.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, data: Vec<u8>) -> Result<(), String> {
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().ok_or("no active PTY")?;
    session
        .writer
        .write_all(&data)
        .map_err(|e| format!("pty write failed: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("pty flush failed: {e}"))
}

/// Resize the PTY so the child reflows to the new terminal dimensions.
#[tauri::command]
pub fn pty_resize(state: State<'_, PtyManager>, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.session.lock().unwrap();
    let session = guard.as_ref().ok_or("no active PTY")?;
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

/// Kill the active PTY child (if any) and drop the session.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>) -> Result<(), String> {
    kill_session(state.inner());
    Ok(())
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

/// Shared teardown: kill the child and drop the session, if one exists.
fn kill_session(mgr: &PtyManager) {
    if let Some(mut session) = mgr.session.lock().unwrap().take() {
        let _ = session.child.kill();
    }
}
