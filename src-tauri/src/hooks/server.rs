//! The local hook endpoint (step 2.1).
//!
//! A tiny `axum` server on `127.0.0.1:<port>` that receives the `http` hooks
//! Claude Code POSTs. It is **pure observation**: every request returns `200` and
//! the server never blocks or steers Claude (design §4.4 — non-2xx from an http
//! hook is non-blocking anyway, but we don't even rely on that; we just always
//! succeed). The two jobs here are:
//!
//! 1. **Filter by `session_id`** — drop any event from a session Workbench didn't
//!    mint (decision 10). This is wired in from day one so the rail never fills
//!    with phantom cards from unrelated `claude` runs on the machine.
//! 2. **Forward** accepted events to the frontend as a `hook-event`, tagged with
//!    the resolved `instance_id`. The Phase-2 status state machine (step 2.2)
//!    consumes that stream; here we only route.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::events::{HookEnvelope, HookEvent};
use super::install::HOOK_PATH;
use crate::pty::PtyManager;

/// The Tauri event name carrying accepted, instance-tagged hook events.
const HOOK_EVENT: &str = "hook-event";

/// Shared server state: the app handle (to resolve sessions and emit events) plus
/// observability counters. Managed by Tauri so the `hook_server_status` command can
/// read it.
pub struct HookContext {
    app: AppHandle,
    port: u16,
    received: AtomicU64,
    accepted: AtomicU64,
    dropped: AtomicU64,
}

impl HookContext {
    pub fn new(app: AppHandle, port: u16) -> Self {
        Self {
            app,
            port,
            received: AtomicU64::new(0),
            accepted: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
        }
    }

    pub fn status(&self) -> HookStatus {
        HookStatus {
            port: self.port,
            listening: true,
            received: self.received.load(Ordering::Relaxed),
            accepted: self.accepted.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
        }
    }
}

/// Snapshot of the hook server for the frontend status readout.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub port: u16,
    pub listening: bool,
    /// Total POSTs received (including foreign + malformed).
    pub received: u64,
    /// Events that passed the session-id filter and were forwarded.
    pub accepted: u64,
    /// Events dropped because their session isn't a Workbench instance.
    pub dropped: u64,
}

/// Serve hook requests on `listener` until the runtime shuts down. Consumes the
/// already-bound std listener (so the port we advertised is the one we serve) and
/// runs on Tauri's async runtime.
pub fn serve(listener: std::net::TcpListener, ctx: Arc<HookContext>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(listener, ctx).await {
            eprintln!("[hooks] server stopped: {e}");
        }
    });
}

async fn run(listener: std::net::TcpListener, ctx: Arc<HookContext>) -> std::io::Result<()> {
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let router = Router::new()
        .route(HOOK_PATH, post(handle))
        .with_state(ctx);
    axum::serve(listener, router).await
}

/// The outcome of inspecting one hook POST.
enum Decision {
    /// Passed the session-id filter — forward this to the frontend.
    Accept(Box<HookEnvelope>),
    /// A well-formed event from a session Workbench didn't mint — drop it.
    Drop,
    /// Unparseable body — ignore it (we never error back at Claude).
    Ignore,
}

/// Pure classification: parse, then run the session-id filter via `resolve`
/// (`session_id → instance_id`). Kept free of the `AppHandle` so the filter
/// behavior — the heart of step 2.1 — is unit-testable.
fn classify(body: &[u8], resolve: impl Fn(&str) -> Option<String>) -> Decision {
    let Ok(event) = serde_json::from_slice::<HookEvent>(body) else {
        return Decision::Ignore;
    };
    match resolve(&event.session_id) {
        Some(instance_id) => Decision::Accept(Box::new(HookEnvelope {
            instance_id,
            received_at: now(),
            event,
        })),
        None => Decision::Drop,
    }
}

/// Handle one hook POST. Always returns `200` — pure observation, never blocking.
async fn handle(State(ctx): State<Arc<HookContext>>, body: Bytes) -> StatusCode {
    ctx.received.fetch_add(1, Ordering::Relaxed);
    let pty = ctx.app.state::<PtyManager>();
    match classify(&body, |sid| pty.instance_for_session(sid)) {
        Decision::Accept(envelope) => {
            ctx.accepted.fetch_add(1, Ordering::Relaxed);
            let _ = ctx.app.emit(HOOK_EVENT, *envelope);
        }
        Decision::Drop => {
            ctx.dropped.fetch_add(1, Ordering::Relaxed);
        }
        Decision::Ignore => {}
    }
    StatusCode::OK
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minted session resolves to its instance and is accepted, carrying the
    /// parsed event through to the envelope.
    #[test]
    fn minted_session_is_accepted() {
        let body = br#"{"session_id":"abc","hook_event_name":"PreToolUse","tool_name":"Bash"}"#;
        let resolve = |sid: &str| (sid == "abc").then(|| "instance-1".to_string());
        match classify(body, resolve) {
            Decision::Accept(env) => {
                assert_eq!(env.instance_id, "instance-1");
                assert_eq!(env.event.hook_event_name.as_deref(), Some("PreToolUse"));
                assert_eq!(env.event.tool_name.as_deref(), Some("Bash"));
            }
            _ => panic!("expected Accept"),
        }
    }

    /// An event from a session Workbench didn't mint is dropped by the filter —
    /// the guard that keeps phantom cards out of the rail (design §4.4).
    #[test]
    fn foreign_session_is_dropped() {
        let body = br#"{"session_id":"someone-elses","hook_event_name":"Stop"}"#;
        let resolve = |_: &str| None; // nothing registered
        assert!(matches!(classify(body, resolve), Decision::Drop));
    }

    /// A malformed body (no `session_id`, or not JSON) is ignored, never errored.
    #[test]
    fn malformed_body_is_ignored() {
        let resolve = |_: &str| Some("x".to_string());
        assert!(matches!(classify(b"{ not json", resolve), Decision::Ignore));
        assert!(matches!(
            classify(br#"{"hook_event_name":"Stop"}"#, resolve),
            Decision::Ignore
        ));
    }

    /// The extra/event-specific fields survive into `rest` for the status machine.
    #[test]
    fn event_specific_fields_are_preserved() {
        let body = br#"{"session_id":"abc","hook_event_name":"Notification","message":"needs approval"}"#;
        let resolve = |_: &str| Some("i".to_string());
        match classify(body, resolve) {
            Decision::Accept(env) => {
                assert_eq!(env.event.rest.get("message").and_then(|v| v.as_str()), Some("needs approval"));
            }
            _ => panic!("expected Accept"),
        }
    }
}
