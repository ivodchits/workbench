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
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::Router;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::events::{HookEnvelope, HookEvent};
use super::install::{HOOK_PATH, INSTANCE_HEADER};
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
        // The managed statusline POSTs Claude Code's statusline JSON here so the
        // account-wide usage meter (step 3.2) can read its `rate_limits`.
        .route(crate::statusline::INGEST_PATH, post(handle_statusline))
        .with_state(ctx);
    axum::serve(listener, router).await
}

/// The outcome of inspecting one hook POST.
enum Decision {
    /// Passed the session-id filter — forward this to the frontend.
    Accept(Box<HookEnvelope>),
    /// A well-formed event from a session Workbench didn't mint. Carries the parsed
    /// event so the handler can attempt cwd-adoption for a rotated session
    /// (`/clear` / `/compact`) before finally dropping it.
    Drop(Box<HookEvent>),
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
        None => Decision::Drop(Box::new(event)),
    }
}

/// Handle one hook POST. Always returns `200` — pure observation, never blocking.
async fn handle(
    State(ctx): State<Arc<HookContext>>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    ctx.received.fetch_add(1, Ordering::Relaxed);
    let pty = ctx.app.state::<PtyManager>();
    let named = named_instance(&headers);
    let decision = classify(&body, |sid| pty.instance_for_session(sid));
    let envelope = match decision {
        Decision::Accept(envelope) => {
            // A `/clear` rotates the session id: the OLD (still-mapped) id emits
            // `SessionEnd{reason:"clear"}`, then the new id appears unmapped and is
            // re-correlated by cwd. Flag this instance as the only legitimate
            // adoption target for that rotation, so a co-located *working* instance
            // (or a foreign `claude`) sharing the cwd can never absorb the rotated
            // session — the bug where closing the masking siblings let a stray
            // clear-rotation flip a working card to idle.
            // An in-console `/resume` swaps the session the same way.
            if is_rotation(&envelope.event) {
                pty.mark_pending_rotation(&envelope.instance_id);
            }
            Some(envelope)
        }
        // A dropped event may be from a session Claude rotated under us (`/clear`):
        // adopt it by cwd into the instance flagged pending-rotation, otherwise it's
        // genuinely foreign and stays dropped.
        Decision::Drop(event) => {
            // DIAGNOSTIC (resume/status investigation): log the id+cwd of an event
            // that the session-id filter rejected, distinguishing "arrived but not
            // ours" (this fires) from "never arrived" (nothing logged, agent idle).
            // The `[hooks] drop`/`adopt` lines are visible in the `tauri dev` console.
            let sid = event.session_id.clone();
            let cwd = event.cwd.clone();
            let name = event.hook_event_name.clone().unwrap_or_default();
            match adopt(&pty, *event, named.as_deref()) {
                Some(env) => {
                    eprintln!(
                        "[hooks] adopt: session={sid} cwd={cwd:?} event={name} -> instance={}",
                        env.instance_id
                    );
                    Some(Box::new(env))
                }
                None => {
                    eprintln!(
                        "[hooks] drop: session={sid} cwd={cwd:?} event={name} (no Workbench instance owns this session id)"
                    );
                    None
                }
            }
        }
        Decision::Ignore => None,
    };
    match envelope {
        Some(envelope) => {
            ctx.accepted.fetch_add(1, Ordering::Relaxed);
            // Hand the session's transcript path to the transcript stream (step T1)
            // and wake this instance's follow, so a `/clear` rotation is acted on
            // now rather than at its next poll.
            crate::transcript::stream::on_hook(
                &ctx.app,
                &envelope.instance_id,
                &envelope.event.session_id,
                envelope.event.transcript_path.as_deref(),
                is_clear_rotation(&envelope.event),
            );
            let _ = ctx.app.emit(HOOK_EVENT, *envelope);
        }
        None => {
            ctx.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    StatusCode::OK
}

/// Receive the managed statusline's POST (step 3.2): the statusline JSON Claude Code
/// pipes to a custom command, carrying account-wide `rate_limits`. Pure observation,
/// always `200`. Deliberately *not* session-filtered — rate limits are account-global,
/// so any session's statusline (even a foreign `claude`) reports the same figures, and
/// `ingest` just keeps the newest snapshot.
async fn handle_statusline(State(ctx): State<Arc<HookContext>>, body: Bytes) -> StatusCode {
    crate::statusline::ingest(&ctx.app, &body);
    StatusCode::OK
}

/// The instance a hook says it came from: the `WORKBENCH_INSTANCE_ID` its `claude`
/// was spawned with, echoed in [`INSTANCE_HEADER`]. `None` for a `claude` Workbench
/// didn't start, whose header arrives empty — or as the bare `$VAR` reference, if
/// the variable is left uninterpolated.
fn named_instance(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(INSTANCE_HEADER)?.to_str().ok()?.trim();
    (!value.is_empty() && !value.starts_with('$')).then(|| value.to_string())
}

/// Try to rescue a dropped event by re-correlating it to a live instance. First by
/// the instance its hook named, when that console is expecting a new session —
/// it just rotated, or this is the `SessionStart` of an in-console `/resume` or
/// `/clear` (see [`is_session_switch`]); otherwise by working dir, as below.
///
/// The working-dir path covers a console spawned before its hooks carried the
/// instance header. `/clear` and `/compact` mint a fresh session id
/// that keeps running in the same cwd, and the first rotated event we see may be a
/// prompt or tool event (not necessarily `SessionStart`) — every event carries
/// `cwd`, so any of them can re-register the mapping. Returns the instance-tagged
/// envelope on success; a genuinely foreign session (no live instance in that dir)
/// matches nothing and stays dropped.
fn adopt(pty: &PtyManager, event: HookEvent, named: Option<&str>) -> Option<HookEnvelope> {
    let by_name = named.filter(|id| {
        (pty.is_pending_rotation(id) || is_session_switch(&event))
            && pty.adopt_session_for_instance(&event.session_id, id)
    });
    let instance_id = match by_name {
        Some(id) => id.to_string(),
        None => pty.adopt_session_for_cwd(&event.session_id, event.cwd.as_deref()?)?,
    };
    Some(HookEnvelope {
        instance_id,
        received_at: now(),
        event,
    })
}

/// True iff this event is a `/clear` rotation: a `SessionEnd` carrying
/// `reason:"clear"`. Such an event is the signal that the emitting instance is
/// about to keep running under a fresh session id, so it (and only it) becomes the
/// adoption target for the next unmapped session in its cwd. Other `SessionEnd`
/// reasons (`prompt_input_exit` / `logout` / `other`) are genuine deaths, not
/// rotations, and must not flag a pending adoption.
fn is_clear_rotation(event: &HookEvent) -> bool {
    end_reason(event) == Some("clear")
}

/// True iff the emitting console keeps running under another session id: a
/// `/clear`, or an in-console `/resume` (`SessionEnd{reason:"resume"}`). Either
/// makes the instance an adoption target for the session that replaces it.
fn is_rotation(event: &HookEvent) -> bool {
    matches!(end_reason(event), Some("clear" | "resume"))
}

/// The `reason` of a `SessionEnd`; `None` for any other event.
fn end_reason(event: &HookEvent) -> Option<&str> {
    if event.hook_event_name.as_deref() != Some("SessionEnd") {
        return None;
    }
    event.rest.get("reason").and_then(|v| v.as_str())
}

/// True iff this is the `SessionStart` of a console switching sessions in place
/// (`source` `resume`, `clear` or `compact`). A `claude` started *inside* a
/// console — by a tool call, say — inherits its instance id but starts with
/// `source:"startup"`, so it is never mistaken for the console's own session.
fn is_session_switch(event: &HookEvent) -> bool {
    event.hook_event_name.as_deref() == Some("SessionStart")
        && matches!(
            event.rest.get("source").and_then(|v| v.as_str()),
            Some("resume" | "clear" | "compact")
        )
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
        assert!(matches!(classify(body, resolve), Decision::Drop(_)));
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

    /// Only `SessionEnd{reason:"clear"}` is a `/clear` — the signal that the
    /// session id is being re-minted in the same cwd. Other `SessionEnd` reasons
    /// are genuine deaths or (`resume`) a rotation that isn't a clear.
    #[test]
    fn clear_rotation_is_detected() {
        let parse = |body: &[u8]| serde_json::from_slice::<HookEvent>(body).unwrap();
        assert!(is_clear_rotation(&parse(
            br#"{"session_id":"a","hook_event_name":"SessionEnd","reason":"clear"}"#
        )));
        // A real end (not a rotation) — must not flag.
        assert!(!is_clear_rotation(&parse(
            br#"{"session_id":"a","hook_event_name":"SessionEnd","reason":"logout"}"#
        )));
        // SessionEnd with no reason — must not flag.
        assert!(!is_clear_rotation(&parse(
            br#"{"session_id":"a","hook_event_name":"SessionEnd"}"#
        )));
        // The right reason on the wrong event — must not flag.
        assert!(!is_clear_rotation(&parse(
            br#"{"session_id":"a","hook_event_name":"Stop","reason":"clear"}"#
        )));
    }

    /// A `/clear` or an in-console `/resume` keeps the console running under a new
    /// session id, so both make the instance an adoption target; a real end doesn't.
    #[test]
    fn clear_and_resume_are_rotations() {
        let parse = |body: &[u8]| serde_json::from_slice::<HookEvent>(body).unwrap();
        for reason in ["clear", "resume"] {
            let body = format!(
                r#"{{"session_id":"a","hook_event_name":"SessionEnd","reason":"{reason}"}}"#
            );
            assert!(is_rotation(&parse(body.as_bytes())), "{reason}");
        }
        assert!(!is_rotation(&parse(
            br#"{"session_id":"a","hook_event_name":"SessionEnd","reason":"prompt_input_exit"}"#
        )));
        assert!(!is_clear_rotation(&parse(
            br#"{"session_id":"a","hook_event_name":"SessionEnd","reason":"resume"}"#
        )));
    }

    /// A console switching sessions in place starts the new one with `source`
    /// `resume` / `clear` / `compact`; a `claude` launched inside the console (which
    /// inherits its instance id) starts with `startup` and must not take it over.
    #[test]
    fn session_switch_excludes_nested_startups() {
        let parse = |body: &[u8]| serde_json::from_slice::<HookEvent>(body).unwrap();
        for source in ["resume", "clear", "compact"] {
            let body = format!(
                r#"{{"session_id":"b","hook_event_name":"SessionStart","source":"{source}"}}"#
            );
            assert!(is_session_switch(&parse(body.as_bytes())), "{source}");
        }
        assert!(!is_session_switch(&parse(
            br#"{"session_id":"b","hook_event_name":"SessionStart","source":"startup"}"#
        )));
        assert!(!is_session_switch(&parse(
            br#"{"session_id":"b","hook_event_name":"UserPromptSubmit","source":"resume"}"#
        )));
    }

    /// The instance header counts only when it carries a value: a `claude` Workbench
    /// didn't start sends it empty, or as the uninterpolated `$VAR`.
    #[test]
    fn reads_the_named_instance() {
        let with = |value: &str| {
            let mut h = HeaderMap::new();
            h.insert(INSTANCE_HEADER, value.parse().unwrap());
            h
        };
        assert_eq!(named_instance(&with("inst-1")).as_deref(), Some("inst-1"));
        assert_eq!(named_instance(&with("")), None);
        assert_eq!(named_instance(&with("$WORKBENCH_INSTANCE_ID")), None);
        assert_eq!(named_instance(&HeaderMap::new()), None);
    }
}
