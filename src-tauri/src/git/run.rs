//! How every git invocation actually reaches the OS (step G8).
//!
//! Until now each helper in `mod.rs` built its own `Command` and called
//! `.output()`. That is fine right up to the moment git decides it wants to talk
//! to a human: a `push` to a remote whose credentials aren't cached asks for a
//! username, `.output()` blocks forever waiting for a stdin nobody is attached
//! to, and the panel sits at `busy: true` with no button that can end it. The
//! same shape hides a second problem — nothing anywhere recorded *what* was run,
//! so a failure could only ever be reported as its last line of stderr.
//!
//! So every helper now funnels through `exec` here, which:
//!
//! * **refuses to prompt.** `GIT_TERMINAL_PROMPT=0` plus an askpass pointing at a
//!   program that doesn't exist, so credential and passphrase prompts fail fast
//!   instead of waiting. Git Credential Manager on Windows is told not to open
//!   its dialog either — a GUI prompt behind a hidden console is the worst case,
//!   because it blocks with nothing on screen to answer.
//! * **has a deadline.** Reader threads drain stdout/stderr while the main thread
//!   polls `try_wait`, so a child that fills a pipe can't deadlock us and one that
//!   simply hangs gets killed at the timeout.
//! * **can be cancelled.** Network ops register their child under the repo root;
//!   `git_cancel` kills it. The poll loop only holds the child's lock for the
//!   instant it takes to check on it, so the kill lands promptly.
//! * **remembers.** Each invocation lands in a small ring the panel reads back as
//!   a scrollback, which is what makes a multi-line git error readable in full
//!   rather than squeezed into a one-line banner.
//!
//! Note what is *not* here: no retry, no queue, no per-repo serialisation. Git
//! takes its own locks and reports contention clearly; layering our own would
//! only mean two lock regimes disagreeing.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Deadline for a local operation. Generous: a `status` on a huge cold repo can
/// take tens of seconds, and killing honest work is worse than waiting.
pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);

/// Deadline for anything that talks to a remote. Longer, because a real fetch of
/// a real repo legitimately takes minutes on a slow link — this is the backstop
/// for a *hung* connection, not a performance budget. Cancellation is the
/// user-facing way out; this is the one that fires when nobody is watching.
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(180);

/// A program that does not exist, pointed at by both askpass variables. Git runs
/// it, fails to read an answer, and — with terminal prompts disabled — gives up
/// with "could not read Username", which is a fast, legible failure. A no-op like
/// `echo` would instead hand git an *empty* password, so the failure would come
/// back as a rejected credential and read like the user's password was wrong.
const NO_ASKPASS: &str = "workbench-no-askpass";

/// How many invocations the scrollback keeps. Sized for "what happened in the
/// last few minutes of clicking", not an audit log.
const RING: usize = 120;

/// Longest output kept per ring entry. Failures keep more than successes: a
/// successful read's stdout is the data the panel already has on screen, while a
/// failure's message is the whole reason the entry exists.
const KEEP_FAIL: usize = 4000;
const KEEP_OK: usize = 600;

/// What a finished invocation produced. `ok` is git's exit status; both streams
/// come back untrimmed so callers can decide what trimming means for them.
#[derive(Debug)]
pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    /// stdout as git wrote it, for a reader that must tell text from binary
    /// (`stdout` has already replaced invalid UTF-8).
    pub raw: Vec<u8>,
}

/// One invocation, as the panel's scrollback shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRecord {
    /// Monotonic id — the frontend uses it as a React key and to spot new entries.
    pub id: u64,
    /// Repo root the command ran in, verbatim as it was passed to us.
    pub repo: String,
    /// The command as typed, e.g. `git log --format=… -n 200`. The `-C <root>`
    /// prefix is left off: it's the same for every row and the repo is in `repo`.
    pub argv: String,
    pub ok: bool,
    /// Wall-clock duration in milliseconds.
    pub ms: u64,
    /// Combined output, tail-capped. Empty for a quiet success.
    pub output: String,
}

/// What `exec` should do, beyond the arguments themselves.
pub struct Spec<'a> {
    pub args: &'a [&'a str],
    /// Fed to git's stdin (and then closed). Written from its own thread, so a
    /// patch bigger than the pipe buffer can't deadlock against git's own output.
    pub stdin: Option<&'a str>,
    pub timeout: Duration,
    /// When set, the child is registered under this key so `cancel` can kill it.
    pub cancel_key: Option<&'a str>,
}

impl<'a> Spec<'a> {
    /// A local command: default deadline, not cancellable (there's nothing to wait
    /// out — a local git either works or fails within a moment).
    pub fn local(args: &'a [&'a str]) -> Self {
        Spec { args, stdin: None, timeout: LOCAL_TIMEOUT, cancel_key: None }
    }

    /// A command that talks to a remote: longer deadline, and cancellable under
    /// `key` (always the repo root — that's the scope of the panel's Cancel).
    pub fn network(args: &'a [&'a str], key: &'a str) -> Self {
        Spec { args, stdin: None, timeout: NETWORK_TIMEOUT, cancel_key: Some(key) }
    }

    pub fn with_stdin(mut self, input: &'a str) -> Self {
        self.stdin = Some(input);
        self
    }
}

/// A child we might be asked to kill. The `Option` is emptied once the child has
/// been reaped, so a cancel arriving a moment too late is a no-op rather than a
/// kill aimed at a recycled pid.
struct Running {
    child: Mutex<Option<Child>>,
    cancelled: AtomicBool,
}

type Registry = Mutex<Vec<(String, Arc<Running>)>>;

fn registry() -> &'static Registry {
    static REG: OnceLock<Registry> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(Vec::new()))
}

fn ring() -> &'static Mutex<std::collections::VecDeque<CommandRecord>> {
    static LOG: OnceLock<Mutex<std::collections::VecDeque<CommandRecord>>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(std::collections::VecDeque::with_capacity(RING)))
}

fn next_id() -> u64 {
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

/// The environment every git process here runs in. Set on the child only — the
/// app's own environment is left alone, so nothing leaks into the terminals and
/// agents Workbench spawns elsewhere.
fn harden(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", NO_ASKPASS)
        .env("SSH_ASKPASS", NO_ASKPASS)
        .env("SSH_ASKPASS_REQUIRE", "never")
        // Git Credential Manager's own kill switch: without it GCM can raise a
        // window that this process has no way to dismiss.
        .env("GCM_INTERACTIVE", "never")
        // No command here ever wants an editor. `true` exits 0 immediately, so a
        // merge or revert keeps the message it composed instead of hanging on an
        // editor that can never appear. (G4 set this for merges only; it belongs
        // on everything for the same reason.)
        .env("GIT_EDITOR", "true")
        .env("GIT_PAGER", "cat")
        // `credential.interactive=false` as config, via env rather than `-c`, so
        // it doesn't clutter every argv in the scrollback.
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "credential.interactive")
        .env("GIT_CONFIG_VALUE_0", "false");
}

/// Drain a child pipe on its own thread into a buffer the caller can read at any
/// time, joined or not.
///
/// The shared buffer isn't fussiness — it's what makes the timeout work. Killing
/// git does not close a pipe that a *grandchild* still holds open (a credential
/// helper, an ssh, anything git spawned), so a reader thread blocked on that pipe
/// can outlive the process we killed. Waiting on it would mean the deadline
/// bought us nothing. Instead we read whatever arrived and walk away; the thread
/// ends on its own when the last writer finally lets go.
///
/// Bytes, not lines: git's `-z` output has NULs in it and its progress output has
/// carriage returns, and neither survives a line-oriented reader intact.
type Drained = (Arc<Mutex<Vec<u8>>>, std::thread::JoinHandle<()>);

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> Drained {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&buf);
    let handle = std::thread::spawn(move || {
        let Some(mut r) = pipe else { return };
        let mut chunk = [0u8; 8192];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(n) => sink.lock().unwrap().extend_from_slice(&chunk[..n]),
            }
        }
    });
    (buf, handle)
}

/// Run `git -C <path> <args>` to completion, or to its deadline.
///
/// `Err` means the command never produced a verdict — git wouldn't start, the
/// deadline passed, or someone cancelled it. A git that ran and *failed* is
/// `Ok` with `ok: false`; deciding what to say about that is the caller's job,
/// because "no upstream configured" and "merge conflict" want different words.
pub fn exec(path: &Path, spec: Spec) -> Result<Output, String> {
    let started = Instant::now();
    let repo = path.to_string_lossy().into_owned();
    let argv = format!("git {}", spec.args.join(" "));

    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(path)
        .args(spec.args)
        .stdin(if spec.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    harden(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        record(&repo, &argv, false, started, &format!("failed to run git: {e}"));
        format!("failed to run git: {e}")
    })?;

    let writer = spec.stdin.map(|input| {
        let mut pipe = child.stdin.take();
        let bytes = input.as_bytes().to_vec();
        std::thread::spawn(move || {
            if let Some(p) = pipe.as_mut() {
                let _ = p.write_all(&bytes);
            }
            // Dropped here, closing the pipe — git waits for EOF before it acts.
            drop(pipe);
        })
    });
    let (out_buf, out_thread) = drain(child.stdout.take());
    let (err_buf, err_thread) = drain(child.stderr.take());

    let slot = Arc::new(Running {
        child: Mutex::new(Some(child)),
        cancelled: AtomicBool::new(false),
    });
    if let Some(key) = spec.cancel_key {
        registry().lock().unwrap().push((key.to_owned(), Arc::clone(&slot)));
    }

    let deadline = started + spec.timeout;
    let mut timed_out = false;
    let mut wait_err: Option<String> = None;
    let mut success = false;
    loop {
        {
            let mut guard = slot.child.lock().unwrap();
            let Some(c) = guard.as_mut() else { break };
            match c.try_wait() {
                Ok(Some(status)) => {
                    success = status.success();
                    *guard = None;
                    break;
                }
                Ok(None) => {
                    if !timed_out && Instant::now() >= deadline {
                        timed_out = true;
                        let _ = c.kill();
                    }
                }
                Err(e) => {
                    wait_err = Some(format!("lost track of git: {e}"));
                    let _ = c.kill();
                    *guard = None;
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    if let Some(key) = spec.cancel_key {
        let mut reg = registry().lock().unwrap();
        reg.retain(|(k, s)| !(k == key && Arc::ptr_eq(s, &slot)));
    }

    // Only wait for the pipe threads when git ended on its own terms. If we
    // killed it, its descendants may still hold the write ends and joining could
    // block for as long as the hang we just escaped.
    let cancelled = slot.cancelled.load(Ordering::Relaxed);
    if !timed_out && !cancelled {
        if let Some(w) = writer {
            let _ = w.join();
        }
        let _ = out_thread.join();
        let _ = err_thread.join();
    }
    let raw = std::mem::take(&mut *out_buf.lock().unwrap());
    let stdout = String::from_utf8_lossy(&raw).into_owned();
    let stderr = String::from_utf8_lossy(&err_buf.lock().unwrap()).into_owned();

    let verb = spec.args.first().copied().unwrap_or("command");
    if let Some(e) = wait_err {
        record(&repo, &argv, false, started, &e);
        return Err(e);
    }
    if cancelled {
        let msg = format!("git {verb} was cancelled");
        record(&repo, &argv, false, started, &msg);
        return Err(msg);
    }
    if timed_out {
        let msg = format!(
            "git {verb} timed out after {}s and was stopped.{}",
            spec.timeout.as_secs(),
            if spec.cancel_key.is_some() {
                " A remote that needs credentials this process can't supply is the usual cause."
            } else {
                ""
            }
        );
        record(&repo, &argv, false, started, &msg);
        return Err(msg);
    }

    // What the scrollback keeps. On success only stderr, which is where git puts
    // progress and warnings — a successful read's stdout is the data the panel is
    // already showing. On failure both, stderr first because it carries the reason
    // ("not something we can merge") while stdout carries the detail (which files
    // conflicted), and for some commands stdout is the only one that speaks.
    let noise = if success {
        stderr.trim().to_owned()
    } else {
        [stderr.trim(), stdout.trim()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    };
    record(&repo, &argv, success, started, &noise);
    Ok(Output { ok: success, stdout, stderr, raw })
}

fn record(repo: &str, argv: &str, ok: bool, started: Instant, output: &str) {
    let rec = CommandRecord {
        id: next_id(),
        repo: repo.to_owned(),
        argv: argv.to_owned(),
        ok,
        ms: started.elapsed().as_millis() as u64,
        output: super::tail(output.trim(), if ok { KEEP_OK } else { KEEP_FAIL }),
    };
    let mut log = ring().lock().unwrap();
    if log.len() >= RING {
        log.pop_front();
    }
    log.push_back(rec);
}

/// Kill whatever network op is in flight for `key`, newest first. Returns how
/// many children were signalled — zero means the op had already finished, which
/// the caller can report as "nothing to cancel" rather than an error.
pub fn cancel(key: &str) -> usize {
    let victims: Vec<Arc<Running>> = {
        let reg = registry().lock().unwrap();
        reg.iter().filter(|(k, _)| k == key).map(|(_, s)| Arc::clone(s)).collect()
    };
    let mut killed = 0;
    for v in victims {
        v.cancelled.store(true, Ordering::Relaxed);
        let mut guard = v.child.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            if c.kill().is_ok() {
                killed += 1;
            }
        }
    }
    killed
}

/// The scrollback for one repo, oldest first.
pub fn history(repo: &str) -> Vec<CommandRecord> {
    ring()
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.repo == repo)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The deadline has to actually fire, and it has to fire as an error rather
    /// than as an empty success — a caller that mistook a killed child for a
    /// finished one would report "no changes" for a command that never ran.
    #[test]
    fn a_hung_git_is_killed_at_its_deadline() {
        let dir = std::env::temp_dir();
        // An alias that sleeps: the closest thing to "git hangs" we can arrange
        // without a network. Git for Windows ships the shell that runs it.
        let spec = Spec {
            args: &["-c", "alias.zzz=!sleep 30", "zzz"],
            stdin: None,
            timeout: Duration::from_millis(400),
            cancel_key: None,
        };
        let before = Instant::now();
        let out = exec(&dir, spec);
        // On a box without `sleep` the alias fails instantly; that's a different
        // outcome but not a wrong one, so only assert when it really did hang.
        if before.elapsed() >= Duration::from_millis(400) {
            let err = out.expect_err("a killed child must not read as success");
            assert!(err.contains("timed out"), "{err}");
        }
    }

    /// Every invocation shows up in the scrollback with its own repo attached —
    /// the panel filters by repo, so a shared ring that lost that would show one
    /// project's commands under another.
    #[test]
    fn the_ring_keeps_commands_per_repo() {
        let dir = std::env::temp_dir().join("workbench-ring-probe");
        std::fs::create_dir_all(&dir).unwrap();
        let _ = exec(&dir, Spec::local(&["rev-parse", "--is-inside-work-tree"]));
        let mine = history(&dir.to_string_lossy());
        assert!(mine.iter().any(|r| r.argv.contains("rev-parse")));
        assert!(mine.iter().all(|r| r.repo == dir.to_string_lossy()));
        assert!(history("C:/nowhere-at-all").is_empty());
    }

    /// Cancelling something that isn't running is a no-op, not a panic — the
    /// button can always be pressed, including a moment after git finished.
    #[test]
    fn cancelling_nothing_is_harmless() {
        assert_eq!(cancel("C:/not-a-repo"), 0);
    }
}
