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
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

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

// --- session enumeration for the resume picker (step 4.x) -------------------
// Lists every Claude session whose working dir is a given directory, so the UI
// can offer them for `claude --resume`. This is read-only file inspection,
// separate from the live tailer above.

/// One resumable session, surfaced to the resume picker. Metadata is read from the
/// transcript JSONL: the id (its file stem), when it was last touched, and the first
/// human prompt as a recognizable label.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    /// The session UUID — what gets passed to `claude --resume`.
    pub session_id: String,
    /// File mtime (epoch seconds) — "last active", used for sort + relative time.
    pub modified_at: i64,
    /// First human prompt in the session, cleaned + truncated; empty if none found.
    pub first_prompt: String,
    /// The session's working directory (as recorded in the transcript).
    pub cwd: String,
}

/// Normalize a directory path for comparison — mirrors `pty::norm_dir` (unify
/// separators, drop a trailing slash, case-fold on Windows) so a session's recorded
/// `cwd` matches the instance's `working_dir` regardless of slash/case differences.
fn norm_dir(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// Reproduce Claude Code's cwd→folder encoding (every non-`[A-Za-z0-9_-]` char
/// becomes `-`), e.g. `C:\Users\me\repo` → `C--Users-me-repo`. Used only as a fast
/// path to the right `~/.claude/projects` subfolder; the per-file `cwd` check below
/// is the real authority, so an encoding quirk just falls back to a full scan.
fn encode_cwd_to_folder(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// Pull the first human prompt out of a transcript line, or `None` if this record
/// isn't a user text message. Handles both string content and the content-block
/// array form, taking the first `text` block.
fn user_text(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(arr) => arr.iter().find_map(|b| {
            (b.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| b.get("text").and_then(Value::as_str))
                .flatten()
                .map(str::to_string)
        }),
        _ => None,
    }
}

/// Collapse whitespace / strip control chars and truncate to a label length.
fn clean_prompt(raw: &str) -> String {
    let collapsed = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>();
    let trimmed = collapsed.split_whitespace().collect::<Vec<_>>().join(" ");
    trimmed.chars().take(160).collect()
}

/// True for the slash-command / tool-result wrapper prompts we'd rather skip past in
/// favor of a real human prompt (e.g. `<local-command-caveat>…`, `<command-name>…`).
fn is_wrapper_prompt(s: &str) -> bool {
    let t = s.trim_start();
    t.starts_with("<local-command") || t.starts_with("<command-") || t.starts_with("Caveat:")
}

/// Read one transcript file's summary if its recorded `cwd` matches `target` (already
/// normalized). Streams just far enough to learn the cwd and a good first prompt, so
/// a non-matching file is rejected after a few lines. Returns `None` for a mismatch,
/// unreadable file, or one with no `cwd` record.
fn read_session_summary(path: &Path, target_norm: &str) -> Option<SessionSummary> {
    let session_id = path.file_stem()?.to_str()?.to_string();
    let modified_at = path
        .metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;

    let reader = BufReader::new(File::open(path).ok()?);
    let mut cwd: Option<String> = None;
    // Prefer a real human prompt; fall back to the first wrapper line if that's all.
    let mut best_prompt: Option<String> = None;
    let mut fallback_prompt: Option<String> = None;

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                if norm_dir(c) != target_norm {
                    return None; // different directory — not this instance's session
                }
                cwd = Some(c.to_string());
            }
        }
        if best_prompt.is_none() {
            if let Some(text) = user_text(&v) {
                let cleaned = clean_prompt(&text);
                if !cleaned.is_empty() {
                    if is_wrapper_prompt(&cleaned) {
                        fallback_prompt.get_or_insert(cleaned);
                    } else {
                        best_prompt = Some(cleaned);
                    }
                }
            }
        }
        if cwd.is_some() && best_prompt.is_some() {
            break;
        }
    }

    Some(SessionSummary {
        session_id,
        modified_at,
        first_prompt: best_prompt.or(fallback_prompt).unwrap_or_default(),
        cwd: cwd?,
    })
}

/// List every Claude session whose working directory is `working_dir` — the original
/// session plus every `/clear` rotation child (they share the cwd) — newest first.
/// Backs the resume picker. Scans the encoded `~/.claude/projects` subfolder when it
/// exists, else falls back to every subfolder; either way each file's recorded `cwd`
/// is the real filter, so worktree/encoding quirks can't leak foreign sessions.
#[tauri::command]
pub fn list_project_sessions(working_dir: String) -> Result<Vec<SessionSummary>, String> {
    let projects_dir = claude_projects_dir().ok_or("no home directory found")?;
    let target_norm = norm_dir(&working_dir);

    // Fast path: the directory's own encoded folder. Fall back to scanning every
    // project folder if it's absent (e.g. an encoding edge case).
    let encoded = projects_dir.join(encode_cwd_to_folder(&working_dir));
    let folders: Vec<PathBuf> = if encoded.is_dir() {
        vec![encoded]
    } else {
        std::fs::read_dir(&projects_dir)
            .map_err(|e| format!("reading {}: {e}", projects_dir.display()))?
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect()
    };

    let mut out: Vec<SessionSummary> = Vec::new();
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(summary) = read_session_summary(&path, &target_norm) {
                out.push(summary);
            }
        }
    }
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(out)
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

    // --- resume-picker session enumeration -----------------------------------

    /// The cwd→folder encoding matches Claude Code's: every non-`[A-Za-z0-9_-]`
    /// char (drive colon, separators) becomes `-`.
    #[test]
    fn encodes_cwd_like_claude() {
        assert_eq!(
            encode_cwd_to_folder(r"C:\Users\mrsha\repos\workbench"),
            "C--Users-mrsha-repos-workbench"
        );
        // Unix-style path, and an existing underscore/hyphen are preserved.
        assert_eq!(encode_cwd_to_folder("/home/me/my_repo-x"), "-home-me-my_repo-x");
    }

    /// `cwd` comparison is slash- and (on Windows) case-insensitive, with a trailing
    /// slash ignored — so a session's recorded cwd matches the instance's dir.
    #[test]
    fn norm_dir_unifies_separators_and_trailing_slash() {
        assert_eq!(norm_dir("C:/a/b"), norm_dir(r"C:\a\b\"));
        if cfg!(windows) {
            assert_eq!(norm_dir(r"C:\A\B"), norm_dir(r"c:\a\b"));
        }
    }

    /// The first prompt is pulled from both the string and content-block forms, and
    /// wrapper/caveat prompts are recognized so a real human prompt can win.
    #[test]
    fn extracts_and_classifies_user_text() {
        let s: Value =
            serde_json::from_str(r#"{"message":{"content":"hello there"}}"#).unwrap();
        assert_eq!(user_text(&s).as_deref(), Some("hello there"));

        let blocks: Value = serde_json::from_str(
            r#"{"message":{"content":[{"type":"text","text":"do the thing"}]}}"#,
        )
        .unwrap();
        assert_eq!(user_text(&blocks).as_deref(), Some("do the thing"));

        // A tool-result-only user turn has no text block.
        let tool: Value = serde_json::from_str(
            r#"{"message":{"content":[{"type":"tool_result","content":"x"}]}}"#,
        )
        .unwrap();
        assert_eq!(user_text(&tool), None);

        assert!(is_wrapper_prompt("<local-command-caveat>foo"));
        assert!(is_wrapper_prompt("Caveat: blah"));
        assert!(!is_wrapper_prompt("continue working on phase 4"));
    }

    /// Control chars collapse to spaces and the label is length-capped.
    #[test]
    fn clean_prompt_collapses_and_truncates() {
        assert_eq!(clean_prompt("  a\tb\n c  "), "a b c");
        assert_eq!(clean_prompt(&"x".repeat(200)).chars().count(), 160);
    }

    /// A summary is read only when the file's recorded `cwd` matches the target; a
    /// different cwd is rejected, and the first non-wrapper prompt becomes the label.
    #[test]
    fn read_session_summary_filters_by_cwd_and_labels() {
        use std::io::Write;
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("wb-sessions-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();

        let target = "/proj/a";
        let match_path = dir.join("11111111-1111-1111-1111-111111111111.jsonl");
        let mut f = File::create(&match_path).unwrap();
        // mode line (no cwd), a wrapper user turn, then the real prompt.
        writeln!(f, r#"{{"type":"mode","mode":"normal"}}"#).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","cwd":"/proj/a","message":{{"content":"<local-command-caveat>x"}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"user","cwd":"/proj/a","message":{{"content":"build the picker"}}}}"#
        )
        .unwrap();
        drop(f);

        let got = read_session_summary(&match_path, &norm_dir(target)).unwrap();
        assert_eq!(got.session_id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(got.cwd, "/proj/a");
        assert_eq!(got.first_prompt, "build the picker");

        // A session in a different cwd is rejected.
        let other_path = dir.join("22222222-2222-2222-2222-222222222222.jsonl");
        std::fs::write(
            &other_path,
            r#"{"type":"user","cwd":"/proj/b","message":{"content":"nope"}}"#,
        )
        .unwrap();
        assert!(read_session_summary(&other_path, &norm_dir(target)).is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

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
