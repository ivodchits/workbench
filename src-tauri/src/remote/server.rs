//! The axum router for the remote access server (steps 4.3, 4.4).
//!
//! Runs on Tauri's async runtime, bound to the Tailscale interface by the parent
//! module. Routes split into the **PWA shell** (unauthenticated static assets, served so
//! the companion can install + load offline) and the **data plane** (bearer-gated):
//!
//! - `GET /` — the phone-optimized dashboard PWA (step 4.4). Unauthenticated.
//! - `GET /manifest.webmanifest`, `GET /sw.js`, `GET /icon-*.png` — the PWA shell: web
//!   app manifest, service worker, and icons. Unauthenticated — the browser fetches them
//!   before any token exists, and the service worker needs them to make the app
//!   installable + show "offline" when the desktop is down (design §11).
//! - `POST /pair` — exchange a one-time pairing code for a device bearer token.
//!   Unauthenticated (the code *is* the gate).
//! - `GET /api/state` — the latest webview snapshot (auth: `Authorization: Bearer`).
//! - `GET /api/ws` — WebSocket: pushes the snapshot on connect and on every change, and
//!   accepts inbound action messages (auth: `?token=`, since browsers can't set headers
//!   on a `WebSocket`).
//! - `POST /api/action` — submit one action over plain HTTP (auth: bearer). Same effect
//!   as a WS action: forwarded to the webview as `remote-action`.
//!
//! Auth is pure set-membership against the parent's token set (`token_ok`); a hit also
//! refreshes the device's `last_seen`. As a submodule of `remote`, this file can reach
//! the parent's private state and helpers directly. All PWA assets are `include_*!`'d
//! into the binary so there's nothing to ship alongside it.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::Emitter;
use tokio::sync::broadcast;

use super::{token_ok, touch_device, try_pair, RemoteState};

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
        .route("/pair", post(pair))
        .route("/api/state", get(api_state))
        .route("/api/ws", get(api_ws))
        .route("/api/action", post(api_action))
        .with_state(state);
    axum::serve(listener, router).await
}

/// The phone-optimized dashboard PWA (step 4.4).
async fn index() -> Html<&'static str> {
    Html(include_str!("pwa/index.html"))
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
/// pinning a stale worker (updates ride the `CACHE` version inside the script instead).
async fn service_worker() -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/javascript"),
            (header::HeaderName::from_static("service-worker-allowed"), "/"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        include_str!("pwa/sw.js"),
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
}

/// Exchange a valid pairing code for a device token, or 401.
async fn pair(State(state): State<Arc<RemoteState>>, Json(req): Json<PairReq>) -> Response {
    let name = if req.name.trim().is_empty() {
        "device".to_string()
    } else {
        req.name.trim().to_string()
    };
    match try_pair(&state, req.code.trim(), &name) {
        Some(token) => (StatusCode::OK, Json(json!({ "token": token }))).into_response(),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid or expired pairing code" })),
        )
            .into_response(),
    }
}

/// Pull the bearer token out of an `Authorization: Bearer <token>` header.
fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    raw.strip_prefix("Bearer ").map(|s| s.trim().to_string())
}

/// Authenticate a request token against the device set; on success refresh `last_seen`.
fn authed(state: &Arc<RemoteState>, token: Option<&str>) -> bool {
    let token = match token {
        Some(t) => t,
        None => return false,
    };
    let ok = { token_ok(&state.inner.lock().unwrap().tokens, token) };
    if ok {
        touch_device(state, token);
    }
    ok
}

/// Serve the latest snapshot JSON (auth: bearer header).
async fn api_state(State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    if !authed(&state, bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let snap = state.inner.lock().unwrap().snapshot.clone();
    ([(header::CONTENT_TYPE, "application/json")], snap).into_response()
}

/// Submit one action over HTTP (auth: bearer header). The body is a JSON action object
/// forwarded verbatim to the webview as `remote-action`.
async fn api_action(
    State(state): State<Arc<RemoteState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authed(&state, bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(action) => {
            let _ = state.app.emit("remote-action", action);
            StatusCode::OK.into_response()
        }
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

#[derive(Deserialize)]
struct WsAuth {
    #[serde(default)]
    token: String,
}

/// Upgrade to a WebSocket (auth: `?token=` query, since browser `WebSocket` can't set
/// an Authorization header).
async fn api_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<RemoteState>>,
    Query(q): Query<WsAuth>,
) -> Response {
    if !authed(&state, Some(q.token.as_str())) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Per-connection loop: push the current snapshot immediately, then forward every
/// broadcast snapshot to the client while forwarding inbound action frames to the
/// webview. Ends when either side closes.
async fn handle_socket(mut socket: WebSocket, state: Arc<RemoteState>) {
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
