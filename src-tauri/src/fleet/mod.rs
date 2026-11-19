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
use proto::{Beat, Frame, Member};

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

/// The database the fleet keeps its state in: the app's (given by [`init`]), or a
/// test's own. A closure, so nothing the tests reach touches the Tauri runtime.
pub struct Storage(Box<StoreFn>);

type StoreFn = dyn Fn(&mut dyn FnMut(&Connection)) + Send + Sync;

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
    pub version: String,
    /// How often the keeper looks (binding, dialing).
    pub tick: Duration,
}

pub struct Fleet {
    cfg: Config,
    net: Box<dyn Net>,
    store: Storage,
    notify: Box<dyn Fn() + Send + Sync>,
    /// Wakes the keeper to act on a change now.
    wake: Notify,
    caps: Vec<String>,
    inner: Mutex<Inner>,
    owners: Mutex<HashMap<IpAddr, OwnerAnswer>>,
}

struct Inner {
    me: String,
    key: SigningKey,
    /// Every member, this machine and tombstones included.
    members: Vec<Member>,
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
}

#[derive(Serialize, Deserialize)]
struct JoinRequest {
    code: String,
    member: Member,
}

#[derive(Serialize, Deserialize)]
struct JoinResponse {
    members: Vec<Member>,
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
    pub fn new(cfg: Config, net: Box<dyn Net>, store: Storage, notify: Box<dyn Fn() + Send + Sync>) -> Arc<Fleet> {
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
        let caps = local_caps();
        let fleet = Arc::new(Fleet {
            net,
            store,
            notify,
            wake: Notify::new(),
            caps,
            inner: Mutex::new(Inner {
                me: me.clone(),
                key,
                members,
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
            }),
            owners: Mutex::new(HashMap::new()),
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
        let fresh = match inner.members.iter().find(|m| m.id == me) {
            Some(m) if !m.removed && m.public_key == public_key => None,
            Some(m) => Some(Member { removed: false, public_key, updated_at: now_ms(), ..m.clone() }),
            None => Some(Member {
                id: me.clone(),
                name: clean_name(&self.cfg.default_name),
                public_key,
                ip: String::new(),
                port: self.cfg.port,
                host: None,
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
        let list = {
            let mut inner = self.inner.lock().unwrap();
            inner.members.retain(|x| x.id != m.id);
            inner.members.push(m.clone());
            inner.backoff.remove(&m.id);
            inner.members.clone()
        };
        self.store.with(|c| store::save(c, &m)).ok();
        self.gossip(None);
        (self.notify)();
        self.wake.notify_one();
        Ok(JoinResponse { members: list })
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
        let name = Self::self_record(&self.inner.lock().unwrap()).name;
        Beat {
            name,
            version: self.cfg.version.clone(),
            os: std::env::consts::OS.into(),
            build: if cfg!(debug_assertions) { "debug" } else { "release" }.into(),
            caps: self.caps.clone(),
        }
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
        Box::new(move || {
            let _ = notify_app.emit("fleet-changed", ());
        }),
    );
    app.manage(fleet.clone());
    tauri::async_runtime::spawn(fleet.run());
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
