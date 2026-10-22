//! The pure parts of remote auth (step R2): pairing codes and the gate that rate-limits
//! and locks out `/pair`, constant-time comparison, device expiry, the `Origin` check,
//! and the auth-failure log the Remote Access menu shows. Step R3 adds the device key:
//! its proof, the challenges it signs and the sessions a proof buys. No I/O and no
//! clock reads — callers pass `now` — so every rule here is unit-tested.

use std::collections::VecDeque;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde::Serialize;

/// How long a freshly minted pairing code stays valid (seconds). A code is shown on
/// screen only while you're pairing a device.
pub const PAIRING_TTL_SECS: u64 = 600;

/// Wrong codes tried against one code before it is burned. A new code has to be
/// generated on the desktop after that.
pub const MAX_MISSES: u32 = 5;

/// `/pair` attempts accepted from anyone within [`RATE_WINDOW_SECS`]; more are refused
/// without being checked.
pub const RATE_MAX: usize = 10;
pub const RATE_WINDOW_SECS: u64 = 60;

/// A device that paired but was not approved on the desktop within this long is dropped.
pub const PENDING_TTL_SECS: u64 = PAIRING_TTL_SECS;

/// An approved device unused for this long is dropped and has to pair again.
pub const IDLE_EXPIRY_SECS: u64 = 30 * 24 * 3600;

/// The characters a pairing code is made of: digits and capitals without the ones that
/// read alike (0/O, 1/I/L) and U. 30 symbols.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";
/// Symbols in a code: 30^10 ≈ 2^49.
const CODE_LEN: usize = 10;

/// A fresh pairing code like `K7M2Q-X9RTA`, from the OS random source (via v4 UUIDs).
pub fn gen_pairing_code() -> String {
    let mut out = String::with_capacity(CODE_LEN + 1);
    // 240 = 8 × 30: rejecting bytes above it keeps every symbol equally likely.
    let limit = (256 / CODE_ALPHABET.len() * CODE_ALPHABET.len()) as u8;
    let mut picked = 0;
    while picked < CODE_LEN {
        let uuid = uuid::Uuid::new_v4();
        for (i, &b) in uuid.as_bytes().iter().enumerate() {
            // Bytes 6 and 8 carry the UUID version and variant bits.
            if i == 6 || i == 8 || b >= limit || picked == CODE_LEN {
                continue;
            }
            if picked == CODE_LEN / 2 {
                out.push('-');
            }
            out.push(CODE_ALPHABET[b as usize % CODE_ALPHABET.len()] as char);
            picked += 1;
        }
    }
    out
}

/// A typed code as compared: capitals, with dashes and spaces dropped.
pub fn normalize_code(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// Equality that takes as long for a near miss as for a far one, so a response time
/// says nothing about how much of a secret was right. Only the length can differ fast.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

/// What became of one `/pair` attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairOutcome {
    Paired,
    /// Wrong code; this many tries are left on it.
    Wrong {
        left: u32,
    },
    /// The code was burned by wrong tries; only a new one from the desktop helps.
    Locked,
    /// No code was generated, or it ran out.
    NoCode,
    /// Too many attempts lately; refused unchecked.
    Busy,
}

/// The single pairing code and the limits around it. A code exists only after the
/// desktop asks for one ([`PairGate::issue`]); it is used up by one success.
#[derive(Default)]
pub struct PairGate {
    /// The code as shown, as compared, and when it runs out.
    code: Option<(String, String, u64)>,
    misses: u32,
    locked: bool,
    recent: VecDeque<u64>,
}

impl PairGate {
    /// Put a new code in place of any other, with a clean slate of tries.
    pub fn issue(&mut self, code: String, now: u64) {
        self.code = Some((normalize_code(&code), code, now + PAIRING_TTL_SECS));
        self.misses = 0;
        self.locked = false;
    }

    /// Drop the code (the server stopped).
    pub fn clear(&mut self) {
        self.code = None;
        self.misses = 0;
        self.locked = false;
    }

    /// The live code as shown and its expiry, if there is one.
    pub fn live(&self, now: u64) -> Option<(&str, u64)> {
        match &self.code {
            Some((_, shown, exp)) if *exp > now => Some((shown.as_str(), *exp)),
            _ => None,
        }
    }

    /// Whether wrong tries burned the last code.
    pub fn locked(&self) -> bool {
        self.locked
    }

    /// Check one attempt. A success consumes the code.
    pub fn attempt(&mut self, input: &str, now: u64) -> PairOutcome {
        while self
            .recent
            .front()
            .is_some_and(|&t| t + RATE_WINDOW_SECS <= now)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= RATE_MAX {
            return PairOutcome::Busy;
        }
        self.recent.push_back(now);
        if self.locked {
            return PairOutcome::Locked;
        }
        let Some((code, _, exp)) = &self.code else {
            return PairOutcome::NoCode;
        };
        if *exp <= now {
            self.code = None;
            return PairOutcome::NoCode;
        }
        if ct_eq(normalize_code(input).as_bytes(), code.as_bytes()) {
            self.code = None;
            self.misses = 0;
            return PairOutcome::Paired;
        }
        self.misses += 1;
        if self.misses >= MAX_MISSES {
            self.code = None;
            self.locked = true;
            return PairOutcome::Locked;
        }
        PairOutcome::Wrong {
            left: MAX_MISSES - self.misses,
        }
    }
}

/// Why a known device's token no longer works, if it doesn't: not approved in time,
/// or unused too long.
pub fn device_expired(
    approved: bool,
    paired_at: u64,
    last_seen: Option<u64>,
    now: u64,
) -> Option<&'static str> {
    if !approved {
        return (paired_at + PENDING_TTL_SECS <= now).then_some("not approved in time");
    }
    let last = last_seen.unwrap_or(paired_at).max(paired_at);
    (last + IDLE_EXPIRY_SECS <= now).then_some("unused for 30 days")
}

/// Whether a WebSocket upgrade comes from this server's own page. Browsers always send
/// `Origin` on a WebSocket; a page on another site would name that site, so it can't
/// ride a device's cookie-less token through a phone's browser. No `Origin` means a
/// non-browser client, which has to present the token itself.
pub fn origin_ok(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some(host) = host else {
        return false;
    };
    let rest = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"));
    matches!(rest, Some(h) if h.eq_ignore_ascii_case(host))
}

// --- the device key (step R3) ----------------------------------------------------
//
// A phone that pairs over https makes a P-256 key pair in the browser (WebCrypto, the
// private half not extractable, kept in IndexedDB) and sends the public half with the
// pairing code. From then on its token alone opens nothing: once per visit it signs a
// fresh challenge and gets a session, a second token that lives only in the page's
// memory and here. A token copied out of the phone's storage is useless without the
// key, which can't be copied out at all.

/// What a device signs: this, then the challenge.
pub const PROOF_PREFIX: &str = "workbench-remote-session:";

/// How long a challenge can be answered.
pub const CHALLENGE_TTL_SECS: u64 = 60;
/// Challenges outstanding at once; a new one drops the oldest.
pub const CHALLENGES_MAX: usize = 32;

/// A session ends after this long unused, and after [`SESSION_MAX_SECS`] in any case.
pub const SESSION_IDLE_SECS: u64 = 4 * 3600;
pub const SESSION_MAX_SECS: u64 = 24 * 3600;
/// Sessions kept per device; a new one drops its oldest (a phone with tabs open).
pub const SESSIONS_PER_DEVICE: usize = 4;

/// 256 bits from the OS random source (two v4 UUIDs, hyphen-free).
pub fn random_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// A public key as the phone sends it (base64url of the 65-byte uncompressed point,
/// WebCrypto's `raw` export), or None if it isn't a P-256 point.
pub fn parse_public_key(b64: &str) -> Option<VerifyingKey> {
    let bytes = B64.decode(b64.trim()).ok()?;
    VerifyingKey::from_sec1_bytes(&bytes).ok()
}

/// Whether `signature` (base64url of WebCrypto's 64-byte `r‖s`) signs
/// [`PROOF_PREFIX`] + `challenge` under `public_key`.
pub fn proof_ok(public_key: &str, challenge: &str, signature: &str) -> bool {
    let Some(key) = parse_public_key(public_key) else {
        return false;
    };
    let Ok(bytes) = B64.decode(signature.trim()) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&bytes) else {
        return false;
    };
    key.verify(format!("{PROOF_PREFIX}{challenge}").as_bytes(), &sig).is_ok()
}

/// The challenges handed out and not yet answered. Each answers once.
#[derive(Default)]
pub struct Challenges {
    live: VecDeque<(String, u64)>,
}

impl Challenges {
    pub fn issue(&mut self, now: u64) -> String {
        self.live.retain(|(_, at)| at + CHALLENGE_TTL_SECS > now);
        while self.live.len() >= CHALLENGES_MAX {
            self.live.pop_front();
        }
        let nonce = random_token();
        self.live.push_back((nonce.clone(), now));
        nonce
    }

    /// Use up `nonce`: true if it was handed out and is still fresh.
    pub fn take(&mut self, nonce: &str, now: u64) -> bool {
        let Some(i) = self.live.iter().position(|(n, _)| ct_eq(n.as_bytes(), nonce.as_bytes())) else {
            return false;
        };
        let (_, at) = self.live.remove(i).expect("found above");
        at + CHALLENGE_TTL_SECS > now
    }
}

struct Session {
    token: String,
    device: String,
    started: u64,
    used: u64,
}

/// The sessions device keys have bought. In memory only: a restart of the desktop
/// asks every phone for a fresh proof.
#[derive(Default)]
pub struct Sessions {
    live: Vec<Session>,
}

impl Sessions {
    /// A new session for `device`.
    pub fn start(&mut self, device: &str, now: u64) -> String {
        self.expire(now);
        let mine: Vec<usize> = (0..self.live.len()).filter(|&i| self.live[i].device == device).collect();
        if mine.len() >= SESSIONS_PER_DEVICE {
            let oldest = mine.into_iter().min_by_key(|&i| self.live[i].used).expect("not empty");
            self.live.remove(oldest);
        }
        let token = random_token();
        self.live.push(Session { token: token.clone(), device: device.to_string(), started: now, used: now });
        token
    }

    /// The device behind session `token`, if it is live; using it keeps it so. Every
    /// session is compared in constant time.
    pub fn device(&mut self, token: &str, now: u64) -> Option<String> {
        self.expire(now);
        let mut hit = None;
        for (i, s) in self.live.iter().enumerate() {
            if ct_eq(s.token.as_bytes(), token.as_bytes()) {
                hit = Some(i);
            }
        }
        let s = &mut self.live[hit?];
        s.used = now;
        Some(s.device.clone())
    }

    /// End every session of `device` (revoked, removed).
    pub fn end_device(&mut self, device: &str) {
        self.live.retain(|s| s.device != device);
    }

    pub fn clear(&mut self) {
        self.live.clear();
    }

    fn expire(&mut self, now: u64) {
        self.live
            .retain(|s| s.used + SESSION_IDLE_SECS > now && s.started + SESSION_MAX_SECS > now);
    }
}

/// One kind of failure from one address, with how often it happened.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthFailure {
    /// Epoch seconds of the latest occurrence.
    pub at: u64,
    pub addr: String,
    pub what: String,
    pub count: u32,
}

/// Recent auth failures, newest first. A repeat of the same failure from the same
/// address (a revoked phone that keeps reconnecting) bumps one entry instead of
/// filling the list.
#[derive(Default)]
pub struct AuthLog {
    entries: VecDeque<AuthFailure>,
}

/// Entries kept.
pub const AUTH_LOG_KEEP: usize = 30;

impl AuthLog {
    pub fn record(&mut self, addr: &str, what: &str, now: u64) {
        let pos = self
            .entries
            .iter()
            .position(|e| e.addr == addr && e.what == what);
        let entry = match pos.and_then(|i| self.entries.remove(i)) {
            Some(mut e) => {
                e.count += 1;
                e.at = now;
                e
            }
            None => AuthFailure {
                at: now,
                addr: addr.to_string(),
                what: what.to_string(),
                count: 1,
            },
        };
        self.entries.push_front(entry);
        self.entries.truncate(AUTH_LOG_KEEP);
    }

    pub fn entries(&self) -> Vec<AuthFailure> {
        self.entries.iter().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_shape() {
        for _ in 0..50 {
            let c = gen_pairing_code();
            assert_eq!(c.len(), CODE_LEN + 1, "{c}");
            assert_eq!(c.as_bytes()[CODE_LEN / 2], b'-');
            assert!(c
                .bytes()
                .filter(|&b| b != b'-')
                .all(|b| CODE_ALPHABET.contains(&b)));
        }
        assert_ne!(gen_pairing_code(), gen_pairing_code());
    }

    #[test]
    fn typed_codes_are_forgiving() {
        assert_eq!(normalize_code(" k7m2q-x9rta "), "K7M2QX9RTA");
        assert_eq!(normalize_code("K7M2Q X9RTA"), "K7M2QX9RTA");
    }

    #[test]
    fn constant_time_equality() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(ct_eq(b"", b""));
    }

    fn gate(code: &str) -> PairGate {
        let mut g = PairGate::default();
        g.issue(code.to_string(), 1000);
        g
    }

    #[test]
    fn no_code_until_one_is_issued() {
        let mut g = PairGate::default();
        assert_eq!(g.attempt("K7M2Q-X9RTA", 1000), PairOutcome::NoCode);
    }

    #[test]
    fn a_code_pairs_once() {
        let mut g = gate("K7M2Q-X9RTA");
        assert_eq!(g.attempt("k7m2qx9rta", 1001), PairOutcome::Paired);
        assert_eq!(g.attempt("K7M2Q-X9RTA", 1002), PairOutcome::NoCode);
    }

    #[test]
    fn a_code_runs_out() {
        let mut g = gate("K7M2Q-X9RTA");
        assert_eq!(
            g.attempt("K7M2Q-X9RTA", 1000 + PAIRING_TTL_SECS),
            PairOutcome::NoCode
        );
    }

    #[test]
    fn wrong_codes_burn_the_code() {
        let mut g = gate("K7M2Q-X9RTA");
        for left in (1..MAX_MISSES).rev() {
            assert_eq!(g.attempt("AAAAA-AAAAA", 1001), PairOutcome::Wrong { left });
        }
        assert_eq!(g.attempt("AAAAA-AAAAA", 1001), PairOutcome::Locked);
        assert!(g.locked());
        // Even the right code is refused now.
        assert_eq!(g.attempt("K7M2Q-X9RTA", 1001), PairOutcome::Locked);
        // A new code from the desktop starts over.
        g.issue("BBBBB-BBBBB".into(), 1002);
        assert!(!g.locked());
        assert_eq!(g.attempt("BBBBB-BBBBB", 1003), PairOutcome::Paired);
    }

    #[test]
    fn a_flood_is_refused_unchecked() {
        let mut g = PairGate::default();
        for _ in 0..RATE_MAX {
            assert_eq!(g.attempt("x", 1000), PairOutcome::NoCode);
        }
        g.issue("K7M2Q-X9RTA".into(), 1000);
        // Even the right code waits for the window to pass.
        assert_eq!(g.attempt("K7M2Q-X9RTA", 1030), PairOutcome::Busy);
        assert_eq!(
            g.attempt("K7M2Q-X9RTA", 1000 + RATE_WINDOW_SECS),
            PairOutcome::Paired
        );
    }

    #[test]
    fn a_brute_force_loop_gets_nowhere() {
        let mut g = gate("K7M2Q-X9RTA");
        let mut paired = 0;
        let mut checked = 0;
        // An hour of trying as fast as possible.
        for t in 0..3600u64 {
            for n in 0..20 {
                match g.attempt(&format!("{t:05}{n:05}"), 1000 + t) {
                    PairOutcome::Paired => paired += 1,
                    PairOutcome::Wrong { .. } => checked += 1,
                    _ => {}
                }
            }
        }
        assert_eq!(paired, 0);
        assert_eq!(checked, MAX_MISSES - 1);
    }

    #[test]
    fn devices_expire() {
        let day = 24 * 3600;
        assert_eq!(device_expired(false, 0, None, PENDING_TTL_SECS - 1), None);
        assert!(device_expired(false, 0, None, PENDING_TTL_SECS).is_some());
        assert_eq!(device_expired(true, 0, Some(10 * day), 39 * day), None);
        assert!(device_expired(true, 0, Some(10 * day), 40 * day).is_some());
        assert!(device_expired(true, 0, None, 30 * day).is_some());
    }

    #[test]
    fn origin_must_be_this_server() {
        let host = Some("100.64.1.2:48990");
        assert!(origin_ok(Some("http://100.64.1.2:48990"), host));
        assert!(origin_ok(
            Some("https://box.tail1.ts.net"),
            Some("box.tail1.ts.net")
        ));
        assert!(origin_ok(None, host));
        assert!(!origin_ok(Some("https://evil.example"), host));
        assert!(!origin_ok(
            Some("http://100.64.1.2:48990.evil.example"),
            host
        ));
        assert!(!origin_ok(Some("null"), host));
        assert!(!origin_ok(Some("http://100.64.1.2:48990"), None));
    }

    #[test]
    fn repeats_fold_into_one_entry() {
        let mut log = AuthLog::default();
        log.record("a", "unknown device token", 1);
        log.record("b", "wrong pairing code", 2);
        log.record("a", "unknown device token", 3);
        let e = log.entries();
        assert_eq!(e.len(), 2);
        assert_eq!((e[0].addr.as_str(), e[0].count, e[0].at), ("a", 2, 3));
        for n in 0..AUTH_LOG_KEEP + 5 {
            log.record(&n.to_string(), "x", 4);
        }
        assert_eq!(log.entries().len(), AUTH_LOG_KEEP);
    }

    /// A key as the phone makes it, and its public half as the phone sends it.
    fn phone_key() -> (p256::ecdsa::SigningKey, String) {
        let key = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
        let public = B64.encode(key.verifying_key().to_encoded_point(false).as_bytes());
        (key, public)
    }

    fn sign(key: &p256::ecdsa::SigningKey, challenge: &str) -> String {
        use p256::ecdsa::signature::Signer;
        let sig: Signature = key.sign(format!("{PROOF_PREFIX}{challenge}").as_bytes());
        B64.encode(sig.to_bytes())
    }

    #[test]
    fn a_proof_is_the_challenge_signed_with_the_paired_key() {
        let (key, public) = phone_key();
        assert!(parse_public_key(&public).is_some());
        assert!(parse_public_key("not a key").is_none());
        assert!(parse_public_key(&B64.encode([4u8; 65])).is_none(), "not on the curve");
        assert!(proof_ok(&public, "abc", &sign(&key, "abc")));
        assert!(!proof_ok(&public, "abd", &sign(&key, "abc")), "another challenge");
        let (other, _) = phone_key();
        assert!(!proof_ok(&public, "abc", &sign(&other, "abc")), "another key");
        assert!(!proof_ok(&public, "abc", "AAAA"));
        assert!(!proof_ok("", "abc", &sign(&key, "abc")));
    }

    /// Made by WebCrypto (Node's, as the phone's browser does it: a `raw` public key
    /// and a 64-byte signature), so the two sides read each other.
    #[test]
    fn reads_what_webcrypto_makes() {
        let public = "BOKSDd84-Gul-XvILV1fRtkiWtxOnRwgaLqpEi4-aBrK_rdSCJA3W02a4VdxMeIyKCamPXDNjnEtUds-Yd_lw4c";
        let sig = "pfnQUJ1XbHQAXHDI4p-OLPw03Gg3VZASB__jQn13DZdnp1iRQGvoDesenQzppFk6g4GLMNIY6QO60TcBrx2HMA";
        assert!(proof_ok(public, "fixture-challenge", sig));
        assert!(!proof_ok(public, "fixture-challengf", sig));
    }

    #[test]
    fn a_challenge_answers_once_and_soon() {
        let mut c = Challenges::default();
        let a = c.issue(100);
        assert!(!c.take("made up", 100));
        assert!(c.take(&a, 100 + CHALLENGE_TTL_SECS - 1));
        assert!(!c.take(&a, 101), "used up");
        let b = c.issue(200);
        assert!(!c.take(&b, 200 + CHALLENGE_TTL_SECS), "too late");
        let first = c.issue(300);
        for _ in 0..CHALLENGES_MAX {
            c.issue(300);
        }
        assert!(!c.take(&first, 300), "a flood pushes the oldest out");
    }

    #[test]
    fn sessions_last_while_used_and_a_day_at_most() {
        let mut s = Sessions::default();
        let t = s.start("phone", 0);
        assert_eq!(s.device(&t, 10).as_deref(), Some("phone"));
        assert_eq!(s.device("other", 10), None);
        // Used every few hours, it lasts the day, and no longer.
        let mut at = 0;
        while at + SESSION_IDLE_SECS - 60 < SESSION_MAX_SECS {
            at += SESSION_IDLE_SECS - 60;
            assert!(s.device(&t, at).is_some(), "at {at}");
        }
        assert_eq!(s.device(&t, SESSION_MAX_SECS), None);
        // Unused, it ends.
        let u = s.start("phone", 0);
        assert_eq!(s.device(&u, SESSION_IDLE_SECS), None);
        // A device's oldest session goes when it has too many; revoking ends them all.
        let first = s.start("phone", 1);
        let rest: Vec<String> = (0..SESSIONS_PER_DEVICE).map(|i| s.start("phone", 2 + i as u64)).collect();
        let tablet = s.start("tablet", 9);
        assert_eq!(s.device(&first, 20), None);
        assert!(rest.iter().all(|t| s.device(t, 20).is_some()));
        s.end_device("phone");
        assert!(rest.iter().all(|t| s.device(t, 21).is_none()));
        assert_eq!(s.device(&tablet, 21).as_deref(), Some("tablet"));
    }
}
