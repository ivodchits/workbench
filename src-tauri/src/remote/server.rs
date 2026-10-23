//! The axum router for the remote access server (steps 4.3, 4.4).
//!
//! Runs on Tauri's async runtime, bound to the Tailscale interface and loopback by the
//! parent module (one task per listener, same router). Loopback is where Tailscale
//! Funnel delivers public requests (step R3), so a loopback peer's `X-Forwarded-*`
//! headers name the real client and host. Routes split into the **PWA shell** (unauthenticated static assets, served so
//! the companion can install + load offline) and the **data plane** (bearer-gated):
//!
//! - `GET /` — the phone-optimized dashboard PWA (step 4.4): one self-contained page,
//!   script, styles and terminal emulator included. Unauthenticated.
//! - `GET /manifest.webmanifest`, `GET /sw.js`, `GET /icon-*.png` — the PWA shell: web
//!   app manifest, service worker, and icons. Unauthenticated — the browser fetches them
//!   before any token exists, and the service worker needs them to make the app
//!   installable + show "offline" when the desktop is down (design §11).
//! - `POST /pair` — exchange a one-time pairing code for a device bearer token, which
//!   works once the device is approved on the desktop. Unauthenticated (the code *is*
//!   the gate), rate-limited and locked out after wrong codes (`auth::PairGate`).
//! - `GET /api/auth/challenge`, `POST /api/auth/session` — a device key's proof
//!   (assistant plan R3): a fresh challenge (unauthenticated), then the device token
//!   with the challenge signed, for a session token that stands in for the device
//!   token from then on. A device that paired with a key needs one; its token alone is
//!   refused everywhere else.
//! - `POST /share` — where Android sends a share when the service worker isn't there
//!   to take it (R3; it reads the share and hands it to the page). A navigation can't
//!   carry the token, so this only sends the page to say the share was lost.
//! - `GET /api/state` — the latest webview snapshot (auth: `Authorization: Bearer`).
//!   Also how a phone learns where it stands: 401 for an unknown token, 403 while it
//!   waits for approval.
//! - `GET /api/ws` — WebSocket: pushes the snapshot on connect and on every change, and
//!   accepts inbound action messages (auth: the token as a `wb-token.<token>`
//!   subprotocol beside `wb` — a browser can't set an `Authorization` header on a
//!   `WebSocket`, and a query string would put the token in URLs and logs).
//! - `POST /api/action` — submit one action over plain HTTP (auth: bearer). Same effect
//!   as a WS action: forwarded to the webview as `remote-action`.
//! - `GET /api/term` — WebSocket: mirrors one instance's live PTY (step 4.5). Attaches
//!   as a multiplexer subscriber (step 4.1), streams raw output down (with scrollback
//!   replayed on connect) and routes raw keystrokes up (auth: as `/api/ws`;
//!   `?instance=` picks the console).
//! - `GET /api/transcript` — WebSocket: one instance's conversation, history paged on
//!   request and appended lines live (step R4, [`super::transcript`]).
//! - `/api/assistant…` — Duck (step R1, [`super::assistant`]): its WebSocket (auth as
//!   `/api/ws`), the phone's voice clips and its spoken replies (auth: bearer).
//! - `/api/notes…` — a project's notes, read and written through the N1 notes module
//!   (step R8, [`super::notes`]). Auth: bearer.
//!
//! Auth is the parent's `check_token` (constant-time, approval and expiry aware); a
//! grant also refreshes the device's `last_seen` and address. Both WebSockets refuse an
//! upgrade whose `Origin` is not this server, and close when their device loses access. As a submodule of `remote`, this file can reach
//! the parent's private state and helpers directly. All PWA assets are `include_*!`'d
//! into the binary so there's nothing to ship alongside it.
//!
//! The page and the service worker are **built** (step R1): `npm run build:pwa` turns
//! `src/pwa/` into `pwa/dist/`, which is not committed. `npm run dev` and `npm run
//! build` do it first, so `tauri dev` / `tauri build` need nothing extra; a bare
//! `cargo build` on a fresh clone is stopped by `build.rs` with that instruction.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::{Emitter, Manager};
use tokio::sync::broadcast;

use super::auth::{self, PairOutcome};
use super::{
    check_token, device_valid, log_failure, start_session, try_pair, Access, RemoteState,
    SessionRefusal,
};
use crate::pty::{PtyManager, RemoteMsg};

/// Spawn the server on Tauri's runtime and return its task handle. The parent aborts
/// the handle to stop the server (dropping the listener frees the port immediately).
pub fn serve(listener: std::net::TcpListener, state: Arc<RemoteState>) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(listener, state).await {
            eprintln!("[remote] server stopped: {e}");
        }
    })
}

async fn run(listener: std::net::TcpListener, state: Arc<RemoteState>) -> std::io::Result<()> {
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let router = Router::new()
        .route("/", get(index))
        // PWA shell — static, unauthenticated, installable + offline-capable.
        .route("/manifest.webmanifest", get(manifest))
        .route("/sw.js", get(service_worker))
        .route("/icon-192.png", get(icon_192))
        .route("/icon-512.png", get(icon_512))
        .route("/icon-maskable-512.png", get(icon_maskable))
        // The app shortcuts' icons (assistant plan R3).
        .route("/icon-talk-96.png", get(|| async { png(include_bytes!("pwa/icon-talk-96.png")) }))
        .route("/icon-chat-96.png", get(|| async { png(include_bytes!("pwa/icon-chat-96.png")) }))
        .route("/icon-task-96.png", get(|| async { png(include_bytes!("pwa/icon-task-96.png")) }))
        .route("/icon-status-96.png", get(|| async { png(include_bytes!("pwa/icon-status-96.png")) }))
        .route("/pair", post(pair))
        // Device keys and shares (assistant plan R3).
        .route("/api/auth/challenge", get(auth_challenge))
        .route("/api/auth/session", post(auth_session))
        .route("/share", post(share_lost))
        .route("/api/state", get(api_state))
        .route("/api/ws", get(api_ws))
        .route("/api/action", post(api_action))
        .route("/api/term", get(api_term))
        .route("/api/transcript", get(super::transcript::api_transcript))
        // Duck (step R1).
        .route("/api/assistant", get(super::assistant::api_assistant))
        .route(
            "/api/assistant/audio",
            post(super::assistant::audio).layer(DefaultBodyLimit::max(super::assistant::AUDIO_BODY_MAX)),
        )
        .route("/api/assistant/tts/{id}", get(super::assistant::tts))
        // Project notes (step R8), through the N1 notes module.
        .route("/api/notes", get(super::notes::counts))
        .route("/api/notes/list", get(super::notes::list))
        .route("/api/notes/read", get(super::notes::read))
        .route("/api/notes/create", post(super::notes::create))
        .route("/api/notes/save", post(super::notes::save))
        .route("/api/notes/rename", post(super::notes::rename))
        .route("/api/notes/delete", post(super::notes::delete))
        // Web Push (step R6).
        .route("/api/push", get(super::push::status))
        .route("/api/push/subscribe", post(super::push::subscribe))
        .route("/api/push/unsubscribe", post(super::push::unsubscribe))
        .route("/api/push/mute", post(super::push::mute))
        // A reminder push's Done and Snooze (step H4): its one-use token is the key.
        .route("/api/reminders/action", post(super::push::reminder_action))
        .with_state(state);
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
}

/// The phone-optimized dashboard PWA (step 4.4), as built from `src/pwa/`.
async fn index() -> Html<&'static str> {
    Html(include_str!("pwa/dist/index.html"))
}

/// The web app manifest that makes the dashboard installable (Add to Home Screen).
async fn manifest() -> Response {
    (
        [(header::CONTENT_TYPE, "application/manifest+json")],
        include_str!("pwa/manifest.webmanifest"),
    )
        .into_response()
}

/// The service worker. `Service-Worker-Allowed: /` lets a script served from `/sw.js`
/// claim the whole-origin scope it declares; the no-store header keeps the browser from
/// pinning a stale worker (updates ride the cache name inside the script, which the
/// build derives from the shell's content).
async fn service_worker() -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/javascript"),
            (
                header::HeaderName::from_static("service-worker-allowed"),
                "/",
            ),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        include_str!("pwa/dist/sw.js"),
    )
        .into_response()
}

/// Serve one embedded PNG icon with a long-lived cache (icons are content-addressed by
/// name and never change within a build).
fn png(bytes: &'static [u8]) -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=604800"),
        ],
        bytes,
    )
        .into_response()
}

async fn icon_192() -> Response {
    png(include_bytes!("pwa/icon-192.png"))
}
async fn icon_512() -> Response {
    png(include_bytes!("pwa/icon-512.png"))
}
async fn icon_maskable() -> Response {
    png(include_bytes!("pwa/icon-maskable-512.png"))
}

#[derive(Deserialize)]
struct PairReq {
    code: String,
    #[serde(default)]
    name: String,
    /// The device key's public half (assistant R3), when the browser could make one.
    #[serde(default, rename = "publicKey")]
    public_key: Option<String>,
}

/// Exchange a valid pairing code for a device token (which waits for approval on the
/// desktop), or say why not.
async fn pair(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<PairReq>,
) -> Response {
    let name = if req.name.trim().is_empty() {
        "device".to_string()
    } else {
        req.name.trim().to_string()
    };
    let addr = client_addr(peer, &headers);
    let (status, error) = match try_pair(&state, &req.code, &name, &addr, req.public_key.as_deref()) {
        Ok((token, bound)) => {
            return (
                StatusCode::OK,
                Json(json!({ "token": token, "pending": true, "bound": bound })),
            )
                .into_response()
        }
        Err(PairOutcome::Wrong { left }) => (
            StatusCode::UNAUTHORIZED,
            format!(
                "Wrong code — {left} more {} on it.",
                if left == 1 { "try" } else { "tries" }
            ),
        ),
        Err(PairOutcome::NoCode) => (
            StatusCode::UNAUTHORIZED,
            "No pairing code is live — generate one in Workbench → remote access.".into(),
        ),
        Err(PairOutcome::Locked) => (
            StatusCode::TOO_MANY_REQUESTS,
            "Too many wrong codes — generate a new code in Workbench.".into(),
        ),
        Err(PairOutcome::Busy | PairOutcome::Paired) => (
            StatusCode::TOO_MANY_REQUESTS,
            "Too many attempts — wait a minute and try again.".into(),
        ),
    };
    (status, Json(json!({ "error": error }))).into_response()
}

/// A challenge for a device key to sign. Unauthenticated: it proves nothing until
/// signed, and answers once.
async fn auth_challenge(State(state): State<Arc<RemoteState>>) -> Response {
    let nonce = state.inner.lock().unwrap().challenges.issue(super::now());
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "challenge": nonce })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct SessionReq {
    challenge: String,
    signature: String,
}

/// Trade the device token and a signed challenge for a session. 401: pair again; 403:
/// waiting for approval; 409: ask for a new challenge (`stale`) or use the token
/// (`noKey`).
async fn auth_session(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<SessionReq>,
) -> Response {
    let addr = client_addr(peer, &headers);
    match start_session(&state, bearer(&headers).as_deref(), &req.challenge, &req.signature, &addr) {
        Ok(session) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({ "session": session })),
        )
            .into_response(),
        Err(SessionRefusal::Denied) => StatusCode::UNAUTHORIZED.into_response(),
        Err(SessionRefusal::Pending) => (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "waiting for approval on the desktop", "pending": true })),
        )
            .into_response(),
        Err(SessionRefusal::NoKey) => (StatusCode::CONFLICT, Json(json!({ "error": "noKey" }))).into_response(),
        Err(SessionRefusal::Stale) => (StatusCode::CONFLICT, Json(json!({ "error": "stale" }))).into_response(),
    }
}

/// A share that reached the server: the service worker wasn't running to take it.
async fn share_lost() -> Response {
    (StatusCode::SEE_OTHER, [(header::LOCATION, "/?duck=share-lost")]).into_response()
}

/// One header as text, when present and readable.
fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Who is asking, for the device list and the failure log. Tailscale Funnel delivers
/// public requests to the loopback listener and names the real client in
/// `X-Forwarded-For`; only a loopback peer is believed when it says so (anything that
/// can reach loopback is on this machine already).
pub(super) fn client_addr(peer: SocketAddr, headers: &HeaderMap) -> String {
    if peer.ip().is_loopback() {
        let forwarded = header_str(headers, "x-forwarded-for")
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty());
        if let Some(addr) = forwarded {
            return addr.to_string();
        }
    }
    peer.ip().to_string()
}

/// Pull the bearer token out of an `Authorization: Bearer <token>` header.
pub(super) fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    raw.strip_prefix("Bearer ").map(|s| s.trim().to_string())
}

/// The token offered as a `wb-token.<token>` WebSocket subprotocol.
fn subprotocol_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::SEC_WEBSOCKET_PROTOCOL)?.to_str().ok()?;
    raw.split(',')
        .find_map(|p| p.trim().strip_prefix("wb-token."))
        .map(str::to_string)
}

/// The subprotocol a WebSocket answer names. The phone offers it beside its token, and
/// a browser drops a connection whose answer names none of what it offered.
pub(super) const SUBPROTOCOL: &str = "wb";

#[allow(clippy::result_large_err)] // a refusal is built once per refused request
/// The device behind `token`, or the refusal to send: 401 for no access, 403 while the
/// device waits for approval.
pub(super) fn authed(
    state: &Arc<RemoteState>,
    token: Option<&str>,
    addr: &str,
) -> Result<String, Response> {
    match check_token(state, token, addr) {
        Access::Granted(id) => Ok(id),
        Access::Pending => Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "waiting for approval on the desktop", "pending": true })),
        )
            .into_response()),
        Access::Denied => Err(StatusCode::UNAUTHORIZED.into_response()),
    }
}

#[allow(clippy::result_large_err)] // a refusal is built once per refused request
/// Check a WebSocket upgrade: from this server's own page, with a device token. Behind
/// Funnel the page's host is the public name, which a proxy may pass on as
/// `X-Forwarded-Host` (believed from a loopback peer only, as in [`client_addr`]).
pub(super) fn ws_authed(
    state: &Arc<RemoteState>,
    headers: &HeaderMap,
    peer: SocketAddr,
) -> Result<String, Response> {
    let addr = client_addr(peer, headers);
    let origin = header_str(headers, "origin");
    let host = header_str(headers, "host");
    let forwarded_host = peer
        .ip()
        .is_loopback()
        .then(|| header_str(headers, "x-forwarded-host"))
        .flatten();
    let own = auth::origin_ok(origin, host)
        || (forwarded_host.is_some() && auth::origin_ok(origin, forwarded_host));
    if !own {
        log_failure(
            state,
            &addr,
            &format!("WebSocket from another site ({})", origin.unwrap_or("")),
        );
        return Err(StatusCode::FORBIDDEN.into_response());
    }
    authed(state, subprotocol_token(headers).as_deref(), &addr)
}

/// Serve the latest snapshot JSON (auth: bearer header).
async fn api_state(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let addr = client_addr(peer, &headers);
    if let Err(refusal) = authed(&state, bearer(&headers).as_deref(), &addr) {
        return refusal;
    }
    let snap = state.inner.lock().unwrap().snapshot.clone();
    ([(header::CONTENT_TYPE, "application/json")], snap).into_response()
}

/// Submit one action over HTTP (auth: bearer header). The body is a JSON action object
/// forwarded verbatim to the webview as `remote-action`.
async fn api_action(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let addr = client_addr(peer, &headers);
    if let Err(refusal) = authed(&state, bearer(&headers).as_deref(), &addr) {
        return refusal;
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(action) => {
            let _ = state.app.emit("remote-action", action);
            StatusCode::OK.into_response()
        }
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

/// Upgrade to the dashboard WebSocket (auth: the token subprotocol).
async fn api_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let device = match ws_authed(&state, &headers, peer) {
        Ok(id) => id,
        Err(refusal) => return refusal,
    };
    ws.protocols([SUBPROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state, device))
}

/// Per-connection loop: push the current snapshot immediately, then forward every
/// broadcast snapshot to the client while forwarding inbound action frames to the
/// webview. Ends when either side closes, or when the device loses access.
async fn handle_socket(mut socket: WebSocket, state: Arc<RemoteState>, device: String) {
    let mut kick = state.kick.subscribe();
    // Snapshot + a subscription to the live channel, taken together under the lock. If
    // the server has since stopped (no channel), close immediately.
    let (initial, mut rx) = {
        let inner = state.inner.lock().unwrap();
        match &inner.tx {
            Some(tx) => (inner.snapshot.clone(), tx.subscribe()),
            None => return,
        }
    };
    if socket.send(Message::Text(initial.into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            // Outbound: a new snapshot to relay.
            update = rx.recv() => match update {
                Ok(snap) => {
                    if socket.send(Message::Text(snap.into())).await.is_err() {
                        break;
                    }
                }
                // Dropped some frames under load — the next full snapshot recovers us.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            // The device was revoked, or the server stopped.
            _ = kick.changed() => {
                if !device_valid(&state, &device) {
                    break;
                }
            },
            // Inbound: an action message, or a close.
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    if let Ok(action) = serde_json::from_str::<Value>(t.as_str()) {
                        let _ = state.app.emit("remote-action", action);
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                // Ping/Pong/Binary: ignore (axum auto-replies to pings).
                _ => {}
            },
        }
    }
}

#[derive(Deserialize)]
struct TermQuery {
    /// The instance whose console to mirror.
    #[serde(default)]
    instance: String,
}

/// Upgrade to the **terminal-mirror** WebSocket (step 4.5, design §11 Phase B): one
/// instance's live PTY bytes stream down, its raw keystrokes go back up. Auth as
/// `/api/ws`; `?instance=` selects the console.
///
/// This carries *only* raw bytes. Structured approve/deny stay on the action channel
/// (`/api/ws` → the webview's one action handler), so the keystroke mapping lives in
/// exactly one place (the §11 caveat) and the desktop status machine is untouched.
async fn api_term(
    ws: WebSocketUpgrade,
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TermQuery>,
) -> Response {
    let device = match ws_authed(&state, &headers, peer) {
        Ok(id) => id,
        Err(refusal) => return refusal,
    };
    ws.protocols([SUBPROTOCOL])
        .on_upgrade(move |socket| handle_term(socket, state, q.instance, device))
}

/// Per-terminal loop: subscribe to the instance's PTY multiplexer (step 4.1) — which
/// replays the scrollback ring on attach — send the source size, then relay live
/// output to the socket while forwarding the phone's raw keystrokes to the PTY's
/// single write path. The phone is just another multiplexer subscriber, so its
/// keystrokes already interleave correctly with the desktop's. Ends on either side
/// closing, the PTY being torn down (its sender drops, so `rx.recv()` yields `None`),
/// or the device losing access.
async fn handle_term(
    mut socket: WebSocket,
    state: Arc<RemoteState>,
    instance_id: String,
    device: String,
) {
    let mut kick = state.kick.subscribe();
    let mgr = state.app.state::<PtyManager>();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<RemoteMsg>();
    let (sub_id, (cols, rows)) = match mgr.subscribe_remote(&instance_id, tx) {
        Some(v) => v,
        None => {
            // No live PTY — tell the client so it can show "not running" and offer to
            // start the instance (a structured `start` action over `/api/ws`).
            let _ = socket
                .send(Message::Text(r#"{"type":"notrunning"}"#.into()))
                .await;
            return;
        }
    };
    // Announce the source terminal's dimensions before the replayed ring arrives, so
    // the phone resizes its xterm to match and renders the TUI at the right width
    // rather than reflowing desktop-width lines. Same socket → ordered ahead of the
    // ring bytes queued in `rx`.
    if socket.send(size_message(cols, rows)).await.is_err() {
        mgr.unsubscribe(&instance_id, sub_id);
        return;
    }
    loop {
        tokio::select! {
            // Outbound: a chunk of live (or replayed) PTY output, or the PTY's new
            // size. Both come down the one queue, so a size change reaches the phone
            // before the first bytes laid out for it.
            out = rx.recv() => match out {
                Some(msg) => {
                    let frame = match msg {
                        RemoteMsg::Bytes(bytes) => Message::Binary(bytes.into()),
                        RemoteMsg::Size(cols, rows) => size_message(cols, rows),
                    };
                    if socket.send(frame).await.is_err() {
                        break;
                    }
                }
                None => break, // PTY torn down — the hub dropped our sender.
            },
            _ = kick.changed() => {
                if !device_valid(&state, &device) {
                    break;
                }
            },
            // Inbound: raw keystroke bytes from the phone keyboard.
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Binary(b))) => {
                    let _ = mgr.write_input(&instance_id, &b);
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                // Text frames are reserved for future control messages; ignore for now.
                _ => {}
            },
        }
    }
    mgr.unsubscribe(&instance_id, sub_id);
}

/// The control frame that tells the phone what size the PTY is.
fn size_message(cols: u16, rows: u16) -> Message {
    Message::Text(format!(r#"{{"type":"size","cols":{cols},"rows":{rows}}}"#).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_protocols(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::SEC_WEBSOCKET_PROTOCOL, value.parse().unwrap());
        h
    }

    /// A forwarded client address is believed from loopback (Funnel's proxy) only.
    #[test]
    fn reads_the_client_address() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "203.0.113.7, 10.0.0.1".parse().unwrap());
        let local: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let tailnet: SocketAddr = "100.70.1.2:5000".parse().unwrap();
        assert_eq!(client_addr(local, &h), "203.0.113.7");
        assert_eq!(client_addr(tailnet, &h), "100.70.1.2");
        assert_eq!(client_addr(local, &HeaderMap::new()), "127.0.0.1");
    }

    /// The phone offers `wb` and `wb-token.<token>`; the token is read from the latter
    /// in either order, and nothing else passes for one.
    #[test]
    fn reads_the_token_subprotocol() {
        assert_eq!(
            subprotocol_token(&with_protocols("wb, wb-token.abc123")).as_deref(),
            Some("abc123")
        );
        assert_eq!(
            subprotocol_token(&with_protocols("wb-token.abc123,wb")).as_deref(),
            Some("abc123")
        );
        assert_eq!(subprotocol_token(&with_protocols("wb")), None);
        assert_eq!(subprotocol_token(&HeaderMap::new()), None);
    }
}
