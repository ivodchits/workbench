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
    /// Closing on purpose, and why (shown in the menu's log on the other side).
    Bye { reason: String },
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
            updated_at: at,
            removed: false,
        }
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
