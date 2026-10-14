//! The pure parts of remote auth (step R2): pairing codes and the gate that rate-limits
//! and locks out `/pair`, constant-time comparison, device expiry, the `Origin` check,
//! and the auth-failure log the Remote Access menu shows. No I/O and no clock reads —
//! callers pass `now` — so every rule here is unit-tested.

use std::collections::VecDeque;

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
}
