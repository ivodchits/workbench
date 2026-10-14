//! Remote access server (step 4.3, design §11).
//!
//! Grows the Rust core into an authenticated API + WebSocket server bound to the
//! **Tailscale interface**, so you can supervise agents from another device on your
//! tailnet (the PWA client is step 4.4, the mirrored terminal step 4.5). This module
//! owns the server lifecycle, the device auth, and the bridge between the frontend
//! and remote clients.
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
//!    (prompt/approve/deny/interrupt/start/stop/create) is emitted as a `remote-action` Tauri
//!    event; the frontend's single handler maps it to the right keystroke/command
//!    (the §11 caveat: keep that mapping in one place). We never write to a PTY here.
//!
//! **Security (step R2):** off by default; enabled from the Remote Access menu. When
//! on we bind **only** to the detected Tailscale address (100.64.0.0/10) — never
//! broader. Pairing takes three things: a code that exists only once the desktop asks
//! for one (10 symbols, 10 minutes, one use, burned after 5 wrong tries, `/pair`
//! rate-limited for everyone — [`auth::PairGate`]); the long-lived token it is
//! exchanged for; and a **desktop approval** before that token is worth anything. A
//! token travels in a header only (`Authorization`, or the WebSocket subprotocol),
//! is compared in constant time, and stops working after 30 days unused. Failures are
//! logged for the menu. Every change to devices, the code or the log is announced to
//! the webview as `remote-changed`.

mod auth;
mod server;

use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, watch};

use crate::db::Db;
use auth::{AuthFailure, AuthLog, PairGate, PairOutcome};

/// The port the remote server binds on the Tailscale interface. A debug build uses a
/// different port so a `tauri dev` run never fights an installed release for it
/// (mirrors the hook server's `PORT_BASE` split).
const REMOTE_PORT: u16 = if cfg!(debug_assertions) { 49020 } else { 48990 };

/// `meta` key persisting whether remote serving was last enabled, so it auto-starts
/// on the next launch (best-effort — a bind failure never blocks the app).
const ENABLED_KEY: &str = "remote_enabled";

/// Longest device name kept from a pairing request.
const NAME_MAX: usize = 40;

/// Tauri-managed (`Arc<RemoteState>`) shared state for the remote server. Created and
/// managed in [`init`] during setup, mirroring how the hook server manages its
/// `Arc<HookContext>`. The axum handlers receive the same `Arc` as their router state,
/// so commands and request handlers see one source of truth.
pub struct RemoteState {
    /// To resolve the DB (paired devices) and to emit events to the webview.
    app: AppHandle,
    inner: Mutex<RemoteInner>,
    /// Bumped whenever a device loses access (revoked, denied, expired, server
    /// stopped), so open sockets re-check theirs and close if it is gone.
    kick: watch::Sender<u64>,
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
    /// Every paired device, approved or waiting (mirrors `remote_devices`).
    devices: Vec<Device>,
    /// The pairing code and the limits on trying it.
    gate: PairGate,
    /// Recent auth failures, for the menu.
    log: AuthLog,
}

/// One paired device, as held in memory.
#[derive(Clone)]
struct Device {
    id: String,
    token: String,
    name: String,
    paired_at: u64,
    last_seen: Option<u64>,
    last_addr: Option<String>,
    approved: bool,
}

/// What a presented token is worth.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Access {
    /// An approved device, by id.
    Granted(String),
    /// Paired, but not yet approved on the desktop.
    Pending,
    Denied,
}

/// Start the remote subsystem: create + manage the shared state, load paired devices
/// (dropping expired ones), and auto-start the server if it was enabled last run.
/// Never fails the app — a bind error only means remote access stays off until
/// re-enabled.
pub fn init(app: &AppHandle) {
    let mut devices = load_devices(app);
    let now = now();
    let (stale, live): (Vec<Device>, Vec<Device>) = devices
        .drain(..)
        .partition(|d| auth::device_expired(d.approved, d.paired_at, d.last_seen, now).is_some());
    // Said in the failure log, so a device that quietly stopped working is explained.
    let mut log = AuthLog::default();
    for d in &stale {
        delete_device_row(app, &d.id);
        if let Some(why) = auth::device_expired(d.approved, d.paired_at, d.last_seen, now) {
            let addr = d.last_addr.as_deref().unwrap_or("—");
            log.record(addr, &format!("“{}” {why}, removed", d.name), now);
        }
    }
    let state = Arc::new(RemoteState {
        app: app.clone(),
        inner: Mutex::new(RemoteInner {
            running: false,
            bound_addr: None,
            task: None,
            tx: None,
            snapshot: "{}".to_string(),
            devices: live,
            gate: PairGate::default(),
            log,
        }),
        kick: watch::channel(0).0,
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

/// Every paired device row.
fn load_devices(app: &AppHandle) -> Vec<Device> {
    let db = app.state::<Db>();
    let conn = db.conn.lock().expect("db lock poisoned");
    // A build from before step R2 sharing this database pairs devices with no id.
    let _ = conn.execute(
        "UPDATE remote_devices SET id = lower(hex(randomblob(8))) WHERE id IS NULL",
        [],
    );
    let mut out = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, token, name, paired_at, last_seen, last_addr, approved FROM remote_devices",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok(Device {
                id: r.get(0)?,
                token: r.get(1)?,
                name: r.get(2)?,
                paired_at: r.get::<_, i64>(3)? as u64,
                last_seen: r.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                last_addr: r.get(5)?,
                approved: r.get::<_, i64>(6)? != 0,
            })
        }) {
            out.extend(rows.flatten());
        }
    }
    out
}

fn delete_device_row(app: &AppHandle, id: &str) {
    let db = app.state::<Db>();
    let conn = db.conn.lock().expect("db lock poisoned");
    let _ = conn.execute("DELETE FROM remote_devices WHERE id = ?1", [id]);
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

/// Tell the webview that devices, the code or the failure log changed.
fn changed(state: &RemoteState) {
    let _ = state.app.emit("remote-changed", ());
}

/// Note a failure from `addr` for the menu.
fn log_failure(state: &RemoteState, addr: &str, what: &str) {
    state.inner.lock().unwrap().log.record(addr, what, now());
    changed(state);
}

/// Tell open sockets to re-check their device.
fn kick(state: &RemoteState) {
    state.kick.send_modify(|n| *n += 1);
}

/// Check a pairing attempt from `addr` and, on success, mint + persist a device token
/// that waits for approval on the desktop. Called by the (unauthenticated) `/pair`
/// handler; the outcome decides its answer.
fn try_pair(
    state: &Arc<RemoteState>,
    code: &str,
    name: &str,
    addr: &str,
) -> Result<String, PairOutcome> {
    let outcome = state.inner.lock().unwrap().gate.attempt(code, now());
    match outcome {
        PairOutcome::Paired => {}
        PairOutcome::Busy => {
            log_failure(state, addr, "too many pairing attempts");
            return Err(outcome);
        }
        PairOutcome::Locked => {
            log_failure(state, addr, "pairing locked after wrong codes");
            return Err(outcome);
        }
        PairOutcome::NoCode => {
            log_failure(state, addr, "pairing with no live code");
            return Err(outcome);
        }
        PairOutcome::Wrong { .. } => {
            log_failure(state, addr, "wrong pairing code");
            return Err(outcome);
        }
    }
    // 256-bit unguessable token (two v4 UUIDs concatenated, hyphen-free).
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let id = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
    let name: String = name.chars().take(NAME_MAX).collect();
    let device = Device {
        id: id.clone(),
        token: token.clone(),
        name,
        paired_at: now(),
        last_seen: None,
        last_addr: Some(addr.to_string()),
        approved: false,
    };
    {
        let db = state.app.state::<Db>();
        let conn = db.conn.lock().expect("db lock poisoned");
        let _ = conn.execute(
            "INSERT INTO remote_devices (id, token, name, paired_at, last_seen, last_addr, approved)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, 0)",
            (&device.id, &device.token, &device.name, device.paired_at as i64, addr),
        );
    }
    state.inner.lock().unwrap().devices.push(device);
    changed(state);
    Ok(token)
}

/// What `token`, presented from `addr`, is worth. Every device is compared in
/// constant time, so the answer's timing doesn't depend on which (if any) matched. A
/// grant records the device's `last_seen` and address. An expired device is dropped.
fn check_token(state: &Arc<RemoteState>, token: Option<&str>, addr: &str) -> Access {
    let token = token.unwrap_or("");
    if token.is_empty() {
        log_failure(state, addr, "no device token");
        return Access::Denied;
    }
    let now = now();
    let found = {
        let inner = state.inner.lock().unwrap();
        let mut hit = None;
        for (i, d) in inner.devices.iter().enumerate() {
            if auth::ct_eq(d.token.as_bytes(), token.as_bytes()) {
                hit = Some(i);
            }
        }
        hit.map(|i| inner.devices[i].clone())
    };
    let Some(device) = found else {
        log_failure(state, addr, "unknown device token");
        return Access::Denied;
    };
    if let Some(why) =
        auth::device_expired(device.approved, device.paired_at, device.last_seen, now)
    {
        remove_device(state, &device.id);
        log_failure(state, addr, &format!("“{}” {why}", device.name));
        return Access::Denied;
    }
    if !device.approved {
        return Access::Pending;
    }
    {
        let mut inner = state.inner.lock().unwrap();
        if let Some(d) = inner.devices.iter_mut().find(|d| d.id == device.id) {
            d.last_seen = Some(now);
            d.last_addr = Some(addr.to_string());
        }
    }
    let db = state.app.state::<Db>();
    let conn = db.conn.lock().expect("db lock poisoned");
    let _ = conn.execute(
        "UPDATE remote_devices SET last_seen = ?1, last_addr = ?2 WHERE id = ?3",
        (now as i64, addr, &device.id),
    );
    Access::Granted(device.id)
}

/// Whether the device behind an open socket still has access.
fn device_valid(state: &RemoteState, id: &str) -> bool {
    let inner = state.inner.lock().unwrap();
    inner.running && inner.devices.iter().any(|d| d.id == id && d.approved)
}

/// Forget a device everywhere and close its sockets.
fn remove_device(state: &RemoteState, id: &str) {
    delete_device_row(&state.app, id);
    state.inner.lock().unwrap().devices.retain(|d| d.id != id);
    kick(state);
    changed(state);
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
    /// Approved devices.
    pub device_count: usize,
    /// Devices waiting for approval.
    pub pending_count: usize,
    /// The active pairing code, if one is live (else null).
    pub pairing_code: Option<String>,
    /// Epoch seconds the active pairing code expires (else null).
    pub pairing_expires_at: Option<u64>,
    /// Whether wrong tries burned the last code (a new one is needed).
    pub pairing_locked: bool,
}

/// A paired device row for the settings panel's device list. The token never leaves
/// the backend; the id names the device for approve and revoke.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
    /// The address it last used (or paired from).
    pub last_addr: Option<String>,
    pub approved: bool,
    /// Epoch seconds it stops working unless used (approved) or approved (pending).
    pub expires_at: u64,
}

fn status_of(state: &Arc<RemoteState>) -> RemoteStatus {
    let inner = state.inner.lock().unwrap();
    let now = now();
    let live = inner.gate.live(now);
    RemoteStatus {
        running: inner.running,
        bound_addr: inner.bound_addr.clone(),
        url: inner.bound_addr.clone().map(|a| format!("http://{a}")),
        port: REMOTE_PORT,
        tailscale_available: tailscale_ip().is_some(),
        device_count: inner.devices.iter().filter(|d| d.approved).count(),
        pending_count: inner.devices.iter().filter(|d| !d.approved).count(),
        pairing_code: live.map(|(code, _)| code.to_string()),
        pairing_expires_at: live.map(|(_, exp)| exp),
        pairing_locked: inner.gate.locked(),
    }
}

fn list_devices(state: &RemoteState) -> Vec<RemoteDevice> {
    let inner = state.inner.lock().unwrap();
    let mut out: Vec<RemoteDevice> = inner
        .devices
        .iter()
        .map(|d| RemoteDevice {
            id: d.id.clone(),
            name: d.name.clone(),
            paired_at: d.paired_at,
            last_seen: d.last_seen,
            last_addr: d.last_addr.clone(),
            approved: d.approved,
            expires_at: if d.approved {
                d.last_seen.unwrap_or(d.paired_at).max(d.paired_at) + auth::IDLE_EXPIRY_SECS
            } else {
                d.paired_at + auth::PENDING_TTL_SECS
            },
        })
        .collect();
    out.sort_by_key(|d| std::cmp::Reverse(d.paired_at));
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

/// Disable remote serving: gracefully stop the server, drop any pairing code, and
/// clear the enabled flag.
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
        inner.gate.clear();
    }
    kick(st); // mirrored consoles don't ride the broadcast channel
    let _ = st.app.state::<Db>().meta_set(ENABLED_KEY, "0");
    status_of(st)
}

/// Current remote server status for the settings panel.
#[tauri::command]
pub fn remote_status(state: State<'_, Arc<RemoteState>>) -> RemoteStatus {
    status_of(state.inner())
}

/// Generate a fresh one-time pairing code (replacing any prior one and clearing a
/// lockout) and return the updated status carrying it. The only way a code comes to
/// exist: shown in the UI so you can type it on the device.
#[tauri::command]
pub fn remote_new_pairing_code(state: State<'_, Arc<RemoteState>>) -> Result<RemoteStatus, String> {
    let st = state.inner();
    if !st.inner.lock().unwrap().running {
        return Err("remote access is off".into());
    }
    let code = auth::gen_pairing_code();
    st.inner.lock().unwrap().gate.issue(code, now());
    Ok(status_of(st))
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

/// List paired devices (approved and waiting) for the menu and the approval dialog.
#[tauri::command]
pub fn remote_devices_list(state: State<'_, Arc<RemoteState>>) -> Vec<RemoteDevice> {
    list_devices(state.inner())
}

/// Approve a waiting device: its token starts working. Returns the updated list.
#[tauri::command]
pub fn remote_approve_device(state: State<'_, Arc<RemoteState>>, id: String) -> Vec<RemoteDevice> {
    let st = state.inner();
    let now = now();
    let found = {
        let mut inner = st.inner.lock().unwrap();
        match inner.devices.iter_mut().find(|d| d.id == id && !d.approved) {
            Some(d) => {
                d.approved = true;
                d.last_seen = Some(now); // the 30 days unused count from here
                true
            }
            None => false,
        }
    };
    if found {
        let db = st.app.state::<Db>();
        let conn = db.conn.lock().expect("db lock poisoned");
        let _ = conn.execute(
            "UPDATE remote_devices SET approved = 1, last_seen = ?1 WHERE id = ?2",
            (now as i64, &id),
        );
        drop(conn);
        changed(st);
    }
    list_devices(st)
}

/// Revoke a paired device, or deny a waiting one: delete its row, drop its token, and
/// close any socket it has open. Returns the updated device list.
#[tauri::command]
pub fn remote_revoke_device(state: State<'_, Arc<RemoteState>>, id: String) -> Vec<RemoteDevice> {
    let st = state.inner();
    remove_device(st, &id);
    list_devices(st)
}

/// Recent auth failures, newest first.
#[tauri::command]
pub fn remote_auth_log(state: State<'_, Arc<RemoteState>>) -> Vec<AuthFailure> {
    state.inner().inner.lock().unwrap().log.entries()
}

/// Empty the failure log.
#[tauri::command]
pub fn remote_clear_auth_log(state: State<'_, Arc<RemoteState>>) {
    let st = state.inner();
    st.inner.lock().unwrap().log.clear();
    changed(st);
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
}
