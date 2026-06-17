//! PTY supervisor (step 1.5).
//!
//! Owns every `portable-pty` child and streams each one's output to the frontend
//! over a per-PTY Tauri `Channel<Vec<u8>>`. Keystrokes and resize flow back
//! through `#[tauri::command]`s. The PTY↔webview bridge is the de-risk for going
//! Tauri-native (design §4.1); Phase 0 proved it with one PTY.
//!
//! Step 1.5 generalizes the single-PTY spike into a supervisor keyed by
//! **`instance_id`**, so many consoles run side by side. Each `claude` child is
//! launched with a Workbench-minted `--session-id <uuid>` (design §4.2, decision
//! 12) and the supervisor keeps a `session_id → instance_id` map alongside the
//! `instance_id → PTY` map — the lookup the Phase-2 hook server needs to route an
//! event (which only carries `session_id`) back to its card.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::UnboundedSender;

/// Recent raw PTY output (cap [`RING_CAP`]) bytes retained for **replay on
/// attach**. A subscriber that joins mid-session gets this replayed so it doesn't
/// start on a blank screen — the scrollback requirement of the multiplexer
/// (design §11, step 4.1). Bytes are stored and replayed **verbatim**, never
/// parsed for state (guardrail: structured state comes from hooks/transcripts, not
/// terminal output).
const RING_CAP: usize = 1024 * 1024; // 1 MiB

/// One subscriber's output sink. The multiplexer fans identical bytes to every sink
/// regardless of transport: a desktop console or torn-off window reads a Tauri IPC
/// `Channel<Vec<u8>>`; a remote phone (step 4.5) reads an `mpsc` channel that the
/// axum WebSocket handler drains to its socket. Keeping both behind one enum means
/// the ring buffer, fan-out, and eviction logic are written once.
enum Sink {
    /// A webview subscriber over a Tauri IPC channel (desktop console / torn-off).
    Channel(Channel<Vec<u8>>),
    /// A remote WS subscriber (step 4.5). `send` is non-blocking, so it works from
    /// the sync reader thread just like the channel.
    Remote(UnboundedSender<Vec<u8>>),
}

impl Sink {
    /// Forward a chunk; `false` means the far end is gone (channel closed / WS
    /// dropped) so the hub should evict this subscriber.
    fn send(&self, chunk: Vec<u8>) -> bool {
        match self {
            Sink::Channel(c) => c.send(chunk).is_ok(),
            Sink::Remote(tx) => tx.send(chunk).is_ok(),
        }
    }
}

/// Fans one PTY child's output out to N **subscribers** and retains a ring buffer
/// of recent bytes for replay-on-attach. This is the heart of step 4.1: the reader
/// thread appends every chunk to `ring` and forwards it to every live subscriber;
/// a fresh subscriber ([`OutputHub::subscribe`]) gets the ring replayed so it joins
/// with scrollback intact. Input routing needs nothing here — `pty_write` is keyed
/// by `instance_id`, so any subscriber's keystrokes already reach the child.
///
/// Until step 4.2 (OS-window tear-off) there's exactly one subscriber per PTY (the
/// desktop console), so this behaves identically to the old single-channel path;
/// the structure is what later lets a torn-off window or a remote phone attach as a
/// second subscriber.
#[derive(Default)]
struct OutputHub {
    /// Recent output bytes, capped at [`RING_CAP`]; replayed to a late subscriber.
    ring: VecDeque<u8>,
    /// Live subscribers keyed by a per-PTY monotonic id ([`OutputHub::subscribe`]).
    subscribers: HashMap<u64, Sink>,
    /// Each subscriber's last-requested terminal size. The PTY is sized to the
    /// **minimum** across subscribers (tmux's smallest-client rule) so a small
    /// client can't force a larger one to wrap. See [`OutputHub::arbitrate_size`].
    sizes: HashMap<u64, (u16, u16)>,
    /// Next subscription id to hand out.
    next_sub_id: u64,
    /// The size last applied to the PTY — the spawn dimensions, then each arbitrated
    /// resize. Reported to a remote subscriber on attach (step 4.5) so the phone can
    /// render the TUI at the source terminal's width instead of reflowing it. A
    /// remote subscriber deliberately does **not** record a size of its own (it never
    /// calls `arbitrate_size`), so a small phone can't shrink the desktop console.
    applied: Option<(u16, u16)>,
}

impl OutputHub {
    /// Append a chunk to the ring, evicting oldest bytes past [`RING_CAP`].
    fn push_ring(&mut self, chunk: &[u8]) {
        self.ring.extend(chunk.iter().copied());
        let overflow = self.ring.len().saturating_sub(RING_CAP);
        if overflow > 0 {
            self.ring.drain(..overflow);
        }
    }

    /// Forward a chunk to every subscriber, dropping any whose channel the
    /// frontend has closed (webview gone). No subscribers is a valid transient
    /// state — output still accrues in the ring for the next attach.
    fn fanout(&mut self, chunk: &[u8]) {
        if self.subscribers.is_empty() {
            return;
        }
        let mut dead = Vec::new();
        for (id, sink) in self.subscribers.iter() {
            if !sink.send(chunk.to_vec()) {
                dead.push(*id);
            }
        }
        for id in dead {
            self.subscribers.remove(&id);
            self.sizes.remove(&id);
        }
    }

    /// Register a subscriber, replay the ring into it, and return its id. The
    /// replay is one `send` of up to [`RING_CAP`] bytes so the attaching terminal
    /// paints the recent session immediately (raw-ArrayBuffer streaming is a later
    /// optimization — correctness first, matching the spawn path).
    fn subscribe(&mut self, sink: Sink) -> u64 {
        let id = self.next_sub_id;
        self.next_sub_id += 1;
        if !self.ring.is_empty() {
            let _ = sink.send(self.ring.iter().copied().collect());
        }
        self.subscribers.insert(id, sink);
        id
    }

    /// Drop a subscriber and its size vote.
    fn unsubscribe(&mut self, id: u64) {
        self.subscribers.remove(&id);
        self.sizes.remove(&id);
    }

    /// Record a subscriber's desired size and return the size the PTY should
    /// actually take — the **minimum** across all subscribers. `None` only if no
    /// sizes are recorded (can't happen right after an insert).
    fn arbitrate_size(&mut self, id: u64, cols: u16, rows: u16) -> Option<(u16, u16)> {
        self.sizes.insert(id, (cols, rows));
        let cols = self.sizes.values().map(|(c, _)| *c).min()?;
        let rows = self.sizes.values().map(|(_, r)| *r).min()?;
        self.applied = Some((cols, rows));
        Some((cols, rows))
    }
}

/// A live PTY child plus the handles needed to write to it, resize it, and kill
/// it. The reader runs on its own detached thread, fanning output through `hub`.
/// Each child's working dir is kept so a rotated session (`/clear` / `/compact`,
/// which mint a fresh id) can be re-correlated to this instance by cwd.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// The working dir this child launched in. Used to re-correlate a session that
    /// Claude Code *rotated* under us — `/clear` and `/compact` start a fresh
    /// session id that we never minted, but in the same cwd as this live instance.
    cwd: String,
    /// Output multiplexer: the reader thread fans chunks here; consoles attach as
    /// subscribers via `pty_subscribe`. Shared with the reader thread (`Arc`).
    /// The remote one-shot command path (`remote_cmd_spawn`) keeps an empty hub —
    /// it streams to its own channel directly and is never multiplexed.
    hub: Arc<Mutex<OutputHub>>,
}

/// Tauri-managed state holding every active PTY, keyed by `instance_id`, plus the
/// reverse `session_id → instance_id` index (design §4.4 / decision 10: the hook
/// server filters incoming events by `session_id`, dropping any session Workbench
/// didn't mint).
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    by_session: Mutex<HashMap<String, String>>,
    /// Instances whose session just rotated under us (they emitted `SessionEnd`
    /// with `reason:"clear"`) and are therefore awaiting a fresh, unminted session
    /// id we can only re-correlate by cwd. Only an instance flagged here is an
    /// adoption candidate — see [`Self::adopt_session_for_cwd`]. This is what keeps
    /// a `/clear` rotation from being absorbed by a co-located *working* instance
    /// (or a foreign `claude`) that happens to share the working directory.
    pending_rotation: Mutex<HashSet<String>>,
}

impl PtyManager {
    /// Resolve a `session_id` to the `instance_id` that owns it, or `None` when
    /// Workbench didn't mint it. This is the **session-id filter** the hook server
    /// relies on (design §4.4, decision 10): user-level hooks fire for every Claude
    /// session on the machine, so the endpoint drops any event whose session isn't
    /// one of ours. The map holds exactly the sessions we launched with
    /// `--session-id` and that are still live.
    pub fn instance_for_session(&self, session_id: &str) -> Option<String> {
        self.by_session.lock().unwrap().get(session_id).cloned()
    }

    /// Snapshot every live `(instance_id, session_id)` mapping — the sessions
    /// Workbench minted (or adopted after a `/clear`) that are still running. The
    /// transcript tailer (step 3.1) uses this to know which sessions' JSONL to
    /// follow; a rotated or killed session simply drops out of the snapshot.
    pub fn live_sessions(&self) -> Vec<(String, String)> {
        self.by_session
            .lock()
            .unwrap()
            .iter()
            .map(|(sid, iid)| (iid.clone(), sid.clone()))
            .collect()
    }

    /// Flag `instance_id` as awaiting a rotated session, because its old session
    /// just emitted `SessionEnd{reason:"clear"}`. A `/clear` mints a brand-new
    /// session id with no link to the old one *except the shared cwd*, so the only
    /// safe re-correlation is: adopt the next unmapped session in that cwd into the
    /// instance that actually cleared. Flagging makes that target explicit. Cleared
    /// on successful adoption (or when the instance is killed).
    pub fn mark_pending_rotation(&self, instance_id: &str) {
        self.pending_rotation
            .lock()
            .unwrap()
            .insert(instance_id.to_string());
    }

    /// Re-correlate a session id Workbench didn't mint to a live instance by its
    /// working dir, registering the mapping so subsequent events pass the filter.
    /// This is how a `/clear` rotation survives (it mints a fresh session id in the
    /// same cwd): the old id's `SessionEnd{reason:"clear"}` flags the instance via
    /// [`Self::mark_pending_rotation`], and here we adopt the rotated session into
    /// it.
    ///
    /// Crucially, the candidate set is **only instances flagged pending-rotation** —
    /// not every live instance in the cwd. When several instances share a working
    /// directory (worktrees off → all default to the project root), a bare-cwd match
    /// is ambiguous: it would let a rotated/foreign session be adopted into a
    /// co-located instance that's actively *working*, flipping its card. (That was
    /// the bug: while the siblings were open the ambiguity guard just dropped the
    /// event; closing them left one live instance in the dir, so the next stray
    /// clear-rotation got adopted into the survivor and reset it to idle.) Gating on
    /// the pending flag means only an instance that genuinely rotated is eligible.
    ///
    /// Returns `None` — leaving the event dropped — when no pending instance matches,
    /// or when ≥2 pending instances share the dir (still ambiguous, but now only
    /// among instances that all actually cleared), so the §4.4 filter stays honest:
    /// we only ever adopt into an instance we're running.
    pub fn adopt_session_for_cwd(&self, session_id: &str, cwd: &str) -> Option<String> {
        let target = norm_dir(cwd);
        let instance_id = {
            let pending = self.pending_rotation.lock().unwrap();
            let mut sessions = self.sessions.lock().unwrap();
            let mut live_match: Option<String> = None;
            for (id, s) in sessions.iter_mut() {
                // Only an instance that actually rotated (`/clear`) is a candidate;
                // a co-located working instance or foreign session is never adopted.
                if !pending.contains(id) {
                    continue;
                }
                if norm_dir(&s.cwd) != target {
                    continue;
                }
                // Skip corpses. When a `claude` child exits on its own (`/exit`,
                // Ctrl-D, crash) its reader thread breaks on EOF but never removes the
                // `PtySession`, so a dead entry can linger in `sessions` keyed to its
                // old cwd. Counting that corpse would trip the ambiguity guard below
                // and strand a rotated session whose `/clear` happened in the same dir
                // — the "hooks dead after /clear" bug. `try_wait` reaps without
                // blocking: `Ok(Some(_))` means the child already exited, so it's not a
                // valid adoption target. An `Err`/`Ok(None)` (can't tell / still
                // running) is treated as live, so we never drop a real instance.
                if matches!(s.child.try_wait(), Ok(Some(_))) {
                    continue;
                }
                if live_match.is_some() {
                    return None; // ambiguous — two cleared instances in the same dir
                }
                live_match = Some(id.clone());
            }
            live_match?
        };
        // The rotation is now correlated — clear the flag so a later stray session in
        // the same dir can't be adopted into this instance a second time.
        self.pending_rotation.lock().unwrap().remove(&instance_id);
        // Replace this instance's mapping rather than add a second one: the old
        // (rotated-away) session id must stop resolving, or a late `SessionEnd` for
        // it would mark the still-live card "ended".
        let mut map = self.by_session.lock().unwrap();
        map.retain(|_, v| v != &instance_id);
        map.insert(session_id.to_string(), instance_id.clone());
        Some(instance_id)
    }

    /// Attach a **remote** WS subscriber (step 4.5) to an instance's live PTY. The
    /// hub replays its ring buffer into `tx` immediately (scrollback on attach), then
    /// fans subsequent output to it alongside any desktop subscribers. Returns the
    /// subscription id (passed to [`Self::unsubscribe`] on disconnect) and the PTY's
    /// current size, which the phone uses to render the TUI at the source width.
    /// `None` when the instance has no live PTY — the WS handler then tells the client
    /// the session isn't running. The remote subscriber never joins resize
    /// arbitration, so it can't shrink the desktop console (the §11 caveat).
    pub fn subscribe_remote(
        &self,
        instance_id: &str,
        tx: UnboundedSender<Vec<u8>>,
    ) -> Option<(u64, (u16, u16))> {
        // Clone the hub handle out from under the sessions lock before touching it,
        // mirroring `pty_subscribe`: never hold both locks at once.
        let hub = {
            let guard = self.sessions.lock().unwrap();
            guard.get(instance_id)?.hub.clone()
        };
        let mut h = hub.lock().unwrap();
        let size = h.applied.unwrap_or((80, 24));
        let id = h.subscribe(Sink::Remote(tx));
        Some((id, size))
    }

    /// Detach a subscriber (`sub_id`) from an instance's PTY without killing the
    /// child. No-op if either is already gone. Shared by the `pty_unsubscribe`
    /// command and the remote WS handler's cleanup.
    pub fn unsubscribe(&self, instance_id: &str, sub_id: u64) {
        if let Some(session) = self.sessions.lock().unwrap().get(instance_id) {
            session.hub.lock().unwrap().unsubscribe(sub_id);
        }
    }

    /// Write input bytes to an instance's PTY. Shared by the `pty_write` command and
    /// the remote terminal's raw-keyboard path (step 4.5), so remote keystrokes reach
    /// the child through the same single write path as the desktop console.
    pub fn write_input(&self, instance_id: &str, data: &[u8]) -> Result<(), String> {
        let mut guard = self.sessions.lock().unwrap();
        let session = guard.get_mut(instance_id).ok_or("no active PTY")?;
        session
            .writer
            .write_all(data)
            .map_err(|e| format!("pty write failed: {e}"))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("pty flush failed: {e}"))
    }
}

/// Normalize a directory path for comparison: unify separators, drop a trailing
/// slash, and fold case on Windows (its filesystem is case-insensitive).
fn norm_dir(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// What to run in the PTY. `Shell` is the 0.2 spike path (debugging convenience);
/// `Claude` is the real target — an interactive `claude` TUI for one instance.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpawnKind {
    Shell,
    Claude,
}

/// Remote launch descriptor (step 3.12). When present on `pty_spawn`, the child is
/// not a local `claude` but a local `ssh` process that attaches-or-creates a tmux
/// session on the host and runs `claude` inside it — so the instance's TUI streams
/// over SSH while the session persists across console close/app quit (only the
/// `ssh` client detaches). The bridge itself (reader thread, write, resize, output
/// Channel) is unchanged; this just changes the command. Design §4.2: the PTY is
/// transport-agnostic bytes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSpawn {
    /// SSH destination — a `~/.ssh/config` alias or `user@host`.
    pub dest: String,
    /// tmux session name on the host (`wb-<short id>`, or an adopted name).
    pub session: String,
    /// Working directory on the host the session starts in.
    pub dir: String,
}

/// Returned to the frontend at spawn. For `Claude`, `session_id` is the session
/// the PTY is bound to — the UUID we minted and passed as `--session-id` for a
/// fresh session, or the `--resume`d id for a resumed one (step 3.8) — so the
/// card↔PTY mapping is known before the first hook fires. `Shell` carries no
/// session id.
#[derive(Debug, Serialize)]
pub struct SpawnResult {
    session_id: Option<String>,
    /// The resolved working directory the child was launched in.
    cwd: String,
}

/// Spawn `kind` for `instance_id` in `cwd` inside a fresh PTY and stream its
/// output to `on_output`. Relaunches cleanly: any existing PTY for the same
/// instance is killed first.
///
/// `resume_session_id` (Claude only, step 3.8): when set, launch
/// `claude --resume <id>` to continue that exact session instead of minting a
/// brand-new one. A plain `--resume` reuses the same session id and appends to the
/// same transcript, so the existing `session_id → instance_id` mapping and the
/// transcript tailer keep working unchanged — we just register the resumed id.
// Each parameter is part of the IPC contract the frontend invokes with (the
// per-PTY output channel, the spawn kind, dimensions, …), so they can't be folded
// into a struct without obscuring the boundary — over clippy's 7-arg advisory.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn pty_spawn(
    state: State<'_, PtyManager>,
    instance_id: String,
    kind: SpawnKind,
    cwd: Option<String>,
    resume_session_id: Option<String>,
    remote: Option<RemoteSpawn>,
    cols: u16,
    rows: u16,
) -> Result<SpawnResult, String> {
    // The local cwd for the child process. For a remote launch the child is a local
    // `ssh` process (the working dir lives on the host), so the passed `cwd` is a
    // remote path that won't exist locally — anchor the ssh client at the home dir
    // instead and skip the local existence check.
    let cwd = if remote.is_some() {
        home_dir().ok_or("no home dir to anchor the local ssh process")?
    } else {
        let c = cwd
            .map(PathBuf::from)
            .or_else(home_dir)
            .ok_or("no working directory given and no home dir found")?;
        if !c.is_dir() {
            return Err(format!("working directory does not exist: {}", c.display()));
        }
        c
    };

    // Build the command up front so a resolution failure (e.g. `claude` not on
    // PATH) reports cleanly before we touch the PTY. A resumed claude keeps the id
    // it's resuming (same session, same transcript); a fresh one mints a UUID.
    // A remote launch mints no session id (no local hook/transcript correlation).
    let session_id = if remote.is_some() {
        None
    } else {
        match kind {
            SpawnKind::Claude => {
                Some(resume_session_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string()))
            }
            SpawnKind::Shell => None,
        }
    };
    let candidates = if let Some(r) = &remote {
        vec![remote_command(r, &cwd, kind)]
    } else {
        match kind {
            SpawnKind::Claude => {
                let sid = session_id.as_deref().unwrap();
                let session_args: [&str; 2] = if resume_session_id.is_some() {
                    ["--resume", sid]
                } else {
                    ["--session-id", sid]
                };
                vec![claude_command(&session_args, &cwd)?]
            }
            SpawnKind::Shell => shell_candidates(&cwd),
        }
    };

    // Tear down any prior PTY for this instance only once we know we can spawn.
    kill_instance(state.inner(), &instance_id);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // Try each candidate until one spawns (shell has fallbacks; claude is one).
    let mut child = None;
    let mut last_err = String::new();
    for cmd in candidates {
        match pair.slave.spawn_command(cmd) {
            Ok(c) => {
                child = Some(c);
                break;
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    let child = child.ok_or_else(|| format!("nothing could be spawned: {last_err}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    // Pump PTY output into the multiplexer until the child exits or the pipe
    // closes. The reader appends each chunk to the ring (for replay-on-attach) and
    // fans it out to every live subscriber (step 4.1). Unlike the old single-channel
    // path, **zero subscribers is not a stop condition** — a console can detach and
    // re-attach while the child keeps running, with output accruing in the ring.
    // `Channel::send` serializes `Vec<u8>` as a JS number array; the frontend
    // reassembles it into a Uint8Array. (Raw-ArrayBuffer streaming is a later
    // optimization; correctness first.)
    let hub = Arc::new(Mutex::new(OutputHub::default()));
    // Seed the applied size with the spawn dimensions so a remote subscriber that
    // attaches before any desktop console resizes the PTY still learns its real width
    // (step 4.5), not the 80×24 fallback.
    hub.lock().unwrap().applied = Some((cols, rows));
    let reader_hub = hub.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut h = reader_hub.lock().unwrap();
                    h.push_ring(&buf[..n]);
                    h.fanout(&buf[..n]);
                }
                Err(_) => break,
            }
        }
    });

    if let Some(sid) = &session_id {
        state
            .by_session
            .lock()
            .unwrap()
            .insert(sid.clone(), instance_id.clone());
    }
    let cwd_str = cwd.to_string_lossy().into_owned();
    state.sessions.lock().unwrap().insert(
        instance_id,
        PtySession {
            master: pair.master,
            writer,
            child,
            cwd: cwd_str.clone(),
            hub,
        },
    );

    Ok(SpawnResult {
        session_id,
        cwd: cwd_str,
    })
}

/// Attach an output subscriber to an instance's live PTY (step 4.1). The PTY's
/// recent scrollback (the hub's ring buffer) is **replayed into `on_output`
/// immediately** so the attaching terminal paints the in-flight session rather
/// than a blank screen; subsequent output then fans out to it live alongside any
/// other subscribers. Returns the subscription id, which the caller passes to
/// `pty_unsubscribe` on close and to `pty_resize` so its size joins the
/// min-size arbitration. Errors if the instance has no live PTY.
#[tauri::command]
pub fn pty_subscribe(
    state: State<'_, PtyManager>,
    instance_id: String,
    on_output: Channel<Vec<u8>>,
) -> Result<u64, String> {
    // Clone out the hub handle and release the sessions lock before touching it,
    // so we never hold both locks at once (the reader thread holds only the hub).
    let hub = {
        let guard = state.sessions.lock().unwrap();
        guard.get(&instance_id).ok_or("no active PTY")?.hub.clone()
    };
    let id = hub.lock().unwrap().subscribe(Sink::Channel(on_output));
    Ok(id)
}

/// Detach a subscriber (its `sub_id` from `pty_subscribe`) from an instance's PTY
/// without killing the child — the console was closed but the session lives on.
/// No-op if the instance or subscriber is already gone.
#[tauri::command]
pub fn pty_unsubscribe(state: State<'_, PtyManager>, instance_id: String, sub_id: u64) {
    state.unsubscribe(&instance_id, sub_id);
}

/// Forward keystrokes (UTF-8 bytes from xterm `onData`) to an instance's PTY.
#[tauri::command]
pub fn pty_write(
    state: State<'_, PtyManager>,
    instance_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    state.write_input(&instance_id, &data)
}

/// Resize an instance's PTY so the child reflows to the new terminal dimensions.
///
/// `sub_id` (step 4.1): when a subscriber identifies itself, its requested size
/// joins the hub's **min-size arbitration** — the PTY is set to the smallest size
/// any subscriber wants, so a small client can't force a larger one to wrap. With
/// a single subscriber (the only case until 4.2) the min is just its own size, so
/// this matches the old behavior. `None` resizes the PTY directly to the requested
/// size (the un-multiplexed `remote_cmd_spawn` modal, which has no hub subscriber).
#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    instance_id: String,
    sub_id: Option<u64>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.sessions.lock().unwrap();
    let session = guard.get(&instance_id).ok_or("no active PTY")?;
    let (cols, rows) = match sub_id {
        Some(id) => session
            .hub
            .lock()
            .unwrap()
            .arbitrate_size(id, cols, rows)
            .unwrap_or((cols, rows)),
        None => (cols, rows),
    };
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

/// Kill an instance's PTY child (if any) and drop the session.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, instance_id: String) -> Result<(), String> {
    kill_instance(state.inner(), &instance_id);
    Ok(())
}

/// Resolve a `session_id` back to the `instance_id` that owns it, or `None` if
/// Workbench didn't mint it. The Phase-2 hook server uses this to route events
/// (which carry only `session_id`) to the right card, and to drop foreign ones.
#[tauri::command]
pub fn session_instance(state: State<'_, PtyManager>, session_id: String) -> Option<String> {
    state.instance_for_session(&session_id)
}

/// Whether `instance_id` has a *live* `claude`/shell child — the truthful answer
/// to "is something already running here?" for the resume shortcut (step 3.8). The
/// frontend console store can't answer it: a child that exits on its own (`/exit`,
/// Ctrl-D, crash) breaks its reader thread but never flips the store off "running"
/// (and never removes the `PtySession`), so the card still reads as live. Here we
/// reap with `try_wait`: `Ok(Some(_))` means the child already exited (not live);
/// `Ok(None)` (running) or `Err` (can't tell) is treated as live so resume never
/// stomps a session we're unsure about. No session for the instance ⇒ not live.
#[tauri::command]
pub fn pty_session_live(state: State<'_, PtyManager>, instance_id: String) -> bool {
    let mut guard = state.sessions.lock().unwrap();
    match guard.get_mut(&instance_id) {
        Some(session) => !matches!(session.child.try_wait(), Ok(Some(_))),
        None => false,
    }
}

/// Default working directory offered to the launcher form (the home dir).
#[tauri::command]
pub fn default_working_dir() -> Option<String> {
    home_dir().map(|p| p.to_string_lossy().into_owned())
}

/// Emitted (event `remote-cmd-done`) when a [`remote_cmd_spawn`] child exits, with
/// everything it printed — so the caller can parse a `tmux ls` listing or just learn
/// the command finished.
#[derive(Clone, Serialize)]
struct RemoteCmdDone {
    id: String,
    output: String,
}

/// Run an **interactive** one-shot remote command in a PTY: `ssh -tt <dest> --
/// <command>` (step 3.12). Unlike the background `ssh` the first cut used — which
/// deadlocked under password auth because it had no terminal to prompt into — this
/// streams to a real `xterm` the user can type their SSH password into. It's keyed
/// by `id` in the same session map as consoles, so `pty_write` / `pty_resize` /
/// `pty_kill` drive it unchanged. On exit it emits `remote-cmd-done` carrying the
/// captured output (the remote-sessions sync parses a `tmux ls` listing out of it;
/// the kill flow just waits for completion).
///
/// `command` is passed as a single token after `--`, so the caller pre-quotes it
/// for the remote shell (e.g. `bash -lc 'tmux ls'`).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn remote_cmd_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    id: String,
    dest: String,
    command: String,
    on_output: Channel<Vec<u8>>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let cwd = home_dir().ok_or("no home dir to anchor the local ssh process")?;
    let mut cmd = CommandBuilder::new("ssh");
    for arg in ["-tt", dest.as_str(), "--", command.as_str()] {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // Tear down any prior command PTY under this id (re-run / retry).
    kill_instance(state.inner(), &id);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("ssh spawn failed: {e}. Is OpenSSH installed?"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    let cwd_str = cwd.to_string_lossy().into_owned();
    state.sessions.lock().unwrap().insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer,
            child,
            cwd: cwd_str,
            // Unused: this one-shot SSH command streams to its own channel directly
            // (below) and is never multiplexed, so its hub stays empty. It exists
            // only so `remote_cmd_spawn` shares the `PtySession` map (and thus
            // `pty_write`/`pty_resize`/`pty_kill`) with consoles.
            hub: Arc::new(Mutex::new(OutputHub::default())),
        },
    );

    // Pump output to the terminal *and* accumulate it; on EOF (child exit / pipe
    // close) drop the session and report what was printed.
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut acc: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    acc.extend_from_slice(&buf[..n]);
                    if on_output.send(buf[..n].to_vec()).is_err() {
                        break; // frontend dropped the channel (modal closed)
                    }
                }
                Err(_) => break,
            }
        }
        if let Some(mgr) = app.try_state::<PtyManager>() {
            mgr.sessions.lock().unwrap().remove(&id);
        }
        let output = String::from_utf8_lossy(&acc).into_owned();
        let _ = app.emit("remote-cmd-done", RemoteCmdDone { id, output });
    });

    Ok(())
}

/// Build the command that launches interactive `claude`. `session_args` carries
/// the session-selecting flags — `["--session-id", <uuid>]` for a fresh session,
/// or `["--resume", <id>]` to continue an existing one (step 3.8) — appended after
/// the resolved `claude` path.
///
/// `claude` is resolved off PATH (honoring `PATHEXT` on Windows). A native
/// executable (`.exe`/`.com` or a Unix binary) is exec'd directly for full TUI
/// fidelity; a `.cmd`/`.bat` shim can't be handed to `CreateProcess` directly, so
/// it's run through `cmd.exe /c`, and a `.ps1` shim through PowerShell. We pass
/// `TERM`/`COLORTERM` so the Ink TUI renders color under ConPTY.
fn claude_command(session_args: &[&str], cwd: &Path) -> Result<CommandBuilder, String> {
    let exe = which::which("claude")
        .map_err(|e| format!("`claude` not found on PATH ({e}). Is Claude Code installed?"))?;
    let ext = exe
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);

    let mut cmd = match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/c");
            c.arg(&exe);
            c
        }
        Some("ps1") => {
            let mut c = CommandBuilder::new("pwsh.exe");
            c.arg("-NoLogo");
            c.arg("-File");
            c.arg(&exe);
            c
        }
        _ => CommandBuilder::new(&exe),
    };
    for arg in session_args {
        cmd.arg(arg);
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    Ok(cmd)
}

/// Build the local `ssh` child that drives a remote `claude` over tmux (step 3.12).
///
/// `ssh -tt <dest> -- tmux new-session -A -s <session> -c <dir> bash -lc claude`:
/// - `-tt` forces a remote PTY so the Ink TUI renders (and our local PTY's
///   window-size changes propagate through ssh to the remote PTY → tmux);
/// - `new-session -A` is *attach-or-create* — the first launch creates the session
///   and runs the command; a reconnect attaches the live one and ignores it (the
///   persistence/reattach semantics this whole step rests on);
/// - `bash -lc claude` runs `claude` under a **login** shell so `claude`/`tmux` are
///   on PATH (a bare `ssh -- tmux …` non-login shell often isn't).
///
/// The local ssh child is just another `portable-pty` child — the reader thread,
/// `pty_write`, `pty_resize`, and output Channel are all unchanged (design §4.2).
///
/// A `Shell` remote launch (step 3.12 follow-up) skips tmux entirely and opens a
/// plain interactive **login shell** in the remote dir
/// (`ssh -tt <dest> -- bash -lc 'cd <dir>; exec $SHELL -l'`) — the Project Shell's
/// remote counterpart, so a remote project's shell runs on the host (where its
/// working dir actually exists) instead of a local shell that can't find it.
fn remote_command(r: &RemoteSpawn, cwd: &Path, kind: SpawnKind) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("ssh");
    match kind {
        SpawnKind::Claude => {
            for arg in [
                "-tt",
                &r.dest,
                "--",
                "tmux",
                "new-session",
                "-A",
                "-s",
                &r.session,
                "-c",
                &r.dir,
                "bash",
                "-lc",
                "claude",
            ] {
                cmd.arg(arg);
            }
        }
        SpawnKind::Shell => {
            // One pre-quoted token after `--` (ssh space-joins argv, so quoting has
            // to survive the remote shell's re-parse): land in the dir, then replace
            // the process with the user's login shell so it's a normal interactive
            // session. `tmux` isn't involved — a shell needs no persistence.
            let payload = format!(
                "bash -lc 'cd \"{}\" 2>/dev/null; exec \"${{SHELL:-bash}}\" -l'",
                r.dir
            );
            for arg in ["-tt", r.dest.as_str(), "--", payload.as_str()] {
                cmd.arg(arg);
            }
        }
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

/// Shell candidates to try in order, each rooted at `cwd`. On Windows we prefer
/// PowerShell 7 (`pwsh`), fall back to Windows PowerShell, then `cmd`. On Unix we
/// honor `$SHELL`.
fn shell_candidates(cwd: &Path) -> Vec<CommandBuilder> {
    let build = |program: &str| {
        let mut cmd = CommandBuilder::new(program);
        cmd.cwd(cwd);
        cmd
    };

    #[cfg(windows)]
    {
        vec![build("pwsh.exe"), build("powershell.exe"), build("cmd.exe")]
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        vec![build(&shell), build("/bin/bash"), build("/bin/sh")]
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Shared teardown: kill the instance's child, drop the session, and unmap its
/// `session_id`. Take the session out from under the `sessions` lock before
/// touching `by_session` so the two mutexes are never held nested.
fn kill_instance(mgr: &PtyManager, instance_id: &str) {
    let removed = mgr.sessions.lock().unwrap().remove(instance_id);
    if let Some(mut session) = removed {
        let _ = session.child.kill();
        // Purge every session id mapping to this instance — the minted one and any
        // adopted after a `/clear` rotation — so no stale id lingers.
        mgr.by_session.lock().unwrap().retain(|_, v| v != instance_id);
        // Drop any pending-rotation flag too, so a stray session in this dir can't
        // be adopted into a now-dead instance.
        mgr.pending_rotation.lock().unwrap().remove(instance_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ring buffer caps at `RING_CAP`, evicting the oldest bytes so a late
    /// subscriber replays only the most recent window (step 4.1 scrollback). Push
    /// past the cap and assert the tail survived and the head was dropped.
    #[test]
    fn ring_caps_and_evicts_oldest() {
        let mut hub = OutputHub::default();
        // Two chunks that together exceed the cap by one chunk's worth.
        let first = vec![b'A'; RING_CAP];
        let second = vec![b'B'; 4096];
        hub.push_ring(&first);
        hub.push_ring(&second);
        assert_eq!(hub.ring.len(), RING_CAP, "ring never grows past the cap");
        // The oldest 4096 'A's were evicted; the newest bytes are all 'B'.
        assert_eq!(hub.ring.back().copied(), Some(b'B'));
        assert_eq!(hub.ring.front().copied(), Some(b'A'));
        let b_count = hub.ring.iter().filter(|&&b| b == b'B').count();
        assert_eq!(b_count, 4096, "exactly the newest chunk's bytes remain at the tail");
    }

    /// A push smaller than the cap is retained whole (the common case — replay
    /// shows the live session, not a truncated one).
    #[test]
    fn ring_keeps_small_output_whole() {
        let mut hub = OutputHub::default();
        hub.push_ring(b"hello ");
        hub.push_ring(b"world");
        let got: Vec<u8> = hub.ring.iter().copied().collect();
        assert_eq!(got, b"hello world");
    }

    /// A remote subscriber (step 4.5) gets the scrollback ring replayed on attach,
    /// receives subsequent fan-out, and is evicted once its receiver is dropped — the
    /// same contract as a webview channel subscriber, just over an mpsc sink.
    #[test]
    fn remote_sink_replays_ring_and_evicts_on_drop() {
        let mut hub = OutputHub::default();
        hub.push_ring(b"hello");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let id = hub.subscribe(Sink::Remote(tx));
        // Attach replays the whole ring as one chunk so the phone paints scrollback.
        assert_eq!(rx.try_recv().expect("ring replayed on attach"), b"hello");
        // Live output then fans out to the remote sink.
        hub.fanout(b" world");
        assert_eq!(rx.try_recv().unwrap(), b" world");
        // A dropped receiver (phone disconnected) is evicted on the next fan-out.
        drop(rx);
        hub.fanout(b"!");
        assert!(!hub.subscribers.contains_key(&id));
    }

    /// Resize arbitration returns the **minimum** size across subscribers (tmux's
    /// smallest-client rule), and a departed subscriber stops constraining it.
    #[test]
    fn arbitrate_size_takes_min_across_subscribers() {
        let mut hub = OutputHub::default();
        // One subscriber: the min is just its own size (the only case before 4.2).
        assert_eq!(hub.arbitrate_size(0, 120, 40), Some((120, 40)));
        // A second, smaller-in-one-axis subscriber pulls each axis to the min.
        assert_eq!(hub.arbitrate_size(1, 80, 50), Some((80, 40)));
        // It leaving restores the remaining subscriber's size.
        hub.unsubscribe(1);
        assert_eq!(hub.arbitrate_size(0, 120, 40), Some((120, 40)));
    }
}
