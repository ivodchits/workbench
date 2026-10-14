//! Transcript stream — the lines themselves, paged and followed live (step T1).
//!
//! The usage tailer in the parent module reads one number out of each transcript.
//! This module hands the frontend the **lines**: a paged read for history, and a
//! per-instance follow that emits what Claude Code appends. Lines cross as raw JSON
//! text; folding them into a conversation happens once, in TypeScript (T2), so the
//! desktop view and the phone share one parser.
//!
//! Four decisions worth stating.
//!
//! **Offsets are byte offsets that sit on line boundaries.** Every offset this
//! module returns or emits is the start of a line, and we never read past the last
//! newline in the file — a half-written line is simply not there yet. That is what
//! lets a consumer stitch history and the live stream together without a gap or a
//! duplicate: `transcript_follow` returns the offset the live stream starts at, and
//! everything before it is fetched with `transcript_read_back`.
//!
//! **Only followed transcripts cost anything.** A follow exists while something
//! holds a reference (a transcript view, later a remote client) and goes away with
//! the last one. Nothing here runs for a console that is only shown as a terminal.
//!
//! **Which file is "the" transcript is decided in one place** ([`target`]): the
//! session id the PTY manager maps to the instance, and the `transcript_path` hook
//! events report for that session (falling back to finding `<session-id>.jsonl`
//! when no hook has spoken yet — a freshly resumed session). `/clear` mints a new
//! session id and a new file; the old id's `SessionEnd{reason:"clear"}` makes the
//! follow let go at once, and the first hook event of the new session points it at
//! the new file. `/compact` stays in the same file and needs nothing.
//!
//! **A rotation tells the consumer to start over.** `transcript-rotated` means
//! "the lines you hold belong to a transcript this instance has left". It carries
//! the new session id (or none, while a `/clear` is waiting for its first prompt)
//! and the offset the live stream continues from.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::{claude_projects_dir, norm_dir, resolve_transcript};
use crate::pty::PtyManager;

/// New complete lines of a followed transcript.
const APPENDED_EVENT: &str = "transcript-appended";
/// The instance moved to another transcript (or its file was truncated).
const ROTATED_EVENT: &str = "transcript-rotated";

/// The watcher is the fast path; this poll is the fallback for a filesystem that
/// doesn't report the write, and it is also what notices a session change that no
/// hook announced (the console was respawned on another session).
const POLL_FALLBACK: Duration = Duration::from_secs(2);

/// One write by Claude Code shows up as a few filesystem events; wait this long
/// after the first so they become one read.
const COALESCE: Duration = Duration::from_millis(25);

/// Upper bound on the lines of one `transcript-appended` event, and the default
/// page size of a read. A single line longer than this (an inline image, a big
/// file's `originalFile`) still goes out whole.
pub(crate) const CHUNK_BYTES: u64 = 256 * 1024;

/// Largest page a caller may ask for.
const MAX_PAGE_BYTES: u64 = 4 * 1024 * 1024;

/// A transcript this small is streamed from the top when the follow moves onto it;
/// anything bigger starts at its end and leaves history to paged reads.
const STREAM_FROM_TOP_BYTES: u64 = CHUNK_BYTES;

// --- reading ----------------------------------------------------------------

/// The offset just past the last newline in `f` — the end of the last *complete*
/// line. Claude Code appends whole lines, so this is almost always the file length;
/// the backward scan only runs when a write is caught mid-line.
fn aligned_end(f: &mut File) -> std::io::Result<u64> {
    let mut end = f.metadata()?.len();
    let mut buf = [0u8; 8192];
    while end > 0 {
        let start = end.saturating_sub(buf.len() as u64);
        let chunk = &mut buf[..(end - start) as usize];
        f.seek(SeekFrom::Start(start))?;
        f.read_exact(chunk)?;
        if let Some(i) = chunk.iter().rposition(|&b| b == b'\n') {
            return Ok(start + i as u64 + 1);
        }
        end = start;
    }
    Ok(0)
}

/// Read exactly `[start, end)` of `f`.
fn read_range(f: &mut File, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    let mut buf = vec![0u8; (end - start) as usize];
    f.seek(SeekFrom::Start(start))?;
    f.read_exact(&mut buf)?;
    Ok(buf)
}

/// Split a buffer of whole lines into strings, dropping the line endings and any
/// blank line. Bytes after the last newline are not a line yet and are ignored.
fn split_lines(buf: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, &b) in buf.iter().enumerate() {
        if b == b'\n' {
            let line = super::trim_ascii(&buf[start..i]);
            if !line.is_empty() {
                out.push(String::from_utf8_lossy(line).into_owned());
            }
            start = i + 1;
        }
    }
    out
}

/// A run of complete lines and the byte range they came from.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Lines {
    pub(crate) lines: Vec<String>,
    /// Offset of the first line.
    pub(crate) offset: u64,
    /// Offset just past the last line — where the next read continues.
    pub(crate) next_offset: u64,
    /// End of the last complete line in the file when it was read.
    pub(crate) end: u64,
}

/// Read complete lines forward from `from`, about `max` bytes of them. Always
/// returns at least one line when one exists, however long it is, so a caller
/// paging with a small `max` can't stall on a big line.
pub(crate) fn read_forward(path: &Path, from: u64, max: u64) -> std::io::Result<Lines> {
    let mut f = File::open(path)?;
    let end = aligned_end(&mut f)?;
    if from >= end {
        return Ok(Lines { lines: Vec::new(), offset: from, next_offset: from, end });
    }
    let mut stop = end.min(from + max.max(1));
    loop {
        let buf = read_range(&mut f, from, stop)?;
        if let Some(i) = buf.iter().rposition(|&b| b == b'\n') {
            let next_offset = from + i as u64 + 1;
            return Ok(Lines { lines: split_lines(&buf[..=i]), offset: from, next_offset, end });
        }
        // No newline in the window: the first line is longer than `max`. Widen until
        // it fits — `end` is a line boundary, so this terminates there at the latest.
        stop = end.min(from + (stop - from) * 2);
    }
}

/// Read complete lines backward: the last `max` bytes' worth of lines ending at
/// `before` (or at the end of the file). This is what "load earlier" pages through.
pub(crate) fn read_back(path: &Path, before: Option<u64>, max: u64) -> std::io::Result<Lines> {
    let mut f = File::open(path)?;
    let end = aligned_end(&mut f)?;
    let before = before.map_or(end, |b| b.min(end));
    let mut start = before.saturating_sub(max.max(1));
    loop {
        let buf = read_range(&mut f, start, before)?;
        if start == 0 {
            return Ok(Lines { lines: split_lines(&buf), offset: 0, next_offset: before, end });
        }
        // `start` is an arbitrary byte, so skip the partial line it landed in. The
        // newline we need is one that still leaves a line after it.
        match buf.iter().position(|&b| b == b'\n') {
            Some(i) if i + 1 < buf.len() => {
                let offset = start + i as u64 + 1;
                return Ok(Lines {
                    lines: split_lines(&buf[i + 1..]),
                    offset,
                    next_offset: before,
                    end,
                });
            }
            _ => start = before.saturating_sub((before - start) * 2),
        }
    }
}

// --- which transcript -------------------------------------------------------

/// What an instance's follow should be reading right now.
#[derive(Debug, Clone, PartialEq)]
enum Target {
    /// The instance has no live session (not spawned, or killed). Keep whatever is
    /// being followed: its transcript is still the right thing to show.
    Keep,
    /// `/clear` ended the old session and the new one hasn't reported in yet.
    Awaiting,
    /// A live session, and its transcript file once we know where it is.
    Session { session_id: String, path: Option<PathBuf> },
}

/// Where a follow is in its transcript.
#[derive(Debug, Default, Clone, PartialEq)]
struct Cursor {
    session_id: Option<String>,
    path: Option<PathBuf>,
    /// Everything before this has been emitted (or is left to paged reads).
    offset: u64,
}

/// Where the live stream starts in a transcript we're moving onto: the top when
/// the file is small enough to just send, else its end.
fn start_offset(path: &Path) -> u64 {
    match File::open(path).and_then(|mut f| aligned_end(&mut f)) {
        Ok(end) if end > STREAM_FROM_TOP_BYTES => end,
        _ => 0,
    }
}

impl Cursor {
    /// A cursor for a consumer attaching now: history is theirs to page, the live
    /// stream starts at the end of the file.
    fn attach(target: Target) -> Self {
        match target {
            Target::Session { session_id, path } => {
                let offset = path
                    .as_deref()
                    .and_then(|p| File::open(p).and_then(|mut f| aligned_end(&mut f)).ok())
                    .unwrap_or(0);
                Cursor { session_id: Some(session_id), path, offset }
            }
            Target::Keep | Target::Awaiting => Cursor::default(),
        }
    }

    /// Move to `target` if it names a different transcript. Returns whether the
    /// consumer must be told to start over.
    fn retarget(&mut self, target: Target) -> bool {
        match target {
            Target::Keep => false,
            Target::Awaiting => {
                let had = self.session_id.is_some();
                *self = Cursor::default();
                had
            }
            Target::Session { session_id, path } => {
                if self.session_id.as_deref() == Some(session_id.as_str()) {
                    // Same session; its file may only now have appeared. It is new,
                    // so it is read from the top and nobody needs to start over.
                    if self.path.is_none() {
                        self.path = path;
                    }
                    return false;
                }
                let offset = path.as_deref().map_or(0, start_offset);
                *self = Cursor { session_id: Some(session_id), path, offset };
                true
            }
        }
    }

    /// Read what was appended since the last call, in chunks. `Err` with
    /// `InvalidData` means the file shrank under us; the cursor has been reset to
    /// the top and the caller should announce it.
    fn drain(&mut self) -> std::io::Result<Vec<Lines>> {
        let Some(path) = self.path.clone() else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        loop {
            let chunk = read_forward(&path, self.offset, CHUNK_BYTES)?;
            if chunk.end < self.offset {
                self.offset = 0;
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            if chunk.next_offset == self.offset {
                return Ok(out);
            }
            self.offset = chunk.next_offset;
            out.push(chunk);
        }
    }
}

/// Accept a hook-reported `transcript_path` only if it is a `.jsonl` under Claude
/// Code's projects directory. The hook endpoint is a local HTTP port; without this
/// a forged event could point the stream at any file the user can read.
fn accept_hook_path(projects_dir: &Path, reported: &str) -> Option<PathBuf> {
    let path = PathBuf::from(reported);
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return None;
    }
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    let root = format!("{}/", norm_dir(&projects_dir.to_string_lossy()));
    norm_dir(reported).starts_with(&root).then_some(path)
}

// --- state ------------------------------------------------------------------

enum Msg {
    /// Something may have changed — look now instead of at the next poll.
    Wake,
    Stop,
}

struct Follow {
    /// How many consumers hold this follow. The thread goes away with the last.
    refs: usize,
    tx: Sender<Msg>,
    cursor: Arc<Mutex<Cursor>>,
}

#[derive(Default)]
struct Inner {
    /// `session_id → transcript_path`, as reported by that session's hook events.
    paths: HashMap<String, PathBuf>,
    /// Instances whose session just ended with `/clear`, so the rotation that
    /// follows can say why it happened.
    cleared: HashSet<String>,
    follows: HashMap<String, Follow>,
}

/// What a follow just did, for consumers outside the webview (the phone's transcript
/// socket, step R4). The webview gets the lines themselves as events; these only say
/// *that* something happened, and each consumer reads from its own cursor, so one
/// that falls behind or reconnects never misses or repeats a line.
#[derive(Debug, Clone)]
pub(crate) enum Note {
    /// New lines were appended to the instance's transcript.
    Appended { instance_id: String },
    /// The instance moved to another transcript, or its file was truncated.
    Rotated {
        instance_id: String,
        session_id: Option<String>,
        path: Option<PathBuf>,
        offset: u64,
        reason: &'static str,
    },
}

/// Tauri-managed state of the transcript stream.
pub struct Streams {
    inner: Mutex<Inner>,
    notes: tokio::sync::broadcast::Sender<Note>,
}

impl Default for Streams {
    fn default() -> Self {
        Streams { inner: Mutex::default(), notes: tokio::sync::broadcast::channel(256).0 }
    }
}

/// Decide what `instance_id` should be reading (see [`Target`]).
fn target(app: &AppHandle, instance_id: &str) -> Target {
    let pty = app.state::<PtyManager>();
    if pty.is_pending_rotation(instance_id) {
        return Target::Awaiting;
    }
    let Some(session_id) = pty.session_for_instance(instance_id) else {
        return Target::Keep;
    };
    let reported = app.state::<Streams>().inner.lock().unwrap().paths.get(&session_id).cloned();
    let path = reported
        .or_else(|| claude_projects_dir().and_then(|dir| resolve_transcript(&dir, &session_id)));
    Target::Session { session_id, path }
}

/// The hook server's hand-off: every accepted event passes through here. Records
/// the session's transcript path, notes a `/clear`, and wakes the instance's
/// follow so a rotation is acted on now rather than at the next poll.
pub fn on_hook(
    app: &AppHandle,
    instance_id: &str,
    session_id: &str,
    transcript_path: Option<&str>,
    cleared: bool,
) {
    let streams = app.state::<Streams>();
    let mut inner = streams.inner.lock().unwrap();
    if let Some(path) = transcript_path
        .and_then(|p| claude_projects_dir().and_then(|dir| accept_hook_path(&dir, p)))
    {
        if !inner.paths.contains_key(session_id) {
            // Sessions come and go; keep the map to the ones that are still live.
            if inner.paths.len() >= 64 {
                let pty = app.state::<PtyManager>();
                inner.paths.retain(|sid, _| pty.instance_for_session(sid).is_some());
            }
            inner.paths.insert(session_id.to_string(), path);
        }
    }
    if cleared {
        inner.cleared.insert(instance_id.to_string());
    }
    if let Some(follow) = inner.follows.get(instance_id) {
        let _ = follow.tx.send(Msg::Wake);
    }
}

// --- the follow thread ------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Appended<'a> {
    instance_id: &'a str,
    session_id: Option<&'a str>,
    lines: &'a [String],
    offset: u64,
    next_offset: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Rotated<'a> {
    instance_id: &'a str,
    /// The transcript the instance is on now; `None` while a `/clear` waits for
    /// its first prompt.
    session_id: Option<&'a str>,
    /// Where the live stream continues. Anything before it is history to page.
    offset: u64,
    /// `"clear"`, `"session"` (the console moved to another session) or
    /// `"truncated"` (the file shrank).
    reason: &'a str,
}

/// Watch the directory holding `path` and wake the follow when that file changes.
/// The directory rather than the file: on Windows that is what the backend watches
/// anyway, and it also works before the file exists.
fn watch(path: &Path, tx: Sender<Msg>) -> Option<RecommendedWatcher> {
    let dir = path.parent()?;
    let name = path.file_name()?.to_owned();
    let handler = move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if ev.paths.iter().any(|p| p.file_name() == Some(name.as_os_str())) {
            let _ = tx.send(Msg::Wake);
        }
    };
    let mut watcher = RecommendedWatcher::new(handler, Config::default()).ok()?;
    watcher.watch(dir, RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}

fn emit_lines(app: &AppHandle, instance_id: &str, session_id: Option<&str>, chunks: &[Lines]) {
    if !chunks.is_empty() {
        let _ = app
            .state::<Streams>()
            .notes
            .send(Note::Appended { instance_id: instance_id.to_string() });
    }
    for c in chunks {
        let _ = app.emit(
            APPENDED_EVENT,
            Appended {
                instance_id,
                session_id,
                lines: &c.lines,
                offset: c.offset,
                next_offset: c.next_offset,
            },
        );
    }
}

/// Announce that `instance_id` is now on `cur`'s transcript, from `cur.offset` on.
fn emit_rotated(app: &AppHandle, instance_id: &str, cur: &Cursor, reason: &'static str) {
    let _ = app.state::<Streams>().notes.send(Note::Rotated {
        instance_id: instance_id.to_string(),
        session_id: cur.session_id.clone(),
        path: cur.path.clone(),
        offset: cur.offset,
        reason,
    });
    let _ = app.emit(
        ROTATED_EVENT,
        Rotated {
            instance_id,
            session_id: cur.session_id.as_deref(),
            offset: cur.offset,
            reason,
        },
    );
}

fn run_follow(
    app: AppHandle,
    instance_id: String,
    cursor: Arc<Mutex<Cursor>>,
    tx: Sender<Msg>,
    rx: mpsc::Receiver<Msg>,
) {
    // The watcher, and the path it was armed for. Re-armed when the path changes,
    // and retried each tick while the directory doesn't exist yet.
    let mut watcher: Option<(PathBuf, RecommendedWatcher)> = None;
    loop {
        match rx.recv_timeout(POLL_FALLBACK) {
            Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(Msg::Wake) => {
                std::thread::sleep(COALESCE);
                loop {
                    match rx.try_recv() {
                        Ok(Msg::Stop) => return,
                        Ok(Msg::Wake) => {}
                        Err(_) => break,
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        let want = target(&app, &instance_id);
        let mut cur = cursor.lock().unwrap();

        let leaving = match &want {
            Target::Keep => false,
            Target::Awaiting => cur.session_id.is_some(),
            Target::Session { session_id, .. } => {
                cur.session_id.as_deref() != Some(session_id.as_str())
            }
        };
        if leaving {
            // Last lines of the transcript we're leaving, before the consumer is
            // told to drop it.
            if let Ok(chunks) = cur.drain() {
                emit_lines(&app, &instance_id, cur.session_id.as_deref(), &chunks);
            }
        }
        if cur.retarget(want) {
            let cleared = {
                let streams = app.state::<Streams>();
                let mut inner = streams.inner.lock().unwrap();
                // Keep the flag while the new session is still awaited, so the
                // rotation onto it is a "clear" too.
                if cur.session_id.is_some() {
                    inner.cleared.remove(&instance_id)
                } else {
                    inner.cleared.contains(&instance_id)
                }
            };
            emit_rotated(&app, &instance_id, &cur, if cleared { "clear" } else { "session" });
        }

        if watcher.as_ref().map(|(p, _)| p) != cur.path.as_ref() {
            watcher = cur
                .path
                .as_ref()
                .and_then(|p| watch(p, tx.clone()).map(|w| (p.clone(), w)));
        }

        match cur.drain() {
            Ok(chunks) => emit_lines(&app, &instance_id, cur.session_id.as_deref(), &chunks),
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                emit_rotated(&app, &instance_id, &cur, "truncated");
                if let Ok(chunks) = cur.drain() {
                    emit_lines(&app, &instance_id, cur.session_id.as_deref(), &chunks);
                }
            }
            Err(_) => {} // not written yet, or briefly unreadable — next tick
        }
    }
}

// --- commands ---------------------------------------------------------------

/// Where a follow stands: which transcript, and the offset the live stream
/// continues from. Everything before `offset` is history.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowInfo {
    session_id: Option<String>,
    offset: u64,
}

/// One page of transcript lines.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// The transcript the page came from; `None` when the instance has none.
    session_id: Option<String>,
    /// Raw JSONL lines, in file order.
    lines: Vec<String>,
    /// Offset of the first line.
    offset: u64,
    /// Offset just past the last line.
    next_offset: u64,
    /// End of the last complete line in the file. `next_offset == end` means the
    /// page reached it.
    end: u64,
}

/// Where a follow stands, with the file it reads — what the phone's socket needs to
/// keep a cursor of its own (step R4).
pub(crate) struct Position {
    pub(crate) session_id: Option<String>,
    pub(crate) path: Option<PathBuf>,
    pub(crate) offset: u64,
}

/// Take a reference on the instance's follow, starting it if nobody holds one. New
/// lines then arrive as `transcript-appended` (and a [`Note`]); a change of transcript
/// as `transcript-rotated`. Pair every call with [`release`].
pub(crate) fn acquire(app: &AppHandle, instance_id: &str) -> Result<Position, String> {
    // Resolve the target before taking our lock: `target` takes it too.
    let want = target(app, instance_id);
    let streams = app.state::<Streams>();
    let mut inner = streams.inner.lock().unwrap();
    if let Some(follow) = inner.follows.get_mut(instance_id) {
        follow.refs += 1;
        let cur = follow.cursor.lock().unwrap();
        return Ok(Position {
            session_id: cur.session_id.clone(),
            path: cur.path.clone(),
            offset: cur.offset,
        });
    }

    let cur = Cursor::attach(want);
    let position =
        Position { session_id: cur.session_id.clone(), path: cur.path.clone(), offset: cur.offset };
    let cursor = Arc::new(Mutex::new(cur));
    let (tx, rx) = mpsc::channel();
    {
        let (app, id, cursor, tx) = (app.clone(), instance_id.to_string(), cursor.clone(), tx.clone());
        std::thread::Builder::new()
            .name("transcript-follow".into())
            .spawn(move || run_follow(app, id, cursor, tx, rx))
            .map_err(|e| format!("could not start transcript follow: {e}"))?;
    }
    // First tick right away: arms the watcher and picks up anything written
    // between measuring the offset and now.
    let _ = tx.send(Msg::Wake);
    inner.follows.insert(instance_id.to_string(), Follow { refs: 1, tx, cursor });
    Ok(position)
}

/// Drop a reference; the last one out stops the follow. Unknown instances are
/// ignored — a view closing after its console was removed is normal.
pub(crate) fn release(app: &AppHandle, instance_id: &str) {
    let streams = app.state::<Streams>();
    let mut inner = streams.inner.lock().unwrap();
    let Some(follow) = inner.follows.get_mut(instance_id) else { return };
    follow.refs = follow.refs.saturating_sub(1);
    if follow.refs == 0 {
        let _ = follow.tx.send(Msg::Stop);
        inner.follows.remove(instance_id);
        inner.cleared.remove(instance_id);
    }
}

/// Every follow's [`Note`]s from now on. Subscribe before [`acquire`], so nothing
/// falls between the two.
pub(crate) fn subscribe(app: &AppHandle) -> tokio::sync::broadcast::Receiver<Note> {
    app.state::<Streams>().notes.subscribe()
}

/// Where the instance's follow stands now, if it has one.
pub(crate) fn position(app: &AppHandle, instance_id: &str) -> Option<Position> {
    let streams = app.state::<Streams>();
    let inner = streams.inner.lock().unwrap();
    let cur = inner.follows.get(instance_id)?.cursor.lock().unwrap().clone();
    Some(Position { session_id: cur.session_id, path: cur.path, offset: cur.offset })
}

/// Start following an instance's transcript, or take another reference on a follow
/// that is already running (see [`acquire`]). Pair every call with
/// `transcript_unfollow`.
#[tauri::command]
pub fn transcript_follow(app: AppHandle, instance_id: String) -> Result<FollowInfo, String> {
    let p = acquire(&app, &instance_id)?;
    Ok(FollowInfo { session_id: p.session_id, offset: p.offset })
}

/// Drop a reference taken with `transcript_follow`.
#[tauri::command]
pub fn transcript_unfollow(app: AppHandle, instance_id: String) {
    release(&app, &instance_id);
}

/// The transcript reads go to: the one the instance's follow is on, so pages and
/// live lines always describe the same file; without a follow, the live session's.
fn current(app: &AppHandle, instance_id: &str) -> (Option<String>, Option<PathBuf>) {
    let want = target(app, instance_id);
    let streams = app.state::<Streams>();
    let inner = streams.inner.lock().unwrap();
    if let Some(follow) = inner.follows.get(instance_id) {
        let cur = follow.cursor.lock().unwrap();
        return (cur.session_id.clone(), cur.path.clone());
    }
    match want {
        Target::Session { session_id, path } => (Some(session_id), path),
        Target::Keep | Target::Awaiting => (None, None),
    }
}

fn page(
    session_id: Option<String>,
    path: Option<PathBuf>,
    read: impl FnOnce(&Path) -> std::io::Result<Lines>,
) -> Result<Page, String> {
    let lines = match path {
        // A session that hasn't written its first line has no file yet: an empty
        // page, not an error.
        Some(p) => match read(&p) {
            Ok(lines) => lines,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Lines::default(),
            Err(e) => return Err(format!("reading {}: {e}", p.display())),
        },
        None => Lines::default(),
    };
    Ok(Page {
        session_id,
        lines: lines.lines,
        offset: lines.offset,
        next_offset: lines.next_offset,
        end: lines.end,
    })
}

fn page_bytes(max_bytes: Option<u64>) -> u64 {
    max_bytes.unwrap_or(CHUNK_BYTES).clamp(1, MAX_PAGE_BYTES)
}

/// Read complete lines forward from `from_offset` (a line boundary: `0`, or an
/// offset this module returned).
#[tauri::command(async)]
pub fn transcript_read(
    app: AppHandle,
    instance_id: String,
    from_offset: u64,
    max_bytes: Option<u64>,
) -> Result<Page, String> {
    let (session_id, path) = current(&app, &instance_id);
    page(session_id, path, |p| read_forward(p, from_offset, page_bytes(max_bytes)))
}

/// Read the page of complete lines that ends at `before_offset` (or at the end of
/// the file when omitted) — history, newest page first.
#[tauri::command(async)]
pub fn transcript_read_back(
    app: AppHandle,
    instance_id: String,
    before_offset: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<Page, String> {
    let (session_id, path) = current(&app, &instance_id);
    page(session_id, path, |p| read_back(p, before_offset, page_bytes(max_bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// The T0 session: fixtures `01`…`15` concatenated are one real transcript.
    fn session_fixture() -> Vec<u8> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/transcript/fixtures");
        let mut names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".jsonl") && !n.contains("sidechain") && !n.starts_with("16"))
            .collect();
        names.sort();
        assert_eq!(names.len(), 15);
        names.iter().flat_map(|n| std::fs::read(dir.join(n)).unwrap()).collect()
    }

    fn clear_fixture() -> Vec<u8> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/transcript/fixtures");
        std::fs::read(dir.join("16-clear-new-session.jsonl")).unwrap()
    }

    fn expected_lines(bytes: &[u8]) -> Vec<String> {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("wb-stream-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn append(path: &Path, bytes: &[u8]) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    /// Paging forward with a page far smaller than the longest line returns every
    /// line of the real session exactly once, each one valid JSON.
    #[test]
    fn forward_paging_reproduces_the_session() {
        let dir = temp_dir("fwd");
        let path = dir.join("s.jsonl");
        let bytes = session_fixture();
        std::fs::write(&path, &bytes).unwrap();

        let mut got = Vec::new();
        let mut offset = 0;
        loop {
            let page = read_forward(&path, offset, 4096).unwrap();
            assert_eq!(page.offset, offset);
            if page.lines.is_empty() {
                assert_eq!(page.next_offset, page.end);
                break;
            }
            offset = page.next_offset;
            got.extend(page.lines);
        }
        assert_eq!(offset, bytes.len() as u64);
        assert_eq!(got, expected_lines(&bytes));
        for line in &got {
            serde_json::from_str::<serde_json::Value>(line).unwrap();
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Paging backward from the end yields the same lines, newest page first, and
    /// the pages tile the file with no gap or overlap.
    #[test]
    fn backward_paging_reproduces_the_session() {
        let dir = temp_dir("back");
        let path = dir.join("s.jsonl");
        let bytes = session_fixture();
        std::fs::write(&path, &bytes).unwrap();

        let mut pages = Vec::new();
        let mut before = None;
        loop {
            let page = read_back(&path, before, 4096).unwrap();
            assert_eq!(page.next_offset, before.unwrap_or(bytes.len() as u64));
            assert!(!page.lines.is_empty());
            before = Some(page.offset);
            let done = page.offset == 0;
            pages.push(page.lines);
            if done {
                break;
            }
        }
        assert!(pages.len() > 10);
        let got: Vec<String> = pages.into_iter().rev().flatten().collect();
        assert_eq!(got, expected_lines(&bytes));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A line caught mid-write is not there yet: reads stop at the last newline,
    /// and the line arrives whole once its newline lands.
    #[test]
    fn half_written_line_is_held_back() {
        let dir = temp_dir("partial");
        let path = dir.join("s.jsonl");
        append(&path, b"{\"a\":1}\n{\"b\":");
        let mut cur = Cursor { session_id: Some("s".into()), path: Some(path.clone()), offset: 0 };

        let first = cur.drain().unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].lines, vec!["{\"a\":1}"]);
        assert_eq!(cur.offset, 8);
        assert!(cur.drain().unwrap().is_empty());
        assert_eq!(read_back(&path, None, 1024).unwrap().lines, vec!["{\"a\":1}"]);

        append(&path, b"2}\r\n");
        let second = cur.drain().unwrap();
        assert_eq!(second[0].lines, vec!["{\"b\":2}"]);
        assert_eq!(second[0].offset, 8);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Following the real session as it is appended in arbitrary pieces delivers
    /// every line once, in order, with contiguous offsets.
    #[test]
    fn follow_delivers_appended_fixture_lines_in_order() {
        let dir = temp_dir("follow");
        let path = dir.join("s.jsonl");
        let bytes = session_fixture();
        let mut cur = Cursor { session_id: Some("s".into()), path: Some(path.clone()), offset: 0 };
        // Not written yet: nothing to read, and not an error worth surfacing.
        assert!(cur.drain().is_err());

        let mut got = Vec::new();
        let mut at = 0;
        for piece in bytes.chunks(7919) {
            append(&path, piece);
            for chunk in cur.drain().unwrap() {
                assert_eq!(chunk.offset, at);
                at = chunk.next_offset;
                got.extend(chunk.lines);
            }
        }
        assert_eq!(at, bytes.len() as u64);
        assert_eq!(got, expected_lines(&bytes));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `/clear`: the follow lets go of the old transcript at once, then picks the
    /// new session's file up from the top. A consumer attaching mid-session starts
    /// at the end of the file instead.
    #[test]
    fn clear_rotates_onto_the_new_transcript() {
        let dir = temp_dir("clear");
        let old = dir.join("old.jsonl");
        let new = dir.join("new.jsonl");
        std::fs::write(&old, session_fixture()).unwrap();

        let mut cur = Cursor::attach(Target::Session {
            session_id: "old".into(),
            path: Some(old.clone()),
        });
        assert_eq!(cur.offset, std::fs::metadata(&old).unwrap().len());
        assert!(cur.drain().unwrap().is_empty());

        // SessionEnd{reason:"clear"}: nothing to follow until the new id reports in.
        assert!(cur.retarget(Target::Awaiting));
        assert_eq!(cur, Cursor::default());
        assert!(!cur.retarget(Target::Awaiting));
        assert!(cur.drain().unwrap().is_empty());

        // First hook of the new session; its (small) file is streamed from the top.
        std::fs::write(&new, clear_fixture()).unwrap();
        let target = Target::Session { session_id: "new".into(), path: Some(new.clone()) };
        assert!(cur.retarget(target.clone()));
        assert_eq!(cur.offset, 0);
        assert!(!cur.retarget(target));
        let lines: Vec<String> = cur.drain().unwrap().into_iter().flat_map(|c| c.lines).collect();
        assert_eq!(lines, expected_lines(&clear_fixture()));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A session with no file yet is followed by id; when the file appears it is
    /// read from the top without a rotation. A dead PTY changes nothing. Moving
    /// onto a big transcript (a resume) starts at its end and says so.
    #[test]
    fn retarget_cases() {
        let dir = temp_dir("retarget");
        let path = dir.join("a.jsonl");
        let mut cur = Cursor::attach(Target::Session { session_id: "a".into(), path: None });
        assert_eq!((cur.offset, cur.path.clone()), (0, None));

        std::fs::write(&path, b"{\"n\":1}\n").unwrap();
        assert!(!cur.retarget(Target::Session { session_id: "a".into(), path: Some(path.clone()) }));
        assert_eq!(cur.drain().unwrap()[0].lines, vec!["{\"n\":1}"]);

        let before = cur.clone();
        assert!(!cur.retarget(Target::Keep));
        assert_eq!(cur, before);

        let big = dir.join("b.jsonl");
        std::fs::write(&big, session_fixture()).unwrap();
        assert!(cur.retarget(Target::Session { session_id: "b".into(), path: Some(big.clone()) }));
        assert_eq!(cur.offset, std::fs::metadata(&big).unwrap().len());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A file that shrank is reported once and then read again from the top.
    #[test]
    fn truncation_restarts_from_the_top() {
        let dir = temp_dir("trunc");
        let path = dir.join("s.jsonl");
        std::fs::write(&path, b"{\"a\":1}\n{\"b\":2}\n").unwrap();
        let mut cur = Cursor { session_id: Some("s".into()), path: Some(path.clone()), offset: 16 };
        std::fs::write(&path, b"{\"c\":3}\n").unwrap();
        assert_eq!(cur.drain().unwrap_err().kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(cur.drain().unwrap()[0].lines, vec!["{\"c\":3}"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Only a `.jsonl` inside the projects directory is taken from a hook event.
    #[test]
    fn hook_path_must_be_a_transcript_under_projects() {
        let projects = Path::new(r"C:\Users\dev\.claude\projects");
        let ok = r"C:\Users\dev\.claude\projects\C--Users-dev-proj\abc.jsonl";
        assert_eq!(accept_hook_path(projects, ok), Some(PathBuf::from(ok)));
        // Hooks report forward slashes on some setups; same file.
        assert!(accept_hook_path(projects, "C:/Users/dev/.claude/projects/p/abc.jsonl").is_some());
        assert!(accept_hook_path(projects, r"C:\Users\dev\.ssh\id_rsa").is_none());
        assert!(accept_hook_path(projects, r"C:\Users\dev\.claude\projects\p\notes.txt").is_none());
        assert!(accept_hook_path(
            projects,
            r"C:\Users\dev\.claude\projects\..\..\secrets\x.jsonl"
        )
        .is_none());
        assert!(accept_hook_path(projects, r"C:\Users\dev\.claude\projects-evil\x.jsonl").is_none());
    }
}
