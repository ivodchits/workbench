//! Hook bridge (step 2.1).
//!
//! The local endpoint that turns Claude Code's hook stream into Workbench state.
//! On startup we: pick a port (the persisted one if still free, else a fresh one),
//! persist it, install user-level `http` hooks pointing at it (see [`install`]),
//! and start the [`server`]. The server filters events by `session_id` and forwards
//! the survivors to the frontend. The status state machine that consumes them is
//! step 2.2; notifications are 2.3.

mod events;
mod install;
mod server;

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::db::Db;
use server::HookContext;
pub use server::HookStatus;

/// `meta` key under which the chosen hook-server port is persisted, so the URL we
/// write into `~/.claude/settings.json` is stable across launches.
const PORT_KEY: &str = "hook_server_port";

/// Preferred base port; we walk upward from here if it's taken. Chosen in the
/// IANA dynamic/private range to avoid clashing with common dev servers. A debug
/// build starts from a different base so it doesn't race a release instance for the
/// same port (each also persists its own choice in its own `meta` table).
const PORT_BASE: u16 = if cfg!(debug_assertions) { 49010 } else { 48970 };
const PORT_SPAN: u16 = 32;

/// Start the hook bridge: bind a port, persist it, install hooks, serve. Failures
/// are returned so the caller can log them — a missing hook server degrades the
/// status engine but must never stop the app from launching.
pub fn init(app: &AppHandle) -> Result<u16, String> {
    let db = app.state::<Db>();
    let persisted = db
        .meta_get(PORT_KEY)
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u16>().ok());

    let listener = bind_listener(persisted)?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("reading bound port: {e}"))?
        .port();

    // Persist the actual port and (re)install hooks to match it. An install error
    // is non-fatal: the server still runs, the user just won't get events until the
    // settings file is fixed.
    let _ = db.meta_set(PORT_KEY, &port.to_string());
    if let Err(e) = install::install_hooks(port) {
        eprintln!("[hooks] could not install hooks: {e}");
    }

    let ctx = Arc::new(HookContext::new(app.clone(), port));
    app.manage(ctx.clone());
    server::serve(listener, ctx);
    Ok(port)
}

/// Bind a loopback listener, preferring `persisted` then walking the
/// `PORT_BASE..` range. Returning the bound listener (rather than just a port)
/// avoids a TOCTOU race — the server serves on this exact socket.
fn bind_listener(persisted: Option<u16>) -> Result<std::net::TcpListener, String> {
    let mut last_err = String::new();
    for port in persisted.into_iter().chain(PORT_BASE..PORT_BASE + PORT_SPAN) {
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => return Ok(l),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!("no free port near {PORT_BASE}: {last_err}"))
}

/// Current hook server status (port, listening, event counters) for the UI.
#[tauri::command]
pub fn hook_server_status(ctx: State<'_, Arc<HookContext>>) -> HookStatus {
    ctx.status()
}
