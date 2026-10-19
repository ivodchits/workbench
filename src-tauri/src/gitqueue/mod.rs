//! A background git queue (step N3): jobs that run against a repo Workbench keeps
//! for itself (the notes repo now, Duck's data repo later), one repo at a time.
//!
//! Each repo gets its own worker thread, started on its first job, and runs its jobs
//! in order. So a commit, a fetch, a merge and a push for the same repo never
//! overlap, while two repos never wait on each other. A job is a closure that gets
//! the repo path and reports its result however it likes (usually an event); the
//! queue only orders them. Callers use [`run`] for git commands so they get the
//! git panel's no-prompt environment and deadlines.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};

use crate::git::run::{exec, Output, Spec};

type Job = Box<dyn FnOnce(&Path) + Send + 'static>;

fn workers() -> &'static Mutex<HashMap<PathBuf, Sender<Job>>> {
    static W: OnceLock<Mutex<HashMap<PathBuf, Sender<Job>>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Queue `job` for `repo`. It runs after every job queued for that repo before it.
pub fn submit(repo: &Path, job: impl FnOnce(&Path) + Send + 'static) {
    let mut map = workers().lock().unwrap();
    let job: Job = Box::new(job);
    if let Some(tx) = map.get(repo) {
        match tx.send(job) {
            Ok(()) => return,
            // The worker is gone (it panicked); start a new one with this job.
            Err(e) => {
                let job = e.0;
                map.insert(repo.to_path_buf(), spawn_worker(repo.to_path_buf(), job));
                return;
            }
        }
    }
    map.insert(repo.to_path_buf(), spawn_worker(repo.to_path_buf(), job));
}

fn spawn_worker(repo: PathBuf, first: Job) -> Sender<Job> {
    let (tx, rx) = channel::<Job>();
    tx.send(first).expect("a fresh channel takes a job");
    std::thread::Builder::new()
        .name(format!("gitqueue {}", repo.display()))
        .spawn(move || {
            for job in rx {
                // One job failing (or panicking) mustn't stop the ones behind it.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&repo)));
            }
        })
        .expect("spawn a git queue worker");
    tx
}

/// Run a local git command in `repo`: its stdout on success, else the error git
/// gave (or why it couldn't run).
pub fn run(repo: &Path, args: &[&str]) -> Result<String, String> {
    finish(args, exec(repo, Spec::local(args)))
}

/// Run a git command that talks to the remote, with the longer network deadline.
pub fn run_network(repo: &Path, args: &[&str]) -> Result<String, String> {
    let key = repo.to_string_lossy().into_owned();
    finish(args, exec(repo, Spec::network(args, &key)))
}

/// Run a git command and return its output whether or not it succeeded, for the
/// commands whose exit status is an answer (`merge-base`, `rev-parse --verify`).
pub fn output(repo: &Path, args: &[&str]) -> Result<Output, String> {
    exec(repo, Spec::local(args))
}

fn finish(args: &[&str], out: Result<Output, String>) -> Result<String, String> {
    let out = out?;
    if out.ok {
        Ok(out.stdout)
    } else {
        let msg = out.stderr.trim();
        let msg = if msg.is_empty() { out.stdout.trim() } else { msg };
        Err(format!("git {}: {msg}", args.first().copied().unwrap_or("")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    #[test]
    fn jobs_for_one_repo_run_in_order() {
        let repo = std::env::temp_dir().join("wb-gitqueue-order");
        let (tx, rx) = channel();
        for i in 0..20 {
            let tx = tx.clone();
            submit(&repo, move |_| {
                if i == 3 {
                    panic!("a failing job doesn't stop the queue");
                }
                tx.send(i).unwrap();
            });
        }
        let got: Vec<i32> = (0..19).map(|_| rx.recv_timeout(Duration::from_secs(5)).unwrap()).collect();
        let want: Vec<i32> = (0..20).filter(|i| *i != 3).collect();
        assert_eq!(got, want);
    }
}
