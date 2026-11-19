//! The pure parts of the fleet (fleet plan F1.1): member records and how gossip merges
//! them, the link's frames and the statements its handshake signs, the join string,
//! and reading Tailscale's answers about who owns a peer. No I/O and no clock reads,
//! so every rule here is unit-tested.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::remote::auth;

/// The link protocol's version, said in `hello`.
pub const LINK_VERSION: u32 = 1;

/// What every handshake signature starts with, so a fleet signature can't be replayed
/// as anything else (a phone's session proof has its own prefix).
pub const LINK_CONTEXT: &str = "workbench-fleet-link-v1";

/// One machine in the fleet, as every member holds it and gossips it. A member is the
/// authority on its own record (name, address); anyone may write a tombstone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub name: String,
    /// Its instance key's public half: base64url SEC1, P-256 (the device keys' format).
    pub public_key: String,
    /// Its tailnet address and fleet port.
    pub ip: String,
    pub port: u16,
    /// Its MagicDNS name, when Tailscale said.
    pub host: Option<String>,
    /// What sort of machine it is: `desktop`, `laptop` or `server` (F1.2). It places the
    /// machine in the default priority order. Its own to say, like the name.
    #[serde(default)]
    pub kind: String,
    /// Its public (Funnel) address, `https://….ts.net`, while it has one (F2.1): where
    /// the phone can open it.
    #[serde(default)]
    pub public_url: Option<String>,
    /// Milliseconds since the epoch of this version of the record: the newer wins.
    pub updated_at: u64,
    /// Removed from the fleet (a tombstone, kept so gossip can't bring it back).
    pub removed: bool,
}

/// What merging a gossiped member list did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Merged {
    /// Records added or replaced.
    pub changed: Vec<String>,
    /// Someone removed this machine from the fleet.
    pub removed_me: bool,
}

/// Merge `incoming` into `local`: per id, the newer `updated_at` wins. This machine's
/// own record only ever changes here into a tombstone (it is removed); anything else
/// about it is its own to say.
pub fn merge(local: &mut Vec<Member>, incoming: &[Member], me: &str) -> Merged {
    let mut out = Merged::default();
    for m in incoming {
        if auth::parse_public_key(&m.public_key).is_none() || m.id.is_empty() {
            continue;
        }
        let pos = local.iter().position(|l| l.id == m.id);
        let newer = pos.is_none_or(|i| m.updated_at > local[i].updated_at);
        if !newer {
            continue;
        }
        if m.id == me {
            if m.removed {
                out.removed_me = true;
            }
            continue;
        }
        match pos {
            Some(i) => local[i] = m.clone(),
            None => local.push(m.clone()),
        }
        out.changed.push(m.id.clone());
    }
    out
}

/// The kinds a machine can be, in the default priority order (settled decision 3: the
/// laptop last, since the server can be main once it has proved itself).
pub const KINDS: [&str; 3] = ["desktop", "server", "laptop"];

pub fn valid_kind(kind: &str) -> bool {
    KINDS.contains(&kind)
}

fn kind_rank(kind: &str) -> usize {
    KINDS.iter().position(|k| *k == kind).unwrap_or(KINDS.len())
}

/// The fleet's shared settings (F1.2): who may be main and in what order. One record
/// for the whole fleet, gossiped; the newer `(updated_at, by)` wins whole, so two
/// machines edited apart settle on the later edit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetConfig {
    /// Member ids in priority order, as set by hand. Empty: the default order (by kind).
    /// Members missing from it come after it, in the default order.
    pub order: Vec<String>,
    /// "The main is this machine until I say otherwise." Until the election (F6) it's
    /// the only way there is a main.
    pub pin: Option<String>,
    /// Members that may never be main ("can be main" off).
    pub not_main: Vec<String>,
    /// Milliseconds since the epoch of this version; 0 for the never-edited default.
    pub updated_at: u64,
    /// Who made this version (breaks a tie in `updated_at`).
    pub by: String,
}

impl FleetConfig {
    /// Whether `other` should replace this one.
    pub fn older_than(&self, other: &FleetConfig) -> bool {
        (other.updated_at, &other.by) > (self.updated_at, &self.by)
    }

    pub fn can_be_main(&self, id: &str) -> bool {
        !self.not_main.iter().any(|x| x == id)
    }
}

/// The live members' ids in priority order: the hand-set order first, then the rest
/// by kind (desktop, server, laptop, unknown), then name.
pub fn ranked(members: &[Member], cfg: &FleetConfig) -> Vec<String> {
    let live: Vec<&Member> = members.iter().filter(|m| !m.removed).collect();
    let mut out: Vec<String> = Vec::new();
    for id in &cfg.order {
        if live.iter().any(|m| &m.id == id) && !out.contains(id) {
            out.push(id.clone());
        }
    }
    let mut rest: Vec<&Member> = live.into_iter().filter(|m| !out.contains(&m.id)).collect();
    rest.sort_by(|a, b| {
        (kind_rank(&a.kind), a.name.to_lowercase(), &a.id).cmp(&(kind_rank(&b.kind), b.name.to_lowercase(), &b.id))
    });
    out.extend(rest.into_iter().map(|m| m.id.clone()));
    out
}

/// The main while it's set by hand (F1.2): the pin, if it names a live member.
pub fn main_by_hand(members: &[Member], cfg: &FleetConfig) -> Option<String> {
    let pin = cfg.pin.as_ref()?;
    members.iter().any(|m| &m.id == pin && !m.removed).then(|| pin.clone())
}

/// Who the list would make main: the first live member that can be main and is up.
/// Shown in the menu until the election (F6) acts on it.
pub fn first_choice(members: &[Member], cfg: &FleetConfig, up: impl Fn(&str) -> bool) -> Option<String> {
    ranked(members, cfg).into_iter().find(|id| cfg.can_be_main(id) && up(id))
}

/// A paired phone (or other device) as the fleet shares it (F2.1): paired on one
/// machine, it's paired on all, and a revoke anywhere is a revoke everywhere. Each
/// machine checks the device's token and key proof itself; sessions stay per machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    /// Its device token. Empty in a tombstone.
    pub token: String,
    pub name: String,
    pub paired_at: u64,
    pub approved: bool,
    pub public_key: Option<String>,
    /// Epoch seconds it was last used on any machine. Outside the version: the larger
    /// wins, so every machine counts the 30 days unused from the same day.
    pub last_seen: Option<u64>,
    /// Milliseconds since the epoch of this version (pairing, approval, revoke).
    pub updated_at: u64,
    /// Revoked, denied or expired: a tombstone, so gossip can't bring it back.
    pub removed: bool,
}

impl PairedDevice {
    pub fn tombstone(id: &str, updated_at: u64) -> PairedDevice {
        PairedDevice {
            id: id.to_string(),
            token: String::new(),
            name: String::new(),
            paired_at: 0,
            approved: false,
            public_key: None,
            last_seen: None,
            updated_at,
            removed: true,
        }
    }
}

/// What `incoming` changes in `local`: the records to put in place (new ones, newer
/// versions, a later `last_seen`). A tombstone carries nothing else.
pub fn merge_devices(local: &[PairedDevice], incoming: &[PairedDevice]) -> Vec<PairedDevice> {
    let mut out: Vec<PairedDevice> = Vec::new();
    for m in incoming {
        if m.id.is_empty() || (!m.removed && m.token.is_empty()) {
            continue;
        }
        let m = if m.removed { PairedDevice::tombstone(&m.id, m.updated_at) } else { m.clone() };
        // A second record of the same id in one batch: against what it already made.
        let current = out.iter().find(|d| d.id == m.id).or_else(|| local.iter().find(|d| d.id == m.id));
        let next = match current {
            None => Some(m),
            Some(l) if m.updated_at > l.updated_at => {
                let last_seen = if m.removed { None } else { l.last_seen.max(m.last_seen) };
                Some(PairedDevice { last_seen, ..m })
            }
            Some(l) if !l.removed && m.last_seen > l.last_seen => {
                Some(PairedDevice { last_seen: m.last_seen, ..l.clone() })
            }
            Some(_) => None,
        };
        if let Some(next) = next {
            out.retain(|d| d.id != next.id);
            out.push(next);
        }
    }
    out
}

/// What a beat says about the machine sending it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    pub name: String,
    /// The app's version.
    pub version: String,
    /// `windows`, `linux`, `macos`.
    pub os: String,
    /// `release` or `debug`.
    pub build: String,
    /// What it can do (grows with F3: `steam`, `gpu`, `voice-models`, …).
    pub caps: Vec<String>,
    /// The port its remote server listens on at its tailnet address, while it does
    /// (F2.2: where the others relay the phone's requests).
    #[serde(default)]
    pub remote_port: Option<u16>,
}

/// A question one machine asks another over the link (F2.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "camelCase")]
pub enum Ask {
    /// A session on your remote server for this paired device, so I can relay its
    /// requests to you. It must be approved there.
    RelaySession { device: String },
}

/// One message on the peer link, as JSON text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Frame {
    /// The first frame each way: who I am, and what you are to sign.
    Hello { id: String, nonce: String, v: u32 },
    /// The other side's nonce, signed (see [`link_statement`]).
    Proof { sig: String },
    /// The members I know, my own record included.
    Members { list: Vec<Member> },
    Beat { beat: Beat },
    /// The fleet's settings, on connect and on every change.
    Config { config: FleetConfig },
    /// The paired devices, tombstones included, on connect and on every change.
    Devices { list: Vec<PairedDevice> },
    /// Closing on purpose, and why (shown in the menu's log on the other side).
    Bye { reason: String },
    /// A question, answered by an `answer` with the same `req`.
    Ask { req: u64, ask: Ask },
    Answer { req: u64, ok: Option<String>, err: Option<String> },
}

impl Frame {
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("frames serialize")
    }
    pub fn parse(text: &str) -> Option<Frame> {
        serde_json::from_str(text).ok()
    }
}

/// What `signer` signs to prove it holds its key to `verifier`, over the nonce
/// `verifier` sent. Both ids are in it, so a proof made for one peer is worth nothing
/// to another.
pub fn link_statement(nonce: &str, signer: &str, verifier: &str) -> String {
    format!("{LINK_CONTEXT}|{nonce}|{signer}|{verifier}")
}

/// `message` signed: base64url of the 64-byte `r‖s`, like the phone's proofs.
pub fn sign(key: &SigningKey, message: &str) -> String {
    let sig: Signature = key.sign(message.as_bytes());
    B64.encode(sig.to_bytes())
}

pub fn verify(public_key: &str, message: &str, signature: &str) -> bool {
    let Some(key) = auth::parse_public_key(public_key) else { return false };
    let Ok(bytes) = B64.decode(signature.trim()) else { return false };
    let Ok(sig) = Signature::from_slice(&bytes) else { return false };
    key.verify(message.as_bytes(), &sig).is_ok()
}

pub fn public_key_b64(key: &SigningKey) -> String {
    B64.encode(key.verifying_key().to_encoded_point(false).as_bytes())
}

pub fn secret_b64(key: &SigningKey) -> String {
    B64.encode(key.to_bytes())
}

pub fn key_from_secret(b64: &str) -> Option<SigningKey> {
    let bytes = B64.decode(b64.trim()).ok()?;
    SigningKey::from_slice(&bytes).ok()
}

/// Which of two links to the same peer to keep, so both ends settle on the same one:
/// a reconnect in the same direction replaces the old link; otherwise the one dialed
/// by the smaller id wins.
pub fn keep_new_link(me: &str, peer: &str, old_dialer: &str, new_dialer: &str) -> bool {
    if old_dialer == new_dialer {
        return true;
    }
    new_dialer == me.min(peer)
}

/// Where to join and with what: `CODE@address:port`, as the menu shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinTarget {
    pub code: String,
    pub host: String,
    pub port: u16,
}

pub fn join_string(code: &str, host: &str, port: u16) -> String {
    format!("{code}@{host}:{port}")
}

/// Read a join string. Forgiving about spaces and case in the code, like the phone's
/// pairing; the port is required.
pub fn parse_join(input: &str) -> Option<JoinTarget> {
    let (code, addr) = input.trim().split_once('@')?;
    let (host, port) = addr.trim().rsplit_once(':')?;
    let code = auth::normalize_code(code);
    let host = host.trim().trim_end_matches('.').to_string();
    let port: u16 = port.trim().parse().ok()?;
    let host_ok = !host.is_empty()
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    (host_ok && !code.is_empty() && port != 0).then_some(JoinTarget { code, host, port })
}

/// The tailnet user that owns this machine, from `tailscale status --json`.
pub fn own_user(status: &Value) -> Option<i64> {
    status["Self"]["UserID"].as_i64()
}

/// The tailnet user that owns the node `tailscale whois --json <ip>` describes. A
/// tagged node is owned by its tags, not a user, so it has none.
pub fn whois_user(whois: &Value) -> Option<i64> {
    let tagged = whois["Node"]["Tags"].as_array().is_some_and(|t| !t.is_empty());
    if tagged {
        return None;
    }
    whois["UserProfile"]["ID"].as_i64().or_else(|| whois["Node"]["User"].as_i64())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;
    use serde_json::json;

    fn member(id: &str, at: u64) -> Member {
        let key = SigningKey::random(&mut OsRng);
        Member {
            id: id.into(),
            name: id.into(),
            public_key: public_key_b64(&key),
            ip: "100.64.0.1".into(),
            port: 48955,
            host: None,
            kind: String::new(),
            public_url: None,
            updated_at: at,
            removed: false,
        }
    }

    fn device(id: &str, at: u64, seen: Option<u64>) -> PairedDevice {
        PairedDevice {
            id: id.into(),
            token: format!("tok-{id}"),
            name: "phone".into(),
            paired_at: 1,
            approved: false,
            public_key: None,
            last_seen: seen,
            updated_at: at,
            removed: false,
        }
    }

    #[test]
    fn devices_merge_by_version_and_last_use() {
        let local = vec![device("a", 10, Some(100)), device("b", 10, None)];
        // a: approved elsewhere (newer), but used here more recently.
        let a2 = PairedDevice { approved: true, ..device("a", 20, Some(50)) };
        // b: an older version used later elsewhere: only its last use moves.
        let b_old = device("b", 5, Some(70));
        let out = merge_devices(&local, &[a2, b_old, device("c", 1, None)]);
        let get = |id: &str| out.iter().find(|d| d.id == id).unwrap();
        assert!(get("a").approved);
        assert_eq!(get("a").last_seen, Some(100));
        assert_eq!(get("b").updated_at, 10);
        assert_eq!(get("b").last_seen, Some(70));
        assert_eq!(get("c").token, "tok-c");
        // Nothing new: nothing to do.
        assert!(merge_devices(&out, &out.clone()).is_empty());
    }

    #[test]
    fn a_revoke_wins_and_stays() {
        let local = vec![device("a", 10, Some(100))];
        let gone = PairedDevice { token: "leaked".into(), ..PairedDevice::tombstone("a", 20) };
        let out = merge_devices(&local, &[gone]);
        assert_eq!(out.len(), 1);
        assert!(out[0].removed);
        assert!(out[0].token.is_empty(), "a tombstone carries no token");
        // The old record, gossiped by someone who hasn't heard, changes nothing,
        // not even its last use.
        assert!(merge_devices(&out, &[device("a", 10, Some(500))]).is_empty());
        // A record with no token is no record.
        let blank = PairedDevice { token: String::new(), ..device("x", 1, None) };
        assert!(merge_devices(&[], &[blank]).is_empty());
    }

    fn kinded(id: &str, kind: &str) -> Member {
        Member { kind: kind.into(), ..member(id, 1) }
    }

    #[test]
    fn the_default_order_goes_by_kind() {
        let ms = vec![kinded("l", "laptop"), kinded("s", "server"), kinded("d", "desktop"), kinded("x", "")];
        let cfg = FleetConfig::default();
        assert_eq!(ranked(&ms, &cfg), vec!["d", "s", "l", "x"]);
        // Two desktops: by name.
        let ms2 = vec![kinded("b", "desktop"), kinded("a", "desktop")];
        assert_eq!(ranked(&ms2, &cfg), vec!["a", "b"]);
    }

    #[test]
    fn a_hand_set_order_comes_first_and_skips_the_gone() {
        let mut ms = vec![kinded("l", "laptop"), kinded("s", "server"), kinded("d", "desktop")];
        let cfg = FleetConfig { order: vec!["s".into(), "gone".into(), "l".into()], ..Default::default() };
        // The desktop isn't in the order: it comes after, by kind.
        assert_eq!(ranked(&ms, &cfg), vec!["s", "l", "d"]);
        ms[1].removed = true;
        assert_eq!(ranked(&ms, &cfg), vec!["l", "d"]);
    }

    #[test]
    fn the_main_is_the_pin_and_the_list_names_a_first_choice() {
        let ms = vec![kinded("l", "laptop"), kinded("s", "server"), kinded("d", "desktop")];
        let mut cfg = FleetConfig::default();
        assert_eq!(main_by_hand(&ms, &cfg), None);
        cfg.pin = Some("l".into());
        assert_eq!(main_by_hand(&ms, &cfg), Some("l".into()));
        cfg.pin = Some("gone".into());
        assert_eq!(main_by_hand(&ms, &cfg), None);

        // The desktop is off: the server.
        assert_eq!(first_choice(&ms, &cfg, |id| id != "d"), Some("s".into()));
        // The server can't be main: the laptop.
        cfg.not_main = vec!["s".into()];
        assert_eq!(first_choice(&ms, &cfg, |id| id != "d"), Some("l".into()));
        assert_eq!(first_choice(&ms, &cfg, |_| false), None);
    }

    #[test]
    fn the_later_config_wins_and_ties_break_by_author() {
        let a = FleetConfig { updated_at: 10, by: "a".into(), ..Default::default() };
        let b = FleetConfig { updated_at: 10, by: "b".into(), ..Default::default() };
        let c = FleetConfig { updated_at: 11, by: "a".into(), ..Default::default() };
        assert!(a.older_than(&b));
        assert!(!b.older_than(&a));
        assert!(b.older_than(&c));
        assert!(!a.older_than(&a.clone()));
        assert!(FleetConfig::default().older_than(&a));
    }

    #[test]
    fn a_record_from_before_kinds_still_reads() {
        let mut v = serde_json::to_value(member("a", 1)).unwrap();
        v.as_object_mut().unwrap().remove("kind");
        let m: Member = serde_json::from_value(v).unwrap();
        assert_eq!(m.kind, "");
    }

    #[test]
    fn the_newer_record_wins() {
        let mut local = vec![member("a", 10), member("b", 10)];
        let mut b2 = member("b", 20);
        b2.name = "laptop".into();
        let old_a = member("a", 5);
        let out = merge(&mut local, &[b2, old_a, member("c", 1)], "a");
        assert_eq!(out.changed, vec!["b", "c"]);
        assert!(!out.removed_me);
        assert_eq!(local.iter().find(|m| m.id == "b").unwrap().name, "laptop");
        assert_eq!(local.len(), 3);
    }

    #[test]
    fn my_own_record_is_mine_unless_i_am_removed() {
        let mut local = vec![member("me", 10)];
        let mut renamed = member("me", 20);
        renamed.name = "someone else's idea".into();
        let out = merge(&mut local, &[renamed], "me");
        assert!(out.changed.is_empty());
        assert_eq!(local[0].name, "me");

        let mut gone = member("me", 30);
        gone.removed = true;
        assert!(merge(&mut local, &[gone], "me").removed_me);
        // An old tombstone of me (from before I rejoined) means nothing.
        let mut local = vec![member("me", 50)];
        let mut stale = member("me", 30);
        stale.removed = true;
        assert!(!merge(&mut local, &[stale], "me").removed_me);
    }

    #[test]
    fn a_tombstone_outlives_older_gossip() {
        let mut local = vec![member("me", 1), member("b", 10)];
        let mut dead = member("b", 20);
        dead.removed = true;
        merge(&mut local, &[dead], "me");
        // Someone who hasn't heard yet gossips the live record: it stays removed.
        merge(&mut local, &[member("b", 10)], "me");
        assert!(local.iter().find(|m| m.id == "b").unwrap().removed);
    }

    #[test]
    fn records_without_a_key_are_ignored() {
        let mut local = vec![];
        let mut bad = member("x", 1);
        bad.public_key = "nope".into();
        assert!(merge(&mut local, &[bad], "me").changed.is_empty());
        assert!(local.is_empty());
    }

    #[test]
    fn a_proof_is_bound_to_both_ends() {
        let key = SigningKey::random(&mut OsRng);
        let public = public_key_b64(&key);
        let sig = sign(&key, &link_statement("n1", "a", "b"));
        assert!(verify(&public, &link_statement("n1", "a", "b"), &sig));
        assert!(!verify(&public, &link_statement("n1", "a", "c"), &sig));
        assert!(!verify(&public, &link_statement("n2", "a", "b"), &sig));
        assert!(!verify(&public, &link_statement("n1", "b", "a"), &sig));
        let other = public_key_b64(&SigningKey::random(&mut OsRng));
        assert!(!verify(&other, &link_statement("n1", "a", "b"), &sig));
        // The key survives being stored.
        let back = key_from_secret(&secret_b64(&key)).unwrap();
        assert_eq!(public_key_b64(&back), public);
    }

    #[test]
    fn both_ends_keep_the_same_link() {
        // a < b: the link a dialed wins at both ends, whichever came second.
        assert!(keep_new_link("a", "b", "b", "a"));
        assert!(!keep_new_link("a", "b", "a", "b"));
        assert!(keep_new_link("b", "a", "b", "a"));
        assert!(!keep_new_link("b", "a", "a", "b"));
        // A reconnect replaces the old link.
        assert!(keep_new_link("a", "b", "b", "b"));
    }

    #[test]
    fn join_strings() {
        let s = join_string("K7M2Q-X9RTA", "100.101.2.3", 48955);
        assert_eq!(s, "K7M2Q-X9RTA@100.101.2.3:48955");
        let t = parse_join(&format!("  {s} ")).unwrap();
        assert_eq!(t.host, "100.101.2.3");
        assert_eq!(t.port, 48955);
        assert_eq!(t.code, auth::normalize_code("K7M2Q-X9RTA"));
        let t = parse_join("k7m2q x9rta @ desktop.tail1234.ts.net.:49055").unwrap();
        assert_eq!(t.host, "desktop.tail1234.ts.net");
        assert_eq!(t.code, auth::normalize_code("K7M2QX9RTA"));
        assert!(parse_join("K7M2Q@host").is_none());
        assert!(parse_join("@host:1").is_none());
        assert!(parse_join("K7M2Q@ho st:1").is_none());
        assert!(parse_join("K7M2Q@host:0").is_none());
        assert!(parse_join("K7M2Q@http://host:1").is_none());
    }

    #[test]
    fn frames_round_trip() {
        let f = Frame::Hello { id: "a".into(), nonce: "n".into(), v: LINK_VERSION };
        let text = f.to_text();
        assert!(text.contains(r#""t":"hello""#));
        assert_eq!(Frame::parse(&text), Some(f));
        assert_eq!(Frame::parse(r#"{"t":"what"}"#), None);
    }

    #[test]
    fn reads_who_owns_a_node() {
        let status = json!({"Self": {"UserID": 4242, "DNSName": "laptop.t.ts.net."}});
        assert_eq!(own_user(&status), Some(4242));
        let whois = json!({"Node": {"User": 4242}, "UserProfile": {"ID": 4242, "LoginName": "me@x"}});
        assert_eq!(whois_user(&whois), Some(4242));
        let tagged = json!({"Node": {"User": 99, "Tags": ["tag:server"]}, "UserProfile": {"ID": 99}});
        assert_eq!(whois_user(&tagged), None);
        assert_eq!(whois_user(&json!({})), None);
    }
}
