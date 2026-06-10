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
}
