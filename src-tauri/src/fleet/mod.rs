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
//! - **The listener** runs only while there is someone to talk to: another member, or
//!   a live join code.
//!
//! The core ([`Fleet`]) takes its network facts ([`Net`]) and its database as values,
//! so the tests run several instances in one process over loopback.

mod link;
mod net;
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
use proto::{Ask, Beat, FleetConfig, Frame, Member, PairedDevice};

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
}

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
    /// The main: the pin, while the main is set by hand.
    pub main: Option<String>,
    /// Who the list would make main now (the election, F6, will act on it).
    pub first_choice: Option<String>,
    /// Where Duck runs: the main by hand, else the first choice.
    pub duck: Option<String>,
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
            }),
            owners: Mutex::new(HashMap::new()),
            asks: Mutex::new(HashMap::new()),
            next_ask: std::sync::atomic::AtomicU64::new(1),
            relay_sessions: Mutex::new(HashMap::new()),
            host_sink: Mutex::new(None),
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
            let (ip, host) = tokio::task::spawn_blocking(move || {
                let ip = me.net.tailnet_ip();
                let host = if want_host && ip.is_some() { me.net.dns_name() } else { None };
                (ip, host)
            })
            .await
            .unwrap_or((None, None));
            self.observe_addr(ip, host);
            self.ensure_listener().await;
            self.dial_due();
            self.write_seen();
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
            if inner.problem.is_some() {
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
        let main = proto::main_by_hand(&inner.members, cfg).or_else(|| proto::first_choice(&inner.members, cfg, up));
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
        drop(inner);
        (self.notify)();
        Some((id, rx))
    }

    fn unregister_link(&self, peer: &str, id: u64) {
        let gone = {
            let mut inner = self.inner.lock().unwrap();
            if inner.links.get(peer).is_some_and(|l| l.id == id) {
                inner.links.remove(peer);
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
        let changed = {
            let mut inner = self.inner.lock().unwrap();
            inner.seen.insert(peer.to_string(), now());
            inner.beats.insert(peer.to_string(), beat.clone()) != Some(beat)
        };
        if changed {
            (self.notify)();
        }
    }

    fn beat(&self) -> Beat {
        let inner = self.inner.lock().unwrap();
        Beat {
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
        let answer = tokio::time::timeout(ASK_TIMEOUT, rx).await;
        self.asks.lock().unwrap().remove(&req);
        match answer {
            Ok(Ok(a)) => a,
            Ok(Err(_)) => Err("the link closed before it answered".into()),
            Err(_) => Err("that machine didn’t answer in time".into()),
        }
    }

    /// A question from `peer` (the link's reader): the answer to send back.
    fn on_ask(&self, ask: Ask) -> Result<String, String> {
        match ask {
            Ask::RelaySession { device } => self.book.relay_session(&device),
        }
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
            main: proto::main_by_hand(&inner.members, cfg),
            first_choice: proto::first_choice(&inner.members, cfg, up),
            duck: proto::main_by_hand(&inner.members, cfg).or_else(|| proto::first_choice(&inner.members, cfg, up)),
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
    fleet.set_remote_port(crate::remote::tailnet_port(app));
    let host_app = app.clone();
    fleet.on_host(Box::new(move |from, text| {
        let _ = host_app.emit("fleet-host", serde_json::json!({ "from": from, "text": text }));
    }));
    app.manage(fleet.clone());
    tauri::async_runtime::spawn(fleet.run());
}

/// The app's fleet, once [`init`] has run.
pub fn get(app: &AppHandle) -> Option<Arc<Fleet>> {
    app.try_state::<Arc<Fleet>>().map(|f| f.inner().clone())
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
