//! The fleet (fleet plan F1.1): Workbench instances on several machines knowing about
//! each other and holding an authenticated link to each other.
//!
//! - **Identity.** Each instance has an id and a P-256 instance key, made on first run
//!   and kept in `meta` ([`store`]). Its member record (name, tailnet address, fleet
//!   port, key) is what the others hold.
//! - **Joining.** "Add a machine" issues a one-time code on one instance (the phone's
//!   [`PairGate`] rules: 10 minutes, one use, burned after wrong tries). The menu shows
//!   it as a join string, `CODE@ip:port`. The other instance posts its own record with
//!   the code to `/fleet/join`; the answer is every member the inviter knows. Entering
//!   a code you were shown is the consent on both sides, and the peer must belong to
//!   the same tailnet user ([`Net::same_owner`]).
//! - **The link.** One WebSocket per pair of members, `/fleet/link`, on this module's
//!   own listener: the **tailnet address only**, never loopback, because loopback is
//!   where Funnel delivers the public internet to the remote server. Each side signs
//!   the other's nonce with its instance key ([`proto::link_statement`]). Both sides
//!   dial; when two links meet, both keep the one the smaller id dialed.
//! - **On the link:** beats every 5 s (name, version, OS, capabilities), the member
//!   list on connect and on every change (gossip: newest record wins, tombstones
//!   included, [`proto::merge`]). 15 s of silence closes the link; the member shows
//!   offline until it reconnects.
//! - **The fleet's settings** (F1.2, [`FleetConfig`]): the priority order, the pin and
//!   who may be main. One record for the whole fleet; the newer edit wins whole, sent
//!   on connect, on every change and in a join's answer. While there's no election
//!   (F6) the main is the pin.
//! - **Paired devices** (F2.1, [`DeviceBook`]): the phone's pairing is the fleet's.
//!   Each machine's devices (tombstones included) go to the others on connect and on
//!   every change; a newer version wins, and the latest use counts everywhere. The
//!   remote server keeps them ([`crate::remote`]); this module carries them.
//! - **Public addresses** (F2.1): each member says its Funnel address, and the phone
//!   gets the list ([`Fleet::phone_list`]) to open whichever machine answers.
//! - **Relaying** (F2.2): a machine relays the phone's requests to another one. It
//!   asks that machine over the link for a session for the phone's device
//!   ([`proto::Ask::RelaySession`], kept a while), then the remote server forwards
//!   to that machine's remote server on its tailnet address ([`Fleet::relay_target`]),
//!   whose own checks then apply. Duck's routes go to the main ([`Fleet::duck_main`]).
//! - **Duck's hosts** (F3.1): the webviews pass Duck's host traffic over the link
//!   ([`Fleet::send_host`], the `fleet-host` event); this module only carries it.
//! - **Duck's state** (F5.1, [`repl`]): a machine that isn't Duck's main keeps a copy
//!   of the main's `duck.db`, pulled over the link: the log after what it has, or a
//!   snapshot when it can't continue.
//! - **The election** (F6.1): a lease `{term, holder}` in every beat. The holder's
//!   beats renew it; silent for [`Config::failover`], the next machine the list
//!   wants takes the next term from its copy (failover). A machine the list wants
//!   more, up for [`Config::handover_after`] with its copy caught up, asks the holder
//!   for it: the holder's Duck finishes its turns, says its log's head, and the asker
//!   catches up and takes the next term (handover). Taking over from another machine
//!   installs the copy as this machine's Duck (`DuckRepl::promote`). Where Duck is,
//!   for the drawer, the phone's relay and the hosts, is the lease's holder.
//! - **Merging after a split** (F6.2, [`merge`]): a machine that took over from
//!   another's copy keeps where it did; once the old main is linked again, it asks
//!   for what that one wrote after, merges it, and says so (`fleet-merged`).
//! - **The listener** runs only while there is someone to talk to: another member, or
//!   a live join code.
//!
//! The core ([`Fleet`]) takes its network facts ([`Net`]) and its database as values,
//! so the tests run several instances in one process over loopback.

mod link;
mod net;
pub mod repl;
pub mod files;
pub mod merge;
pub mod proto;
mod store;

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use p256::ecdsa::SigningKey;
use rand_core::OsRng;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::db::Db;
use crate::remote::auth::{self, AuthFailure, AuthLog, PairGate, PairOutcome};
use proto::{Ask, Beat, FleetConfig, Frame, Lan, Lease, Member, PairedDevice};

/// The fleet's port on the tailnet. A debug build has its own, so a dev run and the
/// installed app on one machine are two members (a real fleet test on one laptop).
pub const FLEET_PORT: u16 = if cfg!(debug_assertions) { 49055 } else { 48955 };

/// Beats are sent this often; a link silent for [`SILENCE`] is closed.
const BEAT_EVERY: Duration = Duration::from_secs(5);
const SILENCE: Duration = Duration::from_secs(15);
/// The handshake's frames must arrive within this.
const HANDSHAKE: Duration = Duration::from_secs(10);
/// Redial backoff: from the first to the last, doubling.
const BACKOFF_MIN: Duration = Duration::from_secs(5);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A member's `last_seen` is written at most this often while it's online.
const SEEN_WRITE_EVERY: u64 = 60;
/// How long Tailscale's answer about who owns an address is trusted.
const OWNER_OK_TTL: Duration = Duration::from_secs(600);
const OWNER_BAD_TTL: Duration = Duration::from_secs(30);
/// Longest member name kept.
const NAME_MAX: usize = 40;
/// An answer over the link must come within this.
const ASK_TIMEOUT: Duration = Duration::from_secs(5);
/// A relay session is used this long before another is asked for (the other side
/// keeps one alive for hours while it's used).
const RELAY_SESSION_TTL: Duration = Duration::from_secs(3600);

/// What this machine's network says, behind a trait so tests can run on loopback.
pub trait Net: Send + Sync + 'static {
    /// The address to listen on and to tell the others: the tailnet's.
    fn tailnet_ip(&self) -> Option<IpAddr>;
    /// This machine's MagicDNS name. May run the Tailscale CLI.
    fn dns_name(&self) -> Option<String>;
    /// Ok when `ip` is a machine of the same tailnet user as this one. May run the
    /// Tailscale CLI.
    fn same_owner(&self, ip: IpAddr) -> Result<(), String>;
    /// This machine's LAN interface, for others to wake it (F4.1).
    fn lan(&self) -> Option<Lan> {
        None
    }
    /// Send a Wake-on-LAN packet for `mac` to `broadcast`.
    fn send_wake(&self, mac: [u8; 6], broadcast: std::net::Ipv4Addr) -> Result<(), String> {
        net::send_magic(mac, broadcast)
    }
}

/// Where the paired devices live (the remote server's list in the app; a fake in the
/// tests). The fleet only carries them between machines.
pub trait DeviceBook: Send + Sync + 'static {
    /// Every device, tombstones included, as the fleet gossips them.
    fn devices(&self) -> Vec<PairedDevice>;
    /// Take devices heard from another machine ([`proto::merge_devices`]); true when
    /// something changed here.
    fn merge_devices(&self, incoming: &[PairedDevice]) -> bool;
    /// A session for `device` on this machine's remote server, for a machine that
    /// relays its requests here (F2.2). The device must be approved here.
    fn relay_session(&self, device: &str) -> Result<String, String>;
}

/// The database the fleet keeps its state in: the app's (given by [`init`]), or a
/// test's own. A closure, so nothing the tests reach touches the Tauri runtime.
pub struct Storage(Box<StoreFn>);

type StoreFn = dyn Fn(&mut dyn FnMut(&Connection)) + Send + Sync;

/// Duck's database on this machine, and where it keeps its copy of the main's (F5.1).
pub struct DuckRepl {
    /// This machine's `duck.db` (the log's source when it's the main).
    pub source: Storage,
    pub replica: Mutex<repl::Replica>,
    /// Where a snapshot is made before it's sent.
    pub scratch: std::path::PathBuf,
    /// Duck's workspace here (its repo), as the settings say (F5.2).
    pub workspace: Mutex<Option<std::path::PathBuf>>,
    /// The mirror of the main's repo.
    pub mirror: std::path::PathBuf,
    /// Where attachments are stored (`assistant::attachments`).
    pub files: std::path::PathBuf,
}

/// A snapshot or a bundle being sent: when it was made, its bytes.
type SnapshotCache = Option<(Instant, Arc<Vec<u8>>)>;

/// The repo is synced at most this often.
const REPO_EVERY: Duration = Duration::from_secs(30);

/// Chunk `n` of `bytes`, as an answer: `{total, data}` (base64).
fn chunk_answer(bytes: &[u8], n: u32) -> Result<String, String> {
    use base64::Engine;
    let total = bytes.len().div_ceil(repl::CHUNK).max(1) as u32;
    if n >= total {
        return Err("no such chunk".into());
    }
    let start = n as usize * repl::CHUNK;
    let part = &bytes[start..(start + repl::CHUNK).min(bytes.len())];
    Ok(serde_json::json!({ "total": total, "data": base64::engine::general_purpose::STANDARD.encode(part) }).to_string())
}

/// Where the copy stands, for the menu.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaView {
    /// The machine it's a copy of.
    pub of: Option<String>,
    pub seq: i64,
    /// The main's last `seq`, when last heard.
    pub head: i64,
    /// Epoch seconds of the last sync, and its trouble.
    pub at: Option<u64>,
    pub error: Option<String>,
    /// Snapshots taken so far this run.
    pub snapshots: u32,
    /// The mirror of the main's repo: its head, and its trouble (F5.2).
    pub repo: Option<String>,
    pub repo_error: Option<String>,
}

/// Tells the webview to finish Duck's turns (true), or that it may take them again.
pub type DrainSink = Box<dyn Fn(bool) + Send + Sync>;

/// Where a merge's notice goes (F6.2).
pub type MergedSink = Box<dyn Fn(String) + Send + Sync>;

/// How the handover on quitting is going (the webview's overlay).
pub type LeaveSink = Box<dyn Fn(LeaveStatus) + Send + Sync>;

/// The handover on quitting: this machine holds Duck, so it hands it to another
/// before it goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaveStatus {
    /// `draining` (Duck finishing its turns), `handing` (asking `to`), `waiting` (the
    /// last round failed: `error`; tried again soon), `done`.
    pub phase: String,
    pub to: Option<String>,
    pub error: Option<String>,
    pub attempt: u32,
}

/// The capability a machine that answers [`Ask::TakeOver`] says in its beat.
const CAP_TAKE_OVER: &str = "take-over";

/// How long a failed handover on quitting waits before it tries again.
const LEAVE_RETRY: Duration = Duration::from_secs(15);

/// Takes host traffic from a peer: (its id, the text).
pub type HostSink = Box<dyn Fn(&str, String) + Send + Sync>;

/// What Tailscale said about an address, and when.
type OwnerAnswer = (Instant, Result<(), String>);

impl Storage {
    pub fn new(f: impl Fn(&mut dyn FnMut(&Connection)) + Send + Sync + 'static) -> Self {
        Storage(Box::new(f))
    }

    fn with<R>(&self, f: impl FnOnce(&Connection) -> R) -> R {
        let mut f = Some(f);
        let mut out = None;
        (self.0)(&mut |c| {
            if let Some(f) = f.take() {
                out = Some(f(c));
            }
        });
        out.expect("the store ran")
    }
}

pub struct Config {
    /// The port to listen on (0: any free one, for tests).
    pub port: u16,
    /// What a new identity names this machine.
    pub default_name: String,
    /// What a new record says this machine is (`desktop`, `laptop`, `server`).
    pub default_kind: String,
    pub version: String,
    /// How often the keeper looks (binding, dialing).
    pub tick: Duration,
    /// The holder unheard this long: the next machine takes over (F6.1).
    pub failover: Duration,
    /// A machine the list wants more asks for the lease after being up this long.
    pub handover_after: Duration,
}

/// What a machine taking over from another does to make the copy its Duck (F6.1):
/// given the term and the old holder's dirs, as the app does it.
pub type Promote = Box<dyn Fn(u64, Option<[String; 2]>) -> Result<(), String> + Send + Sync>;

pub struct Fleet {
    cfg: Config,
    net: Box<dyn Net>,
    store: Storage,
    notify: Box<dyn Fn() + Send + Sync>,
    book: Arc<dyn DeviceBook>,
    /// Wakes the keeper to act on a change now.
    wake: Notify,
    caps: Vec<String>,
    inner: Mutex<Inner>,
    owners: Mutex<HashMap<IpAddr, OwnerAnswer>>,
    /// Questions asked over a link, waiting for their answer.
    asks: Mutex<HashMap<u64, oneshot::Sender<Result<String, String>>>>,
    next_ask: std::sync::atomic::AtomicU64,
    /// Where host traffic from a peer goes (the webview, in the app).
    host_sink: Mutex<Option<HostSink>>,
    /// Duck's database and the copy of the main's (F5.1).
    duck: Mutex<Option<Arc<DuckRepl>>>,
    snap_cache: Mutex<SnapshotCache>,
    bundle_cache: Mutex<SnapshotCache>,
    repo_synced: Mutex<Option<Instant>>,
    replicating: std::sync::atomic::AtomicBool,
    replica_view: Mutex<ReplicaView>,
    /// Making the copy this machine's Duck (the app's; none in most tests).
    promote: Mutex<Option<Promote>>,
    /// The webview's Duck finished its turns for a handover (`fleet_drained`).
    drained: Notify,
    /// Tells the webview to finish its turns (true) or that it may take them again.
    drain_sink: Mutex<Option<DrainSink>>,
    /// A handover is being asked for.
    handing: std::sync::atomic::AtomicBool,
    /// A merge after a split is running, and where its notice goes (F6.2).
    merging: std::sync::atomic::AtomicBool,
    merged_sink: Mutex<Option<MergedSink>>,
    /// Quitting: handing Duck over first (the loop in [`Fleet::leave`]).
    leaving: std::sync::atomic::AtomicBool,
    /// Wakes that loop (retry now, or cancel).
    leave_wake: Notify,
    leave_sink: Mutex<Option<LeaveSink>>,
    /// A copy found damaged in a failover, so it isn't tried again until it changes
    /// (and the notice is said once).
    damaged_copy: Mutex<Option<repl::ReplicaState>>,
    /// Sessions other machines gave for a device, by (machine, device).
    relay_sessions: Mutex<HashMap<(String, String), (String, Instant)>>,
}

struct Inner {
    me: String,
    key: SigningKey,
    /// Every member, this machine and tombstones included.
    members: Vec<Member>,
    config: FleetConfig,
    links: HashMap<String, Link>,
    beats: HashMap<String, Beat>,
    /// Last seen (epoch s): kept, and when it was last written.
    seen: HashMap<String, u64>,
    seen_written: HashMap<String, u64>,
    dialing: HashSet<String>,
    backoff: HashMap<String, (Instant, Duration)>,
    gate: PairGate,
    listener: Option<Listening>,
    tailnet_ip: Option<IpAddr>,
    log: AuthLog,
    /// Something only you can fix (another machine has this one's identity).
    problem: Option<String>,
    next_link: u64,
    /// This machine's remote server's port, while it listens on the tailnet.
    remote_port: Option<u16>,
    /// The lease followed, and when its holder was last heard (F6.1).
    lease: Lease,
    lease_heard: Instant,
    /// When each link came up (for the handover's wait).
    up_since: HashMap<String, Instant>,
    /// The holder's Duck is finishing its turns for a handover.
    draining: bool,
    /// Off the fleet on purpose (tests, and a future "go offline"): no links.
    offline: bool,
    /// Each member's last dirs (from its beats).
    dirs: HashMap<String, [String; 2]>,
}

struct Link {
    id: u64,
    /// Who dialed it.
    dialer: String,
    out: mpsc::UnboundedSender<String>,
    cancel: Option<oneshot::Sender<String>>,
}

struct Listening {
    addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

/// A member as the menu shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub host: Option<String>,
    pub kind: String,
    /// Its public (Funnel) address, while it has one.
    pub public_url: Option<String>,
    /// It said its LAN interface, so it can be sent a Wake-on-LAN packet (F4.1).
    pub wakeable: bool,
    pub online: bool,
    /// Epoch seconds it was last heard from.
    pub last_seen: Option<u64>,
    pub version: Option<String>,
    pub os: Option<String>,
    pub build: Option<String>,
    pub caps: Vec<String>,
    /// Which way its link was dialed: `out` (by this machine) or `in`.
    pub direction: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetStatus {
    pub me: MemberView,
    /// Tailscale has an address here.
    pub tailnet: bool,
    /// Where the fleet listens, while it does.
    pub listening: Option<String>,
    pub code: Option<String>,
    pub code_expires_at: Option<u64>,
    /// `CODE@ip:port`, to type on the other machine.
    pub join_string: Option<String>,
    pub code_locked: bool,
    /// The other members (tombstones left out), by name.
    pub members: Vec<MemberView>,
    pub log: Vec<AuthFailure>,
    pub problem: Option<String>,
    pub config: ConfigView,
    /// This machine's copy of the main's Duck state (F5.1), while it keeps one.
    pub replica: Option<ReplicaView>,
}

/// The fleet's settings as the menu shows them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    /// Every live member's id (this machine's too), in priority order.
    pub order: Vec<String>,
    /// The order was set by hand (else it's the default, by kind).
    pub custom_order: bool,
    pub pin: Option<String>,
    pub not_main: Vec<String>,
    /// Machines that may be woken (F4.1).
    pub wake: Vec<String>,
    /// The main: the pin, while the main is set by hand.
    pub main: Option<String>,
    /// Who the list would make main now (the election, F6, will act on it).
    pub first_choice: Option<String>,
    /// Where Duck runs: the lease's holder (F6.1), else the list's choice.
    pub duck: Option<String>,
    /// The lease's term (0: none yet).
    pub lease_term: u64,
    /// This machine's Duck is finishing its turns to hand over.
    pub draining: bool,
    /// When the settings were last changed, and on which machine.
    pub updated_at: u64,
    pub by: Option<String>,
}

/// The fleet as the phone gets it (`/api/fleet`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneFleet {
    /// The machine answering.
    pub here: String,
    /// The main: the pin, else the list's first choice.
    pub main: Option<String>,
    pub pinned: bool,
    /// Every machine, in priority order.
    pub instances: Vec<PhoneInstance>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneInstance {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// Its public (Funnel) address; null while it has none.
    pub url: Option<String>,
    /// Linked to the machine answering (or is it).
    pub online: bool,
    pub main: bool,
    /// The machine answering.
    pub here: bool,
}

#[derive(Serialize, Deserialize)]
struct JoinRequest {
    code: String,
    member: Member,
}

#[derive(Serialize, Deserialize)]
struct JoinResponse {
    members: Vec<Member>,
    #[serde(default)]
    config: FleetConfig,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..16].to_string()
}

fn clean_name(name: &str) -> String {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).take(NAME_MAX).collect();
    if name.is_empty() { "machine".into() } else { name }
}

impl Fleet {
    pub fn new(
        cfg: Config,
        net: Box<dyn Net>,
        store: Storage,
        book: Arc<dyn DeviceBook>,
        notify: Box<dyn Fn() + Send + Sync>,
    ) -> Arc<Fleet> {
        let (me, key) = store
            .with(store::identity)
            .and_then(|(id, secret)| Some((id, proto::key_from_secret(&secret)?)))
            .unwrap_or_else(|| {
                let id = new_id();
                let key = SigningKey::random(&mut OsRng);
                store.with(|c| store::set_identity(c, &id, &proto::secret_b64(&key))).ok();
                (id, key)
            });
        let mut members = Vec::new();
        let mut seen = HashMap::new();
        for (m, last) in store.with(store::members) {
            if let Some(at) = last {
                seen.insert(m.id.clone(), at);
            }
            members.push(m);
        }
        let config = store.with(store::config);
        let lease0 = store.with(store::lease);
        let caps = local_caps();
        let fleet = Arc::new(Fleet {
            net,
            store,
            notify,
            book,
            wake: Notify::new(),
            caps,
            inner: Mutex::new(Inner {
                me: me.clone(),
                key,
                members,
                config,
                links: HashMap::new(),
                beats: HashMap::new(),
                seen_written: seen.clone(),
                seen,
                dialing: HashSet::new(),
                backoff: HashMap::new(),
                gate: PairGate::default(),
                listener: None,
                tailnet_ip: None,
                log: AuthLog::default(),
                problem: None,
                next_link: 0,
                remote_port: None,
                lease: lease0,
                lease_heard: Instant::now(),
                up_since: HashMap::new(),
                draining: false,
                offline: false,
                dirs: HashMap::new(),
            }),
            owners: Mutex::new(HashMap::new()),
            asks: Mutex::new(HashMap::new()),
            next_ask: std::sync::atomic::AtomicU64::new(1),
            relay_sessions: Mutex::new(HashMap::new()),
            promote: Mutex::new(None),
            drained: Notify::new(),
            drain_sink: Mutex::new(None),
            handing: std::sync::atomic::AtomicBool::new(false),
            merging: std::sync::atomic::AtomicBool::new(false),
            merged_sink: Mutex::new(None),
            leaving: std::sync::atomic::AtomicBool::new(false),
            leave_wake: Notify::new(),
            leave_sink: Mutex::new(None),
            damaged_copy: Mutex::new(None),
            host_sink: Mutex::new(None),
            duck: Mutex::new(None),
            snap_cache: Mutex::new(None),
            bundle_cache: Mutex::new(None),
            repo_synced: Mutex::new(None),
            replicating: std::sync::atomic::AtomicBool::new(false),
            replica_view: Mutex::new(ReplicaView::default()),
            cfg,
        });
        fleet.ensure_self();
        fleet
    }

    /// Make sure this machine has its own record, current and not a tombstone.
    fn ensure_self(&self) {
        let mut inner = self.inner.lock().unwrap();
        let me = inner.me.clone();
        let public_key = proto::public_key_b64(&inner.key);
        let kind = if proto::valid_kind(&self.cfg.default_kind) { self.cfg.default_kind.clone() } else { "desktop".into() };
        let fresh = match inner.members.iter().find(|m| m.id == me) {
            Some(m) if !m.removed && m.public_key == public_key && !m.kind.is_empty() => None,
            Some(m) => Some(Member {
                removed: false,
                public_key,
                kind: if m.kind.is_empty() { kind } else { m.kind.clone() },
                updated_at: now_ms(),
                ..m.clone()
            }),
            None => Some(Member {
                id: me.clone(),
                name: clean_name(&self.cfg.default_name),
                public_key,
                ip: String::new(),
                port: self.cfg.port,
                host: None,
                kind,
                public_url: None,
                lan: None,
                updated_at: now_ms(),
                removed: false,
            }),
        };
        if let Some(m) = fresh {
            inner.members.retain(|x| x.id != me);
            inner.members.push(m.clone());
            drop(inner);
            self.store.with(|c| store::save(c, &m)).ok();
        }
    }

    fn me(&self) -> String {
        self.inner.lock().unwrap().me.clone()
    }

    fn self_record(inner: &Inner) -> Member {
        inner.members.iter().find(|m| m.id == inner.me).cloned().expect("ensure_self keeps it")
    }

    /// Change this machine's record with `f` and tell everyone.
    fn update_self(&self, f: impl FnOnce(&mut Member)) {
        let m = {
            let mut inner = self.inner.lock().unwrap();
            let me = inner.me.clone();
            let Some(rec) = inner.members.iter_mut().find(|m| m.id == me) else { return };
            f(rec);
            rec.updated_at = now_ms();
            rec.clone()
        };
        self.store.with(|c| store::save(c, &m)).ok();
        self.gossip(None);
        (self.notify)();
    }

    fn others_live(inner: &Inner) -> impl Iterator<Item = &Member> {
        inner.members.iter().filter(move |m| m.id != inner.me && !m.removed)
    }

    // --- the keeper ---------------------------------------------------------------

    /// Runs for the life of the app: keeps the address current, the listener up while
    /// it's wanted, the links dialed and `last_seen` written.
    pub async fn run(self: Arc<Self>) {
        let mut looks: u64 = 0;
        loop {
            let me = self.clone();
            let want_host = looks.is_multiple_of(30);
            let (ip, host, lan) = tokio::task::spawn_blocking(move || {
                let ip = me.net.tailnet_ip();
                let host = if want_host && ip.is_some() { me.net.dns_name() } else { None };
                let lan = if want_host { me.net.lan() } else { None };
                (ip, host, lan)
            })
            .await
            .unwrap_or((None, None, None));
            self.observe_addr(ip, host);
            if let Some(lan) = lan {
                self.observe_lan(lan);
            }
            self.ensure_listener().await;
            self.dial_due();
            self.write_seen();
            self.elect();
            self.replicate_due();
            self.merge_due();
            looks += 1;
            tokio::select! {
                _ = tokio::time::sleep(self.cfg.tick) => {}
                _ = self.wake.notified() => {}
            }
        }
    }

    fn observe_addr(&self, ip: Option<IpAddr>, host: Option<String>) {
        let (stale, port) = {
            let mut inner = self.inner.lock().unwrap();
            inner.tailnet_ip = ip;
            let rec = Self::self_record(&inner);
            let port = inner.listener.as_ref().map_or(rec.port, |l| l.addr.port());
            let ip_moved = ip.is_some_and(|ip| rec.ip != ip.to_string());
            let host_moved = host.is_some() && rec.host != host;
            (ip_moved || host_moved || rec.port != port, port)
        };
        if stale {
            self.update_self(|m| {
                if let Some(ip) = ip {
                    m.ip = ip.to_string();
                }
                if host.is_some() {
                    m.host = host;
                }
                m.port = port;
            });
        }
    }

    /// This machine's LAN interface, said to the others when it changes (F4.1).
    fn observe_lan(&self, lan: Lan) {
        let same = Self::self_record(&self.inner.lock().unwrap()).lan.as_ref() == Some(&lan);
        if !same {
            self.update_self(|m| m.lan = Some(lan));
        }
    }

    async fn ensure_listener(self: &Arc<Self>) {
        let (wanted, ip, current) = {
            let inner = self.inner.lock().unwrap();
            let wanted = Self::others_live(&inner).next().is_some() || inner.gate.live(now()).is_some();
            (wanted, inner.tailnet_ip, inner.listener.as_ref().map(|l| l.addr))
        };
        let right_place = match (current, ip) {
            (Some(addr), Some(ip)) => addr.ip() == ip,
            _ => false,
        };
        if current.is_some() && (!wanted || !right_place) {
            if let Some(l) = self.inner.lock().unwrap().listener.take() {
                l.task.abort();
            }
            (self.notify)();
        }
        if !wanted || right_place {
            return;
        }
        let Some(ip) = ip else { return };
        match link::listen(self.clone(), SocketAddr::new(ip, self.cfg.port)).await {
            Ok((addr, task)) => {
                self.inner.lock().unwrap().listener = Some(Listening { addr, task });
                self.observe_addr(Some(ip), None);
                (self.notify)();
            }
            Err(e) => eprintln!("[fleet] couldn’t listen on {ip}:{}: {e}", self.cfg.port),
        }
    }

    fn dial_due(self: &Arc<Self>) {
        let due: Vec<Member> = {
            let mut inner = self.inner.lock().unwrap();
            if inner.problem.is_some() || inner.offline {
                return;
            }
            let at = Instant::now();
            let due: Vec<Member> = Self::others_live(&inner)
                .filter(|m| !inner.links.contains_key(&m.id) && !inner.dialing.contains(&m.id))
                .filter(|m| inner.backoff.get(&m.id).is_none_or(|(next, _)| *next <= at))
                .filter(|m| !m.ip.is_empty())
                .cloned()
                .collect();
            for m in &due {
                inner.dialing.insert(m.id.clone());
            }
            due
        };
        for m in due {
            let me = self.clone();
            tokio::spawn(async move {
                let ok = link::dial(me.clone(), &m).await;
                let mut inner = me.inner.lock().unwrap();
                inner.dialing.remove(&m.id);
                let step = if ok {
                    BACKOFF_MIN
                } else {
                    inner.backoff.get(&m.id).map_or(BACKOFF_MIN, |(_, s)| (*s * 2).min(BACKOFF_MAX))
                };
                inner.backoff.insert(m.id.clone(), (Instant::now() + step, step));
            });
        }
    }

    fn write_seen(&self) {
        let due: Vec<(String, u64)> = {
            let mut inner = self.inner.lock().unwrap();
            let t = now();
            let online: Vec<String> = inner.links.keys().cloned().collect();
            for id in &online {
                inner.seen.insert(id.clone(), t);
            }
            let due: Vec<(String, u64)> = inner
                .seen
                .iter()
                .filter(|(id, at)| inner.seen_written.get(*id).is_none_or(|w| **at >= w + SEEN_WRITE_EVERY))
                .map(|(id, at)| (id.clone(), *at))
                .collect();
            for (id, at) in &due {
                inner.seen_written.insert(id.clone(), *at);
            }
            due
        };
        for (id, at) in due {
            self.store.with(|c| store::seen(c, &id, at));
        }
    }

    // --- who may connect ----------------------------------------------------------

    /// [`Net::same_owner`], remembered for a while (it runs the CLI).
    async fn check_owner(self: &Arc<Self>, ip: IpAddr) -> Result<(), String> {
        if let Some((at, res)) = self.owners.lock().unwrap().get(&ip) {
            let ttl = if res.is_ok() { OWNER_OK_TTL } else { OWNER_BAD_TTL };
            if at.elapsed() < ttl {
                return res.clone();
            }
        }
        let me = self.clone();
        let res = tokio::task::spawn_blocking(move || me.net.same_owner(ip))
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
        self.owners.lock().unwrap().insert(ip, (Instant::now(), res.clone()));
        res
    }

    fn log_failure(&self, addr: &str, what: &str) {
        self.inner.lock().unwrap().log.record(addr, what, now());
        (self.notify)();
    }

    // --- joining ------------------------------------------------------------------

    /// A machine asks to join with a code (the `/fleet/join` handler, after the owner
    /// check). Ok: every member it should know.
    fn accept_join(&self, req: JoinRequest, from: IpAddr) -> Result<JoinResponse, String> {
        let addr = from.to_string();
        let outcome = self.inner.lock().unwrap().gate.attempt(&req.code, now());
        let refusal = match outcome {
            PairOutcome::Paired => None,
            PairOutcome::Busy => Some("too many join attempts; wait a minute"),
            PairOutcome::Locked => Some("the code took too many wrong tries; make a new one"),
            PairOutcome::NoCode => Some("no join code is live there; make one"),
            PairOutcome::Wrong { .. } => Some("wrong code"),
        };
        if let Some(why) = refusal {
            self.log_failure(&addr, &format!("join refused: {why}"));
            return Err(why.into());
        }
        let mut m = req.member;
        if m.id == self.me() {
            self.log_failure(&addr, "a machine with this machine’s identity tried to join");
            return Err("that machine has this one’s identity (its app data was copied); reset its fleet identity".into());
        }
        if auth::parse_public_key(&m.public_key).is_none() || m.id.is_empty() {
            return Err("the request carried no usable key".into());
        }
        // A member rejoining (it left, or moved) is fine; one that's online right now
        // is a second machine with its identity.
        if self.inner.lock().unwrap().links.contains_key(&m.id) {
            self.log_failure(&addr, "a machine with an online member’s identity tried to join");
            return Err("a machine with this identity is already in the fleet and online; if this one’s app data was copied from it, reset its fleet identity".into());
        }
        m.name = clean_name(&m.name);
        m.ip = addr; // what the tailnet says, not what it says
        m.updated_at = now_ms();
        m.removed = false;
        let (list, config) = {
            let mut inner = self.inner.lock().unwrap();
            inner.members.retain(|x| x.id != m.id);
            inner.members.push(m.clone());
            inner.backoff.remove(&m.id);
            (inner.members.clone(), inner.config.clone())
        };
        self.store.with(|c| store::save(c, &m)).ok();
        self.gossip(None);
        (self.notify)();
        self.wake.notify_one();
        Ok(JoinResponse { members: list, config })
    }

    /// Join the fleet of the machine `join` names (a join string from its menu).
    pub async fn join(self: &Arc<Self>, join: &str) -> Result<(), String> {
        let target = proto::parse_join(join).ok_or("that isn’t a join string (CODE@address:port)")?;
        let Some(ip) = self.tailnet_now() else {
            return Err("Tailscale isn’t connected here".into());
        };
        // A fresh record, newer than any tombstone of this machine out there.
        self.update_self(|m| m.ip = ip.to_string());
        let member = Self::self_record(&self.inner.lock().unwrap());
        let body = serde_json::to_string(&JoinRequest { code: target.code, member }).expect("serializes");
        let url = format!("http://{}:{}/fleet/join", target.host, target.port);
        let resp = reqwest::Client::new()
            .post(&url)
            .header("content-type", "application/json")
            .body(body)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| format!("couldn’t reach {}: {e}", target.host))?;
        let ok = resp.status().is_success();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !ok {
            let why = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["error"].as_str().map(str::to_string))
                .unwrap_or(text);
            return Err(format!("refused: {why}"));
        }
        let answer: JoinResponse = serde_json::from_str(&text).map_err(|e| format!("a strange answer: {e}"))?;
        self.take_members(None, answer.members);
        self.take_config(None, answer.config);
        self.wake.notify_one();
        Ok(())
    }

    // --- gossip -------------------------------------------------------------------

    /// Members heard from `from` (a peer's id, or None for a join's answer).
    fn take_members(&self, from: Option<&str>, list: Vec<Member>) {
        let (merged, saved) = {
            let mut inner = self.inner.lock().unwrap();
            let me = inner.me.clone();
            let merged = proto::merge(&mut inner.members, &list, &me);
            let saved: Vec<Member> = merged
                .changed
                .iter()
                .filter_map(|id| inner.members.iter().find(|m| &m.id == id).cloned())
                .collect();
            (merged, saved)
        };
        if merged.removed_me {
            let by = from.and_then(|id| self.name_of(id)).unwrap_or_else(|| "another machine".into());
            self.leave_here(&format!("removed from the fleet by {by}"));
            return;
        }
        if saved.is_empty() {
            return;
        }
        for m in &saved {
            self.store.with(|c| store::save(c, m)).ok();
            if m.removed {
                self.close_link(&m.id, "removed from the fleet");
            }
        }
        self.gossip(from);
        (self.notify)();
        self.wake.notify_one();
    }

    /// The fleet's settings heard from `from` (None: a join's answer): kept if newer.
    fn take_config(&self, from: Option<&str>, cfg: FleetConfig) {
        {
            let mut inner = self.inner.lock().unwrap();
            if !inner.config.older_than(&cfg) {
                return;
            }
            inner.config = cfg.clone();
        }
        self.store.with(|c| store::set_config(c, &cfg)).ok();
        self.send_config(from);
        (self.notify)();
    }

    /// Send the settings to every link but `except`'s.
    fn send_config(&self, except: Option<&str>) {
        let inner = self.inner.lock().unwrap();
        let frame = Frame::Config { config: inner.config.clone() }.to_text();
        for (peer, link) in &inner.links {
            if Some(peer.as_str()) != except {
                let _ = link.out.send(frame.clone());
            }
        }
    }

    /// Change the settings with `f` (false: nothing to change) and tell everyone.
    fn update_config(&self, f: impl FnOnce(&mut FleetConfig, &[Member]) -> bool) {
        let cfg = {
            let mut inner = self.inner.lock().unwrap();
            let mut cfg = inner.config.clone();
            if !f(&mut cfg, &inner.members) || cfg == inner.config {
                return;
            }
            // Later than the version it replaces even if this clock is behind.
            cfg.updated_at = now_ms().max(inner.config.updated_at + 1);
            cfg.by = inner.me.clone();
            inner.config = cfg.clone();
            cfg
        };
        self.store.with(|c| store::set_config(c, &cfg)).ok();
        self.send_config(None);
        (self.notify)();
    }

    /// Back to the never-edited settings (leaving the fleet, a reset identity), so
    /// the next fleet's win at once.
    fn forget_config(&self) {
        self.inner.lock().unwrap().config = FleetConfig::default();
        self.store.with(|c| store::set_config(c, &FleetConfig::default())).ok();
    }

    /// Paired devices heard from `from`: taken, and passed on when they changed
    /// something here.
    fn take_devices(&self, from: &str, list: Vec<PairedDevice>) {
        if self.book.merge_devices(&list) {
            self.send_devices(Some(from));
        }
    }

    /// Send every paired device to every link but `except`'s.
    fn send_devices(&self, except: Option<&str>) {
        let frame = Frame::Devices { list: self.book.devices() }.to_text();
        let inner = self.inner.lock().unwrap();
        for (peer, link) in &inner.links {
            if Some(peer.as_str()) != except {
                let _ = link.out.send(frame.clone());
            }
        }
    }

    /// The paired devices changed here (paired, approved, revoked, used after a while):
    /// tell the fleet.
    pub fn devices_changed(&self) {
        self.send_devices(None);
    }

    /// This machine's public address came or went.
    pub fn set_public_url(&self, url: Option<String>) {
        let same = Self::self_record(&self.inner.lock().unwrap()).public_url == url;
        if !same {
            self.update_self(|m| m.public_url = url);
        }
    }

    /// The machines as the phone sees them: in priority order, the main (or the list's
    /// first choice) marked, each with its public address when it has one.
    pub fn phone_list(&self) -> PhoneFleet {
        let inner = self.inner.lock().unwrap();
        let cfg = &inner.config;
        let up = |id: &str| id == inner.me || inner.links.contains_key(id);
        let main = Self::duck_of(&inner);
        let instances = proto::ranked(&inner.members, cfg)
            .into_iter()
            .filter_map(|id| inner.members.iter().find(|m| m.id == id))
            .map(|m| PhoneInstance {
                id: m.id.clone(),
                name: m.name.clone(),
                kind: m.kind.clone(),
                url: m.public_url.clone(),
                online: up(&m.id),
                main: main.as_deref() == Some(m.id.as_str()),
                here: m.id == inner.me,
            })
            .collect();
        PhoneFleet { here: inner.me.clone(), main, pinned: cfg.pin.is_some(), instances }
    }

    fn name_of(&self, id: &str) -> Option<String> {
        self.inner.lock().unwrap().members.iter().find(|m| m.id == id).map(|m| m.name.clone())
    }

    /// Send every member to every link but `except`'s.
    fn gossip(&self, except: Option<&str>) {
        let inner = self.inner.lock().unwrap();
        let frame = Frame::Members { list: inner.members.clone() }.to_text();
        for (peer, link) in &inner.links {
            if Some(peer.as_str()) != except {
                let _ = link.out.send(frame.clone());
            }
        }
    }

    fn close_link(&self, peer: &str, why: &str) {
        let link = self.inner.lock().unwrap().links.remove(peer);
        if let Some(mut link) = link {
            if let Some(cancel) = link.cancel.take() {
                let _ = cancel.send(why.to_string());
            }
        }
        (self.notify)();
    }

    /// Forget the fleet here: only this machine's own record stays.
    fn leave_here(&self, why: &str) {
        let peers: Vec<String> = {
            let mut inner = self.inner.lock().unwrap();
            let me = inner.me.clone();
            inner.members.retain(|m| m.id == me);
            inner.beats.clear();
            inner.backoff.clear();
            inner.links.keys().cloned().collect()
        };
        let me = self.me();
        self.store.with(|c| store::clear_except(c, &me));
        self.forget_config();
        for p in peers {
            self.close_link(&p, why);
        }
        self.log_failure("—", why);
        self.wake.notify_one();
    }

    // --- links --------------------------------------------------------------------

    /// The key a member links with, unless it isn't (or is no longer) one.
    fn member_key(&self, id: &str) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        let key = Self::others_live(&inner).find(|m| m.id == id).map(|m| m.public_key.clone());
        key
    }

    /// A link proved itself; keep it unless a better one to the same peer is up.
    fn register_link(
        &self,
        peer: &str,
        dialer: &str,
        out: mpsc::UnboundedSender<String>,
    ) -> Option<(u64, oneshot::Receiver<String>)> {
        let (tx, rx) = oneshot::channel();
        let mut inner = self.inner.lock().unwrap();
        if inner.offline {
            return None;
        }
        let me = inner.me.clone();
        if let Some(old) = inner.links.get_mut(peer) {
            if !proto::keep_new_link(&me, peer, &old.dialer, dialer) {
                return None;
            }
            if let Some(cancel) = old.cancel.take() {
                let _ = cancel.send("replaced by a newer link".into());
            }
        }
        inner.next_link += 1;
        let id = inner.next_link;
        inner.links.insert(peer.to_string(), Link { id, dialer: dialer.to_string(), out, cancel: Some(tx) });
        inner.backoff.remove(peer);
        inner.seen.insert(peer.to_string(), now());
        inner.up_since.entry(peer.to_string()).or_insert_with(Instant::now);
        drop(inner);
        (self.notify)();
        Some((id, rx))
    }

    fn unregister_link(&self, peer: &str, id: u64) {
        let gone = {
            let mut inner = self.inner.lock().unwrap();
            if inner.links.get(peer).is_some_and(|l| l.id == id) {
                inner.links.remove(peer);
                inner.up_since.remove(peer);
                inner.seen.insert(peer.to_string(), now());
                true
            } else {
                false
            }
        };
        if gone {
            (self.notify)();
            self.wake.notify_one();
        }
    }

    fn on_beat(&self, peer: &str, beat: Beat) {
        if let Some(l) = beat.lease.clone() {
            self.hear_lease(peer, l);
        }
        let changed = {
            let mut inner = self.inner.lock().unwrap();
            inner.seen.insert(peer.to_string(), now());
            if let Some(d) = beat.dirs.clone() {
                inner.dirs.insert(peer.to_string(), d);
            }
            inner.beats.insert(peer.to_string(), beat.clone()) != Some(beat)
        };
        if changed {
            (self.notify)();
        }
    }

    // --- the election (F6.1) ---------------------------------------------------------

    /// Where Duck is: the lease's holder once there's a lease, else the list's choice.
    fn duck_of(inner: &Inner) -> Option<String> {
        if inner.lease.term > 0 {
            return Some(inner.lease.holder.clone());
        }
        let up = |id: &str| id == inner.me || inner.links.contains_key(id);
        proto::desired(&inner.members, &inner.config, up)
    }

    /// A lease heard from `peer` (its beat): a higher term is followed; the holder's
    /// own beat of the current term renews it.
    fn hear_lease(&self, peer: &str, l: Lease) {
        let (adopted, lost) = {
            let mut inner = self.inner.lock().unwrap();
            // Two machines that took the same term apart (each alone): the one the
            // list puts first keeps it (the pin, else by priority).
            let tie_won = l.term == inner.lease.term && l.holder != inner.lease.holder && {
                let ranked = proto::ranked(&inner.members, &inner.config);
                let pos = |id: &str| {
                    if inner.config.pin.as_deref() == Some(id) {
                        0
                    } else {
                        ranked.iter().position(|x| x == id).map_or(usize::MAX, |p| p + 1)
                    }
                };
                (pos(&l.holder), &l.holder) < (pos(&inner.lease.holder), &inner.lease.holder)
            };
            if l.term > inner.lease.term || tie_won {
                let lost = inner.lease.holder == inner.me && l.holder != inner.me;
                inner.lease = l.clone();
                inner.lease_heard = Instant::now();
                (true, lost)
            } else {
                if l.term == inner.lease.term && l.holder == peer && inner.lease.holder == peer {
                    inner.lease_heard = Instant::now();
                }
                (false, false)
            }
        };
        if adopted {
            self.store.with(|c| store::set_lease(c, &l)).ok();
            if lost && !self.leaving.load(std::sync::atomic::Ordering::SeqCst) {
                // Another machine holds Duck now: this one's takes turns again only
                // as a stand-in, and its copy follows the new holder.
                self.inner.lock().unwrap().draining = false;
                if let Some(sink) = self.drain_sink.lock().unwrap().as_ref() {
                    sink(false);
                }
            }
            (self.notify)();
            self.wake.notify_one();
        }
    }

    /// Take the lease for the next term (from `from`, the holder before, when it was
    /// another machine): its copy becomes this machine's Duck first.
    fn take_lease(&self, from: Option<String>) -> Result<(), String> {
        let (term, dirs) = {
            let inner = self.inner.lock().unwrap();
            (inner.lease.term + 1, from.as_ref().and_then(|f| inner.dirs.get(f).cloned()))
        };
        if let Some(old) = &from {
            let copy = self.duck().ok().map(|d| d.replica.lock().unwrap().state());
            if let Some(st) = copy.filter(|st| st.origin.as_deref() == Some(old.as_str())) {
                if self.damaged_copy.lock().unwrap().as_ref() == Some(&st) {
                    return Err(format!("{}; waiting for a good one", repl::DAMAGED));
                }
                if let Some(p) = self.promote.lock().unwrap().as_ref() {
                    if let Err(e) = p(term, dirs) {
                        if e.starts_with(repl::DAMAGED) {
                            *self.damaged_copy.lock().unwrap() = Some(st);
                        }
                        return Err(e);
                    }
                }
                *self.damaged_copy.lock().unwrap() = None;
                // Where this machine took over from, for the merge if the old main
                // wrote on while cut off (F6.2).
                if let (Ok(d), Some(epoch)) = (self.duck(), st.epoch.as_deref()) {
                    d.source.with(|c| merge::set_split(c, old, epoch, st.seq)).ok();
                }
            }
        }
        let lease = {
            let mut inner = self.inner.lock().unwrap();
            inner.lease = Lease { term, holder: inner.me.clone() };
            inner.lease_heard = Instant::now();
            inner.draining = false;
            inner.lease.clone()
        };
        self.store.with(|c| store::set_lease(c, &lease)).ok();
        // Said at once, not at the next beat.
        let frame = Frame::Beat { beat: self.beat() }.to_text();
        for link in self.inner.lock().unwrap().links.values() {
            let _ = link.out.send(frame.clone());
        }
        (self.notify)();
        Ok(())
    }

    /// One look at the lease: take it when its holder went quiet and this machine is
    /// next, or ask for it when the list wants this machine more.
    fn elect(self: &Arc<Self>) {
        let (me, lease, heard, desired, linked_since, offline) = {
            let inner = self.inner.lock().unwrap();
            // The holder unheard for the failover time (from when this machine took
            // up the lease, too: a lease heard of through another machine gets the
            // time to link to its holder).
            let quiet = inner.lease.term == 0 || (inner.lease.holder != inner.me && inner.lease_heard.elapsed() >= self.cfg.failover);
            let up = |id: &str| id == inner.me || (inner.links.contains_key(id) && !(quiet && id == inner.lease.holder));
            let desired = proto::desired(&inner.members, &inner.config, up);
            let since = inner.up_since.get(&inner.lease.holder).copied();
            (inner.me.clone(), inner.lease.clone(), quiet, desired, since, inner.offline)
        };
        if offline || desired.as_deref() != Some(me.as_str()) || lease.holder == me && lease.term > 0 {
            return;
        }
        if self.leaving.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        if heard {
            // Failover (or the first lease): the holder went quiet.
            let from = (lease.term > 0 && lease.holder != me).then(|| lease.holder.clone());
            let fresh_damage = self.damaged_copy.lock().unwrap().is_none();
            if let Err(e) = self.take_lease(from.clone()) {
                eprintln!("[fleet] couldn’t take Duck over: {e}");
                // Failover: the old main is gone, so there's no good copy to fetch.
                // Duck stays put rather than start here on older state; said once.
                if fresh_damage && e.starts_with(repl::DAMAGED) {
                    let name = from.as_deref().and_then(|f| self.name_of(f)).unwrap_or_else(|| "the machine Duck was on".into());
                    self.say_merged(format!(
                        "Duck couldn't move to this machine: its copy of Duck's state is damaged, and {name} is offline, so there's no good copy to fetch. Duck moves once {name} is back."
                    ));
                }
            }
            return;
        }
        // Handover: the holder is up; ask once this machine has been up a while
        // and its copy has caught up.
        let ready = linked_since.is_some_and(|t| t.elapsed() >= self.cfg.handover_after) && self.caught_up(&lease.holder);
        if !ready || self.handing.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let me2 = self.clone();
        tokio::spawn(async move {
            if let Err(e) = me2.ask_handover(&lease).await {
                eprintln!("[fleet] the handover didn’t happen: {e}");
            }
            me2.handing.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    }

    /// This machine's copy follows `holder` and is at its last known head (no copy
    /// kept here: nothing to catch up).
    fn caught_up(&self, holder: &str) -> bool {
        let Ok(d) = self.duck() else { return true };
        let st = d.replica.lock().unwrap().state();
        let v = self.replica_view.lock().unwrap().clone();
        st.origin.as_deref() == Some(holder) && st.seq >= v.head && v.at.is_some_and(|t| now().saturating_sub(t) <= 30)
    }

    async fn ask_handover(self: &Arc<Self>, lease: &Lease) -> Result<(), String> {
        let text = self.ask_for(&lease.holder, Ask::Handover { term: lease.term }, Duration::from_secs(75)).await?;
        let head = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v["head"].as_i64()).unwrap_or(0);
        // Catch up to the head the holder said, then take over.
        if self.duck().is_ok() {
            for _ in 0..40 {
                let _ = self.replicate().await;
                let seq = self.duck()?.replica.lock().unwrap().state().seq;
                if seq >= head {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        if self.inner.lock().unwrap().lease != *lease {
            return Err("the lease moved meanwhile".into());
        }
        self.take_lease(Some(lease.holder.clone())).inspect_err(|e| self.refetch_if_damaged(e))
    }

    /// A damaged copy, while its main is reachable: drop it, and the next sync fetches
    /// a fresh snapshot.
    fn refetch_if_damaged(&self, e: &str) {
        if e.starts_with(repl::DAMAGED) {
            if let Ok(d) = self.duck() {
                d.replica.lock().unwrap().discard();
            }
            *self.damaged_copy.lock().unwrap() = None;
            eprintln!("[fleet] the copy of Duck's state was damaged; fetching a fresh one");
        }
    }

    /// The other side of [`Fleet::leave`]: the holder of `term` is quitting. Catch the
    /// copy up to its `head`, then take the next term.
    async fn take_over(self: &Arc<Self>, term: u64, head: i64) -> Result<String, String> {
        let from = {
            let inner = self.inner.lock().unwrap();
            if inner.lease.term != term || inner.lease.holder == inner.me {
                return Err("its lease isn't the one this machine follows".into());
            }
            inner.lease.holder.clone()
        };
        if self.duck().is_ok() {
            let mut last = None;
            let mut tries = 0;
            loop {
                if let Err(e) = self.replicate().await {
                    last = Some(e);
                }
                let st = self.duck()?.replica.lock().unwrap().state();
                if st.origin.as_deref() == Some(from.as_str()) && st.seq >= head {
                    break;
                }
                tries += 1;
                if tries >= 120 {
                    return Err(format!("its copy of Duck's state didn't catch up{}", last.map(|e| format!(" ({e})")).unwrap_or_default()));
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        if self.inner.lock().unwrap().lease.term != term {
            return Err("the lease moved meanwhile".into());
        }
        self.take_lease(Some(from)).inspect_err(|e| self.refetch_if_damaged(e))?;
        Ok("ok".into())
    }

    // --- quitting while holding Duck ---------------------------------------------------

    /// Whether quitting has to hand Duck over first: this machine holds it, and the
    /// fleet has another machine that may run it.
    pub fn must_hand_over(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.lease.term > 0
            && inner.lease.holder == inner.me
            && inner.members.iter().any(|m| !m.removed && m.id != inner.me && inner.config.can_be_main(&m.id))
    }

    pub fn on_leave(&self, sink: LeaveSink) {
        *self.leave_sink.lock().unwrap() = Some(sink);
    }

    fn say_leave(&self, phase: &str, to: Option<String>, error: Option<String>, attempt: u32) {
        if let Some(s) = self.leave_sink.lock().unwrap().as_ref() {
            s(LeaveStatus { phase: phase.into(), to, error, attempt });
        }
    }

    pub fn is_leaving(&self) -> bool {
        self.leaving.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Try the handover again now.
    pub fn retry_leave(&self) {
        self.leave_wake.notify_one();
    }

    /// Stay: stop handing over, and Duck takes its turns again.
    pub fn cancel_leave(&self) {
        self.leaving.store(false, std::sync::atomic::Ordering::SeqCst);
        self.leave_wake.notify_one();
    }

    fn leave_cancelled(&self) -> bool {
        if self.leaving.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        let holds = {
            let mut inner = self.inner.lock().unwrap();
            inner.draining = false;
            inner.lease.holder == inner.me
        };
        if holds {
            if let Some(s) = self.drain_sink.lock().unwrap().as_ref() {
                s(false);
            }
        }
        (self.notify)();
        true
    }

    /// Hand Duck to the next machine that's online before quitting: Duck finishes its
    /// turns, then the machines the list puts first are asked in turn to catch up and
    /// take over. A failed round is said and tried again until one takes it (true) or
    /// the user stays ([`Fleet::cancel_leave`]: false).
    pub async fn leave(self: &Arc<Self>) -> bool {
        self.leaving.store(true, std::sync::atomic::Ordering::SeqCst);
        let mut attempt = 0;
        self.say_leave("draining", None, None, attempt);
        self.inner.lock().unwrap().draining = true;
        (self.notify)();
        let sink = self.drain_sink.lock().unwrap().is_some();
        if sink {
            if let Some(s) = self.drain_sink.lock().unwrap().as_ref() {
                s(true);
            }
            tokio::select! {
                _ = self.drained.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                _ = self.leave_wake.notified() => {}
            }
        }
        loop {
            if self.leave_cancelled() {
                return false;
            }
            attempt += 1;
            let (term, holds) = {
                let inner = self.inner.lock().unwrap();
                (inner.lease.term, inner.lease.holder == inner.me)
            };
            if !holds {
                // Another machine took it meanwhile (it asked for it).
                self.say_leave("done", None, None, attempt);
                return true;
            }
            let head = match self.duck() {
                Ok(d) => d.source.with(|c| repl::since(c, None, 0)).map(|a| a.head).unwrap_or(0),
                Err(_) => 0,
            };
            let mut errors = Vec::new();
            let candidates = self.successors();
            if candidates.is_empty() {
                errors.push("No other machine that can run Duck is online.".to_string());
            }
            for (id, able) in candidates {
                let name = self.name_of(&id).unwrap_or_else(|| id.clone());
                if !able {
                    errors.push(format!("{name} runs an older Workbench that can't take Duck over: update it."));
                    continue;
                }
                self.say_leave("handing", Some(name.clone()), None, attempt);
                match self.ask_for(&id, Ask::TakeOver { term, head }, Duration::from_secs(180)).await {
                    Ok(_) => {
                        // Its beat, sent as it took the lease, comes first; a moment more.
                        for _ in 0..50 {
                            if self.inner.lock().unwrap().lease.holder == id {
                                self.say_leave("done", Some(name), None, attempt);
                                return true;
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        errors.push(format!("{name} said it took Duck, but its lease never arrived."));
                    }
                    Err(e) => errors.push(format!("{name}: {e}.")),
                }
                if !self.leaving.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
            }
            self.say_leave("waiting", None, Some(errors.join("\n")), attempt);
            let _ = tokio::time::timeout(LEAVE_RETRY, self.leave_wake.notified()).await;
        }
    }

    /// The machines Duck could go to now, in the list's order: linked, allowed to be
    /// main, and whether each can take it over (an older one can't).
    fn successors(&self) -> Vec<(String, bool)> {
        let inner = self.inner.lock().unwrap();
        proto::ranked(&inner.members, &inner.config)
            .into_iter()
            .filter(|id| *id != inner.me && inner.config.can_be_main(id) && inner.links.contains_key(id))
            .map(|id| {
                let able = inner.beats.get(&id).is_some_and(|b| b.caps.iter().any(|c| c == CAP_TAKE_OVER));
                (id, able)
            })
            .collect()
    }

    /// The holder's side of a handover: Duck finishes its turns (up to 60 s), then
    /// the log's head is the answer. The lease stays until the asker takes the next
    /// term.
    async fn give_handover(&self, term: u64) -> Result<String, String> {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.lease.term != term || inner.lease.holder != inner.me {
                return Err("this machine doesn’t hold that lease".into());
            }
            inner.draining = true;
        }
        (self.notify)();
        let sink = self.drain_sink.lock().unwrap().is_some();
        if sink {
            if let Some(s) = self.drain_sink.lock().unwrap().as_ref() {
                s(true);
            }
            let _ = tokio::time::timeout(Duration::from_secs(60), self.drained.notified()).await;
        }
        let head = match self.duck() {
            Ok(d) => d.source.with(|c| repl::since(c, None, 0)).map(|a| a.head).unwrap_or(0),
            Err(_) => 0,
        };
        Ok(serde_json::json!({ "head": head }).to_string())
    }

    /// Where a merge's notice goes (the webview, in the app).
    pub fn on_merged(&self, sink: MergedSink) {
        *self.merged_sink.lock().unwrap() = Some(sink);
    }

    /// The holder, after a split: once the old main is linked again, merge what it
    /// wrote after this machine took over (F6.2).
    fn merge_due(self: &Arc<Self>) {
        use std::sync::atomic::Ordering;
        let Ok(d) = self.duck() else { return };
        let holds = {
            let inner = self.inner.lock().unwrap();
            inner.lease.term > 0 && inner.lease.holder == inner.me
        };
        if !holds {
            return;
        }
        let Ok(Some((origin, epoch, seq))) = d.source.with(merge::split) else { return };
        if !self.inner.lock().unwrap().links.contains_key(&origin) || self.merging.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            if let Err(e) = me.merge_from(&origin, &epoch, seq).await {
                eprintln!("[fleet] the merge after a split didn’t finish: {e}");
            }
            me.merging.store(false, Ordering::SeqCst);
        });
    }

    async fn merge_from(&self, origin: &str, epoch: &str, mut seq: i64) -> Result<(), String> {
        let d = self.duck()?;
        let name = self.name_of(origin).unwrap_or_else(|| "the other machine".into());
        let mut report = merge::MergeReport::default();
        loop {
            let text = self.ask(origin, Ask::ReplLog { epoch: Some(epoch.to_string()), seq }).await?;
            let a: repl::LogAnswer = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if a.snapshot {
                // Its history moved on (it took over again, or its log was trimmed
                // past the split): nothing can be merged now.
                d.source.with(|c| merge::advance_split(c, None)).ok();
                self.say_merged(format!("{name} was cut off from the fleet for a while, but what it did then couldn't be merged here: its history moved on."));
                return Ok(());
            }
            if a.entries.is_empty() {
                break;
            }
            let last = a.entries.last().map(|e| e.seq).unwrap_or(seq);
            let r = d.source.with(|c| merge::merge_tail(c, &a.entries, &name))?;
            report.messages += r.messages;
            report.records += r.records;
            report.usage += r.usage;
            report.skipped_deletes += r.skipped_deletes;
            report.forked.extend(r.forked);
            seq = last;
            d.source.with(|c| merge::advance_split(c, Some(seq))).ok();
            if (a.entries.len() as i64) < repl::BATCH {
                break;
            }
        }
        d.source.with(|c| merge::advance_split(c, None)).ok();
        if !report.is_empty() {
            self.say_merged(report.text(&name));
        }
        Ok(())
    }

    fn say_merged(&self, text: String) {
        if let Some(s) = self.merged_sink.lock().unwrap().as_ref() {
            s(text);
        }
    }

    /// The webview's Duck finished its turns (`fleet_drained`).
    pub fn drained(&self) {
        self.drained.notify_one();
    }

    /// Where the webview hears to finish its turns for a handover (and when it may
    /// take them again).
    pub fn on_drain(&self, sink: DrainSink) {
        *self.drain_sink.lock().unwrap() = Some(sink);
    }

    /// How this machine makes its copy its Duck.
    pub fn on_promote(&self, p: Promote) {
        *self.promote.lock().unwrap() = Some(p);
    }

    /// Off the fleet (no links) or back on it.
    pub fn set_offline(&self, on: bool) {
        let peers: Vec<String> = {
            let mut inner = self.inner.lock().unwrap();
            inner.offline = on;
            inner.links.keys().cloned().collect()
        };
        if on {
            for p in peers {
                self.close_link(&p, "gone offline");
            }
        }
        self.wake.notify_one();
    }



    fn beat(&self) -> Beat {
        let dirs = self.duck().ok().and_then(|d| {
            let ws = d.workspace.lock().unwrap().clone()?;
            let data = d.files.parent()?.to_string_lossy().into_owned();
            Some([ws.to_string_lossy().into_owned(), data])
        });
        let inner = self.inner.lock().unwrap();
        Beat {
            lease: (inner.lease.term > 0).then(|| inner.lease.clone()),
            dirs,
            name: Self::self_record(&inner).name,
            version: self.cfg.version.clone(),
            os: std::env::consts::OS.into(),
            build: if cfg!(debug_assertions) { "debug" } else { "release" }.into(),
            caps: self.caps.clone(),
            remote_port: inner.remote_port,
        }
    }

    // --- asking another machine ---------------------------------------------------

    /// Ask `peer` something over its link; its answer, or why there is none.
    async fn ask(&self, peer: &str, ask: Ask) -> Result<String, String> {
        self.ask_for(peer, ask, ASK_TIMEOUT).await
    }

    async fn ask_for(&self, peer: &str, ask: Ask, wait: Duration) -> Result<String, String> {
        let req = self.next_ask.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        let sent = {
            let inner = self.inner.lock().unwrap();
            match inner.links.get(peer) {
                Some(link) => {
                    self.asks.lock().unwrap().insert(req, tx);
                    link.out.send(Frame::Ask { req, ask }.to_text()).is_ok()
                }
                None => false,
            }
        };
        if !sent {
            self.asks.lock().unwrap().remove(&req);
            return Err("that machine isn’t connected".into());
        }
        let answer = tokio::time::timeout(wait, rx).await;
        self.asks.lock().unwrap().remove(&req);
        match answer {
            Ok(Ok(a)) => a,
            Ok(Err(_)) => Err("the link closed before it answered".into()),
            Err(_) => Err("that machine didn’t answer in time".into()),
        }
    }

    /// A question from `peer` (the link's reader): the answer to send back.
    async fn on_ask(self: &Arc<Self>, ask: Ask) -> Result<String, String> {
        match ask {
            Ask::Handover { term } => self.give_handover(term).await,
            Ask::TakeOver { term, head } => self.take_over(term, head).await,
            Ask::RelaySession { device } => self.book.relay_session(&device),
            Ask::Wake { id } => self.wake_here(&id),
            Ask::ReplLog { epoch, seq } => self.repl_log(epoch.as_deref(), seq),
            Ask::ReplSnapshot { n } => self.repl_snapshot(n),
            Ask::RepoBundle { have, n } => self.repo_bundle(have.as_deref(), n),
            Ask::FileChunk { id, name, n } => self.file_chunk(&id, &name, n),
        }
    }

    // --- Duck's state (F5.1) ---------------------------------------------------------

    /// Duck's database, and the file for the copy of the main's.
    pub fn set_duck(&self, d: DuckRepl) {
        *self.duck.lock().unwrap() = Some(Arc::new(d));
    }

    fn duck(&self) -> Result<Arc<DuckRepl>, String> {
        self.duck.lock().unwrap().clone().ok_or_else(|| "Duck's database isn't open here".to_string())
    }

    /// The source's side: the log after `seq`.
    fn repl_log(&self, epoch: Option<&str>, seq: i64) -> Result<String, String> {
        let d = self.duck()?;
        let answer = d.source.with(|c| repl::since(c, epoch, seq)).map_err(|e| e.to_string())?;
        Ok(serde_json::to_string(&answer).expect("serializes"))
    }

    /// The source's side: chunk `n` of a snapshot, `{total, data}` (base64).
    fn repl_snapshot(&self, n: u32) -> Result<String, String> {
        let d = self.duck()?;
        let bytes = {
            let mut cache = self.snap_cache.lock().unwrap();
            let fresh = cache.as_ref().is_some_and(|(at, _)| at.elapsed() < Duration::from_secs(300));
            if n == 0 || !fresh {
                let b = Arc::new(d.source.with(|c| repl::snapshot(c, &d.scratch))?);
                *cache = Some((Instant::now(), b));
            }
            cache.as_ref().expect("just made").1.clone()
        };
        chunk_answer(&bytes, n)
    }

    /// The source's side: chunk `n` of a bundle of Duck's repo for a mirror at
    /// `have`, or `{upToDate}`.
    fn repo_bundle(&self, have: Option<&str>, n: u32) -> Result<String, String> {
        let d = self.duck()?;
        let ws = d.workspace.lock().unwrap().clone().ok_or("Duck's workspace isn't known here")?;
        let bytes = {
            let mut cache = self.bundle_cache.lock().unwrap();
            let fresh = cache.as_ref().is_some_and(|(at, _)| at.elapsed() < Duration::from_secs(300));
            if n == 0 || !fresh {
                match files::bundle(&ws, have, &d.scratch.with_extension("bundle"))? {
                    Some(b) => *cache = Some((Instant::now(), Arc::new(b))),
                    None => return Ok(serde_json::json!({ "upToDate": true }).to_string()),
                }
            }
            cache.as_ref().expect("just made").1.clone()
        };
        chunk_answer(&bytes, n)
    }

    /// The source's side: chunk `n` of a stored attachment.
    fn file_chunk(&self, id: &str, name: &str, n: u32) -> Result<String, String> {
        let d = self.duck()?;
        let path = crate::assistant::attachments::file_of(&d.files, id, name)?;
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        chunk_answer(&bytes, n)
    }

    /// Fetch every chunk of something `peer` sends in chunks; None for `upToDate`.
    async fn fetch_chunks(&self, peer: &str, ask: impl Fn(u32) -> Ask) -> Result<Option<Vec<u8>>, String> {
        use base64::Engine;
        let mut bytes = Vec::new();
        let mut n = 0u32;
        loop {
            let text = self.ask(peer, ask(n)).await?;
            let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if v["upToDate"].as_bool() == Some(true) {
                return Ok(None);
            }
            let part = base64::engine::general_purpose::STANDARD.decode(v["data"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
            bytes.extend_from_slice(&part);
            n += 1;
            if n >= v["total"].as_u64().unwrap_or(1) as u32 {
                return Ok(Some(bytes));
            }
        }
    }

    /// Duck's workspace here, as the settings say (F5.2).
    pub fn set_workspace(&self, ws: std::path::PathBuf) {
        if let Ok(d) = self.duck() {
            *d.workspace.lock().unwrap() = Some(ws);
        }
    }

    /// Bring the mirror of the main's repo up to date.
    async fn sync_repo(self: &Arc<Self>, main: &str, d: &DuckRepl) -> Result<(), String> {
        let have = files::head(&d.mirror);
        let have2 = have.clone();
        let Some(bytes) = self.fetch_chunks(main, move |n| Ask::RepoBundle { have: have2.clone(), n }).await? else {
            self.replica_view.lock().unwrap().repo = have.map(|h| h[..h.len().min(10)].to_string());
            return Ok(());
        };
        let mirror = d.mirror.clone();
        let scratch = d.scratch.with_extension("incoming-bundle");
        let head = tokio::task::spawn_blocking(move || files::apply_bundle(&mirror, &bytes, &scratch))
            .await
            .map_err(|e| e.to_string())??;
        self.replica_view.lock().unwrap().repo = Some(head[..head.len().min(10)].to_string());
        Ok(())
    }

    /// An attachment this machine doesn't have, from whichever linked machine has
    /// it (Duck's main first), checked against its id (F5.2).
    pub async fn fetch_attachment(&self, id: &str, name: &str) -> Result<(), String> {
        let d = self.duck()?;
        let mut peers: Vec<String> = self.inner.lock().unwrap().links.keys().cloned().collect();
        if let Some(main) = self.duck_source() {
            peers.retain(|p| p != &main);
            peers.insert(0, main);
        }
        let mut last = "no other machine is connected".to_string();
        for peer in peers {
            let (i, nm) = (id.to_string(), name.to_string());
            match self.fetch_chunks(&peer, move |n| Ask::FileChunk { id: i.clone(), name: nm.clone(), n }).await {
                Ok(Some(bytes)) => {
                    let stored = crate::assistant::attachments::store_bytes(&d.files, name, &bytes)?;
                    if stored.id != id {
                        last = "a machine sent other bytes than the attachment's".into();
                        continue;
                    }
                    return Ok(());
                }
                Ok(None) => {}
                Err(e) => last = e,
            }
        }
        Err(format!("the attachment {name} isn't here, and no machine sent it: {last}"))
    }

    /// Duck's main when that's another machine linked to this one.
    fn duck_source(&self) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        let main = Self::duck_of(&inner)?;
        (main != inner.me && inner.links.contains_key(&main)).then_some(main)
    }

    /// Bring the copy up to date in the background, one run at a time.
    fn replicate_due(self: &Arc<Self>) {
        use std::sync::atomic::Ordering;
        if self.duck.lock().unwrap().is_none() || self.duck_source().is_none() {
            return;
        }
        if self.replicating.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            let res = me.replicate().await;
            {
                let mut v = me.replica_view.lock().unwrap();
                v.at = Some(now());
                v.error = res.err();
            }
            me.replicating.store(false, Ordering::SeqCst);
        });
    }

    /// One sync with the main: the log while there is more, or a snapshot.
    pub async fn replicate(self: &Arc<Self>) -> Result<(), String> {
        let main = self.duck_source().ok_or("Duck's main isn't another machine that's connected")?;
        let d = self.duck()?;
        // Duck's repo, now and then (F5.2).
        let due = self.repo_synced.lock().unwrap().is_none_or(|at| at.elapsed() >= REPO_EVERY);
        if due {
            *self.repo_synced.lock().unwrap() = Some(Instant::now());
            let res = self.sync_repo(&main, &d).await;
            self.replica_view.lock().unwrap().repo_error = res.err();
        }
        for _ in 0..50 {
            let st = d.replica.lock().unwrap().state();
            let answer: repl::LogAnswer = if st.origin.as_deref() == Some(main.as_str()) {
                let text = self.ask(&main, Ask::ReplLog { epoch: st.epoch.clone(), seq: st.seq }).await?;
                serde_json::from_str(&text).map_err(|e| e.to_string())?
            } else {
                repl::LogAnswer { epoch: String::new(), head: 0, snapshot: true, entries: vec![] }
            };
            self.replica_view.lock().unwrap().head = answer.head;
            if answer.snapshot {
                self.fetch_snapshot(&main, &d).await?;
                continue;
            }
            let more = answer.entries.len() as i64 >= repl::BATCH;
            let applied = d.replica.lock().unwrap().apply(&answer.entries);
            if let Err(e) = applied {
                // A schema it doesn't have, say: start over from a snapshot.
                eprintln!("[fleet] the copy of Duck's state couldn't take a change ({e}); taking a snapshot");
                self.fetch_snapshot(&main, &d).await?;
                continue;
            }
            let st = d.replica.lock().unwrap().state();
            {
                let mut v = self.replica_view.lock().unwrap();
                v.of = Some(main.clone());
                v.seq = st.seq;
            }
            if !more {
                return Ok(());
            }
        }
        Ok(())
    }

    async fn fetch_snapshot(self: &Arc<Self>, main: &str, d: &DuckRepl) -> Result<(), String> {
        let bytes = self.fetch_chunks(main, |n| Ask::ReplSnapshot { n }).await?.ok_or("the main sent no snapshot")?;
        d.replica.lock().unwrap().install(main, &bytes)?;
        let st = d.replica.lock().unwrap().state();
        let mut v = self.replica_view.lock().unwrap();
        v.of = Some(main.to_string());
        v.seq = st.seq;
        v.snapshots += 1;
        Ok(())
    }

    // --- waking (F4.1) ---------------------------------------------------------------

    /// Whether machine `id` may be woken.
    pub fn set_wakeable(&self, id: &str, on: bool) {
        self.update_config(|cfg, members| {
            if !members.iter().any(|m| m.id == id && !m.removed) {
                return false;
            }
            cfg.wake.retain(|x| x != id);
            if on {
                cfg.wake.push(id.to_string());
            }
            true
        });
    }

    /// Send machine `id` its packet from here, when this machine is on its network.
    fn wake_here(&self, id: &str) -> Result<String, String> {
        let (target, mine) = {
            let inner = self.inner.lock().unwrap();
            let target = Self::others_live(&inner).find(|m| m.id == id).and_then(|m| m.lan.clone());
            (target, Self::self_record(&inner).lan)
        };
        let target = target.ok_or("that machine hasn’t said its network address")?;
        if mine.as_ref().map(|l| &l.network) != Some(&target.network) {
            return Err("this machine isn’t on its network".into());
        }
        let mac = proto::parse_mac(&target.mac).ok_or("its MAC address doesn’t read")?;
        let broadcast = target.broadcast.parse().map_err(|_| "its broadcast address doesn’t read".to_string())?;
        self.net.send_wake(mac, broadcast)?;
        Ok("sent".into())
    }

    /// Wake machine `id`: the packet goes from here when this machine is on its
    /// network, else from a machine that's on and is. Ok: who sent it.
    pub async fn wake(&self, id: &str) -> Result<String, String> {
        let (name, allowed, online, lan, helpers, here) = {
            let inner = self.inner.lock().unwrap();
            let m = Self::others_live(&inner).find(|m| m.id == id).ok_or("that machine isn’t in the fleet")?;
            let lan = m.lan.clone();
            let helpers: Vec<(String, String)> = Self::others_live(&inner)
                .filter(|p| p.id != id && inner.links.contains_key(&p.id))
                .filter(|p| p.lan.as_ref().map(|l| &l.network) == lan.as_ref().map(|l| &l.network))
                .map(|p| (p.id.clone(), p.name.clone()))
                .collect();
            let here = Self::self_record(&inner).lan.map(|l| l.network);
            (m.name.clone(), inner.config.wake.contains(&m.id), inner.links.contains_key(id), lan, helpers, here)
        };
        if online {
            return Ok(format!("{name} is on already"));
        }
        if !allowed {
            return Err(format!("{name} isn’t set to be woken (Remote Access → fleet: “can be woken”)"));
        }
        let lan = lan.ok_or(format!("{name} hasn’t said its network address yet: it has to be on once first"))?;
        if here.as_ref() == Some(&lan.network) {
            self.wake_here(id)?;
            return Ok(format!("sent to {name} from here"));
        }
        let mut last = format!("no machine on {name}’s network ({}) is on to wake it", lan.network);
        for (peer, peer_name) in helpers {
            match self.ask(&peer, Ask::Wake { id: id.to_string() }).await {
                Ok(_) => return Ok(format!("sent to {name} by {peer_name}")),
                Err(e) => last = format!("{peer_name} couldn’t: {e}"),
            }
        }
        Err(last)
    }

    fn on_answer(&self, req: u64, answer: Result<String, String>) {
        if let Some(tx) = self.asks.lock().unwrap().remove(&req) {
            let _ = tx.send(answer);
        }
    }

    // --- Duck's hosts (F3.1) ------------------------------------------------------

    /// Where host traffic from peers goes from now on.
    pub fn on_host(&self, sink: HostSink) {
        *self.host_sink.lock().unwrap() = Some(sink);
    }

    /// Send host traffic to `peer` over its link.
    pub fn send_host(&self, peer: &str, text: String) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let link = inner.links.get(peer).ok_or("that machine isn’t connected")?;
        link.out.send(Frame::Host { text }.to_text()).map_err(|_| "the link closed".to_string())
    }

    fn take_host(&self, peer: &str, text: String) {
        if let Some(sink) = self.host_sink.lock().unwrap().as_ref() {
            sink(peer, text);
        }
    }

    // --- relaying (F2.2) -----------------------------------------------------------

    /// This machine's remote server listens on the tailnet at `port` (None: it
    /// stopped). Said in the next beat.
    pub fn set_remote_port(&self, port: Option<u16>) {
        self.inner.lock().unwrap().remote_port = port;
    }

    /// Where to relay a request for machine `id`: its remote server on its tailnet
    /// address while it's linked and listening; this machine's own on loopback.
    pub fn relay_target(&self, id: &str) -> Option<SocketAddr> {
        let inner = self.inner.lock().unwrap();
        if id == inner.me {
            return inner.remote_port.map(|p| SocketAddr::from(([127, 0, 0, 1], p)));
        }
        if !inner.links.contains_key(id) {
            return None;
        }
        let port = inner.beats.get(id)?.remote_port?;
        let ip: IpAddr = Self::others_live(&inner).find(|m| m.id == id)?.ip.parse().ok()?;
        Some(SocketAddr::new(ip, port))
    }

    /// A session for `device` on machine `id`'s remote server, to relay with: kept
    /// from before unless `fresh` (the last one was refused).
    pub async fn relay_session(&self, id: &str, device: &str, fresh: bool) -> Result<String, String> {
        if id == self.me() {
            return self.book.relay_session(device);
        }
        let key = (id.to_string(), device.to_string());
        if !fresh {
            if let Some((s, at)) = self.relay_sessions.lock().unwrap().get(&key) {
                if at.elapsed() < RELAY_SESSION_TTL {
                    return Ok(s.clone());
                }
            }
        }
        let session = self.ask(id, Ask::RelaySession { device: device.to_string() }).await?;
        self.relay_sessions.lock().unwrap().insert(key, (session.clone(), Instant::now()));
        Ok(session)
    }

    /// Where Duck is, when it isn't here: the main (the pin, else the list's first
    /// choice) while it's another machine that can be relayed to. None: answer here
    /// (this is the main, or the main can't be reached and this machine stands in).
    pub fn duck_main(&self) -> Option<String> {
        let main = self.phone_list().main?;
        (main != self.me() && self.relay_target(&main).is_some()).then_some(main)
    }

    /// A peer presented this machine's own id: its identity was copied.
    fn identity_clash(&self, addr: &str) {
        let problem = format!(
            "The machine at {addr} has this machine’s fleet identity — one of them has a copy of the other’s app data. Reset the identity on the copy."
        );
        self.inner.lock().unwrap().problem = Some(problem);
        self.log_failure(addr, "a peer with this machine’s own identity");
    }

    // --- what the menu does -------------------------------------------------------

    pub fn status(&self) -> FleetStatus {
        let inner = self.inner.lock().unwrap();
        let t = now();
        let live = inner.gate.live(t);
        let listening = inner.listener.as_ref().map(|l| l.addr);
        let view = |m: &Member| {
            let beat = inner.beats.get(&m.id);
            let link = inner.links.get(&m.id);
            MemberView {
                id: m.id.clone(),
                name: m.name.clone(),
                ip: m.ip.clone(),
                port: m.port,
                host: m.host.clone(),
                kind: m.kind.clone(),
                public_url: m.public_url.clone(),
                wakeable: m.lan.is_some(),
                online: link.is_some(),
                last_seen: inner.seen.get(&m.id).copied(),
                version: beat.map(|b| b.version.clone()),
                os: beat.map(|b| b.os.clone()),
                build: beat.map(|b| b.build.clone()),
                caps: beat.map(|b| b.caps.clone()).unwrap_or_default(),
                direction: link.map(|l| if l.dialer == inner.me { "out" } else { "in" }.to_string()),
            }
        };
        let mut me = view(&Self::self_record(&inner));
        me.online = true;
        me.version = Some(self.cfg.version.clone());
        me.os = Some(std::env::consts::OS.into());
        me.caps = self.caps.clone();
        let mut members: Vec<MemberView> = Self::others_live(&inner).map(view).collect();
        members.sort_by_key(|m| m.name.to_lowercase());
        let cfg = &inner.config;
        let up = |id: &str| id == inner.me || inner.links.contains_key(id);
        let config = ConfigView {
            order: proto::ranked(&inner.members, cfg),
            custom_order: !cfg.order.is_empty(),
            pin: cfg.pin.clone(),
            not_main: cfg.not_main.clone(),
            wake: cfg.wake.clone(),
            main: proto::main_by_hand(&inner.members, cfg),
            first_choice: proto::first_choice(&inner.members, cfg, up),
            duck: Self::duck_of(&inner),
            lease_term: inner.lease.term,
            draining: inner.draining,
            updated_at: cfg.updated_at,
            by: (!cfg.by.is_empty())
                .then(|| inner.members.iter().find(|m| m.id == cfg.by).map_or(cfg.by.clone(), |m| m.name.clone())),
        };
        FleetStatus {
            me,
            tailnet: inner.tailnet_ip.is_some(),
            listening: listening.map(|a| a.to_string()),
            code: live.map(|(c, _)| c.to_string()),
            code_expires_at: live.map(|(_, e)| e),
            join_string: match (live, listening) {
                (Some((c, _)), Some(addr)) => Some(proto::join_string(c, &addr.ip().to_string(), addr.port())),
                _ => None,
            },
            code_locked: inner.gate.locked(),
            members,
            log: inner.log.entries(),
            problem: inner.problem.clone(),
            config,
            replica: {
                let v = self.replica_view.lock().unwrap().clone();
                v.of.is_some().then(|| ReplicaView {
                    of: v.of.as_ref().map(|id| inner.members.iter().find(|m| &m.id == id).map_or(id.clone(), |m| m.name.clone())),
                    ..v
                })
            },
        }
    }

    /// The tailnet address, asked now if the keeper hasn't looked yet.
    fn tailnet_now(&self) -> Option<IpAddr> {
        if let Some(ip) = self.inner.lock().unwrap().tailnet_ip {
            return Some(ip);
        }
        let ip = self.net.tailnet_ip()?;
        self.inner.lock().unwrap().tailnet_ip = Some(ip);
        Some(ip)
    }

    pub fn new_code(&self) -> Result<(), String> {
        if self.tailnet_now().is_none() {
            return Err("Tailscale isn’t connected here".into());
        }
        let mut inner = self.inner.lock().unwrap();
        inner.gate.issue(auth::gen_pairing_code(), now());
        drop(inner);
        self.wake.notify_one();
        (self.notify)();
        Ok(())
    }

    pub fn rename(&self, name: &str) {
        let name = clean_name(name);
        self.update_self(|m| m.name = name);
    }

    /// What sort of machine this one is.
    pub fn set_kind(&self, kind: &str) -> Result<(), String> {
        if !proto::valid_kind(kind) {
            return Err(format!("“{kind}” isn’t a kind of machine (desktop, laptop, server)"));
        }
        let kind = kind.to_string();
        self.update_self(|m| m.kind = kind);
        Ok(())
    }

    /// The priority order, by hand: `ids` first, in this order (an empty list goes
    /// back to the default, by kind).
    pub fn set_order(&self, ids: Vec<String>) {
        self.update_config(|cfg, members| {
            let mut order: Vec<String> = Vec::new();
            for id in ids {
                let live = members.iter().any(|m| m.id == id && !m.removed);
                if live && !order.contains(&id) {
                    order.push(id);
                }
            }
            cfg.order = order;
            true
        });
    }

    /// Pin the main to a member (None: unpin). A pinned machine can be main.
    pub fn set_pin(&self, id: Option<String>) -> Result<(), String> {
        if let Some(id) = &id {
            let live = self.inner.lock().unwrap().members.iter().any(|m| &m.id == id && !m.removed);
            if !live {
                return Err("that machine isn’t in the fleet".into());
            }
        }
        self.update_config(|cfg, _| {
            if let Some(id) = &id {
                cfg.not_main.retain(|x| x != id);
            }
            cfg.pin = id;
            true
        });
        Ok(())
    }

    /// Whether a member may be main. One that may not loses the pin.
    pub fn set_can_be_main(&self, id: &str, can: bool) {
        self.update_config(|cfg, members| {
            if !members.iter().any(|m| m.id == id) {
                return false;
            }
            cfg.not_main.retain(|x| x != id);
            if !can {
                cfg.not_main.push(id.to_string());
                if cfg.pin.as_deref() == Some(id) {
                    cfg.pin = None;
                }
            }
            true
        });
    }

    /// Remove a member from the fleet, everywhere; this machine's own id leaves.
    pub fn remove(&self, id: &str) {
        let me = self.me();
        if id == me {
            let tomb = {
                let inner = self.inner.lock().unwrap();
                Member { removed: true, updated_at: now_ms(), ..Self::self_record(&inner) }
            };
            {
                let inner = self.inner.lock().unwrap();
                let frame = Frame::Members { list: vec![tomb] }.to_text();
                for link in inner.links.values() {
                    let _ = link.out.send(frame.clone());
                }
            }
            self.leave_here("left the fleet");
            self.update_self(|_| {}); // newer than the tombstone, for a later join
            return;
        }
        let tomb = {
            let mut inner = self.inner.lock().unwrap();
            let Some(m) = inner.members.iter_mut().find(|m| m.id == id) else { return };
            m.removed = true;
            m.updated_at = now_ms();
            m.clone()
        };
        self.store.with(|c| store::save(c, &tomb)).ok();
        self.gossip(None); // it hears it too, before its link closes
        self.close_link(id, "removed from the fleet");
        self.inner.lock().unwrap().beats.remove(id);
        (self.notify)();
    }

    /// A new id and key for this machine (its app data was copied from another).
    pub fn reset_identity(&self) {
        let peers: Vec<String> = self.inner.lock().unwrap().links.keys().cloned().collect();
        for p in peers {
            self.close_link(&p, "identity reset");
        }
        let id = new_id();
        let key = SigningKey::random(&mut OsRng);
        self.store
            .with(|c| {
                store::clear_except(c, ""); // every row: no id is empty
                store::set_identity(c, &id, &proto::secret_b64(&key))
            })
            .ok();
        {
            let mut inner = self.inner.lock().unwrap();
            let rec = Self::self_record(&inner);
            inner.members = vec![Member { id: id.clone(), ..rec }];
            inner.me = id;
            inner.key = key;
            inner.problem = None;
            inner.beats.clear();
            inner.backoff.clear();
        }
        self.forget_config();
        self.ensure_self(); // the old key differs: a fresh record is saved
        (self.notify)();
        self.wake.notify_one();
    }
}

/// What this machine can do, said in its beats. F3 grows it.
fn local_caps() -> Vec<String> {
    let mut caps = Vec::new();
    if which::which("claude").is_ok() {
        caps.push("claude-code".into());
    }
    caps.push(CAP_TAKE_OVER.into());
    caps
}

/// What a machine most likely is, for its first record: Linux is the server (the only
/// Linux machine planned), a Windows PC with a battery is a laptop, any other a
/// desktop. Editable in the menu.
fn default_kind() -> &'static str {
    if cfg!(target_os = "linux") {
        return "server";
    }
    if cfg!(target_os = "macos") {
        return "laptop";
    }
    #[cfg(windows)]
    {
        use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        let mut s = SYSTEM_POWER_STATUS::default();
        // 128: no system battery; 255: unknown.
        if unsafe { GetSystemPowerStatus(&mut s) }.is_ok() && s.BatteryFlag != 128 && s.BatteryFlag != 255 {
            return "laptop";
        }
    }
    "desktop"
}

// ---------------------------------------------------------------------------------
// The app's instance and its commands.
// ---------------------------------------------------------------------------------

/// Start the fleet: make or load this machine's identity and run the keeper. The
/// listener comes up only once there's a member or a code.
pub fn init(app: &AppHandle) {
    let default_name = sysinfo::System::host_name()
        .map(|h| h.to_lowercase())
        .unwrap_or_else(|| "machine".into());
    let notify_app = app.clone();
    let fleet = Fleet::new(
        Config {
            port: FLEET_PORT,
            default_name,
            default_kind: default_kind().into(),
            version: env!("CARGO_PKG_VERSION").into(),
            tick: Duration::from_secs(3),
            failover: Duration::from_secs(30),
            handover_after: Duration::from_secs(120),
        },
        Box::new(net::Tailscale),
        Storage::new({
            let app = app.clone();
            move |f| {
                let db = app.state::<Db>();
                let conn = db.conn.lock().expect("db lock poisoned");
                f(&conn)
            }
        }),
        crate::remote::device_book(app),
        Box::new(move || {
            let _ = notify_app.emit("fleet-changed", ());
        }),
    );
    fleet.set_public_url(crate::remote::public_url(app));
    // The election (F6.1): the webview's Duck finishes its turns for a handover,
    // and taking over installs the copy.
    let drain_app = app.clone();
    fleet.on_drain(Box::new(move |on| {
        let _ = drain_app.emit("fleet-drain", on);
    }));
    let leave_app = app.clone();
    fleet.on_leave(Box::new(move |status| {
        let _ = leave_app.emit("fleet-leaving", status);
    }));
    let merged_app = app.clone();
    fleet.on_merged(Box::new(move |text| {
        let _ = merged_app.emit("fleet-merged", text);
    }));
    let promote_app = app.clone();
    fleet.on_promote(Box::new(move |term, dirs| promote_here(&promote_app, term, dirs)));
    // Duck's state (F5.1): its database, and the copy of the main's beside it.
    if let (Ok(dir), Some(_)) = (app.path().app_data_dir(), app.try_state::<Arc<crate::assistant::Assistant>>()) {
        let replica = if cfg!(debug_assertions) { "duck.replica.dev.db" } else { "duck.replica.db" };
        let mirror = if cfg!(debug_assertions) { "duck-replica-workspace.dev" } else { "duck-replica-workspace" };
        let source_app = app.clone();
        fleet.set_duck(DuckRepl {
            source: Storage::new(move |f| {
                let a = source_app.state::<Arc<crate::assistant::Assistant>>();
                let conn = a.db.conn.lock().expect("duck db lock poisoned");
                f(&conn)
            }),
            replica: Mutex::new(repl::Replica::new(dir.join(replica))),
            scratch: dir.join(format!("{replica}.snapshot")),
            workspace: Mutex::new(crate::assistant::workspace::resolve(None).ok()),
            mirror: dir.join(mirror),
            files: crate::assistant::attachments::root(&dir),
        });
    }
    fleet.set_remote_port(crate::remote::tailnet_port(app));
    let host_app = app.clone();
    fleet.on_host(Box::new(move |from, text| {
        let _ = host_app.emit("fleet-host", serde_json::json!({ "from": from, "text": text }));
    }));
    app.manage(fleet.clone());
    tauri::async_runtime::spawn(fleet.run());
}

/// Make the copy of the old main's Duck this machine's (F6.1): its `duck.db` (the
/// old one kept beside it), its paths rebased to this machine's, and Duck's
/// workspace moved to the mirror's head (the old head kept on a branch). The
/// webview then starts Duck again on it (`duck-promoted`).
fn promote_here(app: &AppHandle, term: u64, dirs: Option<[String; 2]>) -> Result<(), String> {
    let fleet = get(app).ok_or("no fleet")?;
    let d = fleet.duck()?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let live = dir.join(crate::assistant::db::FILE_NAME);
    let backup = dir.join(format!("{}.before-term-{term}", crate::assistant::db::FILE_NAME));
    let my_ws = d.workspace.lock().unwrap().clone();
    // Held until the copy is installed: a sync can't reopen it and write meanwhile.
    let mut replica = d.replica.lock().unwrap();
    let copy = replica.close().to_path_buf();
    let a = app.state::<Arc<crate::assistant::Assistant>>();
    a.db.become_copy(&live, &copy, &backup, |c| {
        if let (Some([ws, data]), Some(mine)) = (&dirs, &my_ws) {
            let my_data = dir.to_string_lossy().into_owned();
            repl::rebase_paths(c, &[ws.as_str(), data.as_str()], &[&mine.to_string_lossy(), &my_data]).map_err(|e| e.to_string())?;
        }
        Ok(())
    })?;
    replica.discard();
    drop(replica);
    // Duck's repo: the mirror's head, the old one kept.
    if let (Some(ws), Some(_)) = (my_ws, files::head(&d.mirror)) {
        let mirror = d.mirror.to_string_lossy().into_owned();
        if files::head(&ws).is_some() {
            let _ = crate::gitqueue::run(&ws, &["branch", "-f", &format!("fleet/before-term-{term}"), "HEAD"]);
        } else if !ws.join(".git").exists() {
            std::fs::create_dir_all(&ws).map_err(|e| e.to_string())?;
            crate::gitqueue::run(&ws, &["init", "-q"])?;
        }
        crate::gitqueue::run(&ws, &["fetch", "-q", &mirror, "HEAD"])?;
        crate::gitqueue::run(&ws, &["reset", "-q", "--hard", "FETCH_HEAD"])?;
    }
    let _ = app.emit("duck-promoted", term);
    Ok(())
}

/// The app's fleet, once [`init`] has run.
pub fn get(app: &AppHandle) -> Option<Arc<Fleet>> {
    app.try_state::<Arc<Fleet>>().map(|f| f.inner().clone())
}

/// Duck's workspace here, from the settings (F5.2: the repo the mirror follows).
/// Take this machine off the fleet (no links) or put it back (F6.1).
#[tauri::command]
pub fn fleet_set_offline(fleet: State<'_, Arc<Fleet>>, on: bool) -> FleetStatus {
    fleet.set_offline(on);
    fleet.status()
}

/// Bring the main window up (from the tray, too): the handover on quitting shows there.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The handover on quitting: try again now.
#[tauri::command]
pub fn fleet_leave_retry(fleet: State<'_, Arc<Fleet>>) {
    fleet.retry_leave();
}

/// The handover on quitting: stay open instead.
#[tauri::command]
pub fn fleet_leave_cancel(fleet: State<'_, Arc<Fleet>>) {
    fleet.cancel_leave();
}

/// Quit without handing Duck over (the overlay's "Quit anyway"): the other machines
/// take it over by themselves once this one goes quiet (failover).
#[tauri::command]
pub fn fleet_quit_now(app: AppHandle) {
    crate::shutdown::exit(&app);
}

/// The webview's Duck finished its turns for a handover (F6.1).
#[tauri::command]
pub fn fleet_drained(fleet: State<'_, Arc<Fleet>>) {
    fleet.drained();
}

#[tauri::command]
pub fn fleet_set_workspace(fleet: State<'_, Arc<Fleet>>, workspace: Option<String>) -> Result<(), String> {
    fleet.set_workspace(crate::assistant::workspace::resolve(workspace.as_deref())?);
    Ok(())
}

/// Make sure attachment `id` / `name` is here, from another machine if it isn't
/// (F5.2). Ok when it's here now.
pub async fn ensure_attachment(app: &AppHandle, root: &std::path::Path, id: &str, name: &str) -> Result<(), String> {
    if crate::assistant::attachments::file_of(root, id, name).is_ok() {
        return Ok(());
    }
    let Some(fleet) = get(app) else { return Err(format!("the attachment {name} is gone")) };
    fleet.fetch_attachment(id, name).await
}

/// Duck's host traffic to another machine (F3.1).
#[tauri::command]
pub fn fleet_host_send(fleet: State<'_, Arc<Fleet>>, peer: String, text: String) -> Result<(), String> {
    fleet.send_host(&peer, text)
}

#[tauri::command]
pub fn fleet_status(fleet: State<'_, Arc<Fleet>>) -> FleetStatus {
    fleet.status()
}

#[tauri::command]
pub fn fleet_new_code(fleet: State<'_, Arc<Fleet>>) -> Result<FleetStatus, String> {
    fleet.new_code()?;
    Ok(fleet.status())
}

#[tauri::command]
pub async fn fleet_join(fleet: State<'_, Arc<Fleet>>, join: String) -> Result<FleetStatus, String> {
    let fleet = fleet.inner().clone();
    fleet.join(&join).await?;
    Ok(fleet.status())
}

#[tauri::command]
pub fn fleet_rename(fleet: State<'_, Arc<Fleet>>, name: String) -> FleetStatus {
    fleet.rename(&name);
    fleet.status()
}

#[tauri::command]
pub fn fleet_set_kind(fleet: State<'_, Arc<Fleet>>, kind: String) -> Result<FleetStatus, String> {
    fleet.set_kind(&kind)?;
    Ok(fleet.status())
}

#[tauri::command]
pub fn fleet_set_order(fleet: State<'_, Arc<Fleet>>, ids: Vec<String>) -> FleetStatus {
    fleet.set_order(ids);
    fleet.status()
}

#[tauri::command]
pub fn fleet_set_pin(fleet: State<'_, Arc<Fleet>>, id: Option<String>) -> Result<FleetStatus, String> {
    fleet.set_pin(id)?;
    Ok(fleet.status())
}

#[tauri::command]
pub fn fleet_set_can_be_main(fleet: State<'_, Arc<Fleet>>, id: String, can: bool) -> FleetStatus {
    fleet.set_can_be_main(&id, can);
    fleet.status()
}

/// Wake a machine (F4.1): who sent the packet, or why none went.
#[tauri::command]
pub async fn fleet_wake(fleet: State<'_, Arc<Fleet>>, id: String) -> Result<String, String> {
    let fleet = fleet.inner().clone();
    fleet.wake(&id).await
}

#[tauri::command]
pub fn fleet_set_wakeable(fleet: State<'_, Arc<Fleet>>, id: String, on: bool) -> FleetStatus {
    fleet.set_wakeable(&id, on);
    fleet.status()
}

#[tauri::command]
pub fn fleet_remove(fleet: State<'_, Arc<Fleet>>, id: String) -> FleetStatus {
    fleet.remove(&id);
    fleet.status()
}

#[tauri::command]
pub fn fleet_reset_identity(fleet: State<'_, Arc<Fleet>>) -> FleetStatus {
    fleet.reset_identity();
    fleet.status()
}

#[tauri::command]
pub fn fleet_clear_log(fleet: State<'_, Arc<Fleet>>) -> FleetStatus {
    fleet.inner.lock().unwrap().log.clear();
    (fleet.notify)();
    fleet.status()
}

#[cfg(test)]
mod tests;
