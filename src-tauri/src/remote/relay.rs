//! Relaying the phone's requests to another machine of the fleet (fleet plan F2.2).
//!
//! - **A machine's sessions:** `/m/<machine>/<route>` carries one of the session
//!   routes ([`MACHINE_ROUTES`]: the dashboard socket, actions, a console, a
//!   transcript, notes, uploads) to that machine. The phone's page picks the machine
//!   and puts the prefix on (`src/pwa/machine.ts`).
//! - **Duck:** every `/api/assistant…` route goes to the main when that's another
//!   machine ([`crate::fleet::Fleet::duck_main`]): there's one Duck, and the phone
//!   talks to it from whichever machine's page it's on. With the main unreachable,
//!   this machine's own Duck answers.
//!
//! The phone is checked here, as for any request. The request then goes to the other
//! machine's remote server on its tailnet address, with a session that machine gave
//! for this device over the peer link, so its own checks apply as well (the device
//! must be approved there too, which the fleet's shared devices make so). A refused
//! session (that machine restarted) is asked for again once. Plain http on the
//! tailnet: WireGuard is the encryption, as for a phone on the tailnet address.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as Up;

use super::server::{authed, bearer, client_addr, ws_authed, SUBPROTOCOL};
use super::RemoteState;

/// What `/m/<machine>/` carries: a machine's sessions and what belongs to them.
pub(super) const MACHINE_ROUTES: [&str; 7] =
    ["api/ws", "api/action", "api/term", "api/transcript", "api/notes", "api/session/", "api/media"];

/// The largest body relayed: an upload's.
const BODY_MAX: usize = super::uploads::FILE_MAX;

/// Set on every relayed request. Such a request is answered where it lands, never
/// relayed again: two machines that briefly disagree about the main can't pass it
/// back and forth.
const RELAYED: &str = "x-workbench-relayed";

/// A relayed HTTP request must be answered within this.
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// `rest` (after `/m/<machine>/`) is a route a machine's page may be relayed.
pub(super) fn machine_route(rest: &str) -> bool {
    !rest.contains("..") && MACHINE_ROUTES.iter().any(|r| rest == *r || rest.starts_with(&format!("{r}/")) || (r.ends_with('/') && rest.starts_with(r)))
}

/// `/m/{machine}/{*rest}`: one of a machine's routes, relayed to it.
pub(super) async fn machine(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((id, rest)): Path<(String, String)>,
    req: Request,
) -> Response {
    if !machine_route(&rest) {
        return StatusCode::NOT_FOUND.into_response();
    }
    forward(&state, peer, &id, &format!("/{rest}"), req).await
}

/// A layer over the router: Duck's routes go to the main when it's elsewhere.
pub(super) async fn duck(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();
    let duck_route = path == "/api/assistant" || path.starts_with("/api/assistant/");
    if !duck_route || req.headers().contains_key(RELAYED) {
        return next.run(req).await;
    }
    let main = crate::fleet::get(&state.app).and_then(|f| f.duck_main());
    match main {
        Some(main) => forward(&state, peer, &main, &path, req).await,
        None => next.run(req).await,
    }
}

fn refuse(status: StatusCode, why: &str) -> Response {
    (status, Json(json!({ "error": why }))).into_response()
}

fn is_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// Check the phone here, then send `req` to machine `id` as `path`.
async fn forward(state: &Arc<RemoteState>, peer: SocketAddr, id: &str, path: &str, req: Request) -> Response {
    let Some(fleet) = crate::fleet::get(&state.app) else {
        return refuse(StatusCode::NOT_FOUND, "this machine isn’t in a fleet");
    };
    let headers = req.headers().clone();
    let ws = is_upgrade(&headers);
    let device = if ws {
        ws_authed(state, &headers, peer)
    } else {
        authed(state, bearer(&headers).as_deref(), &client_addr(peer, &headers))
    };
    let device = match device {
        Ok(d) => d,
        Err(refusal) => return refusal,
    };
    let Some(target) = fleet.relay_target(id) else {
        return refuse(StatusCode::BAD_GATEWAY, "that machine isn’t connected, or its remote access is off");
    };
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let path = format!("{path}{query}");
    if ws {
        let (mut parts, _) = req.into_parts();
        let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, state).await {
            Ok(u) => u,
            Err(e) => return e.into_response(),
        };
        return relay_socket(&fleet, id, &device, target, &path, upgrade).await;
    }
    let method = req.method().clone();
    let body = match axum::body::to_bytes(req.into_body(), BODY_MAX).await {
        Ok(b) => b,
        Err(_) => return refuse(StatusCode::PAYLOAD_TOO_LARGE, "too large to relay"),
    };
    let client = reqwest::Client::new();
    let url = format!("http://{target}{path}");
    let mut fresh = false;
    loop {
        let session = match fleet.relay_session(id, &device, fresh).await {
            Ok(s) => s,
            Err(e) => return refuse(StatusCode::BAD_GATEWAY, &e),
        };
        let mut up = client
            .request(method.clone(), &url)
            .header(header::AUTHORIZATION, format!("Bearer {session}"))
            .header(RELAYED, "1")
            .timeout(HTTP_TIMEOUT)
            .body(body.clone());
        // A player's range (a shown video, S3) is asked for over there as it was here.
        for name in [header::CONTENT_TYPE, header::RANGE] {
            if let Some(t) = headers.get(&name) {
                up = up.header(name, t);
            }
        }
        let resp = match up.send().await {
            Ok(r) => r,
            Err(e) => return refuse(StatusCode::BAD_GATEWAY, &format!("couldn’t reach that machine: {e}")),
        };
        if resp.status() == StatusCode::UNAUTHORIZED && !fresh {
            fresh = true;
            continue;
        }
        let status = resp.status();
        let mut out = Response::builder().status(status);
        for name in [
            header::CONTENT_TYPE,
            header::CONTENT_DISPOSITION,
            header::CACHE_CONTROL,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
        ] {
            if let Some(v) = resp.headers().get(&name) {
                out = out.header(name, v);
            }
        }
        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => return refuse(StatusCode::BAD_GATEWAY, &format!("that machine’s answer broke off: {e}")),
        };
        return out.body(Body::from(bytes)).unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
    }
}

/// Open the socket on the other machine first, so a refusal is an HTTP error here,
/// then join the phone's socket to it.
async fn relay_socket(
    fleet: &crate::fleet::Fleet,
    id: &str,
    device: &str,
    target: SocketAddr,
    path: &str,
    upgrade: WebSocketUpgrade,
) -> Response {
    let url = format!("ws://{target}{path}");
    let mut fresh = false;
    loop {
        let session = match fleet.relay_session(id, device, fresh).await {
            Ok(s) => s,
            Err(e) => return refuse(StatusCode::BAD_GATEWAY, &e),
        };
        let Ok(mut req) = url.as_str().into_client_request() else {
            return refuse(StatusCode::BAD_GATEWAY, "a strange address");
        };
        let h = req.headers_mut();
        if let Ok(v) = HeaderValue::from_str(&format!("{SUBPROTOCOL}, wb-token.{session}")) {
            h.insert(header::SEC_WEBSOCKET_PROTOCOL, v);
        }
        if let Ok(v) = HeaderValue::from_str(&format!("http://{target}")) {
            h.insert(header::ORIGIN, v);
        }
        h.insert(RELAYED, HeaderValue::from_static("1"));
        match tokio_tungstenite::connect_async(req).await {
            Ok((up, _)) => {
                return upgrade.protocols([SUBPROTOCOL]).on_upgrade(move |down| join(down, up));
            }
            Err(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status() == StatusCode::UNAUTHORIZED && !fresh => {
                fresh = true;
            }
            Err(tokio_tungstenite::tungstenite::Error::Http(r)) => {
                return refuse(r.status(), "that machine refused the socket");
            }
            Err(e) => return refuse(StatusCode::BAD_GATEWAY, &format!("couldn’t reach that machine: {e}")),
        }
    }
}

type Upstream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Carry messages both ways until either end closes.
async fn join(down: WebSocket, up: Upstream) {
    let (mut down_tx, mut down_rx) = down.split();
    let (mut up_tx, mut up_rx) = up.split();
    let to_up = async {
        while let Some(Ok(msg)) = down_rx.next().await {
            let m = match msg {
                Message::Text(t) => Up::Text(t.as_str().into()),
                Message::Binary(b) => Up::Binary(b),
                Message::Close(_) => break,
                _ => continue, // pings are each side's own
            };
            if up_tx.send(m).await.is_err() {
                break;
            }
        }
        let _ = up_tx.close().await;
    };
    let to_down = async {
        while let Some(Ok(msg)) = up_rx.next().await {
            let m = match msg {
                Up::Text(t) => Message::Text(t.as_str().into()),
                Up::Binary(b) => Message::Binary(b),
                Up::Close(_) => break,
                _ => continue,
            };
            if down_tx.send(m).await.is_err() {
                break;
            }
        }
        let _ = down_tx.close().await;
    };
    tokio::select! {
        _ = to_up => {}
        _ = to_down => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_machines_routes_are_relayed() {
        for ok in ["api/ws", "api/action", "api/term", "api/transcript", "api/notes", "api/notes/list", "api/session/upload", "api/media/0a1b", "api/media/0a1b/info"] {
            assert!(machine_route(ok), "{ok}");
        }
        for no in ["api/fleet", "api/auth/session", "pair", "api/assistant", "api/wsx", "api/notes/../push", "api/push/test", ""] {
            assert!(!machine_route(no), "{no}");
        }
    }
}
