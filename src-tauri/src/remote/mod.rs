//! Remote access server (step 4.3, design §11).
//!
//! Grows the Rust core into an authenticated API + WebSocket server bound to the
//! **Tailscale interface**, so you can supervise agents from another device on your
//! tailnet (the PWA client is step 4.4, the mirrored terminal step 4.5). This module
//! owns the server lifecycle, the pairing-token auth, and the bridge between the
//! frontend and remote clients.
//!
//! **Two deliberate boundaries** keep this thin and avoid duplicating subtle logic:
//!
//! 1. **State comes from the webview, not from here.** The card-status state machine
//!    lives in the frontend (`src/state/status.ts`) and is explicitly painful to
//!    retrofit, so we don't reimplement it in Rust. Instead the webview pushes a live
//!    snapshot (instances + phases + usage) via [`remote_push_snapshot`]; we store it
//!    and fan it out to WS clients. If the desktop webview is gone the snapshot simply
//!    stops updating — exactly the "Workbench offline" case §11 describes.
//! 2. **Actions are executed by the webview, not here.** An inbound action
//!    (prompt/approve/deny/interrupt/start/stop) is emitted as a `remote-action` Tauri
//!    event; the frontend's single handler maps it to the right keystroke/command
//!    (the §11 caveat: keep that mapping in one place). We never write to a PTY here.
//!
//! **Security:** off by default; enabled from the Remote Access settings panel. When
//! on we bind **only** to the detected Tailscale address (100.64.0.0/10) — never
//! broader. A device must `POST /pair` a short, expiring, one-time code to receive a
//! long-lived bearer token; every API/WS call presents that token (decision: §11
//! pairing). Tailscale secures the wire; the token gates who may attach.

mod server;

use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager, State};
use tokio::sync::broadcast;

use crate::db::Db;

/// The port the remote server binds on the Tailscale interface. A debug build uses a
/// different port so a `tauri dev` run never fights an installed release for it
/// (mirrors the hook server's `PORT_BASE` split).
const REMOTE_PORT: u16 = if cfg!(debug_assertions) { 49020 } else { 48990 };

/// How long a freshly minted pairing code stays valid (seconds). Short by design: a
/// code is shown on screen only while you're pairing a device.
const PAIRING_TTL_SECS: u64 = 600; // 10 minutes

/// `meta` key persisting whether remote serving was last enabled, so it auto-starts
/// on the next launch (best-effort — a bind failure never blocks the app).
const ENABLED_KEY: &str = "remote_enabled";

/// Tauri-managed (`Arc<RemoteState>`) shared state for the remote server. Created and
/// managed in [`init`] during setup, mirroring how the hook server manages its
/// `Arc<HookContext>`. The axum handlers receive the same `Arc` as their router state,
/// so commands and request handlers see one source of truth.
pub struct RemoteState {
    /// To resolve the DB (paired devices) and to emit `remote-action` to the webview.
    app: AppHandle,
    inner: Mutex<RemoteInner>,
}

struct RemoteInner {
    running: bool,
    /// `ip:port` the server is bound to, when running.
    bound_addr: Option<String>,
    /// The running server's acceptor task. Aborting it drops the listener and frees the
    /// port immediately, so a disable→enable toggle can always re-bind.
    task: Option<JoinHandle<()>>,
    /// Broadcast of snapshot JSON to every connected WS client, **created per run**: it
    /// lives only while the server is running. Dropping it on stop makes every connected
    /// client's receiver close, so the toggle actually disconnects them (rather than
    /// leaving a phone attached to a server that's "off"). A lagging client just misses
    /// intermediate frames — each frame is the full state, so it recovers.
    tx: Option<broadcast::Sender<String>>,
    /// The most recent snapshot the webview pushed; served to a new WS/HTTP client.
    snapshot: String,
    /// Valid device bearer tokens (loaded from `remote_devices` at init, kept in sync
    /// on pair/revoke). The auth check is a pure set-membership test against this.
    tokens: HashSet<String>,
    /// The single active pairing code, if one has been generated and not yet used or
    /// expired.
    pairing: Option<PairingCode>,
}

struct PairingCode {
    code: String,
    expires_at: u64,
}

/// Start the remote subsystem: create + manage the shared state, load paired-device
/// tokens, and auto-start the server if it was enabled last run. Never fails the app —
/// a bind error only means remote access stays off until re-enabled.
pub fn init(app: &AppHandle) {
    let tokens = load_tokens(app);
    let state = Arc::new(RemoteState {
        app: app.clone(),
        inner: Mutex::new(RemoteInner {
            running: false,
            bound_addr: None,
            task: None,
            tx: None,
            snapshot: "{}".to_string(),
            tokens,
            pairing: None,
        }),
    });
    app.manage(state.clone());

    let enabled = app
        .state::<Db>()
        .meta_get(ENABLED_KEY)
        .ok()
        .flatten()
        .as_deref()
        == Some("1");
    if enabled {
        if let Err(e) = start_server(&state) {
            eprintln!("[remote] auto-start skipped: {e}");
        }
    }
}

/// Load every paired device token from the database into the in-memory auth set.
fn load_tokens(app: &AppHandle) -> HashSet<String> {
    let db = app.state::<Db>();
    let conn = db.conn.lock().expect("db lock poisoned");
    let mut set = HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT token FROM remote_devices") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for t in rows.flatten() {
                set.insert(t);
            }
        }
    }
    set
}

/// Bind the Tailscale interface and spawn the axum server. Idempotent: if already
/// running, returns the current bound address. Errors (returned, never panicked) when
/// no Tailscale interface is present or the bind fails — the caller surfaces that.
/// A fresh broadcast channel is created per run so [`remote_stop`] can drop it to
/// disconnect clients.
fn start_server(state: &Arc<RemoteState>) -> Result<String, String> {
    {
        let inner = state.inner.lock().unwrap();
        if inner.running {
            return Ok(inner.bound_addr.clone().unwrap_or_default());
        }
    }
    let ip = tailscale_ip()
        .ok_or("Tailscale interface not found — is Tailscale installed and connected?")?;
    let listener = std::net::TcpListener::bind((ip, REMOTE_PORT))
        .map_err(|e| format!("bind {ip}:{REMOTE_PORT} failed: {e}"))?;
    let addr = format!("{ip}:{REMOTE_PORT}");
    let (tx, _rx) = broadcast::channel::<String>(32);
    {
        let mut inner = state.inner.lock().unwrap();
        inner.running = true;
        inner.bound_addr = Some(addr.clone());
        inner.tx = Some(tx);
    }
    // Spawn after the state is published so a connection that arrives immediately finds
    // the channel; store the acceptor handle so stop can abort it (freeing the port).
    let task = server::serve(listener, state.clone());
    state.inner.lock().unwrap().task = Some(task);
    Ok(addr)
}

/// The first local IPv4 in the Tailscale CGNAT range (100.64.0.0/10), or `None`.
fn tailscale_ip() -> Option<Ipv4Addr> {
    let addrs = if_addrs::get_if_addrs().ok()?;
    addrs.into_iter().find_map(|iface| match iface.ip() {
        std::net::IpAddr::V4(v4) if is_tailscale_v4(v4) => Some(v4),
        _ => None,
    })
}

/// Whether `ip` falls in Tailscale's CGNAT block 100.64.0.0/10 (second octet 64–127).
/// Pure so the range logic is unit-testable without a live interface.
fn is_tailscale_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..=127).contains(&o[1])
}

/// Validate a pairing attempt and, on success, mint + persist a device token. The code
/// is **one-time**: a successful pair consumes it (cleared), so a leaked code can't be
/// replayed. Returns the new bearer token, or `None` when the code is wrong/expired.
/// Called by the (unauthenticated) `/pair` handler.
fn try_pair(state: &Arc<RemoteState>, code: &str, name: &str) -> Option<String> {
    {
        let mut inner = state.inner.lock().unwrap();
        let ok = matches!(&inner.pairing, Some(p) if p.code == code && p.expires_at > now());
        if !ok {
            return None;
        }
        inner.pairing = None; // one-time: consume on success
    }
    // 256-bit unguessable token (two v4 UUIDs concatenated, hyphen-free).
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    {
        let db = state.app.state::<Db>();
        let conn = db.conn.lock().expect("db lock poisoned");
        let _ = conn.execute(
            "INSERT INTO remote_devices (token, name, paired_at, last_seen) VALUES (?1, ?2, ?3, NULL)",
            (&token, name, now() as i64),
        );
    }
    state.inner.lock().unwrap().tokens.insert(token.clone());
    Some(token)
}

/// Whether `token` is a known paired device. Pure set membership — the heart of the
/// API/WS auth gate. Kept tiny and testable.
fn token_ok(tokens: &HashSet<String>, token: &str) -> bool {
    !token.is_empty() && tokens.contains(token)
}

/// Record that a token was just used (updates `last_seen`). Best-effort, called on each
/// authenticated request / WS connect — low frequency, so a DB write per call is fine.
fn touch_device(state: &Arc<RemoteState>, token: &str) {
    let db = state.app.state::<Db>();
    let conn = db.conn.lock().expect("db lock poisoned");
    let _ = conn.execute(
        "UPDATE remote_devices SET last_seen = ?1 WHERE token = ?2",
        (now() as i64, token),
    );
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Commands (registered in lib.rs). State is `Arc<RemoteState>`.
// ---------------------------------------------------------------------------

/// Snapshot of the remote server for the settings panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    /// `ip:port` when running, else null.
    pub bound_addr: Option<String>,
    /// Convenience `http://ip:port` to open on the phone, when running.
    pub url: Option<String>,
    pub port: u16,
    /// Whether a Tailscale interface is currently detectable (drives the UI hint).
    pub tailscale_available: bool,
    pub device_count: usize,
    /// The active pairing code, if one is live (else null).
    pub pairing_code: Option<String>,
    /// Epoch seconds the active pairing code expires (else null).
    pub pairing_expires_at: Option<u64>,
}

/// A paired device row for the settings panel's device list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    /// The bearer token — also serves as the stable id for revoke (desktop-trusted UI).
    pub token: String,
    pub name: String,
    pub paired_at: i64,
    pub last_seen: Option<i64>,
}

fn status_of(state: &Arc<RemoteState>) -> RemoteStatus {
    let inner = state.inner.lock().unwrap();
    let (code, exp) = match &inner.pairing {
        Some(p) if p.expires_at > now() => (Some(p.code.clone()), Some(p.expires_at)),
        _ => (None, None),
    };
    RemoteStatus {
        running: inner.running,
        bound_addr: inner.bound_addr.clone(),
        url: inner.bound_addr.clone().map(|a| format!("http://{a}")),
        port: REMOTE_PORT,
        tailscale_available: tailscale_ip().is_some(),
        device_count: inner.tokens.len(),
        pairing_code: code,
        pairing_expires_at: exp,
    }
}

fn list_devices(app: &AppHandle) -> Vec<RemoteDevice> {
    let db = app.state::<Db>();
    let conn = db.conn.lock().expect("db lock poisoned");
    let mut out = Vec::new();
    if let Ok(mut stmt) = conn
        .prepare("SELECT token, name, paired_at, last_seen FROM remote_devices ORDER BY paired_at DESC")
    {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok(RemoteDevice {
                token: r.get(0)?,
                name: r.get(1)?,
                paired_at: r.get(2)?,
                last_seen: r.get(3)?,
            })
        }) {
            for d in rows.flatten() {
                out.push(d);
            }
        }
    }
    out
}

/// Enable remote serving: bind the Tailscale interface, start the server, and persist
/// the enabled flag so it auto-starts next launch. Errors if no tailnet / bind fails.
#[tauri::command]
pub fn remote_start(state: State<'_, Arc<RemoteState>>) -> Result<RemoteStatus, String> {
    let st = state.inner();
    start_server(st)?;
    let _ = st.app.state::<Db>().meta_set(ENABLED_KEY, "1");
    Ok(status_of(st))
}

/// Disable remote serving: gracefully stop the server and clear the enabled flag.
#[tauri::command]
pub fn remote_stop(state: State<'_, Arc<RemoteState>>) -> RemoteStatus {
    let st = state.inner();
    {
        let mut inner = st.inner.lock().unwrap();
        // Abort the acceptor (drops the listener → frees the port) and drop the
        // broadcast sender (every connected client's receiver closes → they disconnect).
        if let Some(task) = inner.task.take() {
            task.abort();
        }
        inner.tx = None;
        inner.running = false;
        inner.bound_addr = None;
    }
    let _ = st.app.state::<Db>().meta_set(ENABLED_KEY, "0");
    status_of(st)
}

/// Current remote server status for the settings panel.
#[tauri::command]
pub fn remote_status(state: State<'_, Arc<RemoteState>>) -> RemoteStatus {
    status_of(state.inner())
}

/// Generate a fresh one-time pairing code (replacing any prior active one) and return
/// the updated status carrying it. Shown in the UI so you can type it on the device.
#[tauri::command]
pub fn remote_new_pairing_code(state: State<'_, Arc<RemoteState>>) -> RemoteStatus {
    let st = state.inner();
    let code = gen_pairing_code();
    {
        let mut inner = st.inner.lock().unwrap();
        inner.pairing = Some(PairingCode {
            code,
            expires_at: now() + PAIRING_TTL_SECS,
        });
    }
    status_of(st)
}

/// A short, human-typable code like `A1B2-C3D4` (8 hex chars from a fresh UUID).
fn gen_pairing_code() -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    let up = hex[..8].to_uppercase();
    format!("{}-{}", &up[..4], &up[4..8])
}

/// Store the latest snapshot from the webview and fan it out to every WS client. Called
/// by the frontend mirror whenever instances/statuses/usage change.
#[tauri::command]
pub fn remote_push_snapshot(state: State<'_, Arc<RemoteState>>, json: String) {
    let st = state.inner();
    let mut inner = st.inner.lock().unwrap();
    inner.snapshot = json.clone();
    if let Some(tx) = &inner.tx {
        let _ = tx.send(json); // Err only means no WS clients are connected
    }
}

/// List paired devices for the settings panel.
#[tauri::command]
pub fn remote_devices_list(state: State<'_, Arc<RemoteState>>) -> Vec<RemoteDevice> {
    list_devices(&state.inner().app)
}

/// Revoke a paired device: delete its row and drop its token from the auth set, so its
/// next request is rejected. Returns the updated device list.
#[tauri::command]
pub fn remote_revoke_device(
    state: State<'_, Arc<RemoteState>>,
    token: String,
) -> Vec<RemoteDevice> {
    let st = state.inner();
    {
        let db = st.app.state::<Db>();
        let conn = db.conn.lock().expect("db lock poisoned");
        let _ = conn.execute("DELETE FROM remote_devices WHERE token = ?1", [&token]);
    }
    st.inner.lock().unwrap().tokens.remove(&token);
    list_devices(&st.app)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Tailscale CGNAT block 100.64.0.0/10 is recognized; neighboring private and
    /// public ranges are not — so we only ever bind the tailnet, never the LAN.
    #[test]
    fn detects_tailscale_cgnat_range() {
        assert!(is_tailscale_v4(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(is_tailscale_v4(Ipv4Addr::new(100, 100, 12, 9)));
        assert!(is_tailscale_v4(Ipv4Addr::new(100, 127, 255, 255)));
        // Just outside the /10 on either side.
        assert!(!is_tailscale_v4(Ipv4Addr::new(100, 63, 0, 1)));
        assert!(!is_tailscale_v4(Ipv4Addr::new(100, 128, 0, 1)));
        // Ordinary private / loopback / public addresses.
        assert!(!is_tailscale_v4(Ipv4Addr::new(192, 168, 1, 5)));
        assert!(!is_tailscale_v4(Ipv4Addr::new(10, 0, 0, 1)));
        assert!(!is_tailscale_v4(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!is_tailscale_v4(Ipv4Addr::new(8, 8, 8, 8)));
    }

    /// The auth gate accepts exactly the tokens in the set, and never the empty string
    /// (a missing/blank bearer must be rejected, not treated as a present token).
    #[test]
    fn token_membership_gate() {
        let mut set = HashSet::new();
        set.insert("good-token".to_string());
        assert!(token_ok(&set, "good-token"));
        assert!(!token_ok(&set, "other"));
        assert!(!token_ok(&set, ""));
        assert!(!token_ok(&HashSet::new(), "good-token"));
    }

    /// A pairing code is `XXXX-XXXX`, uppercase hex — the shape the device types in.
    #[test]
    fn pairing_code_shape() {
        let c = gen_pairing_code();
        assert_eq!(c.len(), 9);
        assert_eq!(c.as_bytes()[4], b'-');
        assert!(c
            .chars()
            .filter(|&ch| ch != '-')
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_lowercase()));
    }
}
