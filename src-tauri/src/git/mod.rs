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
/// it would integrate into — a compact at-a-glance figure for the teardown dialog
/// (the full file-by-file review lives in the Diff/Review panel, step 2.7).
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

// ---------------------------------------------------------------------------
// Diff / Review (step 2.7) — design §5 "Diff / Review".
// ---------------------------------------------------------------------------

/// One changed file in an instance's diff against its base (step 2.7). The list
/// entry the Diff/Review panel renders: a status glyph, the path, and ± counts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    /// Path relative to the working dir, forward-slashed — the list label + key.
    pub path: String,
    /// Absolute on-disk path the panel reads/writes for inline edits; `None` for a
    /// deleted file (nothing to open).
    pub abs_path: Option<String>,
    /// `"added" | "modified" | "deleted" | "typechange" | "untracked"`.
    pub status: String,
    /// Lines added (0 for a binary or deleted-only change).
    pub insertions: u32,
    /// Lines removed (0 for an addition / binary).
    pub deletions: u32,
    /// True when git reports the file binary — no textual diff, no inline edit.
    pub binary: bool,
}

/// An instance's changes versus its base ref (step 2.7, design §5) — the answer to
/// "what did this agent change?": tracked changes (committed + uncommitted) against
/// the base, plus untracked new files.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceDiff {
    /// The ref the diff was taken against (the panel shows "vs &lt;base&gt;").
    pub base: String,
    pub files: Vec<DiffFile>,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

/// List what an instance changed versus its base (step 2.7). The base is resolved
/// by `resolve_base` unless `base` is given. Pure inspection — no repo state
/// changes. Renames are intentionally *not* detected (`-M` omitted): a rename shows
/// as an add + a delete, which keeps the `--numstat` and `--name-status` paths
/// aligned (no `{old => new}` munging) — fine for a review pane (staging is out of
/// scope here).
#[tauri::command]
pub fn instance_diff(
    repo_root: String,
    working_dir: String,
    base: Option<String>,
) -> Result<InstanceDiff, String> {
    let wd = Path::new(&working_dir);
    if !wd.is_dir() {
        return Err(format!("working dir is not a directory: {working_dir}"));
    }
    let base = resolve_base(Path::new(&repo_root), wd, base);

    // Counts (and the binary flag) from --numstat; the change kind from
    // --name-status. `core.quotePath=false` keeps non-ASCII paths verbatim so they
    // match what we hand back for the editor to open.
    let mut files: Vec<DiffFile> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let status_by_path = parse_name_status(
        &git_output(wd, &["-c", "core.quotePath=false", "diff", "--name-status", &base])
            .unwrap_or_default(),
    );
    let numstat =
        git_output(wd, &["-c", "core.quotePath=false", "diff", "--numstat", &base]).unwrap_or_default();
    for line in numstat.lines() {
        let mut cols = line.splitn(3, '\t');
        let ins_raw = cols.next().unwrap_or("");
        let del_raw = cols.next().unwrap_or("");
        let path = match cols.next() {
            Some(p) if !p.is_empty() => p.to_owned(),
            _ => continue,
        };
        let binary = ins_raw == "-" || del_raw == "-";
        let insertions = ins_raw.parse().unwrap_or(0);
        let deletions = del_raw.parse().unwrap_or(0);
        let status = status_by_path
            .get(&path)
            .cloned()
            .unwrap_or_else(|| "modified".to_owned());
        let abs_path = if status == "deleted" {
            None
        } else {
            Some(wd.join(&path).to_string_lossy().into_owned())
        };
        seen.insert(path.clone());
        files.push(DiffFile { path, abs_path, status, insertions, deletions, binary });
    }

    // Untracked files never appear in `git diff` — list them separately and count
    // their lines as additions (the whole file is "new").
    let untracked =
        git_output(wd, &["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"])
            .unwrap_or_default();
    for path in untracked.lines() {
        if path.is_empty() || seen.contains(path) {
            continue;
        }
        let abs = wd.join(path);
        let (insertions, binary) = count_added_lines(&abs);
        files.push(DiffFile {
            path: path.to_owned(),
            abs_path: Some(abs.to_string_lossy().into_owned()),
            status: "untracked".to_owned(),
            insertions,
            deletions: 0,
            binary,
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    let files_changed = files.len() as u32;
    let insertions = files.iter().map(|f| f.insertions).sum();
    let deletions = files.iter().map(|f| f.deletions).sum();
    Ok(InstanceDiff { base, files, files_changed, insertions, deletions })
}

/// One file's unified diff against the base (step 2.7) — fetched on demand when the
/// user selects a file in the panel. `untracked` files have no base version, so we
/// synthesize an all-added diff from the file's current content.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub base: String,
    /// Unified-diff text — each line led by `+`/`-`/` `/`@`. Empty when binary.
    pub text: String,
    pub binary: bool,
    pub untracked: bool,
}

/// Read one file's unified diff for the Diff/Review panel (step 2.7). For tracked
/// files this is `git diff <base> -- <path>` (untrimmed, so leading context isn't
/// lost); for `untracked` files it's an all-added synthesis from disk.
#[tauri::command]
pub fn instance_file_diff(
    working_dir: String,
    base: String,
    path: String,
    untracked: bool,
) -> Result<FileDiff, String> {
    let wd = Path::new(&working_dir);
    if untracked {
        let (text, binary) = synth_added_diff(&wd.join(&path));
        return Ok(FileDiff { path, base, text, binary, untracked: true });
    }
    let out = git_stdout(wd, &["-c", "core.quotePath=false", "diff", &base, "--", &path])
        .unwrap_or_default();
    let binary = out.contains("Binary files ");
    Ok(FileDiff {
        text: if binary { String::new() } else { out },
        path,
        base,
        binary,
        untracked: false,
    })
}

/// Pick the ref to diff an instance's working dir against (step 2.7). An explicit
/// `base` wins. Otherwise a *linked worktree* (a dir other than the repo root)
/// diffs against the main repo's current branch — the branch it would integrate
/// into, mirroring `worktree_teardown_info`. A root instance diffs against `HEAD`,
/// surfacing the agent's uncommitted (and any committed) work since HEAD.
fn resolve_base(repo_root: &Path, working_dir: &Path, explicit: Option<String>) -> String {
    if let Some(b) = explicit.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) {
        return b;
    }
    if !same_path(repo_root, working_dir) {
        if let Some(b) =
            git_output(repo_root, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD")
        {
            return b;
        }
        if let Some(b) = detect_default_branch(repo_root) {
            return b;
        }
    }
    "HEAD".to_owned()
}

/// Parse `git diff --name-status` into a `path → status` map. Status letters map to
/// our display vocabulary; unknown letters fall back to "modified". (No `-M`, so we
/// only ever see single-path A/M/D/T lines — see `instance_diff`.)
fn parse_name_status(out: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in out.lines() {
        let mut cols = line.splitn(2, '\t');
        let code = cols.next().unwrap_or("");
        let path = match cols.next() {
            Some(p) if !p.is_empty() => p,
            _ => continue,
        };
        let status = match code.chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            Some('T') => "typechange",
            Some('M') => "modified",
            _ => "modified",
        };
        map.insert(path.to_owned(), status.to_owned());
    }
    map
}

/// Count a file's lines (as all-added) and detect binary, for an untracked entry.
/// A NUL byte in the first chunk marks it binary (git's own heuristic); an unreadable
/// file counts as 0 lines, non-binary.
fn count_added_lines(path: &Path) -> (u32, bool) {
    match std::fs::read(path) {
        Ok(bytes) => {
            if bytes.iter().take(8000).any(|&b| b == 0) {
                return (0, true);
            }
            let text = String::from_utf8_lossy(&bytes);
            let mut n = text.lines().count() as u32;
            // A trailing newline-less final line still counts; `lines()` already
            // yields it, but an empty file has zero lines.
            if text.is_empty() {
                n = 0;
            }
            (n, false)
        }
        Err(_) => (0, false),
    }
}

/// Synthesize an all-added unified diff for an untracked file from its content, so
/// the panel renders it the same way as a tracked diff. Returns empty text + binary
/// when the file is binary or unreadable.
fn synth_added_diff(path: &Path) -> (String, bool) {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return (String::new(), false),
    };
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return (String::new(), true);
    }
    let text = String::from_utf8_lossy(&bytes);
    if text.is_empty() {
        return (String::new(), false);
    }
    let lines: Vec<&str> = text.lines().collect();
    let mut out = format!("@@ -0,0 +1,{} @@\n", lines.len());
    for line in lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    (out, false)
}

/// True when two paths point at the same location (canonicalized; falls back to a
/// raw compare when either can't be canonicalized).
fn same_path(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// Like `git_output` but returns stdout **untrimmed** — diff text must keep its
/// leading/trailing whitespace and newlines intact. `None` on a missing/erroring git.
fn git_stdout(path: &Path, args: &[&str]) -> Option<String> {
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
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
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

// ---------------------------------------------------------------------------
// Git panel (step 3.11) — design §5 "Git" / §7. A project-scoped repo lens:
// history, branches, working tree, stash, and remote ops — the repo-level
// counterpart to the instance-scoped Diff/Review panel (step 2.7).
//
// Read paths each run a *single* batched `git` command (a whole log, the whole
// branch list, the whole status — never one invocation per row); write paths
// shell out exactly like the worktree code above. Design §9 allows "git2 or
// shell-out"; we stay shell-out for consistency with the rest of this module —
// one toolchain, the same `CREATE_NO_WINDOW` + error-capture helpers, and no
// libgit2 build dependency. Destructive ops (branch -D, discard, clean,
// force-push) are gated behind a confirm in the UI, not here.

/// Field/record separators for `git log --format` (and friends): characters that
/// never occur in commit metadata, so a subject with spaces/commas/newlines stays
/// in one piece. ASCII unit-separator (0x1f) between fields, record-separator
/// (0x1e) between commits.
const US: char = '\u{1f}';
const RS: char = '\u{1e}';

/// One commit in the history view (step 3.11).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// Author date, epoch seconds (the panel formats it locally).
    pub date: i64,
    /// Parent SHAs (≥2 ⇒ a merge) — lets the panel draw a minimal graph gutter.
    pub parents: Vec<String>,
    /// Ref decorations on this commit (branch tips, tags), e.g. `main`, `tag: v1`.
    pub refs: Vec<String>,
}

/// Recent history for a project's repo (step 3.11): HEAD's log, newest first,
/// capped at `limit` (default 200, hard-capped at 2000 so a giant repo can't
/// flood the UI in one call). Pure inspection.
#[tauri::command]
pub fn git_log(repo_root: String, limit: Option<u32>) -> Result<Vec<Commit>, String> {
    let root = Path::new(&repo_root);
    let n = limit.unwrap_or(200).clamp(1, 2000).to_string();
    let fmt = format!("%H{US}%h{US}%an{US}%at{US}%P{US}%D{US}%s{RS}");
    let out = git_stdout(root, &["log", "--no-color", "-n", &n, &format!("--format={fmt}")])
        .unwrap_or_default();
    let mut commits = Vec::new();
    for rec in out.split(RS) {
        let rec = rec.trim_matches(|c| c == '\n' || c == '\r');
        if rec.is_empty() {
            continue;
        }
        let mut f = rec.split(US);
        let sha = f.next().unwrap_or("").to_owned();
        if sha.is_empty() {
            continue;
        }
        let short = f.next().unwrap_or("").to_owned();
        let author = f.next().unwrap_or("").to_owned();
        let date = f.next().unwrap_or("").trim().parse::<i64>().unwrap_or(0);
        let parents = f
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        let refs = f
            .next()
            .unwrap_or("")
            .split(", ")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        let subject = f.next().unwrap_or("").to_owned();
        commits.push(Commit { sha, short, subject, author, date, parents, refs });
    }
    Ok(commits)
}

/// One local branch in the branch list (step 3.11), with its upstream tracking.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    /// The configured upstream (e.g. `origin/main`), or `None` if unset.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// True for the currently checked-out branch.
    pub is_head: bool,
    /// The branch tip's short SHA.
    pub short: String,
}

/// The project's branches (step 3.11): local branches with ahead/behind, the
/// current branch (or a detached-HEAD flag), and the remote branch names.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    /// The checked-out branch, or `None` when HEAD is detached.
    pub current: Option<String>,
    pub detached: bool,
    pub local: Vec<Branch>,
    pub remote: Vec<String>,
}

#[tauri::command]
pub fn git_branches(repo_root: String) -> Result<Branches, String> {
    let root = Path::new(&repo_root);
    let fmt = format!(
        "%(HEAD){US}%(refname:short){US}%(upstream:short){US}%(upstream:track){US}%(objectname:short)"
    );
    let out = git_stdout(root, &["branch", "--format", &fmt]).unwrap_or_default();
    let mut local = Vec::new();
    let mut current = None;
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut f = line.split(US);
        let head = f.next().unwrap_or("").trim();
        let name = f.next().unwrap_or("").to_owned();
        if name.is_empty() {
            continue;
        }
        let upstream = f.next().unwrap_or("").trim();
        let track = f.next().unwrap_or("");
        let short = f.next().unwrap_or("").to_owned();
        let is_head = head == "*";
        if is_head {
            current = Some(name.clone());
        }
        let (ahead, behind) = parse_track(track);
        local.push(Branch {
            name,
            upstream: (!upstream.is_empty()).then(|| upstream.to_owned()),
            ahead,
            behind,
            is_head,
            short,
        });
    }
    // HEAD is detached when no branch row was the current one, yet HEAD resolves.
    let detached = current.is_none()
        && git_output(root, &["rev-parse", "--abbrev-ref", "HEAD"]).as_deref() == Some("HEAD");
    let remote = git_stdout(root, &["branch", "-r", "--format", "%(refname:short)"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.ends_with("/HEAD"))
        .map(str::to_owned)
        .collect();
    Ok(Branches { current, detached, local, remote })
}

/// Parse git's `%(upstream:track)` token — `[ahead 1, behind 2]`, `[ahead 3]`,
/// `[behind 4]`, `[gone]`, or empty — into `(ahead, behind)`.
fn parse_track(track: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    for part in inner.split(',') {
        let p = part.trim();
        if let Some(n) = p.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = p.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// One entry in the working-tree status (step 3.11). The porcelain `XY` pair:
/// `index` is the staged column, `worktree` the unstaged column (each `M`/`A`/
/// `D`/`R`/`C`/`?`/` `). The panel buckets these into staged/unstaged/untracked.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub untracked: bool,
}

#[tauri::command]
pub fn git_status_entries(repo_root: String) -> Result<Vec<StatusEntry>, String> {
    let root = Path::new(&repo_root);
    let out = git_stdout(
        root,
        &[
            "-c",
            "core.quotePath=false",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ],
    )
    .unwrap_or_default();
    let mut entries = Vec::new();
    for line in out.lines() {
        // Each record is `XY <path>`; the first three bytes are ASCII so slicing
        // by byte index is safe even when the path itself is non-ASCII.
        if line.len() < 4 {
            continue;
        }
        let index = &line[0..1];
        let worktree = &line[1..2];
        let mut path = line[3..].to_owned();
        // Renames/copies render as `old -> new` — show the destination path.
        if let Some(idx) = path.find(" -> ") {
            path = path[idx + 4..].to_owned();
        }
        entries.push(StatusEntry {
            path,
            index: index.to_owned(),
            worktree: worktree.to_owned(),
            untracked: index == "?",
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// One stash entry (step 3.11): its ref (`stash@{0}`) and one-line description.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub reference: String,
    pub message: String,
}

#[tauri::command]
pub fn git_stash_list(repo_root: String) -> Result<Vec<Stash>, String> {
    let root = Path::new(&repo_root);
    let fmt = format!("%gd{US}%s");
    let out = git_stdout(root, &["stash", "list", &format!("--format={fmt}")]).unwrap_or_default();
    let mut stashes = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut f = line.split(US);
        let reference = f.next().unwrap_or("").to_owned();
        if reference.is_empty() {
            continue;
        }
        let message = f.next().unwrap_or("").to_owned();
        stashes.push(Stash { reference, message });
    }
    Ok(stashes)
}

/// The files a commit changed (step 3.11) — the per-commit changed-file list shown
/// when you click a row in the history. Renames are *not* detected (no `-M`), so a
/// rename shows as an add + delete and the `--numstat`/`--name-status` paths stay
/// aligned (same simplification as `instance_diff`). `abs_path` is always `None`:
/// this is historical content, not the working tree, so it isn't inline-editable.
#[tauri::command]
pub fn git_commit_files(repo_root: String, sha: String) -> Result<Vec<DiffFile>, String> {
    let root = Path::new(&repo_root);
    let status_by_path = parse_name_status(
        &git_output(
            root,
            &["-c", "core.quotePath=false", "show", "--name-status", "--format=", &sha],
        )
        .unwrap_or_default(),
    );
    let numstat = git_output(
        root,
        &["-c", "core.quotePath=false", "show", "--numstat", "--format=", &sha],
    )
    .unwrap_or_default();
    let mut files = Vec::new();
    for line in numstat.lines() {
        let mut cols = line.splitn(3, '\t');
        let ins_raw = cols.next().unwrap_or("");
        let del_raw = cols.next().unwrap_or("");
        let path = match cols.next() {
            Some(p) if !p.is_empty() => p.to_owned(),
            _ => continue,
        };
        let binary = ins_raw == "-" || del_raw == "-";
        let status = status_by_path
            .get(&path)
            .cloned()
            .unwrap_or_else(|| "modified".to_owned());
        files.push(DiffFile {
            path,
            abs_path: None,
            status,
            insertions: ins_raw.parse().unwrap_or(0),
            deletions: del_raw.parse().unwrap_or(0),
            binary,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// One file's unified diff within a commit (step 3.11) — fetched on demand when a
/// changed file is selected in the history. `git show --format=` drops the commit
/// header, leaving just the file's patch (which `git` already diffs against the
/// commit's parent). Empty text + `binary` for a binary blob.
#[tauri::command]
pub fn git_commit_file_diff(
    repo_root: String,
    sha: String,
    path: String,
) -> Result<FileDiff, String> {
    let root = Path::new(&repo_root);
    let out = git_stdout(
        root,
        &["-c", "core.quotePath=false", "show", "--format=", &sha, "--", &path],
    )
    .unwrap_or_default();
    let binary = out.contains("Binary files ");
    Ok(FileDiff {
        text: if binary { String::new() } else { out },
        path,
        base: sha,
        binary,
        untracked: false,
    })
}

// --- write paths (each shells out; the UI gates the destructive ones) --------

/// Check out a branch, tag, or commit (step 3.11). On success returns git's
/// stdout; on a dirty-tree / unknown-ref failure returns git's stderr message.
#[tauri::command]
pub fn git_checkout(repo_root: String, reference: String) -> Result<String, String> {
    git_run(Path::new(&repo_root), &["checkout", &reference])
}

/// Create a branch (step 3.11), optionally from `start_point` and optionally
/// checking it out. With `checkout` it's `checkout -b`; otherwise `branch`.
#[tauri::command]
pub fn git_create_branch(
    repo_root: String,
    name: String,
    start_point: Option<String>,
    checkout: bool,
) -> Result<String, String> {
    let sp = start_point.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let mut args: Vec<&str> = if checkout {
        vec!["checkout", "-b", name.as_str()]
    } else {
        vec!["branch", name.as_str()]
    };
    if let Some(s) = sp.as_deref() {
        args.push(s);
    }
    git_run(Path::new(&repo_root), &args)
}

/// Rename a branch (step 3.11).
#[tauri::command]
pub fn git_rename_branch(repo_root: String, old: String, new: String) -> Result<String, String> {
    git_run(Path::new(&repo_root), &["branch", "-m", &old, &new])
}

/// Delete a branch (step 3.11). `force` uses `-D` (drops unmerged work) — gated
/// behind a confirm in the UI; the default `-d` refuses to delete unmerged work.
#[tauri::command]
pub fn git_delete_branch(repo_root: String, name: String, force: bool) -> Result<String, String> {
    git_run(
        Path::new(&repo_root),
        &["branch", if force { "-D" } else { "-d" }, &name],
    )
}

/// Stage paths (step 3.11) — `git add`, which also stages deletions.
#[tauri::command]
pub fn git_stage(repo_root: String, paths: Vec<String>) -> Result<String, String> {
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_run(Path::new(&repo_root), &args)
}

/// Unstage paths (step 3.11) — `git restore --staged`, leaving the working tree
/// changes in place.
#[tauri::command]
pub fn git_unstage(repo_root: String, paths: Vec<String>) -> Result<String, String> {
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_run(Path::new(&repo_root), &args)
}

/// Discard tracked changes to paths (step 3.11) — revert both the staged and the
/// working-tree copy to HEAD. Destructive (gated behind a confirm). Untracked
/// files aren't touched here — `git_clean` removes those.
#[tauri::command]
pub fn git_discard(repo_root: String, paths: Vec<String>) -> Result<String, String> {
    let mut args = vec!["restore", "--staged", "--worktree", "--source=HEAD", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_run(Path::new(&repo_root), &args)
}

/// Remove untracked files/dirs at paths (step 3.11) — `git clean -fd`. Destructive
/// (gated behind a confirm); the working-tree counterpart to `git_discard`.
#[tauri::command]
pub fn git_clean(repo_root: String, paths: Vec<String>) -> Result<String, String> {
    let mut args = vec!["clean", "-fdq", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_run(Path::new(&repo_root), &args)
}

/// Stash the working tree (step 3.11), optionally including untracked files and
/// with a message.
#[tauri::command]
pub fn git_stash_push(
    repo_root: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<String, String> {
    let msg = message.map(|m| m.trim().to_owned()).filter(|m| !m.is_empty());
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if let Some(m) = msg.as_deref() {
        args.push("-m");
        args.push(m);
    }
    git_run(Path::new(&repo_root), &args)
}

/// Pop a stash back onto the working tree (step 3.11). A conflict surfaces git's
/// message for the user to resolve in the Project Shell.
#[tauri::command]
pub fn git_stash_pop(repo_root: String, reference: String) -> Result<String, String> {
    git_run(Path::new(&repo_root), &["stash", "pop", &reference])
}

/// Drop a stash without applying it (step 3.11) — destructive (gated by a confirm).
#[tauri::command]
pub fn git_stash_drop(repo_root: String, reference: String) -> Result<String, String> {
    git_run(Path::new(&repo_root), &["stash", "drop", &reference])
}

/// Fetch from a remote (step 3.11), pruning deleted remote branches. No remote ⇒
/// the default (usually `origin`).
#[tauri::command]
pub fn git_fetch(repo_root: String, remote: Option<String>) -> Result<String, String> {
    let r = remote.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let mut args = vec!["fetch", "--prune"];
    if let Some(s) = r.as_deref() {
        args.push(s);
    }
    git_run(Path::new(&repo_root), &args)
}

/// Pull the current branch (step 3.11). A merge conflict / non-fast-forward
/// surfaces git's message; resolve in the Project Shell.
#[tauri::command]
pub fn git_pull(repo_root: String) -> Result<String, String> {
    git_run(Path::new(&repo_root), &["pull"])
}

/// Push the current branch (step 3.11). **Never** auto-pushes — only called from an
/// explicit button. `force` uses `--force-with-lease` (refuses to clobber remote
/// work it hasn't seen) rather than a bare `--force`, and is gated by a confirm.
#[tauri::command]
pub fn git_push(repo_root: String, force: bool) -> Result<String, String> {
    let mut args = vec!["push"];
    if force {
        args.push("--force-with-lease");
    }
    git_run(Path::new(&repo_root), &args)
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

    #[test]
    fn parse_name_status_maps_change_codes() {
        let map = parse_name_status("A\tnew.rs\nM\tlib.rs\nD\told.rs\nT\tlink");
        assert_eq!(map.get("new.rs").unwrap(), "added");
        assert_eq!(map.get("lib.rs").unwrap(), "modified");
        assert_eq!(map.get("old.rs").unwrap(), "deleted");
        assert_eq!(map.get("link").unwrap(), "typechange");
        assert!(!map.contains_key("missing"));
    }

    #[test]
    fn synth_added_diff_prefixes_every_line() {
        let dir = temp_dir("synth");
        let f = dir.join("a.txt");
        std::fs::write(&f, "one\ntwo\n").unwrap();
        let (text, binary) = synth_added_diff(&f);
        assert!(!binary);
        assert!(text.starts_with("@@ -0,0 +1,2 @@\n"));
        assert!(text.contains("\n+one\n"));
        assert!(text.contains("\n+two\n"));

        // A NUL byte marks the file binary (no diff text).
        std::fs::write(&f, [b'a', 0, b'b']).unwrap();
        let (text, binary) = synth_added_diff(&f);
        assert!(binary);
        assert!(text.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// End-to-end diff: an uncommitted edit, a deletion, and an untracked file in a
    /// root instance show up against HEAD with the right statuses + a per-file diff.
    #[test]
    fn instance_diff_reports_tracked_and_untracked_changes() {
        let dir = temp_dir("diff");
        if !init_repo(&dir) {
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        // Seed two tracked files and commit them, so HEAD has a baseline.
        std::fs::write(dir.join("keep.txt"), "v1\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "bye\n").unwrap();
        git_run(&dir, &["add", "."]).unwrap();
        git_run(&dir, &["commit", "-q", "-m", "seed"]).unwrap();

        // Now: modify one, delete the other, and add an untracked file.
        std::fs::write(dir.join("keep.txt"), "v1\nv2\n").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::write(dir.join("fresh.txt"), "hello\nworld\n").unwrap();

        // Root instance → base is HEAD (working_dir == repo_root).
        let root = dir.to_string_lossy().into_owned();
        let diff = instance_diff(root.clone(), root.clone(), None).unwrap();
        assert_eq!(diff.base, "HEAD");
        assert_eq!(diff.files_changed, 3);

        let by_path = |p: &str| diff.files.iter().find(|f| f.path == p).unwrap();
        assert_eq!(by_path("keep.txt").status, "modified");
        assert_eq!(by_path("gone.txt").status, "deleted");
        assert!(by_path("gone.txt").abs_path.is_none(), "deleted files aren't editable");
        let fresh = by_path("fresh.txt");
        assert_eq!(fresh.status, "untracked");
        assert_eq!(fresh.insertions, 2);

        // A tracked file's diff comes from git; an untracked file's is synthesized.
        let tracked = instance_file_diff(root.clone(), "HEAD".into(), "keep.txt".into(), false).unwrap();
        assert!(tracked.text.contains("+v2"), "diff shows the added line");
        let synth = instance_file_diff(root, "HEAD".into(), "fresh.txt".into(), true).unwrap();
        assert!(synth.untracked);
        assert!(synth.text.contains("+hello") && synth.text.contains("+world"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_track_reads_ahead_behind() {
        assert_eq!(parse_track("[ahead 1, behind 2]"), (1, 2));
        assert_eq!(parse_track("[ahead 3]"), (3, 0));
        assert_eq!(parse_track("[behind 4]"), (0, 4));
        assert_eq!(parse_track("[gone]"), (0, 0));
        assert_eq!(parse_track(""), (0, 0));
    }

    /// The Git panel's read paths over a real repo: log lists the commit, branches
    /// reports a current branch, status surfaces an unstaged edit + an untracked
    /// file, and a commit's changed-file list + per-file diff come back.
    #[test]
    fn git_panel_reads_log_branches_status_and_commit() {
        let dir = temp_dir("panel");
        if !init_repo(&dir) {
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        std::fs::write(dir.join("a.txt"), "1\n").unwrap();
        git_run(&dir, &["add", "."]).unwrap();
        git_run(&dir, &["commit", "-q", "-m", "first commit"]).unwrap();
        let root = dir.to_string_lossy().into_owned();

        let log = git_log(root.clone(), None).unwrap();
        let head = log.iter().find(|c| c.subject == "first commit").expect("commit in log");
        assert!(!head.sha.is_empty());

        let br = git_branches(root.clone()).unwrap();
        assert!(br.current.is_some());
        assert!(!br.detached);
        assert!(br.local.iter().any(|b| b.is_head));

        // The commit's file list + a per-file diff.
        let files = git_commit_files(root.clone(), head.sha.clone()).unwrap();
        let a = files.iter().find(|f| f.path == "a.txt").expect("a.txt in commit");
        assert_eq!(a.status, "added");
        let fd = git_commit_file_diff(root.clone(), head.sha.clone(), "a.txt".into()).unwrap();
        assert!(fd.text.contains("+1"));

        // An unstaged modification + an untracked file show up in status.
        std::fs::write(dir.join("a.txt"), "1\n2\n").unwrap();
        std::fs::write(dir.join("b.txt"), "new\n").unwrap();
        let st = git_status_entries(root).unwrap();
        assert!(st.iter().any(|e| e.path == "a.txt" && e.worktree == "M"));
        assert!(st.iter().any(|e| e.path == "b.txt" && e.untracked));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Write paths: create + checkout a branch, stage a change, stash it (which
    /// cleans the tree), then pop it back.
    #[test]
    fn git_panel_branch_stage_stash_roundtrip() {
        let dir = temp_dir("panel-write");
        if !init_repo(&dir) {
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        std::fs::write(dir.join("a.txt"), "1\n").unwrap();
        git_run(&dir, &["add", "."]).unwrap();
        git_run(&dir, &["commit", "-q", "-m", "seed"]).unwrap();
        let root = dir.to_string_lossy().into_owned();

        git_create_branch(root.clone(), "feature".into(), None, true).unwrap();
        let br = git_branches(root.clone()).unwrap();
        assert_eq!(br.current.as_deref(), Some("feature"));

        // A staged change, stashed (tree goes clean), then popped back.
        std::fs::write(dir.join("a.txt"), "1\n2\n").unwrap();
        git_stage(root.clone(), vec!["a.txt".into()]).unwrap();
        git_stash_push(root.clone(), Some("wip".into()), false).unwrap();
        assert!(git_status_entries(root.clone()).unwrap().is_empty(), "stash cleaned the tree");
        let stashes = git_stash_list(root.clone()).unwrap();
        assert_eq!(stashes.len(), 1);
        git_stash_pop(root.clone(), stashes[0].reference.clone()).unwrap();
        assert!(
            git_status_entries(root).unwrap().iter().any(|e| e.path == "a.txt"),
            "pop restored the change"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
