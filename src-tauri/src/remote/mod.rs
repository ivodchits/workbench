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
//! on we bind **only** the detected Tailscale address (100.64.0.0/10) and loopback —
//! never the LAN. Pairing takes three things: a code that exists only once the desktop asks
//! for one (10 symbols, 10 minutes, one use, burned after 5 wrong tries, `/pair`
//! rate-limited for everyone — [`auth::PairGate`]); the long-lived token it is
//! exchanged for; and a **desktop approval** before that token is worth anything. A
//! token travels in a header only (`Authorization`, or the WebSocket subprotocol),
//! is compared in constant time, and stops working after 30 days unused. Failures are
//! logged for the menu. Every change to devices, the code or the log is announced to
//! the webview as `remote-changed`.
//!
//! **Device keys (assistant plan R3):** a phone that pairs over https sends a public
//! key with the code. Its token then opens nothing by itself: the page signs a
//! challenge (`/auth/challenge`, `/auth/session`) and uses the session it gets, which
//! lives only in memory (here and in the page). See [`auth`]'s "the device key".
//! A phone paired over plain http (the tailnet address) has no WebCrypto, so no key,
//! and works on its token as before; the menu says which devices are bound.
//!
//! **Public access (step R3):** the server also listens on `127.0.0.1`, and an
//! opt-in switch has Tailscale Funnel proxy a public `https://…ts.net` address to that
//! listener ([`funnel`]). A background *keeper* thread holds things in place: it binds
//! the tailnet address once Tailscale connects (it may come up after Workbench at
//! boot), adds the funnel while the switch and the server are on, removes it when
//! either goes off, and re-checks now and then so the menu says what is missing.
//!
//! **Duck (step R1):** [`assistant`] carries the Duck Protocol to the phone, through
//! the webview like the dashboard: its own socket and broadcast channel (per run,
//! like the snapshot's), plus routes for the phone's voice clips and spoken replies.

pub mod assistant;
mod auth;
mod funnel;
mod notes;
pub mod push;
mod server;
mod transcript;

use std::net::Ipv4Addr;
use std::sync::atomic::AtomicU64;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, watch};

use crate::db::Db;
use auth::{AuthFailure, AuthLog, PairGate, PairOutcome};
use funnel::{PublicPhase, PublicStatus};

/// The port the remote server binds on the Tailscale interface. A debug build uses a
/// different port so a `tauri dev` run never fights an installed release for it
/// (mirrors the hook server's `PORT_BASE` split).
const REMOTE_PORT: u16 = if cfg!(debug_assertions) { 49020 } else { 48990 };

/// `meta` key persisting whether remote serving was last enabled, so it auto-starts
/// on the next launch (best-effort — a bind failure never blocks the app).
const ENABLED_KEY: &str = "remote_enabled";

/// `meta` key persisting the public access (Funnel) switch. Off unless set to `1`.
const PUBLIC_KEY: &str = "remote_public";

/// How often the keeper re-checks: while public access works, while it doesn't (or
/// the tailnet address is missing), and otherwise.
const RECHECK_ON: Duration = Duration::from_secs(60);
const RECHECK_RETRY: Duration = Duration::from_secs(15);
const RECHECK_IDLE: Duration = Duration::from_secs(300);

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
    /// Wakes the keeper thread to act on a change now rather than at its next check.
    wake: Mutex<mpsc::Sender<()>>,
    /// Numbers Duck's sockets, so an answer goes to the one that asked.
    next_conn: AtomicU64,
}

struct RemoteInner {
    running: bool,
    /// The tailnet `ip:port` the server is bound to, when running and Tailscale is up.
    bound_addr: Option<String>,
    /// The loopback `ip:port` (what Funnel proxies to), when running.
    local_addr: Option<String>,
    /// The running server's acceptor tasks, one per listener. Aborting them drops the
    /// listeners and frees the port immediately, so a disable→enable toggle can always
    /// re-bind.
    tasks: Vec<JoinHandle<()>>,
    /// Public access: the switch and where it stands.
    public: PublicStatus,
    /// Our funnel may still be up although it is no longer wanted; the keeper removes
    /// it once Tailscale can be asked.
    funnel_cleanup: bool,
    /// Broadcast of snapshot JSON to every connected WS client, **created per run**: it
    /// lives only while the server is running. Dropping it on stop makes every connected
    /// client's receiver close, so the toggle actually disconnects them (rather than
    /// leaving a phone attached to a server that's "off"). A lagging client just misses
    /// intermediate frames — each frame is the full state, so it recovers.
    tx: Option<broadcast::Sender<String>>,
    /// Duck's frames to its sockets (step R1); per run, like `tx`.
    duck: Option<broadcast::Sender<assistant::DuckFrame>>,
    /// The most recent snapshot the webview pushed; served to a new WS/HTTP client.
    snapshot: String,
    /// Every paired device, approved or waiting (mirrors `remote_devices`).
    devices: Vec<Device>,
    /// The pairing code and the limits on trying it.
    gate: PairGate,
    /// What device keys sign, and the sessions their proofs bought (assistant R3).
    challenges: auth::Challenges,
    sessions: auth::Sessions,
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
    /// The device key's public half (base64url SEC1), when it paired with one. Its
    /// token alone is then refused: it needs a session.
    public_key: Option<String>,
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
    let db = app.state::<Db>();
    let meta = |key| db.meta_get(key).ok().flatten();
    let enabled = meta(ENABLED_KEY).as_deref() == Some("1");
    let public = meta(PUBLIC_KEY);
    let public_on = public.as_deref() == Some("1");
    let (wake, wake_rx) = mpsc::channel();
    let state = Arc::new(RemoteState {
        app: app.clone(),
        inner: Mutex::new(RemoteInner {
            running: false,
            bound_addr: None,
            local_addr: None,
            tasks: Vec::new(),
            public: PublicStatus::new(public_on),
            // Only someone who has used the switch can have a funnel of ours left over.
            funnel_cleanup: public.is_some() && !(public_on && enabled),
            tx: None,
            duck: None,
            snapshot: "{}".to_string(),
            devices: live,
            gate: PairGate::default(),
            challenges: auth::Challenges::default(),
            sessions: auth::Sessions::default(),
            log,
        }),
        kick: watch::channel(0).0,
        wake: Mutex::new(wake),
        next_conn: AtomicU64::new(0),
    });
    app.manage(state.clone());

    if enabled {
        if let Err(e) = start_server(&state) {
            eprintln!("[remote] auto-start skipped: {e}");
        }
    }
    let keeper_state = state.clone();
    std::thread::Builder::new()
        .name("remote-keeper".into())
        .spawn(move || keeper(keeper_state, wake_rx))
        .ok();
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
        "SELECT id, token, name, paired_at, last_seen, last_addr, approved, public_key FROM remote_devices",
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
                public_key: r.get(7)?,
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
    // Its push subscription goes with it (step R6).
    let _ = conn.execute("DELETE FROM push_subscriptions WHERE device_id = ?1", [id]);
}

/// Bind loopback (and the Tailscale interface, if it is up) and spawn the axum server.
/// Idempotent: if already running, does nothing. Errors (returned, never panicked)
/// when the loopback bind fails — the caller surfaces that. With no Tailscale address
/// yet, the keeper binds it once one appears. A fresh broadcast channel is created per
/// run so [`remote_stop`] can drop it to disconnect clients.
fn start_server(state: &Arc<RemoteState>) -> Result<(), String> {
    if state.inner.lock().unwrap().running {
        return Ok(());
    }
    let local = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, REMOTE_PORT))
        .map_err(|e| format!("bind 127.0.0.1:{REMOTE_PORT} failed: {e}"))?;
    let (tx, _rx) = broadcast::channel::<String>(32);
    // Room for a burst of streamed text.
    let (duck, _rx) = broadcast::channel::<assistant::DuckFrame>(512);
    {
        let mut inner = state.inner.lock().unwrap();
        inner.running = true;
        inner.local_addr = Some(format!("127.0.0.1:{REMOTE_PORT}"));
        inner.tx = Some(tx);
        inner.duck = Some(duck);
    }
    // Spawn after the state is published so a connection that arrives immediately finds
    // the channel; store the acceptor handle so stop can abort it (freeing the port).
    let task = server::serve(local, state.clone());
    state.inner.lock().unwrap().tasks.push(task);
    if let Err(e) = bind_tailnet(state) {
        eprintln!("[remote] {e}");
    }
    wake(state);
    Ok(())
}

/// Add the tailnet listener to a running server, if Tailscale has an address and it
/// isn't bound yet. `Ok(false)`: nothing to bind (yet).
fn bind_tailnet(state: &Arc<RemoteState>) -> Result<bool, String> {
    {
        let inner = state.inner.lock().unwrap();
        if !inner.running || inner.bound_addr.is_some() {
            return Ok(false);
        }
    }
    let Some(ip) = tailscale_ip() else { return Ok(false) };
    let listener = std::net::TcpListener::bind((ip, REMOTE_PORT))
        .map_err(|e| format!("bind {ip}:{REMOTE_PORT} failed: {e}"))?;
    let task = server::serve(listener, state.clone());
    let mut inner = state.inner.lock().unwrap();
    if !inner.running {
        task.abort(); // stopped meanwhile
        return Ok(false);
    }
    inner.bound_addr = Some(format!("{ip}:{REMOTE_PORT}"));
    inner.tasks.push(task);
    Ok(true)
}

/// The loopback URL Funnel proxies to.
fn local_target() -> String {
    format!("http://127.0.0.1:{REMOTE_PORT}")
}

/// Ask the keeper to look again now.
fn wake(state: &RemoteState) {
    let _ = state.wake.lock().unwrap().send(());
}

/// The keeper thread: see the module docs. Runs for the life of the app.
fn keeper(state: Arc<RemoteState>, wake: mpsc::Receiver<()>) {
    loop {
        let wait = keep(&state);
        match wake.recv_timeout(wait) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        while wake.try_recv().is_ok() {} // several changes, one look
    }
}

/// One look: bind the tailnet if it has appeared, then bring the funnel in line with
/// the switch. Returns how long to wait before the next look. The CLI calls run with
/// no lock held.
fn keep(state: &Arc<RemoteState>) -> Duration {
    match bind_tailnet(state) {
        Ok(true) => changed(state),
        Ok(false) => {}
        Err(e) => eprintln!("[remote] {e}"),
    }
    let (running, tailnet, enabled) = {
        let inner = state.inner.lock().unwrap();
        (inner.running, inner.bound_addr.is_some(), inner.public.enabled)
    };
    let target = local_target();
    if running && enabled {
        let next = match funnel::ensure(&target) {
            Ok(url) => PublicStatus {
                phase: PublicPhase::On,
                url: Some(url),
                ..PublicStatus::new(true)
            },
            Err(p) => PublicStatus {
                phase: PublicPhase::Problem,
                problem: Some(p.message),
                fix_url: p.fix_url,
                ..PublicStatus::new(true)
            },
        };
        let on = next.phase == PublicPhase::On;
        set_public(state, next, true);
        return if on && tailnet { RECHECK_ON } else { RECHECK_RETRY };
    }
    set_public(
        state,
        PublicStatus { phase: PublicPhase::Off, ..PublicStatus::new(enabled) },
        enabled,
    );
    if state.inner.lock().unwrap().funnel_cleanup {
        let done = match funnel::remove(&target) {
            Ok(done) => done,
            Err(e) => {
                eprintln!("[remote] couldn’t remove the funnel: {e}");
                true // said once; don't keep at it
            }
        };
        if done {
            state.inner.lock().unwrap().funnel_cleanup = false;
        }
    }
    let cleanup = state.inner.lock().unwrap().funnel_cleanup;
    if cleanup || (running && !tailnet) {
        RECHECK_RETRY
    } else {
        RECHECK_IDLE
    }
}

/// Publish the keeper's finding, unless the switch moved while it looked (`wanted` is
/// the switch it looked for). Announces only a real change.
fn set_public(state: &RemoteState, next: PublicStatus, wanted: bool) {
    let moved = {
        let mut inner = state.inner.lock().unwrap();
        if inner.public.enabled != wanted || inner.public == next {
            false
        } else {
            inner.public = next;
            true
        }
    };
    if moved {
        changed(state);
    }
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
/// that waits for approval on the desktop, bound to `public_key` when one came (and
/// parses; one that doesn't is dropped, so the page learns from `bound` below).
/// Called by the (unauthenticated) `/pair` handler; the outcome decides its answer.
fn try_pair(
    state: &Arc<RemoteState>,
    code: &str,
    name: &str,
    addr: &str,
    public_key: Option<&str>,
) -> Result<(String, bool), PairOutcome> {
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
    let token = auth::random_token();
    let public_key = public_key
        .map(str::trim)
        .filter(|k| auth::parse_public_key(k).is_some())
        .map(str::to_string);
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
        public_key,
    };
    let bound = device.public_key.is_some();
    {
        let db = state.app.state::<Db>();
        let conn = db.conn.lock().expect("db lock poisoned");
        let _ = conn.execute(
            "INSERT INTO remote_devices (id, token, name, paired_at, last_seen, last_addr, approved, public_key)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, 0, ?6)",
            (&device.id, &device.token, &device.name, device.paired_at as i64, addr, &device.public_key),
        );
    }
    state.inner.lock().unwrap().devices.push(device);
    changed(state);
    Ok((token, bound))
}

/// The device whose token is `token`. Every device is compared in constant time, so
/// the answer's timing doesn't depend on which (if any) matched.
fn device_by_token(state: &RemoteState, token: &str) -> Option<Device> {
    let inner = state.inner.lock().unwrap();
    let mut hit = None;
    for (i, d) in inner.devices.iter().enumerate() {
        if auth::ct_eq(d.token.as_bytes(), token.as_bytes()) {
            hit = Some(i);
        }
    }
    hit.map(|i| inner.devices[i].clone())
}

/// What `token`, presented from `addr`, is worth: a session a device key bought, or a
/// device token (refused for a device with a key, which must use a session). A grant
/// records the device's `last_seen` and address. An expired device is dropped.
fn check_token(state: &Arc<RemoteState>, token: Option<&str>, addr: &str) -> Access {
    let token = token.unwrap_or("");
    if token.is_empty() {
        log_failure(state, addr, "no device token");
        return Access::Denied;
    }
    let now = now();
    let session = state.inner.lock().unwrap().sessions.device(token, now);
    let found = match &session {
        Some(id) => state.inner.lock().unwrap().devices.iter().find(|d| &d.id == id).cloned(),
        None => device_by_token(state, token),
    };
    let Some(device) = found else {
        log_failure(state, addr, if session.is_some() { "a session of a removed device" } else { "unknown device token" });
        return Access::Denied;
    };
    if session.is_none() && device.public_key.is_some() && device.approved {
        log_failure(state, addr, &format!("“{}” token used without its device key", device.name));
        return Access::Denied;
    }
    grant(state, device, addr, now)
}

/// The rest of [`check_token`] once the device is known: expiry, approval, and the
/// record of its use.
fn grant(state: &Arc<RemoteState>, device: Device, addr: &str, now: u64) -> Access {
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

/// Why `/auth/session` refused.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SessionRefusal {
    /// No such device, or the proof failed: pair again.
    Denied,
    /// Proven, but the desktop hasn't allowed it yet.
    Pending,
    /// The device paired without a key; its token is what it uses.
    NoKey,
    /// The challenge expired or was used: ask for another.
    Stale,
}

/// Start a session for the device behind `token`, if `signature` signs `challenge`
/// with the key it paired with.
fn start_session(
    state: &Arc<RemoteState>,
    token: Option<&str>,
    challenge: &str,
    signature: &str,
    addr: &str,
) -> Result<String, SessionRefusal> {
    let now = now();
    let token = token.unwrap_or("");
    let found = if token.is_empty() { None } else { device_by_token(state, token) };
    let Some(device) = found else {
        log_failure(state, addr, "unknown device token");
        return Err(SessionRefusal::Denied);
    };
    let Some(key) = device.public_key.clone() else {
        return Err(SessionRefusal::NoKey);
    };
    if !state.inner.lock().unwrap().challenges.take(challenge, now) {
        return Err(SessionRefusal::Stale);
    }
    if !auth::proof_ok(&key, challenge, signature) {
        log_failure(state, addr, &format!("“{}” device key proof failed", device.name));
        return Err(SessionRefusal::Denied);
    }
    let id = device.id.clone();
    match grant(state, device, addr, now) {
        Access::Granted(_) => Ok(state.inner.lock().unwrap().sessions.start(&id, now)),
        Access::Pending => Err(SessionRefusal::Pending),
        Access::Denied => Err(SessionRefusal::Denied),
    }
}

/// Whether the device behind an open socket still has access.
fn device_valid(state: &RemoteState, id: &str) -> bool {
    let inner = state.inner.lock().unwrap();
    inner.running && inner.devices.iter().any(|d| d.id == id && d.approved)
}

/// Forget a device everywhere and close its sockets.
fn remove_device(state: &RemoteState, id: &str) {
    delete_device_row(&state.app, id);
    {
        let mut inner = state.inner.lock().unwrap();
        inner.devices.retain(|d| d.id != id);
        inner.sessions.end_device(id);
    }
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
    /// The tailnet `ip:port` when running and Tailscale is up, else null.
    pub bound_addr: Option<String>,
    /// The loopback `ip:port` when running (what Funnel proxies to).
    pub local_addr: Option<String>,
    /// Convenience `http://ip:port` to open on the phone over the tailnet.
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
    /// Public access through Tailscale Funnel (step R3).
    pub public: PublicStatus,
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
    /// It paired with a device key (assistant R3): its token alone opens nothing.
    pub bound: bool,
}

fn status_of(state: &Arc<RemoteState>) -> RemoteStatus {
    let inner = state.inner.lock().unwrap();
    let now = now();
    let live = inner.gate.live(now);
    RemoteStatus {
        running: inner.running,
        bound_addr: inner.bound_addr.clone(),
        local_addr: inner.local_addr.clone(),
        url: inner.bound_addr.clone().map(|a| format!("http://{a}")),
        port: REMOTE_PORT,
        tailscale_available: tailscale_ip().is_some(),
        device_count: inner.devices.iter().filter(|d| d.approved).count(),
        pending_count: inner.devices.iter().filter(|d| !d.approved).count(),
        pairing_code: live.map(|(code, _)| code.to_string()),
        pairing_expires_at: live.map(|(_, exp)| exp),
        pairing_locked: inner.gate.locked(),
        public: inner.public.clone(),
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
            bound: d.public_key.is_some(),
        })
        .collect();
    out.sort_by_key(|d| std::cmp::Reverse(d.paired_at));
    out
}

/// Enable remote serving: bind loopback and the Tailscale interface, start the server,
/// and persist the enabled flag so it auto-starts next launch. Errors if the bind
/// fails. With Tailscale down it still starts; the tailnet address follows.
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
        for task in inner.tasks.drain(..) {
            task.abort();
        }
        inner.tx = None;
        inner.duck = None;
        inner.running = false;
        inner.bound_addr = None;
        inner.local_addr = None;
        inner.gate.clear();
        inner.sessions.clear();
        // A funnel to a stopped server only answers 502; take it down too. The switch
        // stays as it is, so turning the server back on restores it.
        if inner.public.enabled {
            inner.funnel_cleanup = true;
            inner.public.phase = PublicPhase::Off;
        }
    }
    kick(st); // mirrored consoles don't ride the broadcast channel
    wake(st);
    let _ = st.app.state::<Db>().meta_set(ENABLED_KEY, "0");
    status_of(st)
}

/// Turn public access (Tailscale Funnel) on or off. Persisted, so it comes back on
/// with the app. The keeper does the work and announces the outcome as
/// `remote-changed`; the status returned says "starting" until then.
#[tauri::command]
pub fn remote_set_public(state: State<'_, Arc<RemoteState>>, enabled: bool) -> RemoteStatus {
    let st = state.inner();
    {
        let mut inner = st.inner.lock().unwrap();
        let phase = if enabled && inner.running { PublicPhase::Starting } else { PublicPhase::Off };
        inner.public = PublicStatus { phase, ..PublicStatus::new(enabled) };
        if !enabled {
            inner.funnel_cleanup = true;
        }
    }
    let _ = st.app.state::<Db>().meta_set(PUBLIC_KEY, if enabled { "1" } else { "0" });
    wake(st);
    changed(st);
    status_of(st)
}

/// `text` as a QR code (an SVG document), for the public address.
#[tauri::command]
pub fn remote_qr_svg(text: String) -> Result<String, String> {
    funnel::qr_svg(&text)
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

/// Tell connected phones that a project's notes changed (step R8), on the dashboard
/// socket beside the snapshots: `{"type":"notes","projectId":…}`. Not stored as the
/// snapshot, so a phone connecting later just reads the notes fresh. A no-op while
/// the server is off or remote access was never set up.
pub fn push_notes_changed(app: &AppHandle, project_id: &str) {
    let Some(state) = app.try_state::<Arc<RemoteState>>() else { return };
    let inner = state.inner.lock().unwrap();
    if let Some(tx) = &inner.tx {
        let _ = tx.send(serde_json::json!({ "type": "notes", "projectId": project_id }).to_string());
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
    /// public ranges are not — so we only ever bind the tailnet (and loopback), never the
/// LAN.
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
