//! The fleet view (fleet plan F9.1): every other machine's sessions, here.
//!
//! - **A dashboard socket per peer.** For each other member that can be relayed to
//!   now ([`Fleet::relayable`]: linked, with its remote access on), one socket to its
//!   `/api/ws` with a session it gave this machine over the link
//!   ([`Fleet::peer_session`]), the same snapshot its phone gets. Every frame goes to
//!   the sink as `(machine, Some(snapshot))`; the socket ending, or the machine no
//!   longer being reachable, as `(machine, None)`. The latest of each is kept for the
//!   webview's first read and for the office server.
//! - **Sockets for the webview.** A remote console's transcript (`/api/transcript`)
//!   and terminal (`/api/term`) are other sockets to the same server, opened for a
//!   panel and closed with it ([`FleetView::open`]). Binary frames are base64.
//! - **Actions** go to its `/api/action` ([`FleetView::action`]).
//!
//! Plain http and ws on the tailnet, as the relay's (F2.2): WireGuard is the
//! encryption. A refused session (that machine restarted) is asked for again once.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{header, HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::Message;

use super::Fleet;

/// The subprotocol the remote server answers with (`remote::server::SUBPROTOCOL`).
const SUBPROTOCOL: &str = "wb";
/// How often the peers are looked at: new ones get a socket, gone ones lose it.
const SCAN_EVERY: Duration = Duration::from_secs(2);
/// After a failed connect, how long before trying that machine again.
const RETRY_AFTER: Duration = Duration::from_secs(10);
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
/// A shown file (50 MB at most unless asked) has this long to arrive.
const MEDIA_TIMEOUT: Duration = Duration::from_secs(300);

/// What a machine's view is now, for the webview.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewEntry {
    pub machine: String,
    /// Its latest snapshot (JSON text), or None while there's no socket.
    pub snapshot: Option<String>,
    /// Why there's no socket, when it failed to open.
    pub error: Option<String>,
}

/// Where a machine's view changes go: `(machine, snapshot or None, why)`.
pub type ViewSink = Box<dyn Fn(&ViewEntry) + Send + Sync>;

/// A frame on a webview socket, as the panel gets it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum SocketMsg {
    Open,
    Text { d: String },
    /// Base64.
    Bin { d: String },
    Closed { why: Option<String> },
}

/// What the webview sends up a socket.
pub enum SocketOut {
    Text(String),
    Bin(Vec<u8>),
}

type Upstream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub struct FleetView {
    fleet: Arc<Fleet>,
    sink: ViewSink,
    /// The latest snapshot per machine with a live socket.
    snaps: Mutex<HashMap<String, String>>,
    /// Machines with a socket open (or opening).
    watching: Mutex<HashSet<String>>,
    /// Machines whose last connect failed: when, and why.
    failed: Mutex<HashMap<String, (Instant, String)>>,
    sockets: Mutex<HashMap<u64, mpsc::UnboundedSender<SocketOut>>>,
    next: AtomicU64,
}

impl FleetView {
    pub fn new(fleet: Arc<Fleet>, sink: ViewSink) -> Arc<Self> {
        Arc::new(Self {
            fleet,
            sink,
            snaps: Mutex::new(HashMap::new()),
            watching: Mutex::new(HashSet::new()),
            failed: Mutex::new(HashMap::new()),
            sockets: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        })
    }

    /// Keep a socket open to every reachable peer, forever.
    pub async fn run(self: Arc<Self>) {
        let mut tick = tokio::time::interval(SCAN_EVERY);
        loop {
            tick.tick().await;
            self.scan();
        }
    }

    /// One look at the peers: a socket for each new one.
    pub fn scan(self: &Arc<Self>) {
        for id in self.fleet.relayable() {
            if self.watching.lock().unwrap().contains(&id) {
                continue;
            }
            if self.failed.lock().unwrap().get(&id).is_some_and(|(at, _)| at.elapsed() < RETRY_AFTER) {
                continue;
            }
            self.watching.lock().unwrap().insert(id.clone());
            let me = self.clone();
            tokio::spawn(async move { me.watch(id).await });
        }
    }

    /// Every machine's view as it is now: those with a snapshot, and those that failed.
    pub fn list(&self) -> Vec<ViewEntry> {
        let snaps = self.snaps.lock().unwrap();
        let failed = self.failed.lock().unwrap();
        let mut out: Vec<ViewEntry> = snaps
            .iter()
            .map(|(m, s)| ViewEntry { machine: m.clone(), snapshot: Some(s.clone()), error: None })
            .collect();
        for (m, (_, why)) in failed.iter() {
            if !snaps.contains_key(m) {
                out.push(ViewEntry { machine: m.clone(), snapshot: None, error: Some(why.clone()) });
            }
        }
        out.sort_by(|a, b| a.machine.cmp(&b.machine));
        out
    }

    /// The latest snapshot per machine (the office server's peers).
    pub fn snapshots(&self) -> Vec<(String, String)> {
        let mut v: Vec<_> = self.snaps.lock().unwrap().iter().map(|(m, s)| (m.clone(), s.clone())).collect();
        v.sort();
        v
    }

    fn tell(&self, machine: &str, snapshot: Option<String>, error: Option<String>) {
        (self.sink)(&ViewEntry { machine: machine.to_string(), snapshot, error });
    }

    async fn watch(self: Arc<Self>, id: String) {
        match self.connect(&id, "/api/ws").await {
            Ok(mut up) => {
                self.failed.lock().unwrap().remove(&id);
                let mut check = tokio::time::interval(SCAN_EVERY);
                loop {
                    tokio::select! {
                        msg = up.next() => match msg {
                            Some(Ok(Message::Text(t))) => {
                                let t = t.as_str().to_string();
                                self.snaps.lock().unwrap().insert(id.clone(), t.clone());
                                self.tell(&id, Some(t), None);
                            }
                            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                            _ => {}
                        },
                        _ = check.tick() => {
                            if self.fleet.relay_target(&id).is_none() {
                                break;
                            }
                        }
                    }
                }
                let _ = up.close(None).await;
            }
            Err(why) => {
                self.failed.lock().unwrap().insert(id.clone(), (Instant::now(), why.clone()));
                self.snaps.lock().unwrap().remove(&id);
                self.watching.lock().unwrap().remove(&id);
                self.tell(&id, None, Some(why));
                return;
            }
        }
        self.snaps.lock().unwrap().remove(&id);
        self.watching.lock().unwrap().remove(&id);
        self.tell(&id, None, None);
    }

    /// A socket to machine `id`'s remote server at `path` (with its query).
    async fn connect(&self, id: &str, path: &str) -> Result<Upstream, String> {
        let target = self.target(id)?;
        let url = format!("ws://{target}{path}");
        let mut fresh = false;
        loop {
            let session = self.fleet.peer_session(id, fresh).await?;
            let mut req = url.as_str().into_client_request().map_err(|_| "a strange address".to_string())?;
            let h = req.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&format!("{SUBPROTOCOL}, wb-token.{session}")) {
                h.insert(header::SEC_WEBSOCKET_PROTOCOL, v);
            }
            if let Ok(v) = HeaderValue::from_str(&format!("http://{target}")) {
                h.insert(header::ORIGIN, v);
            }
            match tokio_tungstenite::connect_async(req).await {
                Ok((up, _)) => return Ok(up),
                Err(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status() == StatusCode::UNAUTHORIZED && !fresh => {
                    fresh = true;
                }
                Err(tokio_tungstenite::tungstenite::Error::Http(r)) => {
                    return Err(format!("that machine refused ({})", r.status()));
                }
                Err(e) => return Err(format!("couldn’t reach that machine: {e}")),
            }
        }
    }

    fn target(&self, id: &str) -> Result<SocketAddr, String> {
        self.fleet
            .relay_target(id)
            .ok_or_else(|| "that machine isn’t connected, or its remote access is off".to_string())
    }

    /// A signed `GET` of machine `id`'s `path` (with `range`, when given): its
    /// answer, whatever its status but a refused session, which is asked for again
    /// once. For its media (improvement plan S3), so the timeout is a big file's.
    pub async fn get(&self, id: &str, path: &str, range: Option<&str>) -> Result<reqwest::Response, String> {
        let target = self.target(id)?;
        let client = reqwest::Client::new();
        let mut fresh = false;
        loop {
            let session = self.fleet.peer_session(id, fresh).await?;
            let mut req = client
                .get(format!("http://{target}{path}"))
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {session}"))
                .timeout(MEDIA_TIMEOUT);
            if let Some(r) = range {
                req = req.header(reqwest::header::RANGE, r);
            }
            let resp = req.send().await.map_err(|e| format!("couldn’t reach that machine: {e}"))?;
            if resp.status() == StatusCode::UNAUTHORIZED && !fresh {
                fresh = true;
                continue;
            }
            return Ok(resp);
        }
    }

    /// Send `action` (a `RemoteAction`'s JSON) to machine `id`.
    pub async fn action(&self, id: &str, action: &serde_json::Value) -> Result<(), String> {
        let target = self.target(id)?;
        let body = serde_json::to_vec(action).map_err(|e| e.to_string())?;
        let client = reqwest::Client::new();
        let mut fresh = false;
        loop {
            let session = self.fleet.peer_session(id, fresh).await?;
            let resp = client
                .post(format!("http://{target}/api/action"))
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {session}"))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .timeout(HTTP_TIMEOUT)
                .body(body.clone())
                .send()
                .await
                .map_err(|e| format!("couldn’t reach that machine: {e}"))?;
            if resp.status() == StatusCode::UNAUTHORIZED && !fresh {
                fresh = true;
                continue;
            }
            if resp.status().is_success() {
                return Ok(());
            }
            return Err(format!("that machine refused ({})", resp.status()));
        }
    }

    /// Open a socket to machine `id`'s `path` for a panel: its frames go to `on`, and
    /// the id it returns sends ([`FleetView::send`]) and closes ([`FleetView::close`]).
    pub fn open(self: &Arc<Self>, id: &str, path: &str, on: Box<dyn Fn(SocketMsg) + Send + Sync>) -> Result<u64, String> {
        if !path.starts_with("/api/term") && !path.starts_with("/api/transcript") {
            return Err("not a route a panel opens".into());
        }
        let n = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, mut rx) = mpsc::unbounded_channel::<SocketOut>();
        self.sockets.lock().unwrap().insert(n, tx);
        let (me, id, path) = (self.clone(), id.to_string(), path.to_string());
        // Not `tokio::spawn`: `fleet_socket_open` is a sync command, so this runs on
        // the main thread, outside any runtime. There `tokio::spawn` panics, inside
        // WebView2's callback, where a panic can't unwind and the app aborts.
        tauri::async_runtime::spawn(async move {
            let up = match me.connect(&id, &path).await {
                Ok(up) => up,
                Err(why) => {
                    me.sockets.lock().unwrap().remove(&n);
                    on(SocketMsg::Closed { why: Some(why) });
                    return;
                }
            };
            on(SocketMsg::Open);
            let (mut up_tx, mut up_rx) = up.split();
            let b64 = base64::engine::general_purpose::STANDARD;
            let why = loop {
                tokio::select! {
                    msg = up_rx.next() => match msg {
                        Some(Ok(Message::Text(t))) => on(SocketMsg::Text { d: t.as_str().to_string() }),
                        Some(Ok(Message::Binary(b))) => on(SocketMsg::Bin { d: b64.encode(&b) }),
                        Some(Ok(Message::Close(_))) | None => break None,
                        Some(Err(e)) => break Some(e.to_string()),
                        _ => {}
                    },
                    out = rx.recv() => match out {
                        Some(SocketOut::Text(t)) => { let _ = up_tx.send(Message::Text(t.into())).await; }
                        Some(SocketOut::Bin(b)) => { let _ = up_tx.send(Message::Binary(b.into())).await; }
                        None => { let _ = up_tx.close().await; break None; }
                    },
                }
            };
            me.sockets.lock().unwrap().remove(&n);
            on(SocketMsg::Closed { why });
        });
        Ok(n)
    }

    pub fn send(&self, socket: u64, out: SocketOut) -> Result<(), String> {
        let sockets = self.sockets.lock().unwrap();
        let tx = sockets.get(&socket).ok_or("that socket closed")?;
        tx.send(out).map_err(|_| "that socket closed".to_string())
    }

    /// Close a panel's socket (dropping its sender ends the task).
    pub fn close(&self, socket: u64) {
        self.sockets.lock().unwrap().remove(&socket);
    }
}
