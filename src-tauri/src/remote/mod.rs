//! Remote host helpers for SSH+tmux projects (step 3.12).
//!
//! A remote *instance* runs as a persistent tmux session on the host (driven from
//! a Console via the `ssh` child in `pty`); these two commands are the out-of-band
//! `ssh` calls that don't go through a PTY: **list** the host's sessions (to
//! reconcile which `wb-*` instances are live/detached and to offer adopting any
//! foreign sessions) and **kill** a session (when an instance is removed — detach
//! ≠ kill, so removal must explicitly tear the session down). Telemetry stays out
//! of scope for remote (no hooks/tokens cross the SSH boundary), so this is the
//! whole remote backend surface.
//!
//! Both shell out to the system `ssh`, leaning on `~/.ssh/config` for auth/host/
//! port/keys (design §3.12: an SSH *destination*, not credentials we manage).

use std::process::Command;

/// Run `ssh <dest> <args…>`, returning stdout on success. On Windows, suppress the
/// console window the child would otherwise flash (`CREATE_NO_WINDOW`).
fn ssh(dest: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("ssh");
    cmd.arg(dest);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output()
        .map_err(|e| format!("failed to run ssh: {e}. Is OpenSSH installed and `{dest}` reachable?"))
}

/// List the tmux session names on `dest` (`tmux ls`). Returns an empty list — not
/// an error — when no tmux server is running there yet (the common "host is up but
/// nothing started" case), so the caller can show "no sessions" rather than a scary
/// failure. A genuine ssh/connection failure is surfaced.
#[tauri::command]
pub fn remote_tmux_sessions(dest: String) -> Result<Vec<String>, String> {
    let out = ssh(&dest, &["tmux", "ls", "-F", "#{session_name}"])?;
    if out.status.success() {
        let names = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect();
        return Ok(names);
    }
    // tmux exits non-zero with this on its stderr when no server is up — that's an
    // empty session set, not a connection problem.
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("no server running") || err.contains("No such file or directory") {
        return Ok(Vec::new());
    }
    Err(format!("ssh {dest}: {}", err.trim()))
}

/// Kill a tmux session on `dest` (`tmux kill-session -t <session>`). Idempotent: a
/// missing session ("can't find session") is treated as success, since the goal —
/// "this session is gone" — already holds. Used when removing a remote instance
/// (detach ≠ kill: closing a console only detaches; removal must end the session).
#[tauri::command]
pub fn remote_kill_session(dest: String, session: String) -> Result<(), String> {
    let out = ssh(&dest, &["tmux", "kill-session", "-t", &session])?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("can't find session") || err.contains("no server running") {
        return Ok(());
    }
    Err(format!("ssh {dest}: {}", err.trim()))
}
