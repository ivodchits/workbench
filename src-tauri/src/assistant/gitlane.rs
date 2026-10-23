//! Duck's background git lanes (step L4), for its data repo (the workspace).
//!
//! The mechanical lane is the shared git queue (`gitqueue`): memory commits are
//! already queued there (`memory::commit`), and the backup push here queues behind
//! them, so a push never races a commit and nothing git-related blocks a reply.
//! What needs judgment (a push the remote rejected, a lock left behind, a
//! conflict) goes back to the engine as the push's `outcome`, and the engine hands
//! it to a background worker (`src/assistant/housekeeping.ts`).
//!
//! Housekeeping's mechanical part is here too ([`housekeep`]): task retention, the
//! leftovers no commit took, and `git gc --auto`. The judgment part (tidying the
//! memory files) is a worker's, on a branch, which [`review_branch`] reads.
//!
//! The push is the trust floor's one named exception (`duck-data-push`): only this
//! repo, only its `origin`, its own branch, and never forced. The arguments are
//! fixed here and [`refuse_force`] checks them anyway.

use std::path::Path;
use std::sync::mpsc;

use serde::Serialize;

use crate::git::run::{exec, Spec};
use crate::gitqueue;

/// Where the backup goes, and how far behind it is.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    /// The workspace is a git repo (Duck's first memory write makes it one).
    pub repo: bool,
    pub remote: Option<String>,
    pub branch: Option<String>,
    /// Commits not on the remote yet; null when it was never pushed.
    pub ahead: Option<u32>,
}

/// What a push came to. `outcome` is one of `pushed`, `nothing` (the remote had it
/// all), `no_remote`, `no_repo`, `offline`, `auth`, `rejected` (the remote moved),
/// `lock` (a lock file left behind), `detached`, `failed`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub outcome: &'static str,
    pub detail: String,
}

fn outcome(outcome: &'static str, detail: impl Into<String>) -> PushOutcome {
    PushOutcome { outcome, detail: detail.into() }
}

/// Refuse any push that could overwrite the remote's history.
pub fn refuse_force(args: &[&str]) -> Result<(), String> {
    for a in args {
        let forced = *a == "-f"
            || a.starts_with("--force")
            || *a == "--mirror"
            || *a == "--delete"
            || *a == "-d"
            || (a.starts_with('+') && a.len() > 1)
            || (a.starts_with('-') && !a.starts_with("--") && a.contains('f'));
        if forced {
            return Err(format!("a forced push ({a}) is never allowed for Duck's data"));
        }
    }
    Ok(())
}

fn remote_url(repo: &Path) -> Option<String> {
    gitqueue::output(repo, &["remote", "get-url", "origin"])
        .ok()
        .filter(|o| o.ok)
        .map(|o| o.stdout.trim().to_string())
        .filter(|u| !u.is_empty())
}

fn branch(repo: &Path) -> Option<String> {
    gitqueue::run(repo, &["symbolic-ref", "-q", "--short", "HEAD"])
        .ok()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
}

pub fn status(workspace: &Path) -> BackupStatus {
    if !workspace.join(".git").exists() {
        return BackupStatus { repo: false, remote: None, branch: None, ahead: None };
    }
    let branch = branch(workspace);
    let ahead = branch.as_ref().and_then(|b| {
        let range = format!("refs/remotes/origin/{b}..HEAD");
        gitqueue::run(workspace, &["rev-list", "--count", &range]).ok().and_then(|n| n.trim().parse().ok())
    });
    BackupStatus { repo: true, remote: remote_url(workspace), branch, ahead }
}

fn classify(err: &str) -> &'static str {
    let e = err.to_lowercase();
    if e.contains("non-fast-forward") || e.contains("fetch first") || e.contains("[rejected]") || e.contains("rejected") {
        "rejected"
    } else if e.contains(".lock") {
        "lock"
    } else if e.contains("authentication") || e.contains("permission denied") || e.contains("could not read username") || e.contains("403") {
        "auth"
    } else if e.contains("does not appear to be a git repository") || e.contains("no such remote") {
        "no_remote"
    } else if e.contains("could not resolve host")
        || e.contains("unable to access")
        || e.contains("failed to connect")
        || e.contains("timed out")
        || e.contains("connection")
    {
        "offline"
    } else {
        "failed"
    }
}

/// Push the workspace's branch to `origin`, now. Called from a git queue job.
pub fn push_now(repo: &Path) -> PushOutcome {
    if !repo.join(".git").exists() {
        return outcome("no_repo", "Duck's workspace isn't a git repo yet");
    }
    if remote_url(repo).is_none() {
        return outcome("no_remote", "no backup remote is set up");
    }
    let Some(b) = branch(repo) else {
        return outcome("detached", "the workspace is on a detached HEAD");
    };
    let refspec = format!("HEAD:refs/heads/{b}");
    let args = ["push", "--porcelain", "origin", refspec.as_str()];
    if let Err(e) = refuse_force(&args) {
        return outcome("failed", e);
    }
    let key = repo.to_string_lossy().into_owned();
    match exec(repo, Spec::network(&args, &key)) {
        Err(e) => outcome(classify(&e), e),
        Ok(o) if o.ok => {
            // Porcelain: a line per ref, `=` when it was already there.
            let same = o.stdout.lines().any(|l| l.starts_with("=\t"));
            if same {
                outcome("nothing", "the backup was up to date")
            } else {
                outcome("pushed", format!("pushed {b}"))
            }
        }
        Ok(o) => {
            let text = format!("{}\n{}", o.stdout.trim(), o.stderr.trim());
            outcome(classify(&text), text.trim().to_string())
        }
    }
}

/// Queue a push behind the repo's other git jobs, and wait for it.
pub fn push(workspace: &Path) -> PushOutcome {
    let (tx, rx) = mpsc::channel();
    gitqueue::submit(workspace, move |repo| {
        let _ = tx.send(push_now(repo));
    });
    rx.recv().unwrap_or_else(|_| outcome("failed", "the git queue dropped the push"))
}

const README: &str = "# Duck's data\n\nDuck's memory, skills, config and task folders, kept by Workbench's Duck.\n\n**Private.** This is personal memory: keep this repository private, and don't share it.\n";

/// Set up the backup: make the workspace a repo, add a README saying it's private,
/// and create a private GitHub repo as `origin` with `gh`, pushing to it. Returns
/// the remote's URL. The caller asked first (a card, or your click in settings).
pub fn create(workspace: &Path, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 || name.chars().any(|c| !(c.is_ascii_alphanumeric() || "-_.".contains(c))) {
        return Err("a repo name is letters, digits, - _ and .".into());
    }
    if let Some(url) = remote_url(workspace) {
        return Err(format!("Duck's data already has a backup remote: {url}"));
    }
    let gh = which::which("gh").map_err(|_| "the GitHub CLI (gh) isn't on PATH".to_string())?;
    if !workspace.join("README.md").exists() {
        std::fs::write(workspace.join("README.md"), README).map_err(|e| e.to_string())?;
    }
    let (tx, rx) = mpsc::channel();
    gitqueue::submit(workspace, move |repo| {
        let _ = tx.send(super::memory::commit_now(repo, &["README.md".to_string()], "Duck: README (this repo is private)"));
    });
    rx.recv().map_err(|_| "the git queue dropped the commit".to_string())??;
    let mut cmd = std::process::Command::new(gh);
    cmd.args(["repo", "create", name, "--private", "--source"])
        .arg(workspace)
        .args(["--remote", "origin", "--push"])
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("cannot run gh: {e}"))?;
    if !out.status.success() {
        return Err(format!("gh repo create: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    remote_url(workspace).ok_or_else(|| "gh made the repo but set no origin".into())
}

/// What a branch of the workspace changes against its merge base with HEAD, for
/// deciding whether a housekeeping run only tidied.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchReview {
    pub files: Vec<String>,
    /// Memory entries (bullets) the branch removes whose text isn't anywhere in what
    /// it adds: really gone, not moved or merged.
    pub removed: Vec<String>,
    /// Memory entries it adds or rewrites.
    pub added: usize,
}

/// An entry's fact, without its date and its `(src: …)` tail, lower-cased: what a
/// move or a rewording keeps.
fn fact(line: &str) -> String {
    let s = line.trim().trim_start_matches("- ").trim();
    let s = match s.split_once(" — ") {
        Some((d, rest)) if d.len() == 10 && d.chars().all(|c| c.is_ascii_digit() || c == '-') => rest,
        _ => s,
    };
    let s = s.rsplit_once(" (src:").map_or(s, |(a, _)| a);
    s.split_once(" Why:").map_or(s, |(a, _)| a).trim().trim_end_matches('.').to_lowercase()
}

pub fn review_branch(workspace: &Path, branch: &str) -> Result<BranchReview, String> {
    if branch.starts_with('-') || branch.contains("..") {
        return Err("not a branch name".into());
    }
    let range = format!("HEAD...{branch}");
    let files: Vec<String> = gitqueue::run(workspace, &["diff", "--name-only", &range])?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let diff = gitqueue::run(workspace, &["diff", "--unified=0", &range, "--", "memory/"])?;
    let mut gone: Vec<String> = Vec::new();
    let mut added: Vec<String> = Vec::new();
    for l in diff.lines() {
        if l.starts_with("---") || l.starts_with("+++") {
            continue;
        }
        if let Some(e) = l.strip_prefix("-- ") {
            gone.push(format!("- {e}"));
        } else if let Some(e) = l.strip_prefix("+- ") {
            added.push(format!("- {e}"));
        }
    }
    let kept: Vec<String> = added.iter().map(|a| fact(a)).collect();
    let removed = gone
        .into_iter()
        .filter(|g| {
            let f = fact(g);
            !f.is_empty() && !kept.iter().any(|k| k == &f || k.contains(&f))
        })
        .collect();
    Ok(BranchReview { files, removed, added: added.len() })
}

// ── housekeeping's mechanical part ──

/// What a task folder keeps forever; the rest goes once it's old.
const KEEP: [&str; 3] = ["brief.md", "result.md", "result.json"];
const INDEX: &str = "tasks/INDEX.md";
const INDEX_HEAD: &str = "# Tasks\n\nOne line per task folder older than 30 days. Each folder keeps its brief and its result; the files a worker made on the way are gone.\n\n";

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HousekeepReport {
    /// Folders newly listed in `tasks/INDEX.md`.
    pub indexed: Vec<String>,
    /// Intermediate files removed from old task folders, and their size.
    pub removed: u32,
    pub bytes: u64,
    /// Files committed that no commit had taken (memory, config, the index, old
    /// tasks' results).
    pub committed: Vec<String>,
}

fn remove_all_but_keep(dir: &Path, top: bool, report: &mut HousekeepReport) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            remove_all_but_keep(&p, false, report);
            let _ = std::fs::remove_dir(&p);
        } else if !(top && KEEP.contains(&name.as_str())) {
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            if std::fs::remove_file(&p).is_ok() {
                report.removed += 1;
                report.bytes += size;
            }
        }
    }
}

/// Fold task folders dated before `cutoff` (YYYY-MM-DD) into `tasks/INDEX.md` and
/// clear their intermediate files.
fn tidy_tasks(ws: &Path, cutoff: &str, report: &mut HousekeepReport) -> Result<(), String> {
    let tasks = ws.join("tasks");
    let Ok(rd) = std::fs::read_dir(&tasks) else { return Ok(()) };
    let mut names: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.len() > 10 && n.as_bytes()[10] == b'-' && n[..10].bytes().all(|b| b.is_ascii_digit() || b == b'-'))
        .filter(|n| &n[..10] < cutoff)
        .collect();
    names.sort();
    let index_path = ws.join(INDEX);
    let mut index = std::fs::read_to_string(&index_path).unwrap_or_else(|_| INDEX_HEAD.to_string());
    for n in names {
        let dir = tasks.join(&n);
        remove_all_but_keep(&dir, true, report);
        let at = format!("(tasks/{n}/)");
        if index.contains(&at) {
            continue;
        }
        let title = std::fs::read_to_string(dir.join("brief.md"))
            .ok()
            .and_then(|b| b.lines().next().map(|l| l.trim_start_matches('#').trim().to_string()))
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| n[11..].replace('-', " "));
        let headline = std::fs::read_to_string(dir.join("result.json"))
            .ok()
            .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
            .and_then(|v| v["headline"].as_str().map(str::to_string))
            .unwrap_or_else(|| "no result".into());
        if !index.ends_with('\n') {
            index.push('\n');
        }
        index.push_str(&format!("- {} — {title}: {} {at}\n", &n[..10], headline.replace('\n', " ")));
        report.indexed.push(n);
    }
    if !report.indexed.is_empty() {
        std::fs::write(&index_path, index).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Housekeeping's mechanical part, on the git queue: old tasks folded into the
/// index, the files no commit took committed (a hand edit of the memory, the
/// prompts or `reminders.json`), and `git gc --auto`.
pub fn housekeep(workspace: &Path, cutoff: &str) -> Result<HousekeepReport, String> {
    if cutoff.len() != 10 || !cutoff.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err("the cutoff is a date, YYYY-MM-DD".into());
    }
    let cutoff = cutoff.to_string();
    let (tx, rx) = mpsc::channel();
    gitqueue::submit(workspace, move |repo| {
        let run = || -> Result<HousekeepReport, String> {
            let mut report = HousekeepReport::default();
            tidy_tasks(repo, &cutoff, &mut report)?;
            if !repo.join(".git").exists() {
                return Ok(report);
            }
            let mut files: Vec<String> = gitqueue::run(repo, &["status", "--porcelain", "-uall", "--", "memory", "config", super::reminders::FILE])?
                .lines()
                .filter_map(|l| l.get(3..).map(|p| p.trim().trim_matches('"').to_string()))
                .filter(|p| !p.is_empty())
                .collect();
            if !report.indexed.is_empty() {
                files.push(INDEX.into());
                for n in &report.indexed {
                    files.extend(KEEP.iter().map(|k| format!("tasks/{n}/{k}")));
                }
            }
            if !files.is_empty() && super::memory::commit_now(repo, &files, "Duck: housekeeping")? {
                report.committed = files.into_iter().filter(|f| repo.join(f).exists()).collect();
            }
            let _ = gitqueue::run(repo, &["gc", "--auto", "-q"]);
            Ok(report)
        };
        let _ = tx.send(run());
    });
    rx.recv().map_err(|_| "the git queue dropped housekeeping".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wb-gitlane-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let mut all = vec!["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
        all.extend_from_slice(args);
        gitqueue::run(dir, &all).unwrap()
    }

    fn put(dir: &Path, path: &str, text: &str) {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// A workspace with a commit, and a bare repo as its origin.
    fn lab(name: &str) -> (PathBuf, PathBuf) {
        let root = temp(name);
        let (ws, remote) = (root.join("ws"), root.join("remote.git"));
        std::fs::create_dir_all(&ws).unwrap();
        gitqueue::run(&root, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]).unwrap();
        gitqueue::run(&ws, &["init", "-q", "-b", "main"]).unwrap();
        put(&ws, "memory/decisions.md", "- 2026-10-01 — use SQLite. (src: thread:a)\n");
        git(&ws, &["add", "-A"]);
        git(&ws, &["commit", "-q", "-m", "one"]);
        git(&ws, &["remote", "add", "origin", remote.to_str().unwrap()]);
        (ws, remote)
    }

    #[test]
    fn ten_memory_writes_commit_in_the_background_and_the_push_waits_for_them() {
        let (ws, remote) = lab("ten");
        let started = std::time::Instant::now();
        for i in 0..10 {
            put(&ws, &format!("memory/projects/p{i}.md"), &format!("- fact {i}\n"));
            super::super::memory::commit(&ws, vec![format!("memory/projects/p{i}.md")], format!("Duck memory: fact {i}"));
        }
        // Queuing them costs the caller nothing: no git ran on this thread.
        assert!(started.elapsed() < std::time::Duration::from_millis(100), "{:?}", started.elapsed());
        // The push is queued behind them, so it carries all ten.
        assert_eq!(push(&ws).outcome, "pushed");
        let log = gitqueue::run(&remote, &["log", "--format=%s", "main"]).unwrap();
        assert_eq!(log.lines().filter(|l| l.starts_with("Duck memory: fact")).count(), 10);
    }

    #[test]
    fn force_is_refused_in_every_spelling() {
        for a in ["-f", "--force", "--force-with-lease", "+HEAD:refs/heads/main", "--mirror", "--delete", "-fq", "-d"] {
            assert!(refuse_force(&["push", "origin", a]).is_err(), "{a}");
        }
        assert!(refuse_force(&["push", "--porcelain", "origin", "HEAD:refs/heads/main"]).is_ok());
        assert!(refuse_force(&["push", "-q", "origin", "HEAD:refs/heads/main"]).is_ok());
    }

    #[test]
    fn pushes_then_has_nothing_to_push() {
        let (ws, _remote) = lab("push");
        assert_eq!(status(&ws).ahead, None);
        assert_eq!(push(&ws).outcome, "pushed");
        assert_eq!(push(&ws).outcome, "nothing");
        let s = status(&ws);
        assert_eq!((s.repo, s.branch.as_deref(), s.ahead), (true, Some("main"), Some(0)));
        put(&ws, "memory/goals.md", "- ship L4\n");
        git(&ws, &["add", "-A"]);
        git(&ws, &["commit", "-q", "-m", "two"]);
        assert_eq!(status(&ws).ahead, Some(1));
        assert_eq!(push(&ws).outcome, "pushed");
    }

    #[test]
    fn a_remote_that_moved_is_rejected_not_forced() {
        let (ws, remote) = lab("moved");
        assert_eq!(push(&ws).outcome, "pushed");
        // Another machine pushes first.
        let other = ws.parent().unwrap().join("other");
        gitqueue::run(ws.parent().unwrap(), &["clone", "-q", remote.to_str().unwrap(), other.to_str().unwrap()]).unwrap();
        put(&other, "memory/people.md", "- Ann\n");
        git(&other, &["add", "-A"]);
        git(&other, &["commit", "-q", "-m", "theirs"]);
        git(&other, &["push", "-q", "origin", "main"]);
        put(&ws, "memory/goals.md", "- mine\n");
        git(&ws, &["add", "-A"]);
        git(&ws, &["commit", "-q", "-m", "mine"]);
        let o = push(&ws);
        assert_eq!(o.outcome, "rejected", "{o:?}");
        // The remote still has their commit on top.
        let log = gitqueue::run(&remote, &["log", "--format=%s", "main"]).unwrap();
        assert_eq!(log.lines().next(), Some("theirs"));
    }

    #[test]
    fn no_remote_and_no_repo_say_so() {
        let d = temp("bare");
        assert_eq!(push(&d).outcome, "no_repo");
        gitqueue::run(&d, &["init", "-q", "-b", "main"]).unwrap();
        assert_eq!(push(&d).outcome, "no_remote");
        assert_eq!(status(&d).remote, None);
    }

    #[test]
    fn a_review_tells_a_moved_entry_from_a_removed_one() {
        let (ws, _) = lab("review");
        put(&ws, "memory/decisions.md", "- 2026-10-01 — use SQLite. (src: thread:a)\n- 2026-10-02 — tabs over spaces. (src: thread:b)\n");
        git(&ws, &["add", "-A"]);
        git(&ws, &["commit", "-q", "-m", "two entries"]);
        git(&ws, &["checkout", "-q", "-b", "agent/tidy"]);
        // SQLite moves to another file, reworded around the same fact; tabs is dropped.
        put(&ws, "memory/decisions.md", "");
        put(&ws, "memory/projects/notes.md", "- 2026-10-01 — Use SQLite for notes sync. (src: thread:a)\n");
        put(&ws, "tasks/INDEX.md", "# Tasks\n");
        git(&ws, &["add", "-A"]);
        git(&ws, &["commit", "-q", "-m", "tidy"]);
        git(&ws, &["checkout", "-q", "main"]);
        let r = review_branch(&ws, "agent/tidy").unwrap();
        assert_eq!(r.files, ["memory/decisions.md", "memory/projects/notes.md", "tasks/INDEX.md"]);
        assert_eq!(r.removed, ["- 2026-10-02 — tabs over spaces. (src: thread:b)"]);
        assert_eq!(r.added, 1);
        assert!(review_branch(&ws, "--all").is_err());
    }

    #[test]
    fn housekeeping_folds_old_tasks_and_commits_leftovers() {
        let (ws, _) = lab("keep");
        let old = "tasks/2026-09-01-find-a-flight";
        put(&ws, &format!("{old}/brief.md"), "# Find a flight\n\nTo Lisbon.\n");
        put(&ws, &format!("{old}/result.json"), r#"{"status":"done","headline":"TAP on the 3rd, 140 EUR","question":null}"#);
        put(&ws, &format!("{old}/result.md"), "TAP\n");
        put(&ws, &format!("{old}/notes/search.html"), &"x".repeat(5000));
        put(&ws, &format!("{old}/draft.txt"), "draft");
        put(&ws, "tasks/2026-10-20-recent/scratch.txt", "kept: not old yet");
        // A memory write whose commit never happened.
        put(&ws, "memory/goals.md", "- ship L4\n");
        let r = housekeep(&ws, "2026-09-22").unwrap();
        assert_eq!(r.indexed, ["2026-09-01-find-a-flight"]);
        assert_eq!((r.removed, r.bytes), (2, 5005));
        assert!(ws.join(format!("{old}/result.md")).exists() && !ws.join(format!("{old}/notes")).exists());
        assert!(ws.join("tasks/2026-10-20-recent/scratch.txt").exists());
        let index = std::fs::read_to_string(ws.join(INDEX)).unwrap();
        assert!(index.contains("- 2026-09-01 — Find a flight: TAP on the 3rd, 140 EUR (tasks/2026-09-01-find-a-flight/)"), "{index}");
        assert!(r.committed.contains(&"memory/goals.md".to_string()) && r.committed.contains(&INDEX.to_string()));
        assert_eq!(gitqueue::run(&ws, &["status", "--porcelain", "--", "memory", "tasks/INDEX.md"]).unwrap(), "");
        // Again: nothing new to fold or commit.
        assert_eq!(housekeep(&ws, "2026-09-22").unwrap(), HousekeepReport::default());
        assert!(housekeep(&ws, "soon").is_err());
    }
}
