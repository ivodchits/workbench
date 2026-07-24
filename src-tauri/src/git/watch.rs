//! Telling the Git panel that the repo moved under it (step G8).
//!
//! Workbench's whole premise is that something *else* is working in this repo:
//! an agent commits, a terminal rebases, an editor saves. A panel that only
//! updates when you click Refresh is therefore showing you the past by
//! construction, and the longer you leave it open the more confidently wrong it
//! gets. So we watch the repo and say what changed.
//!
//! Three decisions worth stating.
//!
//! **What we watch.** The working tree recursively, plus the git directory when
//! it lives outside the working tree (a linked worktree's does, and its common
//! dir is the main repo's `.git`). The recursive working-tree watch necessarily
//! sees `.git/objects` churn; rather than trying to carve it out of the watch —
//! which no backend supports — we drop it in `classify`, where it costs a string
//! comparison and produces no refresh.
//!
//! **What we say.** Not "something changed" but *which slices* changed: writing
//! the index is a status change and nothing else, while moving HEAD changes
//! nearly everything. The panel reloads only what it's told to, which is the
//! other half of G8's targeted refresh — a watcher that shouted "reload!" at
//! every keystroke in the working tree would be worse than no watcher.
//!
//! **How often.** Events are coalesced to a quiet period, with a ceiling so a
//! continuous stream (a build writing into the tree) still produces a refresh
//! rather than being starved out forever. A `git commit` fires a dozen events
//! across `index`, `logs/`, `refs/` and `COMMIT_EDITMSG`; one refresh is the
//! correct response to all of them.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// How long the repo has to be quiet before we emit. Long enough to swallow the
/// burst a single git command produces, short enough that "within a second"
/// holds for the common case.
const QUIET: Duration = Duration::from_millis(250);

/// Emit anyway once events have been arriving for this long without a gap — a
/// long-running build in the working tree would otherwise keep resetting the
/// quiet timer and the panel would never update while it ran.
const MAX_WAIT: Duration = Duration::from_millis(1500);

/// Never emit more often than this, whatever the filesystem is doing.
const MIN_GAP: Duration = Duration::from_millis(750);

/// The event the frontend listens for.
pub const EVENT: &str = "git-changed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changed {
    /// The repo root exactly as it was passed to `start`, so the panel can match
    /// it against its own without normalising anything.
    repo_root: String,
    /// Which slices of the panel's state are now stale. See `classify`.
    slices: Vec<&'static str>,
}

/// Slices a panel can reload independently. Strings rather than an enum because
/// they cross to TypeScript, where they're the same vocabulary the panel's own
/// targeted refresh uses.
const STATUS: &str = "status";
const REFS: &str = "refs";
const HISTORY: &str = "history";
const STATE: &str = "state";
const STASHES: &str = "stashes";
const TAGS: &str = "tags";

#[derive(Default)]
struct Pending {
    slices: BTreeSet<&'static str>,
    /// When the current burst started — the clock `MAX_WAIT` runs against.
    first: Option<Instant>,
    /// The most recent event — the clock `QUIET` runs against.
    last: Option<Instant>,
}

struct Entry {
    /// How many panels asked for this repo. The watcher goes away with the last.
    refs: usize,
    /// Set when the last panel leaves; the emitter thread reads it and exits.
    stop: Arc<AtomicBool>,
    /// Held only to keep it alive: dropping a `Watcher` unwatches everything.
    _watchers: Vec<RecommendedWatcher>,
}

fn watches() -> &'static Mutex<HashMap<String, Entry>> {
    static W: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start watching `repo_root`, or take another reference on an existing watch.
///
/// Best-effort by design: a repo on a filesystem the backend can't watch returns
/// an error the panel treats as "no auto-refresh here", not as a broken panel.
pub fn start(app: &AppHandle, repo_root: &str) -> Result<(), String> {
    let mut map = watches().lock().unwrap();
    if let Some(e) = map.get_mut(repo_root) {
        e.refs += 1;
        return Ok(());
    }

    let root = PathBuf::from(repo_root);
    if !root.is_dir() {
        return Err(format!("not a directory: {repo_root}"));
    }
    let dirs = git_dirs(&root);

    let pending = Arc::new(Mutex::new(Pending::default()));
    let stop = Arc::new(AtomicBool::new(false));

    // One watcher per root we watch. `notify` allows several paths on a single
    // watcher, but a per-path watcher means a failure to watch the git dir of a
    // linked worktree doesn't cost us the working-tree watch as well.
    let mut targets: Vec<PathBuf> = vec![root.clone()];
    for d in &dirs {
        if !d.starts_with(&root) {
            targets.push(d.clone());
        }
    }

    let mut watchers = Vec::new();
    for target in targets {
        let pending = Arc::clone(&pending);
        let dirs = dirs.clone();
        let handler = move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            let mut hit: BTreeSet<&'static str> = BTreeSet::new();
            for p in &ev.paths {
                if let Some(slices) = classify(p, &dirs) {
                    hit.extend(slices);
                }
            }
            if hit.is_empty() {
                return;
            }
            let now = Instant::now();
            let mut pend = pending.lock().unwrap();
            pend.slices.extend(hit);
            pend.first.get_or_insert(now);
            pend.last = Some(now);
        };
        match RecommendedWatcher::new(handler, Config::default()) {
            Ok(mut w) => match w.watch(&target, RecursiveMode::Recursive) {
                Ok(()) => watchers.push(w),
                Err(e) => {
                    if target == root {
                        return Err(format!("cannot watch {}: {e}", target.display()));
                    }
                }
            },
            Err(e) => return Err(format!("cannot watch {}: {e}", target.display())),
        }
    }
    if watchers.is_empty() {
        return Err(format!("cannot watch {repo_root}"));
    }

    spawn_emitter(app.clone(), repo_root.to_owned(), pending, Arc::clone(&stop));
    map.insert(repo_root.to_owned(), Entry { refs: 1, stop, _watchers: watchers });
    Ok(())
}

/// Drop a reference; the last one out tears the watch down. Unknown roots are
/// ignored — a panel closing after its repo was un-registered is normal.
pub fn stop(repo_root: &str) {
    let mut map = watches().lock().unwrap();
    let Some(e) = map.get_mut(repo_root) else { return };
    e.refs = e.refs.saturating_sub(1);
    if e.refs == 0 {
        e.stop.store(true, Ordering::Relaxed);
        map.remove(repo_root);
    }
}

/// The coalescing thread: the only place that decides an event burst is over.
fn spawn_emitter(
    app: AppHandle,
    repo_root: String,
    pending: Arc<Mutex<Pending>>,
    stop: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut last_emit: Option<Instant> = None;
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(80));
            let now = Instant::now();
            let slices = {
                let mut pend = pending.lock().unwrap();
                if !due(&pend, now, last_emit) {
                    continue;
                }
                pend.first = None;
                pend.last = None;
                std::mem::take(&mut pend.slices)
            };
            if slices.is_empty() {
                continue;
            }
            last_emit = Some(now);
            let _ = app.emit(
                EVENT,
                Changed { repo_root: repo_root.clone(), slices: slices.into_iter().collect() },
            );
        }
    });
}

/// Whether a burst of events has become a refresh.
///
/// Three clocks, and all three matter. It has to have gone quiet (`QUIET`), or
/// we'd emit in the middle of a `git commit`'s dozen writes. It can't wait for
/// quiet *forever* (`MAX_WAIT`), or a build writing into the tree would starve
/// the panel of updates for as long as it ran. And it can't fire faster than
/// `MIN_GAP` however busy the repo is, because each emit costs a git read.
fn due(pend: &Pending, now: Instant, last_emit: Option<Instant>) -> bool {
    let (Some(first), Some(last)) = (pend.first, pend.last) else { return false };
    if last_emit.is_some_and(|t| now.duration_since(t) < MIN_GAP) {
        return false;
    }
    now.duration_since(last) >= QUIET || now.duration_since(first) >= MAX_WAIT
}

/// The git directories belonging to `root`: its own, plus the common dir it
/// shares when `root` is a linked worktree (refs and the object store live in the
/// main repo's `.git`, so a branch created elsewhere shows up there, not here).
fn git_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(d) = super::git_output(root, &["rev-parse", "--absolute-git-dir"]) {
        out.push(PathBuf::from(d));
    }
    if let Some(d) = super::git_output(root, &["rev-parse", "--git-common-dir"]) {
        let p = PathBuf::from(&d);
        out.push(if p.is_absolute() { p } else { root.join(p) });
    }
    if out.is_empty() {
        out.push(root.join(".git"));
    }
    out.dedup();
    // Longest first. A linked worktree's own git dir lives *inside* the common
    // one (`.git/worktrees/<name>`), so testing the shorter path first would
    // match everything against the common dir and classify `worktrees/x/HEAD` —
    // which is nothing — instead of `HEAD`.
    out.sort_by_key(|p| std::cmp::Reverse(p.as_os_str().len()));
    out
}

/// Which slices a changed path invalidates, or `None` for a path no view of the
/// repo depends on.
///
/// The git-directory cases are the interesting ones: they're what let a commit
/// made in a terminal refresh history and branches without also re-reading the
/// working tree, and what stop `.git/objects` — by far the noisiest thing under a
/// repo — from causing any work at all.
fn classify(path: &Path, git_dirs: &[PathBuf]) -> Option<Vec<&'static str>> {
    for gd in git_dirs {
        if let Ok(rel) = path.strip_prefix(gd) {
            return classify_git(&rel.to_string_lossy().replace('\\', "/"));
        }
    }
    // Anything else under the watch is working-tree content.
    Some(vec![STATUS])
}

fn classify_git(rel: &str) -> Option<Vec<&'static str>> {
    // Object writes are the bulk of git's filesystem traffic and mean nothing on
    // their own — a commit is only visible once its ref moves. Lock files are the
    // same event twice (create, rename-away), and the message buffer is scratch.
    if rel.starts_with("objects/")
        || rel.starts_with("lfs/")
        || rel.starts_with("hooks/")
        || rel.starts_with("info/")
        || rel.ends_with(".lock")
        || rel == "COMMIT_EDITMSG"
    {
        return None;
    }
    // The stash is a ref, so it has to be tested before the general ref cases.
    if rel.starts_with("refs/stash") || rel.starts_with("logs/refs/stash") {
        return Some(vec![STASHES]);
    }
    if rel.starts_with("refs/tags/") {
        return Some(vec![TAGS, HISTORY]);
    }
    if rel == "packed-refs" {
        // One file holding branches and tags both, so it invalidates both.
        return Some(vec![REFS, TAGS, HISTORY]);
    }
    if rel.starts_with("refs/") || rel.starts_with("logs/") {
        return Some(vec![REFS, HISTORY]);
    }
    if rel.starts_with("rebase-merge")
        || rel.starts_with("rebase-apply")
        || rel.starts_with("sequencer")
        || matches!(rel, "MERGE_HEAD" | "MERGE_MSG" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "BISECT_LOG")
    {
        return Some(vec![STATE, STATUS]);
    }
    match rel {
        // A checkout: the branch changed, and with it what's staged, what's
        // ahead/behind, and which commits are reachable.
        "HEAD" | "ORIG_HEAD" => Some(vec![REFS, HISTORY, STATUS, STATE]),
        "index" => Some(vec![STATUS]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The classification *is* the feature: get it wrong in the quiet direction
    /// and the panel stays stale, get it wrong in the loud direction and every
    /// object write re-reads the world.
    #[test]
    fn paths_map_to_the_views_that_depend_on_them() {
        let gd = PathBuf::from("C:/repo/.git");
        let dirs = vec![gd.clone()];
        let at = |rel: &str| classify(&gd.join(rel), &dirs);

        assert_eq!(at("objects/ab/cdef"), None, "object churn must be free");
        assert_eq!(at("index.lock"), None);
        assert_eq!(at("COMMIT_EDITMSG"), None);
        assert_eq!(at("index"), Some(vec![STATUS]));
        assert_eq!(at("refs/heads/main"), Some(vec![REFS, HISTORY]));
        assert_eq!(at("refs/tags/v1"), Some(vec![TAGS, HISTORY]));
        assert_eq!(at("refs/stash"), Some(vec![STASHES]));
        assert_eq!(at("logs/refs/stash"), Some(vec![STASHES]));
        assert_eq!(at("MERGE_HEAD"), Some(vec![STATE, STATUS]));
        assert_eq!(at("rebase-merge/done"), Some(vec![STATE, STATUS]));
        assert_eq!(at("HEAD"), Some(vec![REFS, HISTORY, STATUS, STATE]));

        // Anything outside the git dir is working-tree content, however deep.
        assert_eq!(
            classify(Path::new("C:/repo/src/deep/file.rs"), &dirs),
            Some(vec![STATUS])
        );
    }

    fn burst(first_ms_ago: u64, last_ms_ago: u64) -> Pending {
        let now = Instant::now();
        Pending {
            slices: [STATUS].into_iter().collect(),
            first: Some(now - Duration::from_millis(first_ms_ago)),
            last: Some(now - Duration::from_millis(last_ms_ago)),
        }
    }

    /// The three clocks, each checked where it's the one that decides.
    #[test]
    fn a_burst_becomes_a_refresh_when_it_settles_or_runs_long() {
        let now = Instant::now();
        assert!(!due(&Pending::default(), now, None), "nothing pending, nothing to do");
        assert!(!due(&burst(200, 40), now, None), "still arriving");
        assert!(due(&burst(400, 300), now, None), "gone quiet");
        // Events still arriving, but the burst has run long enough that waiting
        // for quiet would mean never refreshing at all.
        assert!(due(&burst(2_000, 10), now, None), "overdue");
        // …and even an overdue burst waits out the rate limit.
        assert!(!due(&burst(2_000, 10), now, Some(now - Duration::from_millis(100))));
        assert!(due(&burst(2_000, 10), now, Some(now - Duration::from_millis(900))));
    }

    /// A linked worktree's git dir sits under the main repo's `.git`, so the
    /// list has to be tried longest-first — otherwise the common dir matches
    /// first, `worktrees/agent-x/HEAD` classifies as nothing, and switching
    /// branches in a worktree never refreshes anything. `git_dirs` sorts for
    /// this; the test passes them in the unhelpful order to prove `classify`
    /// isn't quietly relying on the caller.
    #[test]
    fn a_worktrees_own_git_dir_wins_over_the_common_one() {
        let own = PathBuf::from("C:/repo/.git/worktrees/agent-x");
        let common = PathBuf::from("C:/repo/.git");
        let mut dirs = vec![common, own.clone()];
        dirs.sort_by_key(|p| std::cmp::Reverse(p.as_os_str().len()));
        assert_eq!(
            classify(&own.join("HEAD"), &dirs),
            Some(vec![REFS, HISTORY, STATUS, STATE])
        );
    }
}
