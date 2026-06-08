//! PTY bridge (Phase 0 spike).
//!
//! Owns a single `portable-pty` child running the user's shell and streams its
//! output to the frontend over a Tauri `Channel<Vec<u8>>`. Keystrokes and resize
//! flow back through `#[tauri::command]`s. This is the de-risk for going
//! Tauri-native (design §4.1): prove the PTY↔webview bridge before building on it.
//!
//! Scope is deliberately one PTY. The multi-PTY supervisor, the `claude`
//! launcher, and per-instance mapping arrive in later steps (0.3, 1.5).

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
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

/// Shell candidates to try in order. On Windows we prefer PowerShell 7 (`pwsh`),
/// fall back to Windows PowerShell, then `cmd`. On Unix we honor `$SHELL`.
fn shell_candidates() -> Vec<CommandBuilder> {
    let cwd = home_dir();
    let build = |program: &str| {
        let mut cmd = CommandBuilder::new(program);
        if let Some(dir) = &cwd {
            cmd.cwd(dir);
        }
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

/// Spawn the shell in a fresh PTY and stream its output to `on_output`.
///
/// Replaces any existing session (kills it first), so the frontend can respawn.
#[tauri::command]
pub fn pty_spawn(
    state: State<'_, PtyManager>,
    on_output: Channel<Vec<u8>>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Tear down any prior session before starting a new one.
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

    // Try each shell candidate until one spawns.
    let mut child = None;
    let mut last_err = String::new();
    for cmd in shell_candidates() {
        match pair.slave.spawn_command(cmd) {
            Ok(c) => {
                child = Some(c);
                break;
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    let child = child.ok_or_else(|| format!("no shell could be spawned: {last_err}"))?;

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

    Ok(())
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

/// Resize the PTY so the shell reflows to the new terminal dimensions.
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

/// Shared teardown: kill the child and drop the session, if one exists.
fn kill_session(mgr: &PtyManager) {
    if let Some(mut session) = mgr.session.lock().unwrap().take() {
        let _ = session.child.kill();
    }
}
