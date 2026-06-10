//! Git inspection (step 1.3) + worktree provisioning (step 2.4).
//!
//! Started as just enough git to support project registration: given a folder the
//! user picked, report whether it's a git repo and what its default branch is, plus
//! a suggested project name (the folder's basename). Step 2.4 adds the other half of
//! design §6 / decision 5/7: provisioning an isolated git worktree on its own
//! `agent/<slug>` branch when an instance flips its worktree toggle on.
//!
//! We shell out to `git` (design §9: "git2 or shell-out") rather than pull in
//! libgit2 — repo detection works from the `.git` entry alone, and `git worktree
//! add` is a single, well-trodden command — so a missing or broken `git` binary
//! degrades to "no branch detected" / a clear provisioning error instead of
//! failing the whole flow.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// What `detect_repo` learns about a candidate project folder.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// True when the folder contains a `.git` entry (directory, or a file for
    /// linked worktrees/submodules).
    pub is_git_repo: bool,
    /// The repo's default branch — the remote's `origin/HEAD` if known, else the
    /// currently checked-out branch. `None` for non-repos or a detached HEAD.
    pub default_branch: Option<String>,
    /// Suggested project name: the folder's file name.
    pub suggested_name: Option<String>,
}

/// Inspect `path` for project registration (the folder picker hands us a path).
#[tauri::command]
pub fn detect_repo(path: String) -> Result<RepoInfo, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let suggested_name = p
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::to_owned);
    let is_git_repo = p.join(".git").exists();
    let default_branch = if is_git_repo {
        detect_default_branch(p)
    } else {
        None
    };
    Ok(RepoInfo {
        is_git_repo,
        default_branch,
        suggested_name,
    })
}

/// Prefer the remote's default branch (`origin/HEAD`); fall back to the current
/// branch. A detached HEAD reports `"HEAD"`, which we treat as "no branch".
fn detect_default_branch(path: &Path) -> Option<String> {
    if let Some(remote_head) =
        git_output(path, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    {
        // e.g. "origin/main" -> "main"
        let branch = remote_head
            .rsplit('/')
            .next()
            .unwrap_or(&remote_head)
            .to_owned();
        if !branch.is_empty() {
            return Some(branch);
        }
    }
    git_output(path, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD")
}

/// Run `git -C <path> <args>` and return trimmed stdout on success, or `None` if
/// git is missing, errors, or prints nothing. On Windows, suppress the console
/// window that `CreateProcess` would otherwise flash.
fn git_output(path: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// ---------------------------------------------------------------------------
// Worktree provisioning (step 2.4) — design §6, decisions 5 & 7.
// ---------------------------------------------------------------------------

/// The worktree created for an instance: where it lives on disk and the branch it
/// was checked out on. The frontend points the instance's working dir at `path`
/// and relaunches `claude` there (design §6, step 2.4).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeResult {
    pub path: String,
    pub branch: String,
}

/// Provision an isolated worktree for an instance whose worktree toggle just went
/// on (design §6). Runs `git worktree add -b agent/<slug> <path>` from `repo_root`,
/// placing the worktree under `base_dir` (when given) or — per decision 7 — a
/// sibling `.workbench/worktrees/` next to the repo. The branch and folder name are
/// uniquified so re-using a title (or two projects sharing a sibling area) never
/// collides. Teardown/merge is the next step (2.5); this only creates.
#[tauri::command]
pub fn provision_worktree(
    repo_root: String,
    slug: String,
    base_dir: Option<String>,
) -> Result<WorktreeResult, String> {
    let root = Path::new(&repo_root);
    if !root.join(".git").exists() {
        return Err(format!("not a git repository: {repo_root}"));
    }

    let base = match base_dir.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) {
        Some(b) => PathBuf::from(b),
        None => default_worktree_base(root),
    };

    let safe = sanitize_slug(&slug);
    let (branch, path) = unique_worktree(root, &base, &safe)?;

    std::fs::create_dir_all(&base)
        .map_err(|e| format!("could not create worktree dir {}: {e}", base.display()))?;

    let path_str = path.to_string_lossy().into_owned();
    // Options before the path: the canonical `git worktree add -b <branch> <path>`
    // form, which creates `branch` off the repo's current HEAD.
    git_run(root, &["worktree", "add", "-b", &branch, &path_str])?;

    // If the worktree area lives inside the repo, keep `git status` clean by adding
    // it to the repo's *local* excludes (not the committed `.gitignore`).
    ensure_excluded(root, &base);

    Ok(WorktreeResult {
        path: path_str,
        branch,
    })
}

/// Decision 7's default location: a `.workbench/worktrees/` dir sitting next to the
/// repo (its parent), so worktrees never clutter the repo's own working tree. Falls
/// back to inside the repo when it has no parent (e.g. a drive root).
fn default_worktree_base(root: &Path) -> PathBuf {
    let anchor = root.parent().unwrap_or(root);
    anchor.join(".workbench").join("worktrees")
}

/// Slugify an instance title into a branch/dir-safe token: lowercase, runs of
/// non-alphanumeric chars collapse to a single `-`, edges trimmed. Empty input
/// (or all-punctuation) falls back to `agent` so we always have a usable name.
fn sanitize_slug(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
            prev_dash = false;
        } else if !out.is_empty() && !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "agent".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// Find a free `(branch, path)` pair for `slug`: try `slug`, then `slug-2`,
/// `slug-3`, … until both the `agent/<n>` branch is absent and the target dir
/// doesn't already exist. Bounded so a pathological repo can't spin forever.
fn unique_worktree(root: &Path, base: &Path, slug: &str) -> Result<(String, PathBuf), String> {
    for n in 1..=100 {
        let name = if n == 1 {
            slug.to_owned()
        } else {
            format!("{slug}-{n}")
        };
        let branch = format!("agent/{name}");
        let path = base.join(&name);
        if !branch_exists(root, &branch) && !path.exists() {
            return Ok((branch, path));
        }
    }
    Err(format!("could not find a free worktree name for '{slug}'"))
}

/// True when `branch` already exists in `root` (local ref). Uses `show-ref
/// --verify --quiet`, which exits 0 only when the ref resolves.
fn branch_exists(root: &Path, branch: &str) -> bool {
    git_run(root, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
}

/// When the worktree base lives inside the repo, add it to `.git/info/exclude`
/// (the repo's *local*, uncommitted ignore list) so its dirs don't show up as
/// untracked noise. Best-effort and idempotent; a no-op for the default sibling
/// location (outside the repo) and for linked worktrees (`.git` is a file).
fn ensure_excluded(root: &Path, base: &Path) {
    let rel = match base.strip_prefix(root) {
        Ok(r) => r.to_string_lossy().replace('\\', "/"),
        Err(_) => return, // outside the repo — nothing to ignore
    };
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return;
    }
    let git_dir = root.join(".git");
    if !git_dir.is_dir() {
        return;
    }
    let entry = format!("/{rel}/");
    let exclude = git_dir.join("info").join("exclude");
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|l| l.trim() == entry) {
        return;
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(&entry);
    next.push('\n');
    let _ = std::fs::create_dir_all(git_dir.join("info"));
    let _ = std::fs::write(&exclude, next);
}

// ---------------------------------------------------------------------------
// Worktree post-create setup (step 2.5) — design §6 "gotcha".
// ---------------------------------------------------------------------------

/// Outcome of the optional post-create setup run for a fresh worktree. The
/// worktree exists regardless of this result — a failing setup command is
/// surfaced but never unwinds the provisioning (design §6: the setup step is a
/// convenience, not a gate).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    /// True when nothing was configured (no `.env` copy, no command) so no work ran.
    pub skipped: bool,
    /// Top-level `.env*` filenames copied from the repo root into the worktree.
    pub copied_env: Vec<String>,
    /// The setup command that ran (echoed back for display), if any.
    pub command: Option<String>,
    /// Combined stdout+stderr of the setup command, tail-capped for display.
    pub output: String,
    /// The command's exit code, or `None` if it couldn't be launched / none ran.
    pub exit_code: Option<i32>,
    /// True when the command exited non-zero or failed to launch.
    pub failed: bool,
}

/// Run the optional post-create steps for a just-provisioned worktree (design
/// §6): copy the repo root's `.env*` files (which worktrees don't share) and/or
/// run a user-defined setup command (`npm install`, deps symlink, …) in the
/// worktree. Both are optional; an absent command and `copy_env == false` make
/// this a no-op (`skipped`). The worktree is left intact even if the command
/// fails — the caller surfaces `failed`/`output` so the user can fix it by hand.
#[tauri::command]
pub fn run_worktree_setup(
    repo_root: String,
    worktree_path: String,
    command: Option<String>,
    copy_env: bool,
) -> Result<SetupResult, String> {
    let wt = Path::new(&worktree_path);
    if !wt.is_dir() {
        return Err(format!("worktree path is not a directory: {worktree_path}"));
    }
    let cmd = command.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());

    let copied_env = if copy_env {
        copy_env_files(Path::new(&repo_root), wt)
    } else {
        Vec::new()
    };

    if cmd.is_none() && !copy_env {
        return Ok(SetupResult {
            skipped: true,
            copied_env,
            command: None,
            output: String::new(),
            exit_code: None,
            failed: false,
        });
    }

    let (exit_code, output, failed) = match &cmd {
        Some(c) => {
            let (code, out) = run_setup_command(wt, c);
            (code, tail(&out, 8_000), code != Some(0))
        }
        None => (None, String::new(), false),
    };

    Ok(SetupResult {
        skipped: false,
        copied_env,
        command: cmd,
        output,
        exit_code,
        failed,
    })
}

/// Copy every top-level `.env` / `.env.*` file from `src` into `dst`, skipping any
/// the worktree already has (never clobber). Returns the filenames copied. Worktrees
/// don't share these (they're typically git-ignored), so a fresh one needs them
/// re-seeded before `claude` or a dev server runs there. Best-effort: a read/copy
/// error on one file is silently skipped rather than failing the whole setup.
fn copy_env_files(src: &Path, dst: &Path) -> Vec<String> {
    let mut copied = Vec::new();
    let entries = match std::fs::read_dir(src) {
        Ok(e) => e,
        Err(_) => return copied,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        let name = match name.to_str() {
            Some(n) => n,
            None => continue,
        };
        // `.env` exactly, or `.env.<something>` (`.env.local`, `.env.production`),
        // but not unrelated dotfiles like `.environment`.
        if name != ".env" && !name.starts_with(".env.") {
            continue;
        }
        let target = dst.join(name);
        if target.exists() {
            continue; // the worktree already has one — leave it
        }
        if std::fs::copy(entry.path(), &target).is_ok() {
            copied.push(name.to_owned());
        }
    }
    copied
}

/// Run `command` through the platform shell in `dir`, returning its exit code (or
/// `None` if it couldn't launch) and combined stdout+stderr. Uses `cmd /C` on
/// Windows and `sh -c` elsewhere so a user's setup line ("npm ci && cp ../.env .")
/// behaves the way it would in their terminal.
fn run_setup_command(dir: &Path, command: &str) -> (Option<i32>, String) {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    cmd.current_dir(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(out) => {
            let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.trim().is_empty() {
                if !s.is_empty() && !s.ends_with('\n') {
                    s.push('\n');
                }
                s.push_str(&err);
            }
            (out.status.code(), s)
        }
        Err(e) => (None, format!("failed to launch setup command: {e}")),
    }
}

/// Keep only the last `max` characters of `s` (on a char boundary), prefixing an
/// elision marker when truncated — so a chatty `npm install` log doesn't flood the
/// UI but its tail (where errors land) is preserved.
fn tail(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let kept: String = s.chars().rev().take(max).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…\n{kept}")
}

// ---------------------------------------------------------------------------
// Worktree teardown (step 2.5) — design §6 / §7 "one-click merge".
// ---------------------------------------------------------------------------

/// A `git diff --stat`-style summary of what a worktree changed versus the branch
/// it would integrate into. Stands in for the full Diff/Review panel (step 2.7,
/// not yet landed) so the teardown dialog can show the shape of the change.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStat {
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
    /// The per-file `--stat` text, for display in the dialog.
    pub stat: String,
    /// The ref the diff was taken against (the integration target).
    pub base: String,
}

/// What the teardown dialog needs to render before the user picks an action: the
/// branch the worktree would integrate into (the main repo's current branch) and a
/// diff summary against it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeardownInfo {
    /// The main repo's currently checked-out branch — the merge/rebase target.
    /// `None` for a detached HEAD (integration is then unavailable in the UI).
    pub target_branch: Option<String>,
    pub diff: DiffStat,
}

/// Gather the teardown dialog's read-only context (design §7): the integration
/// target branch and a diff summary of the worktree against it. Pure inspection —
/// no repo state changes here.
#[tauri::command]
pub fn worktree_teardown_info(
    repo_root: String,
    worktree_path: String,
) -> Result<TeardownInfo, String> {
    let root = Path::new(&repo_root);
    let wt = Path::new(&worktree_path);
    if !wt.is_dir() {
        return Err(format!("worktree path is not a directory: {worktree_path}"));
    }
    // The integration target is whatever the main repo has checked out; fall back
    // to its detected default branch for a detached HEAD so the diff still has a base.
    let target_branch = git_output(root, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD");
    let base = target_branch
        .clone()
        .or_else(|| detect_default_branch(root))
        .unwrap_or_else(|| "HEAD".to_owned());

    // Diff the worktree's working tree (committed + uncommitted) against the base,
    // so "what did this agent change" captures everything, staged or not.
    let stat = git_output(wt, &["diff", "--stat", &base]).unwrap_or_default();
    let shortstat = git_output(wt, &["diff", "--shortstat", &base]).unwrap_or_default();
    let (files_changed, insertions, deletions) = parse_shortstat(&shortstat);

    Ok(TeardownInfo {
        target_branch,
        diff: DiffStat {
            files_changed,
            insertions,
            deletions,
            stat,
            base,
        },
    })
}

/// Parse git's `--shortstat` line — e.g. `3 files changed, 45 insertions(+), 2
/// deletions(-)` — into its three counts. Any field git omits (a change with no
/// insertions, say) defaults to 0.
fn parse_shortstat(line: &str) -> (u32, u32, u32) {
    let mut files = 0;
    let mut ins = 0;
    let mut del = 0;
    for part in line.split(',') {
        let part = part.trim();
        let num: u32 = part
            .split_whitespace()
            .next()
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        if part.contains("file") {
            files = num;
        } else if part.contains("insertion") {
            ins = num;
        } else if part.contains("deletion") {
            del = num;
        }
    }
    (files, ins, del)
}

/// Integrate a worktree's `agent/<slug>` branch into the main repo (design §7
/// one-click merge). With `rebase == false` this merges `branch` into the main
/// repo's current branch; with `rebase == true` it first replays the worktree's
/// commits onto `target_branch` (in the worktree) for a linear history, then
/// fast-forwards the main branch onto the result.
///
/// Conflicts (or a dirty tree) surface as an error with git's message — the user
/// resolves them in the Project Shell. A failed rebase is aborted so the worktree
/// is left clean for a retry. This only integrates; `remove_worktree` does cleanup.
#[tauri::command]
pub fn integrate_worktree(
    repo_root: String,
    worktree_path: String,
    branch: String,
    target_branch: String,
    rebase: bool,
) -> Result<String, String> {
    let root = Path::new(&repo_root);
    let wt = Path::new(&worktree_path);

    if rebase {
        // Replay the agent commits onto the target in the worktree; abort on
        // conflict so we don't leave a half-rebased detached state behind.
        if let Err(e) = git_run(wt, &["rebase", &target_branch]) {
            let _ = git_run(wt, &["rebase", "--abort"]);
            return Err(format!("rebase onto {target_branch} failed: {e}"));
        }
        // The branch is now ahead of the target by exactly its commits — a
        // fast-forward keeps history linear with no merge commit.
        git_run(root, &["merge", "--ff-only", &branch])
    } else {
        git_run(root, &["merge", &branch])
    }
}

/// Remove a worktree and (optionally) its branch (design §6 cleanup). `force`
/// removes even with uncommitted changes in the worktree — used by the "discard"
/// path; the default merge path removes cleanly. Branch deletion is best-effort
/// (`-D`): a lingering branch is harmless and visible later in the Git panel, so a
/// failure there doesn't fail the whole teardown once the worktree itself is gone.
#[tauri::command]
pub fn remove_worktree(
    repo_root: String,
    worktree_path: String,
    branch: Option<String>,
    delete_branch: bool,
    force: bool,
) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let mut args = vec!["worktree", "remove", &worktree_path];
    if force {
        args.push("--force");
    }
    git_run(root, &args)?;

    if delete_branch {
        if let Some(b) = branch.as_deref().filter(|b| !b.is_empty()) {
            let _ = git_run(root, &["branch", "-D", b]);
        }
    }
    Ok(())
}

/// Run `git -C <path> <args>`, returning trimmed stdout on success or the captured
/// stderr on failure. Unlike `git_output` (which swallows errors into `None`), this
/// surfaces *why* a command failed so provisioning can report it to the user.
fn git_run(path: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        return Err(if err.is_empty() {
            format!("git {} failed", args.first().copied().unwrap_or("command"))
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A throwaway directory under the OS temp dir, removed on drop.
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("wb-git-test-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn non_repo_folder_reports_no_git_and_a_name() {
        let dir = temp_dir("plain");
        let info = detect_repo(dir.to_string_lossy().into_owned()).unwrap();
        assert!(!info.is_git_repo);
        assert_eq!(info.default_branch, None);
        assert!(info.suggested_name.unwrap().starts_with("wb-git-test-plain"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detects_git_repo_by_dot_git_entry() {
        let dir = temp_dir("repo");
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let info = detect_repo(dir.to_string_lossy().into_owned()).unwrap();
        assert!(info.is_git_repo, "a `.git` entry should mark the folder a repo");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_path_is_an_error() {
        let result = detect_repo("/no/such/workbench/path/xyz".into());
        assert!(result.is_err());
    }

    #[test]
    fn sanitize_slug_is_branch_safe() {
        assert_eq!(sanitize_slug("Fix Auth Redirect"), "fix-auth-redirect");
        assert_eq!(sanitize_slug("  multiple   spaces  "), "multiple-spaces");
        assert_eq!(sanitize_slug("weird/chars*&^%"), "weird-chars");
        assert_eq!(sanitize_slug("keep_underscores"), "keep_underscores");
        assert_eq!(sanitize_slug("---"), "agent");
        assert_eq!(sanitize_slug(""), "agent");
    }

    /// Initialize a repo with one empty commit so `git worktree add -b` has a HEAD
    /// to branch from. Returns false (skip the test) when git isn't installed.
    fn init_repo(dir: &Path) -> bool {
        if which::which("git").is_err() {
            return false;
        }
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "Test"],
            &["commit", "--allow-empty", "-q", "-m", "init"],
        ] {
            if git_run(dir, args).is_err() {
                return false;
            }
        }
        true
    }

    #[test]
    fn provisions_worktree_and_uniquifies_repeats() {
        let dir = temp_dir("wt");
        if !init_repo(&dir) {
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        // Keep the worktrees inside the temp repo so the test is self-contained
        // (the production default is a sibling dir — covered by the path assertion).
        let base = dir.join("worktrees").to_string_lossy().into_owned();

        let res = provision_worktree(
            dir.to_string_lossy().into_owned(),
            "Fix Auth Redirect".into(),
            Some(base.clone()),
        )
        .unwrap();
        assert_eq!(res.branch, "agent/fix-auth-redirect");
        // A linked worktree has a `.git` *file* (a gitdir pointer) — its presence
        // confirms the checkout exists.
        assert!(Path::new(&res.path).join(".git").exists());

        // Re-provisioning the same title must not collide — branch + dir uniquify.
        let res2 = provision_worktree(
            dir.to_string_lossy().into_owned(),
            "Fix Auth Redirect".into(),
            Some(base),
        )
        .unwrap();
        assert_eq!(res2.branch, "agent/fix-auth-redirect-2");
        assert_ne!(res.path, res2.path);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn provision_on_non_repo_errors() {
        let dir = temp_dir("notrepo");
        let result = provision_worktree(dir.to_string_lossy().into_owned(), "x".into(), None);
        assert!(result.is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_shortstat_handles_missing_fields() {
        assert_eq!(
            parse_shortstat(" 3 files changed, 45 insertions(+), 2 deletions(-)"),
            (3, 45, 2)
        );
        // git omits a side that's zero.
        assert_eq!(parse_shortstat(" 1 file changed, 7 insertions(+)"), (1, 7, 0));
        assert_eq!(parse_shortstat(" 1 file changed, 4 deletions(-)"), (1, 0, 4));
        assert_eq!(parse_shortstat(""), (0, 0, 0));
    }

    #[test]
    fn tail_caps_and_marks_truncation() {
        assert_eq!(tail("short", 100), "short"); // under the cap → untouched
        let big = "x".repeat(50);
        let out = tail(&big, 10);
        assert!(out.starts_with("…\n"));
        assert!(out.ends_with(&"x".repeat(10)));
    }

    #[test]
    fn copy_env_files_seeds_only_env_files_without_clobbering() {
        let src = temp_dir("envsrc");
        let dst = temp_dir("envdst");
        std::fs::write(src.join(".env"), "A=1").unwrap();
        std::fs::write(src.join(".env.local"), "B=2").unwrap();
        std::fs::write(src.join(".environment"), "nope").unwrap(); // not an env file
        std::fs::write(src.join("README.md"), "hi").unwrap();
        std::fs::write(dst.join(".env.local"), "EXISTING").unwrap(); // must not clobber

        let mut copied = copy_env_files(&src, &dst);
        copied.sort();
        assert_eq!(copied, vec![".env".to_owned()]); // .env.local already present, others ignored
        assert_eq!(std::fs::read_to_string(dst.join(".env")).unwrap(), "A=1");
        assert_eq!(std::fs::read_to_string(dst.join(".env.local")).unwrap(), "EXISTING");
        assert!(!dst.join(".environment").exists());

        std::fs::remove_dir_all(&src).ok();
        std::fs::remove_dir_all(&dst).ok();
    }

    #[test]
    fn setup_runs_command_in_the_worktree() {
        let dir = temp_dir("setup");
        if which::which("git").is_err() {
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        // A worktree-shaped target (any dir works — the command runs in `current_dir`).
        // Write a marker file from the setup command and confirm it lands in `dir`.
        let cmd = if cfg!(windows) {
            "echo done> setup-ran.txt"
        } else {
            "echo done > setup-ran.txt"
        };
        let res = run_worktree_setup(
            dir.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
            Some(cmd.into()),
            false,
        )
        .unwrap();
        assert!(!res.skipped);
        assert_eq!(res.exit_code, Some(0));
        assert!(!res.failed);
        assert!(dir.join("setup-ran.txt").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn setup_with_nothing_configured_is_skipped() {
        let dir = temp_dir("setup-skip");
        let res = run_worktree_setup(
            dir.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
            None,
            false,
        )
        .unwrap();
        assert!(res.skipped);
        assert!(res.copied_env.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// End-to-end teardown: provision a worktree, commit a change in it, read the
    /// diff summary, merge it into the main repo, and remove the worktree + branch.
    #[test]
    fn integrate_merge_then_remove_worktree() {
        let dir = temp_dir("teardown");
        if !init_repo(&dir) {
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        let base = dir.join("worktrees").to_string_lossy().into_owned();
        let wt = provision_worktree(
            dir.to_string_lossy().into_owned(),
            "add feature".into(),
            Some(base),
        )
        .unwrap();
        let wt_path = Path::new(&wt.path);

        // Make a committed change in the worktree.
        std::fs::write(wt_path.join("feature.txt"), "hello").unwrap();
        git_run(wt_path, &["add", "."]).unwrap();
        git_run(wt_path, &["commit", "-q", "-m", "add feature"]).unwrap();

        // The teardown summary should see one changed file against the main branch.
        let info = worktree_teardown_info(
            dir.to_string_lossy().into_owned(),
            wt.path.clone(),
        )
        .unwrap();
        assert!(info.target_branch.is_some());
        assert_eq!(info.diff.files_changed, 1);
        assert!(info.diff.insertions >= 1);

        // Merge the branch into the main repo, then remove the worktree + branch.
        integrate_worktree(
            dir.to_string_lossy().into_owned(),
            wt.path.clone(),
            wt.branch.clone(),
            info.target_branch.unwrap(),
            false,
        )
        .unwrap();
        assert!(dir.join("feature.txt").exists(), "merge landed the file in main");

        remove_worktree(
            dir.to_string_lossy().into_owned(),
            wt.path.clone(),
            Some(wt.branch.clone()),
            true,
            false,
        )
        .unwrap();
        assert!(!wt_path.exists(), "worktree dir removed");
        assert!(
            !branch_exists(&dir, &wt.branch),
            "agent branch deleted after merge"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
