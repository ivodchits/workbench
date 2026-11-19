//! Duck's repo and files across the fleet (fleet plan F5.2).
//!
//! - **The repo.** The main commits to Duck's workspace as today; another machine
//!   keeps a mirror of it in its own folder (`duck-replica-workspace`), never its own
//!   workspace (its Duck still writes that until the election, F6), and never
//!   commits there. The mirror asks for a bundle of what it doesn't have
//!   ([`bundle`]: since its head when that's an ancestor, else whole), fetches it and
//!   moves to the main's head ([`apply_bundle`]).
//! - **Files.** An attachment is stored under the first 32 hex digits of its
//!   SHA-256, so a machine missing one asks the others for it by id and checks the
//!   bytes against the id before keeping it (`Fleet::fetch_attachment`).

use std::path::Path;

use crate::gitqueue;

/// The repo's head commit, or None (no repo, or no commit yet).
pub fn head(repo: &Path) -> Option<String> {
    if !repo.join(".git").exists() {
        return None;
    }
    gitqueue::run(repo, &["rev-parse", "--verify", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// A bundle of `repo`'s HEAD for a mirror at `have`: what it lacks when `have` is an
/// ancestor of HEAD, else everything. None: the mirror is up to date (or there's
/// nothing to send).
pub fn bundle(repo: &Path, have: Option<&str>, scratch: &Path) -> Result<Option<Vec<u8>>, String> {
    let Some(mine) = head(repo) else { return Ok(None) };
    if have == Some(mine.as_str()) {
        return Ok(None);
    }
    let since = have.filter(|h| {
        h.len() >= 7
            && h.bytes().all(|b| b.is_ascii_hexdigit())
            && gitqueue::output(repo, &["merge-base", "--is-ancestor", h, "HEAD"]).is_ok_and(|o| o.ok)
    });
    let _ = std::fs::remove_file(scratch);
    let out = scratch.to_string_lossy().into_owned();
    let range = since.map(|h| format!("{h}..HEAD"));
    let mut args = vec!["bundle", "create", "-q", out.as_str()];
    match &range {
        Some(r) => args.push(r),
        None => args.push("HEAD"),
    }
    gitqueue::run(repo, &args)?;
    let bytes = std::fs::read(scratch).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(scratch);
    bytes.map(Some)
}

/// Bring the mirror to the bundle's HEAD (made first when there's none). Returns
/// the mirror's new head.
pub fn apply_bundle(mirror: &Path, bytes: &[u8], scratch: &Path) -> Result<String, String> {
    if !mirror.join(".git").exists() {
        std::fs::create_dir_all(mirror).map_err(|e| e.to_string())?;
        gitqueue::run(mirror, &["init", "-q"])?;
    }
    std::fs::write(scratch, bytes).map_err(|e| e.to_string())?;
    let path = scratch.to_string_lossy().into_owned();
    let fetched = gitqueue::run(mirror, &["fetch", "-q", &path, "HEAD"]);
    let res = fetched.and_then(|_| gitqueue::run(mirror, &["reset", "-q", "--hard", "FETCH_HEAD"]));
    let _ = std::fs::remove_file(scratch);
    res?;
    head(mirror).ok_or_else(|| "the mirror has no head after the bundle".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("wb-files-{}-{name}", uuid::Uuid::new_v4().simple()))
    }

    fn commit(repo: &Path, file: &str, text: &str) {
        std::fs::write(repo.join(file), text).unwrap();
        gitqueue::run(repo, &["add", "-A"]).unwrap();
        gitqueue::run(repo, &["-c", "user.name=Duck", "-c", "user.email=duck@localhost", "commit", "-q", "-m", file]).unwrap();
    }

    #[test]
    fn a_mirror_follows_the_repo_by_bundles() {
        let repo = temp("repo");
        std::fs::create_dir_all(&repo).unwrap();
        gitqueue::run(&repo, &["init", "-q"]).unwrap();
        let mirror = temp("mirror");
        let scratch = temp("bundle");
        // No commit yet: nothing to send.
        assert!(bundle(&repo, None, &scratch).unwrap().is_none());

        commit(&repo, "memory.md", "the user likes tea");
        let whole = bundle(&repo, None, &scratch).unwrap().unwrap();
        let h1 = apply_bundle(&mirror, &whole, &scratch).unwrap();
        assert_eq!(Some(h1.clone()), head(&repo));
        assert_eq!(std::fs::read_to_string(mirror.join("memory.md")).unwrap(), "the user likes tea");
        assert!(bundle(&repo, Some(&h1), &scratch).unwrap().is_none(), "up to date");

        commit(&repo, "reminders.json", "[]");
        let since = bundle(&repo, Some(&h1), &scratch).unwrap().unwrap();
        assert!(since.len() < whole.len() + 1024);
        let h2 = apply_bundle(&mirror, &since, &scratch).unwrap();
        assert_eq!(Some(h2), head(&repo));
        assert!(mirror.join("reminders.json").exists());

        // A mirror on a history the repo doesn't have gets everything.
        let stranger = "0123456789abcdef0123456789abcdef01234567";
        let again = bundle(&repo, Some(stranger), &scratch).unwrap().unwrap();
        assert!(apply_bundle(&mirror, &again, &scratch).is_ok());
    }
}
