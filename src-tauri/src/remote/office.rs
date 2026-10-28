//! The office's listener (office plan O0.2): the office page and its API, on
//! **loopback only**, started by the first "Open Office" and kept while the app runs.
//! Independent of the phone's remote-access switch, but fed the same way: the same
//! snapshot the webview pushes, the same `remote-action` events back.
//!
//! - `GET /office/` — the page, built from `src/office/` into `office/dist/`.
//! - `POST /office/api/session` — trade a launch token for a session. Workbench mints
//!   the token when it opens the page (`/office/#t=<token>`); it works once, within a
//!   minute. The session lives in memory here and in the tab, until the app quits.
//! - `GET /office/api/state`, `POST /office/api/action` — as the phone's (auth:
//!   `Authorization: Bearer <session>`).
//! - `GET /office/api/stats` — what Workbench costs (O0.4, `stats.rs`), for the HUD.
//! - `GET`/`PUT /office/api/prefs` — the page's own settings (O1.3: the room each
//!   project sits in, which worker each instance had), one JSON object kept in the app
//!   DB so they outlive the tab and the browser. Workbench doesn't read them.
//! - `GET /office/api/ws`, `GET /office/api/transcript` — as the phone's sockets (auth:
//!   the session as a `wb-token.<session>` subprotocol).
//! - `GET /office/api/assistant` — Duck's socket (O3.1), the phone's Duck Protocol
//!   over the same bridge ([`assistant::relay`]), as the device `office`: the webview
//!   takes it for you at the desktop, not a phone (`remoteBridge.ts`). Auth as the
//!   other sockets.
//!
//! A debug build starts the listener with the app and leaves a reusable URL in the
//! app-data dir ([`DEV_URL_FILE`]), so a tool can open the office without a click.
//!
//! Every request must name this listener in its `Host` (`127.0.0.1:<port>` or
//! `localhost:<port>`): any web page can reach loopback, and a DNS-rebinding page would
//! arrive under its own name. Requests that act, and the sockets, must also come from
//! the office's own page (`Origin`).

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::broadcast;

use super::assistant::{self, DuckFrame};
use super::auth::{self, ct_eq};
use super::server::{bearer, subprotocol_token, SUBPROTOCOL};
use super::transcript::{self, TranscriptQuery};
use super::RemoteState;

mod stats;

/// Where the office listens; a debug build apart from a release, like the phone's
/// server. Taken by something else, any free port does: the URL is minted per launch.
const OFFICE_PORT: u16 = if cfg!(debug_assertions) { 49050 } else { 48950 };
/// How long a launch token works, seconds.
const LAUNCH_SECS: u64 = 60;
/// Sessions kept (office tabs); a new one drops the oldest.
const SESSIONS_MAX: usize = 8;
/// The `meta` key the office's prefs live under, and how large they may get.
const PREFS_KEY: &str = "office.prefs";
const PREFS_MAX: usize = 64 * 1024;

#[derive(Default)]
pub(super) struct Office {
    inner: Mutex<OfficeInner>,
}

#[derive(Default)]
struct OfficeInner {
    /// The bound port, once started.
    port: Option<u16>,
    /// Snapshots to the office's sockets.
    tx: Option<broadcast::Sender<String>>,
    /// Duck's frames to the office's Duck sockets.
    duck: Option<broadcast::Sender<DuckFrame>>,
    /// Launch tokens not yet used, with when they stop working.
    launches: Vec<(String, u64)>,
    /// A debug build's launch token that works as often as asked while the app runs
    /// ([`dev_launch`]).
    dev_launch: Option<String>,
    sessions: Vec<String>,
}

impl Office {
    pub(super) fn running(&self) -> bool {
        self.inner.lock().unwrap().port.is_some()
    }

    /// Hand a new snapshot to the office's sockets.
    pub(super) fn push(&self, json: &str) {
        if let Some(tx) = &self.inner.lock().unwrap().tx {
            let _ = tx.send(json.to_string()); // Err: no office open
        }
    }

    /// Hand one of Duck's frames to the office's Duck sockets.
    pub(super) fn duck(&self, frame: DuckFrame) {
        if let Some(tx) = &self.inner.lock().unwrap().duck {
            let _ = tx.send(frame); // Err: no Duck chat open
        }
    }

    /// A fresh launch token, good once for [`LAUNCH_SECS`].
    fn launch(&self, now: u64) -> String {
        let mut inner = self.inner.lock().unwrap();
        inner.launches.retain(|(_, until)| *until > now);
        let token = auth::random_token();
        inner.launches.push((token.clone(), now + LAUNCH_SECS));
        token
    }

    /// Spend a launch token on a session.
    fn session(&self, token: &str, now: u64) -> Option<String> {
        let mut inner = self.inner.lock().unwrap();
        inner.launches.retain(|(_, until)| *until > now);
        let mut hit = None;
        for (i, (t, _)) in inner.launches.iter().enumerate() {
            if ct_eq(t.as_bytes(), token.as_bytes()) {
                hit = Some(i);
            }
        }
        let dev = inner.dev_launch.as_deref().is_some_and(|t| ct_eq(t.as_bytes(), token.as_bytes()));
        match hit {
            Some(i) => drop(inner.launches.remove(i)),
            None if dev => {}
            None => return None,
        }
        if inner.sessions.len() >= SESSIONS_MAX {
            inner.sessions.remove(0);
        }
        let session = auth::random_token();
        inner.sessions.push(session.clone());
        Some(session)
    }

    fn valid(&self, session: Option<&str>) -> bool {
        let Some(session) = session else { return false };
        let inner = self.inner.lock().unwrap();
        let mut hit = false;
        for s in &inner.sessions {
            hit |= ct_eq(s.as_bytes(), session.as_bytes());
        }
        hit
    }
}

/// Where a debug build leaves its office URL, in the app-data dir.
pub const DEV_URL_FILE: &str = "office-dev.url";

/// A debug build (`tauri dev`) opens the office's listener at start and writes a URL
/// for it to [`DEV_URL_FILE`], with a launch token that works every time while the app
/// runs: a tool driving a browser can open the office without anyone clicking "Open
/// Office". Only someone who can read the user's app-data dir can use it.
pub(super) fn dev_launch(state: &Arc<RemoteState>) {
    let Ok(dir) = state.app.path().app_data_dir() else { return };
    let port = match ensure_started(state) {
        Ok(port) => port,
        Err(e) => return eprintln!("[office] no dev launch: {e}"),
    };
    let token = auth::random_token();
    state.office.inner.lock().unwrap().dev_launch = Some(token.clone());
    let url = format!("http://127.0.0.1:{port}/office/#t={token}");
    if let Err(e) = std::fs::write(dir.join(DEV_URL_FILE), &url) {
        eprintln!("[office] could not write the dev URL: {e}");
    }
    super::changed(state);
}

/// Start the listener if it isn't up; its port.
fn ensure_started(state: &Arc<RemoteState>) -> Result<u16, String> {
    if let Some(port) = state.office.inner.lock().unwrap().port {
        return Ok(port);
    }
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, OFFICE_PORT))
        .or_else(|_| std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|e| format!("the office could not listen on loopback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let (tx, _rx) = broadcast::channel::<String>(32);
    // Room for a burst of streamed text, as the phone's.
    let (duck, _rx) = broadcast::channel::<DuckFrame>(512);
    {
        let mut inner = state.office.inner.lock().unwrap();
        inner.port = Some(port);
        inner.tx = Some(tx);
        inner.duck = Some(duck);
    }
    let router = router(state.clone(), port);
    tauri::async_runtime::spawn(async move {
        let serve = async {
            let listener = tokio::net::TcpListener::from_std(listener)?;
            axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await
        };
        if let Err(e) = serve.await {
            eprintln!("[office] listener stopped: {e}");
        }
    });
    Ok(port)
}

fn router(state: Arc<RemoteState>, port: u16) -> Router {
    Router::new()
        .route("/office", get(|| async { Redirect::permanent("/office/") }))
        .route("/office/", get(page))
        .route("/office/api/session", post(start_session))
        .route("/office/api/state", get(api_state))
        .route("/office/api/action", post(api_action))
        .route("/office/api/stats", get(api_stats))
        .route("/office/api/prefs", get(get_prefs).put(put_prefs))
        .route("/office/api/ws", get(api_ws))
        .route("/office/api/transcript", get(api_transcript))
        .route("/office/api/assistant", get(api_assistant))
        .with_state(state)
        .layer(middleware::from_fn_with_state(port, host_guard))
}

/// One header as text, when present and readable.
fn header_str(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// The `Host` a request to this listener carries: loopback by number or by name.
fn host_ok(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|h| {
        h.eq_ignore_ascii_case(&format!("127.0.0.1:{port}")) || h.eq_ignore_ascii_case(&format!("localhost:{port}"))
    })
}

/// Refuses a request that doesn't name this listener (DNS rebinding), and one that
/// acts or opens a socket from another site.
async fn host_guard(State(port): State<u16>, req: Request, next: Next) -> Response {
    let headers = req.headers();
    let host = header_str(headers, header::HOST);
    if !host_ok(host, port) {
        return (StatusCode::MISDIRECTED_REQUEST, "not this host").into_response();
    }
    let acts = req.method() != axum::http::Method::GET || headers.contains_key(header::UPGRADE);
    if acts && !auth::origin_ok(header_str(headers, header::ORIGIN), host) {
        return (StatusCode::FORBIDDEN, "not from the office").into_response();
    }
    next.run(req).await
}

/// The office page, never cached (a new build replaces it) nor framed.
async fn page() -> Response {
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::X_FRAME_OPTIONS, "DENY"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Html(include_str!("office/dist/index.html")),
    )
        .into_response()
}

#[derive(Deserialize)]
struct SessionReq {
    token: String,
}

/// Trade a launch token for a session; 401 once it is spent or too old.
async fn start_session(State(state): State<Arc<RemoteState>>, Json(req): Json<SessionReq>) -> Response {
    match state.office.session(&req.token, super::now()) {
        Some(session) => ([(header::CACHE_CONTROL, "no-store")], Json(json!({ "session": session }))).into_response(),
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn api_state(State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let snap = state.inner.lock().unwrap().snapshot.clone();
    ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], snap).into_response()
}

/// What Workbench and its sessions cost now; CPU since the previous call.
async fn api_stats(State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match tokio::task::spawn_blocking(stats::measure).await {
        Ok(cost) => ([(header::CACHE_CONTROL, "no-store")], Json(cost)).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// The office's prefs as saved, `{}` before the first save.
async fn get_prefs(State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.app.state::<crate::db::Db>().meta_get(PREFS_KEY) {
        Ok(saved) => (
            [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")],
            saved.unwrap_or_else(|| "{}".into()),
        )
            .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Replace the office's prefs: any JSON object up to [`PREFS_MAX`] bytes.
async fn put_prefs(State(state): State<Arc<RemoteState>>, headers: HeaderMap, body: Bytes) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(prefs) = prefs_ok(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match state.app.state::<crate::db::Db>().meta_set(PREFS_KEY, &prefs) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// `body` as compact JSON, when it is an object and not too large.
fn prefs_ok(body: &[u8]) -> Option<String> {
    if body.len() > PREFS_MAX {
        return None;
    }
    match serde_json::from_slice::<Value>(body).ok()? {
        v @ Value::Object(_) => Some(v.to_string()),
        _ => None,
    }
}

/// One action, forwarded to the webview as the phone's are.
async fn api_action(State(state): State<Arc<RemoteState>>, headers: HeaderMap, body: Bytes) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
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

async fn api_ws(ws: WebSocketUpgrade, State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    if !state.office.valid(subprotocol_token(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.protocols([SUBPROTOCOL]).on_upgrade(move |socket| snapshots(socket, state))
}

/// The current snapshot, then every new one; inbound frames are actions.
async fn snapshots(mut socket: WebSocket, state: Arc<RemoteState>) {
    let Some(mut rx) = state.office.inner.lock().unwrap().tx.as_ref().map(|tx| tx.subscribe()) else {
        return;
    };
    let initial = state.inner.lock().unwrap().snapshot.clone();
    if socket.send(Message::Text(initial.into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            update = rx.recv() => match update {
                Ok(snap) => {
                    if socket.send(Message::Text(snap.into())).await.is_err() {
                        break;
                    }
                }
                // Each frame is the whole state, so the next one catches up.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    if let Ok(action) = serde_json::from_str::<Value>(t.as_str()) {
                        let _ = state.app.emit("remote-action", action);
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
}

async fn api_transcript(
    ws: WebSocketUpgrade,
    State(state): State<Arc<RemoteState>>,
    headers: HeaderMap,
    Query(q): Query<TranscriptQuery>,
) -> Response {
    if !state.office.valid(subprotocol_token(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // An office session lasts as long as the app, so nothing ends the socket early.
    ws.protocols([SUBPROTOCOL]).on_upgrade(move |socket| transcript::follow(socket, state, q, || true))
}

/// The largest frame the office's Duck socket takes, as the phone's.
const DUCK_FRAME_MAX: usize = 256 * 1024;

/// Duck's socket for the office's chat.
async fn api_assistant(ws: WebSocketUpgrade, State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    let session = subprotocol_token(&headers);
    if !state.office.valid(session.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(rx) = state.office.inner.lock().unwrap().duck.as_ref().map(|tx| tx.subscribe()) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    ws.protocols([SUBPROTOCOL]).max_message_size(DUCK_FRAME_MAX).on_upgrade(move |socket| {
        let st = state.clone();
        assistant::relay(socket, state, "office".into(), rx, move || st.office.valid(session.as_deref()), false)
    })
}

/// Start the office's listener if needed and open the office in the default browser.
/// Returns the URL opened.
#[tauri::command]
pub fn office_open(state: tauri::State<'_, Arc<RemoteState>>) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let st = state.inner();
    let was_running = st.office.running();
    let port = ensure_started(st)?;
    let url = format!("http://127.0.0.1:{port}/office/#t={}", st.office.launch(super::now()));
    if !was_running {
        // The mirror starts pushing snapshots for the office.
        super::changed(st);
    }
    st.app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string())?;
    Ok(url)
}

/// A repo's commits, as the office shows them.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCommits {
    /// The latest commit's time (epoch seconds), on any branch.
    last_at: Option<i64>,
    /// How many were made since the `since` asked for (office plan O1.6: today's).
    since: Option<u32>,
}

/// Each repo's commits, in order: the latest one's time and how many since `since`
/// (epoch seconds), `None` where there are none. Off the main thread: it runs git
/// twice per repo.
#[tauri::command]
pub async fn office_commits(repo_roots: Vec<String>, since: i64) -> Result<Vec<RepoCommits>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        repo_roots
            .iter()
            .map(|r| {
                let root = std::path::Path::new(r);
                RepoCommits { last_at: crate::git::last_commit_at(root), since: crate::git::commits_since(root, since) }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_its_own_host() {
        assert!(host_ok(Some("127.0.0.1:48950"), 48950));
        assert!(host_ok(Some("LOCALHOST:48950"), 48950));
        assert!(!host_ok(Some("127.0.0.1:48951"), 48950));
        assert!(!host_ok(Some("evil.example:48950"), 48950));
        assert!(!host_ok(Some("127.0.0.1"), 48950));
        assert!(!host_ok(None, 48950));
    }

    #[test]
    fn a_launch_token_works_once_and_not_for_long() {
        let office = Office::default();
        let token = office.launch(1000);
        assert!(office.session("nope", 1001).is_none());
        let session = office.session(&token, 1001).expect("a session");
        assert!(office.valid(Some(&session)));
        assert!(office.session(&token, 1002).is_none(), "spent");

        office.inner.lock().unwrap().dev_launch = Some("dev".into());
        assert!(office.session("dev", 1003).is_some());
        assert!(office.session("dev", 9999).is_some(), "a dev launch works again, and late");

        let late = office.launch(2000);
        assert!(office.session(&late, 2000 + LAUNCH_SECS).is_none(), "expired");
        assert!(!office.valid(Some("nope")));
        assert!(!office.valid(None));
    }

    #[test]
    fn takes_prefs_only_as_a_json_object_of_bounded_size() {
        assert_eq!(prefs_ok(br#"{ "rooms": {"p1": "demiurge"} }"#).as_deref(), Some(r#"{"rooms":{"p1":"demiurge"}}"#));
        assert!(prefs_ok(b"[1, 2]").is_none());
        assert!(prefs_ok(b"not json").is_none());
        let big = format!(r#"{{"x":"{}"}}"#, "a".repeat(PREFS_MAX));
        assert!(prefs_ok(big.as_bytes()).is_none());
    }

    #[test]
    fn keeps_the_newest_sessions() {
        let office = Office::default();
        let sessions: Vec<String> = (0..=SESSIONS_MAX)
            .map(|i| {
                let t = office.launch(i as u64);
                office.session(&t, i as u64).unwrap()
            })
            .collect();
        assert!(!office.valid(Some(&sessions[0])));
        assert!(sessions[1..].iter().all(|s| office.valid(Some(s))));
    }
}
