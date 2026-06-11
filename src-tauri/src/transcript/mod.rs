//! Transcript tailing — context-window occupancy (step 3.1).
//!
//! A small file-tailing subsystem that reads each live session's transcript JSONL
//! (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`) and reports the size of
//! the agent's **current context window** — the same figure Claude Code's
//! `/context` shows. This is deliberately *separate* from the hook-driven status
//! engine (design §4.5): hook payloads carry no usage data, so tokens come from the
//! transcript instead.
//!
//! **What "context window" means here.** Each assistant turn's `usage` records the
//! prompt it ran against: `input_tokens` (new) + `cache_creation_input_tokens` +
//! `cache_read_input_tokens` = the full prompt size = how full the context is.
//! That's a property of the *latest* turn, **not a sum** over the session — a
//! cumulative sum balloons every turn (each re-reads the whole cached prefix) and
//! diverges wildly from `/context`. So we track the latest turn's figures and let
//! the UI show `input + cache_creation + cache_read`. After a `/compact` or
//! `/clear` the window shrinks, and this tracks that automatically.
//!
//! Two implementation notes from the real files:
//!
//! 1. **Latest turn, main thread only.** We overwrite with each `type:"assistant"`
//!    line's `usage`; the last one wins. Claude Code writes one line *per content
//!    block* of a turn, all repeating the same `usage`, so overwriting is
//!    idempotent within a turn. Subagent (`isSidechain`) turns run in their own
//!    context and are skipped — they must not stand in for the main window.
//! 2. **Incremental tail.** We track a byte offset per session and only parse the
//!    bytes appended since the last poll, buffering an incomplete trailing line —
//!    so a long session isn't re-parsed from the top every tick.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;
use crate::pty::PtyManager;

/// How often to re-scan live sessions' transcripts. Token figures change at most
/// once per assistant turn (seconds to minutes apart), so a couple of seconds is
/// plenty live without busy-reading.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The Tauri event carrying a per-instance token update to the frontend.
const USAGE_EVENT: &str = "usage-updated";

/// The latest assistant turn's token usage. The context window the UI shows is
/// `input + cache_creation + cache_read` (the prompt size); `output` is kept for
/// completeness but isn't part of the window figure.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
}

/// The payload emitted to the frontend: an instance id plus its (flattened) usage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageUpdate {
    instance_id: String,
    #[serde(flatten)]
    usage: Usage,
}

/// Per-session tailing state: where we've read to, an incomplete-line buffer, and
/// the latest turn's usage (the current context-window figures).
#[derive(Default)]
struct Tail {
    /// Resolved transcript path; `None` until the file exists (it appears a moment
    /// after spawn, once Claude writes its first line).
    path: Option<PathBuf>,
    /// Bytes consumed so far.
    offset: u64,
    /// Bytes of an incomplete trailing line, prepended to the next read.
    partial: Vec<u8>,
    /// The most recent main-thread assistant turn's usage.
    usage: Usage,
}

impl Tail {
    /// Read any newly-appended bytes and fold their complete lines into `usage`.
    /// Returns whether the figures changed. A file that shrank (rotated/truncated)
    /// restarts the accounting from the top.
    fn poll(&mut self) -> std::io::Result<bool> {
        let Some(path) = self.path.clone() else {
            return Ok(false);
        };
        let mut f = std::fs::File::open(&path)?;
        let len = f.metadata()?.len();
        if len < self.offset {
            self.offset = 0;
            self.partial.clear();
            self.usage = Usage::default();
        }
        if len == self.offset {
            return Ok(false);
        }
        f.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::with_capacity((len - self.offset) as usize);
        f.read_to_end(&mut buf)?;
        self.offset = len;

        let before = self.usage;
        self.feed(&buf);
        Ok(self.usage != before)
    }

    /// Fold a chunk of appended bytes into the accumulators, line by line. Any
    /// trailing bytes without a newline are an incomplete line and are held back
    /// for the next chunk.
    fn feed(&mut self, bytes: &[u8]) {
        self.partial.extend_from_slice(bytes);
        let buf = std::mem::take(&mut self.partial);
        let mut start = 0;
        for (i, &b) in buf.iter().enumerate() {
            if b == b'\n' {
                self.ingest_line(&buf[start..i]);
                start = i + 1;
            }
        }
        self.partial.extend_from_slice(&buf[start..]);
    }

    /// Parse one transcript line; if it's a main-thread assistant turn, replace the
    /// stored usage with its figures (the latest turn defines the current window —
    /// not a sum). Content-block lines of one turn carry identical `usage`, so the
    /// overwrite is idempotent within a turn and the file's last such line wins.
    fn ingest_line(&mut self, line: &[u8]) {
        let line = trim_ascii(line);
        if line.is_empty() {
            return;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            return; // not JSON (or a partial we shouldn't have) — skip, never error
        };
        if v.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        // Subagent turns run in their own context window; they must not stand in for
        // the main agent's current context.
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let Some(u) = v.get("message").and_then(|m| m.get("usage")) else {
            return;
        };
        self.usage = Usage {
            input_tokens: usage_field(u, "input_tokens"),
            output_tokens: usage_field(u, "output_tokens"),
            cache_creation_tokens: usage_field(u, "cache_creation_input_tokens"),
            cache_read_tokens: usage_field(u, "cache_read_input_tokens"),
        };
    }
}

/// Read one integer field out of a `usage` object, defaulting to 0 when absent.
fn usage_field(usage: &Value, name: &str) -> i64 {
    usage.get(name).and_then(Value::as_i64).unwrap_or(0)
}

/// Trim leading/trailing ASCII whitespace (notably a trailing `\r` on CRLF files).
fn trim_ascii(mut s: &[u8]) -> &[u8] {
    while let [first, rest @ ..] = s {
        if first.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    while let [rest @ .., last] = s {
        if last.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    s
}

/// Locate a session's transcript by globbing `<projects>/*/<session-id>.jsonl`.
/// The session id is a UUID unique across every project folder, so this sidesteps
/// having to reproduce Claude Code's cwd→folder encoding (which differs for
/// worktrees). `None` until the file exists.
fn resolve_transcript(projects_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let file_name = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(projects_dir).ok()?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let candidate = entry.path().join(&file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// `~/.claude/projects`, where Claude Code stores per-session transcripts.
fn claude_projects_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".claude").join("projects"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Start the transcript tailer on a background thread. Polls live sessions, tails
/// their transcripts, persists the token figures to the instance row, and emits a
/// `usage-updated` event for the live UI. A failure here only degrades the token
/// readout — it must never stop the app — so the caller logs and continues.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    if let Err(e) = std::thread::Builder::new()
        .name("transcript-tailer".into())
        .spawn(move || run(app))
    {
        eprintln!("[transcript] could not start tailer: {e}");
    }
}

fn run(app: AppHandle) {
    let Some(projects_dir) = claude_projects_dir() else {
        eprintln!("[transcript] no home dir found; token tailing disabled");
        return;
    };
    // Per-session tailing state, keyed by session id. A session that rotates
    // (`/clear`) or is killed drops out of the live set and is pruned, so its
    // successor starts a fresh tail (matching the cleared context's fresh count).
    let mut tails: HashMap<String, Tail> = HashMap::new();
    loop {
        std::thread::sleep(POLL_INTERVAL);

        let live = app.state::<PtyManager>().live_sessions();
        let live_sids: HashSet<&String> = live.iter().map(|(_, sid)| sid).collect();
        tails.retain(|sid, _| live_sids.contains(sid));

        for (instance_id, session_id) in &live {
            let tail = tails.entry(session_id.clone()).or_default();
            if tail.path.is_none() {
                tail.path = resolve_transcript(&projects_dir, session_id);
                if tail.path.is_none() {
                    continue; // transcript not written yet; retry next tick
                }
            }
            match tail.poll() {
                Ok(true) => {
                    persist(&app, instance_id, tail.usage);
                    let _ = app.emit(
                        USAGE_EVENT,
                        UsageUpdate {
                            instance_id: instance_id.clone(),
                            usage: tail.usage,
                        },
                    );
                }
                Ok(false) => {}
                Err(_) => {} // file vanished mid-session etc. — try again next tick
            }
        }
    }
}

/// Write the latest turn's token figures to the instance row so the window
/// survives restart and a registry reload (a targeted UPDATE, not a
/// read-modify-write, so it never clobbers a concurrently-changed column like
/// `status`).
fn persist(app: &AppHandle, instance_id: &str, usage: Usage) {
    let db = app.state::<Db>();
    let Ok(conn) = db.conn.lock() else {
        return;
    };
    let _ = crate::registry::set_instance_tokens(
        &conn,
        instance_id,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_creation_tokens,
        usage.cache_read_tokens,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The context window is the *latest* turn's prompt size, not a sum: a newer
    /// assistant turn replaces the previous figures (the real numbers from the
    /// llm-ttrpg session — window = 2 + 15171 + 33304 = 48477 ≈ /context's 48.5k).
    #[test]
    fn latest_turn_replaces_not_sums() {
        let mut t = Tail::default();
        t.ingest_line(br#"{"type":"assistant","message":{"id":"a","usage":{"input_tokens":1,"output_tokens":9,"cache_creation_input_tokens":2,"cache_read_input_tokens":3}}}"#);
        t.ingest_line(br#"{"type":"assistant","message":{"id":"b","usage":{"input_tokens":2,"output_tokens":1369,"cache_creation_input_tokens":15171,"cache_read_input_tokens":33304}}}"#);
        assert_eq!(t.usage.input_tokens, 2);
        assert_eq!(t.usage.cache_creation_tokens, 15171);
        assert_eq!(t.usage.cache_read_tokens, 33304);
        let window =
            t.usage.input_tokens + t.usage.cache_creation_tokens + t.usage.cache_read_tokens;
        assert_eq!(window, 48477);
    }

    /// Content-block lines of one turn repeat identical `usage`, so overwriting with
    /// each is idempotent. Subagent (sidechain) turns and noise never replace the
    /// main-thread window.
    #[test]
    fn repeats_idempotent_sidechain_and_noise_ignored() {
        let mut t = Tail::default();
        let line = br#"{"type":"assistant","message":{"id":"m","usage":{"input_tokens":100,"cache_read_input_tokens":50}}}"#;
        t.ingest_line(line);
        t.ingest_line(line); // same turn, second content block — no change
        t.ingest_line(br#"{"type":"assistant","isSidechain":true,"message":{"id":"sub","usage":{"input_tokens":7,"cache_read_input_tokens":7}}}"#);
        t.ingest_line(br#"{"type":"user","message":{"role":"user"}}"#);
        t.ingest_line(b"{ not json");
        assert_eq!(t.usage.input_tokens, 100);
        assert_eq!(t.usage.cache_read_tokens, 50);
    }

    /// `feed` reassembles a line split across two chunks at a non-newline boundary,
    /// and only counts it once the line is complete.
    #[test]
    fn feed_buffers_incomplete_trailing_line() {
        let mut t = Tail::default();
        t.feed(br#"{"type":"assistant","message":{"id":"x","usage":{"input"#);
        assert_eq!(t.usage.input_tokens, 0); // line not yet complete
        t.feed(b"_tokens\":42}}}\n");
        assert_eq!(t.usage.input_tokens, 42);
        // A second complete message on its own line replaces (it's the new latest).
        t.feed(br#"{"type":"assistant","message":{"id":"y","usage":{"output_tokens":7}}}"#);
        t.feed(b"\n");
        assert_eq!(t.usage.output_tokens, 7);
        assert_eq!(t.usage.input_tokens, 0); // y has no input — replaced, not summed
    }

    /// A trailing `\r` (CRLF) doesn't defeat JSON parsing.
    #[test]
    fn crlf_lines_parse() {
        let mut t = Tail::default();
        t.ingest_line(b"{\"type\":\"assistant\",\"message\":{\"id\":\"z\",\"usage\":{\"input_tokens\":9}}}\r");
        assert_eq!(t.usage.input_tokens, 9);
    }
}
