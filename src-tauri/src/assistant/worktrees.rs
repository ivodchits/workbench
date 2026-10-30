//! Disposing of a session's git worktree (`dispose_worktree`): whether its branch
//! is fully merged into the project's main branch and its tree is clean, and the
//! removal of the worktree and its branch.
//!
//! The check runs again inside `dispose`, right before anything is removed, so a
//! commit or an edit made after the card was shown is never lost unforced.

use std::path::Path;

use serde::Serialize;

use crate::git::run::{exec, Spec};

/// The most unmerged commits listed (the count is always whole).
const COMMITS_SHOWN: usize = 10;

/// What removing a worktree would lose.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub branch: String,
    /// The project's main branch, which `branch` is checked against.
    pub base: String,
    /// Commits on `branch` that `base` doesn't have.
    pub unmerged: u32,
    /// The newest of them, `<short sha> <subject>`.
    pub commits: Vec<String>,
    /// Uncommitted and untracked files in the worktree (ignored ones aren't).
    pub dirty: Vec<String>,
}

impl Check {
    /// Nothing would be lost.
    pub fn safe(&self) -> bool {
        self.unmerged == 0 && self.dirty.is_empty()
    }

    /// What would be lost, in a sentence's words; empty when nothing would.
    pub fn loss(&self) -> String {
        let mut parts = Vec::new();
        if self.unmerged > 0 {
            let s = if self.unmerged == 1 { "" } else { "s" };
            parts.push(format!("{} has {} commit{s} not in {} ({})", self.branch, self.unmerged, self.base, self.commits.join("; ")));
        }
        if !self.dirty.is_empty() {
            let s = if self.dirty.len() == 1 { "" } else { "s" };
            parts.push(format!("the worktree has {} uncommitted or untracked file{s} ({})", self.dirty.len(), self.dirty.join(", ")));
        }
        parts.join(", and ")
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = exec(dir, Spec::local(args))?;
    if !out.ok {
        return Err(format!("git {} failed: {}", args.join(" "), out.stderr.trim()));
    }
    Ok(out.stdout)
}

/// The project's main branch: the remote's default when the repo has that branch
/// locally, else `main`, else `master`.
pub fn main_branch(root: &Path) -> Result<String, String> {
    let local = |b: &str| git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{b}")]).is_ok();
    if let Ok(head) = git(root, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        let b = head.trim().rsplit('/').next().unwrap_or("").to_owned();
        if !b.is_empty() && local(&b) {
            return Ok(b);
        }
    }
    ["main", "master"]
        .into_iter()
        .find(|b| local(b))
        .map(str::to_owned)
        .ok_or_else(|| format!("{} has no main or master branch to check against", root.display()))
}

/// Whether the worktree at `worktree` (on `branch`) can go without losing work.
pub fn check(root: &Path, worktree: &Path, branch: &str) -> Result<Check, String> {
    if !worktree.is_dir() {
        return Err(format!("the worktree {} isn't on disk", worktree.display()));
    }
    let head = git(worktree, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_owned();
    if head != branch {
        return Err(format!("the worktree is on {head}, not {branch}: remove it from the rail"));
    }
    let base = main_branch(root)?;
    if base == branch {
        return Err(format!("{branch} is the main branch itself"));
    }
    let range = format!("{base}..{branch}");
    let unmerged = git(root, &["rev-list", "--count", &range])?.trim().parse::<u32>().map_err(|e| e.to_string())?;
    let shown = format!("-n{COMMITS_SHOWN}");
    let commits = git(root, &["log", "--format=%h %s", &shown, &range])?.lines().map(str::to_owned).collect();
    let dirty = git(worktree, &["status", "--porcelain=v1", "--untracked-files=all"])?
        .lines()
        .filter_map(|l| l.get(3..))
        .map(|p| p.trim_matches('"').to_owned())
        .collect();
    Ok(Check { branch: branch.to_owned(), base, unmerged, commits, dirty })
}

/// Remove the worktree and delete its branch. Refused, saying what would be lost,
/// unless nothing would be or `force`. Returns the check it went on.
pub fn dispose(root: &Path, worktree: &Path, branch: &str, force: bool) -> Result<Check, String> {
    let c = check(root, worktree, branch)?;
    if !force && !c.safe() {
        return Err(format!("not removed: {}", c.loss()));
    }
    let path = worktree.to_string_lossy();
    let mut args = vec!["worktree", "remove", path.as_ref()];
    if !c.dirty.is_empty() {
        args.push("--force");
    }
    git(root, &args)?;
    // `-d` would check against the root's checked-out branch, not `base`; the
    // check above is the one that counts.
    git(root, &["branch", "-D", branch])?;
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wb-duck-worktrees-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn run(dir: &Path, args: &[&str]) {
        let mut all = vec!["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
        all.extend_from_slice(args);
        git(dir, &all).unwrap();
    }

    /// A repo on `main` with a worktree on `agent/x` at `<root>/wt`.
    fn lab(name: &str) -> (PathBuf, PathBuf) {
        let root = temp(name);
        let (repo, wt) = (root.join("repo"), root.join("wt"));
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-q", "-m", "one"]);
        run(&repo, &["worktree", "add", "-q", "-b", "agent/x", wt.to_str().unwrap()]);
        (repo, wt)
    }

    fn branch_exists(repo: &Path) -> bool {
        git(repo, &["rev-parse", "--verify", "--quiet", "refs/heads/agent/x"]).is_ok()
    }

    #[test]
    fn a_merged_clean_worktree_goes_with_its_branch() {
        let (repo, wt) = lab("merged");
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        run(&wt, &["add", "-A"]);
        run(&wt, &["commit", "-q", "-m", "two"]);
        run(&repo, &["merge", "-q", "--no-ff", "-m", "merge", "agent/x"]);
        // Ignored files don't count as work.
        std::fs::write(wt.join(".gitignore"), "target/\n").unwrap();
        run(&wt, &["add", "-A"]);
        run(&wt, &["commit", "-q", "-m", "ignore"]);
        run(&repo, &["merge", "-q", "agent/x"]);
        std::fs::create_dir_all(wt.join("target")).unwrap();
        std::fs::write(wt.join("target/out"), "x").unwrap();
        let c = check(&repo, &wt, "agent/x").unwrap();
        assert!(c.safe(), "{c:?}");
        assert_eq!(c.base, "main");
        let c = dispose(&repo, &wt, "agent/x", false).unwrap();
        assert!(c.safe());
        assert!(!wt.exists());
        assert!(!branch_exists(&repo));
    }

    #[test]
    fn unmerged_or_dirty_work_is_refused_and_named_unless_forced() {
        let (repo, wt) = lab("unmerged");
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        run(&wt, &["add", "-A"]);
        run(&wt, &["commit", "-q", "-m", "half done"]);
        std::fs::write(wt.join("a.txt"), "changed\n").unwrap();
        std::fs::write(wt.join("new.txt"), "n\n").unwrap();
        let c = check(&repo, &wt, "agent/x").unwrap();
        assert_eq!(c.unmerged, 1);
        assert_eq!(c.commits.len(), 1);
        assert!(c.commits[0].ends_with(" half done"));
        assert_eq!(c.dirty, vec!["a.txt", "new.txt"]);
        let err = dispose(&repo, &wt, "agent/x", false).unwrap_err();
        assert!(err.contains("agent/x has 1 commit not in main"), "{err}");
        assert!(err.contains("2 uncommitted or untracked files (a.txt, new.txt)"), "{err}");
        assert!(wt.exists() && branch_exists(&repo), "nothing removed");
        let c = dispose(&repo, &wt, "agent/x", true).unwrap();
        assert_eq!((c.unmerged, c.dirty.len()), (1, 2));
        assert!(!wt.exists());
        assert!(!branch_exists(&repo));
    }

    #[test]
    fn a_worktree_on_another_branch_is_refused() {
        let (repo, wt) = lab("other");
        run(&wt, &["checkout", "-q", "-b", "agent/y"]);
        let err = check(&repo, &wt, "agent/x").unwrap_err();
        assert!(err.contains("on agent/y, not agent/x"), "{err}");
        assert!(check(&repo, &repo.join("nope"), "agent/x").is_err());
    }
}
