//! Git inspection (step 1.3).
//!
//! Just enough git to support project registration: given a folder the user
//! picked, report whether it's a git repo and what its default branch is, plus a
//! suggested project name (the folder's basename). The registry stores these on
//! the `Project` row (design §3); worktree provisioning and diff ops are Phase 2.
//!
//! We shell out to `git` (design §9: "git2 or shell-out") rather than pull in
//! libgit2 — repo detection works from the `.git` entry alone, so a missing or
//! broken `git` binary degrades to "no branch detected" instead of failing the
//! whole flow.

use std::path::Path;
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
}
