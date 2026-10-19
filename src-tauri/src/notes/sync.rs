//! Notes sync across machines (step N3): the notes root is a git repo with a private
//! remote, committed and pushed in the background, pulled at start and when you
//! come back to the window.
//!
//! - **Only a release build syncs**, or a debug build whose notes root was set with
//!   `WORKBENCH_NOTES_DIR` (for trying it with two roots on one PC). `notes.dev/`
//!   never syncs.
//! - **Notes always save locally first.** Sync runs on the git queue's thread and
//!   never holds the notes write lock across the network: only while it applies a
//!   merge, which is local and quick.
//! - **Commits** come 30 s after the last change in the folder (or at once when a
//!   note is closed), as `notes: <project> / <note>`, and each is pushed.
//! - **Pulls** happen at start, when the window comes back after five minutes or
//!   more, and before every push. Nothing polls while the app is idle.
//! - **Merges are by file and never lose text** ([`merge`]): a file changed on both
//!   sides keeps yours under its name and theirs as `<name> (from <machine>).<ext>`;
//!   an edit beats a delete. Git's line merge is never used: merged prose surprises.
//! - A pull or push that fails (offline, auth) retries with backoff and is reported
//!   once it has been failing for an hour. Saving never waits on it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;
use crate::gitqueue::{output, run, run_network};

pub const STATUS_EVENT: &str = "notes-sync-status";
pub const NOTICE_EVENT: &str = "notes-sync-notice";

/// The remote URL, in the registry's `meta` table. Set = sync is on.
const META_REMOTE: &str = "notes_sync_remote";

/// The branch every machine shares.
const BRANCH: &str = "main";

/// Quiet time after the last change before a commit.
const QUIET: Duration = Duration::from_secs(30);

/// How long the window has to have been away before coming back pulls.
const FOCUS_PULL_AGE: Duration = Duration::from_secs(5 * 60);

/// A failing sync is reported after this long.
const REPORT_FAILING_AFTER: Duration = Duration::from_secs(60 * 60);

/// Overrides the machine name in commits and conflict copies (for tests on one PC).
pub const MACHINE_ENV: &str = "WORKBENCH_MACHINE_NAME";

/// Git's empty tree: the base for two histories that share nothing (a join).
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// This build may sync (release, or a debug build with its own notes root).
    pub available: bool,
    pub remote: Option<String>,
    /// "off", "idle", "syncing" or "failing".
    pub state: &'static str,
    /// When the last sync finished, ms since the epoch.
    pub last_sync: Option<u64>,
    pub error: Option<String>,
    pub machine: String,
}

/// Something the person should know about a sync (the *info* items).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub at: u64,
    /// "conflict", "restored", "linked" or "failing".
    pub kind: &'static str,
    pub text: String,
}

struct Shared {
    app: AppHandle,
    status: Status,
    notices: Vec<Notice>,
    /// The last change seen in the folder, not yet committed.
    dirty_since: Option<Instant>,
    last_pull: Option<Instant>,
    failing_since: Option<Instant>,
    failures: u32,
    retry_at: Option<Instant>,
    reported_failing: bool,
}

fn shared() -> &'static OnceLock<Mutex<Shared>> {
    static S: OnceLock<Mutex<Shared>> = OnceLock::new();
    &S
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// This machine's name, as it appears in commits and conflict copies.
pub fn machine_name() -> String {
    let raw = std::env::var(MACHINE_ENV)
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "another machine".into());
    file_safe(&raw)
}

/// A name that is safe inside a file name (`<note> (from <machine>).md`).
fn file_safe(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if r#"<>:"/\|?*()"#.contains(c) || c.is_control() { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim_matches(['.', ' ', '-']).to_string();
    if cleaned.is_empty() { "another machine".into() } else { cleaned }
}

fn available() -> bool {
    !cfg!(debug_assertions) || std::env::var_os(super::ROOT_ENV).is_some_and(|d| !d.is_empty())
}

// --- the git side: pure on a root, so the tests run two "machines" in temp dirs ---------

/// What one sync did.
#[derive(Debug, Default, PartialEq)]
pub struct Report {
    /// Files the pull changed here, relative to the root.
    pub changed: BTreeSet<String>,
    pub notices: Vec<(&'static str, String)>,
    pub pushed: bool,
}

fn git_as<'a>(machine: &'a str, args: &[&'a str]) -> Vec<String> {
    let mut v = vec![
        "-c".to_string(),
        format!("user.name={machine}"),
        "-c".to_string(),
        format!("user.email={machine}@workbench.local"),
    ];
    v.extend(args.iter().map(|s| s.to_string()));
    v
}

fn run_as(root: &Path, machine: &str, args: &[&str]) -> Result<String, String> {
    let owned = git_as(machine, args);
    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
    run(root, &refs)
}

pub fn is_repo(root: &Path) -> bool {
    root.join(".git").exists()
}

/// Make `root` a repo on `main` that ignores the notes module's temp files.
pub fn init_repo(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    if !is_repo(root) {
        run(root, &["init", "-b", BRANCH])?;
    }
    let ignore = root.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "*.tmp\n").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The project a notes path belongs to, by its folder's `project.json`.
fn project_name(root: &Path, path: &str) -> String {
    let folder = path.split('/').next().unwrap_or(path);
    super::link::read_project_file(&root.join(folder))
        .map(|f| f.name)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| folder.to_string())
}

/// A notes path as a person reads it: `<project> / <note>` for a file in a project's
/// folder, the path itself for anything else.
fn label(root: &Path, path: &str) -> String {
    match path.split_once('/') {
        Some((_, file)) => {
            let note = file.strip_suffix(".md").unwrap_or(file);
            format!("{} / {note}", project_name(root, path))
        }
        None => path.to_string(),
    }
}

/// `notes: <project> / <note>` for one changed file; with several, the first note
/// and a count.
fn commit_message(root: &Path, paths: &[String]) -> String {
    let first = paths.iter().find(|p| p.ends_with(".md")).or(paths.first());
    match first {
        None => "notes".into(),
        Some(p) if paths.len() == 1 => format!("notes: {}", label(root, p)),
        Some(p) => format!("notes: {} and {} more", label(root, p), paths.len() - 1),
    }
}

/// Commit everything changed in the folder. `true` when there was something.
pub fn commit_all(root: &Path, machine: &str) -> Result<bool, String> {
    run(root, &["add", "-A"])?;
    let staged = run(root, &["diff", "--cached", "--name-only", "-z"])?;
    let paths: Vec<String> = staged.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect();
    if paths.is_empty() {
        return Ok(false);
    }
    let msg = commit_message(root, &paths);
    run_as(root, machine, &["commit", "-q", "-m", &msg])?;
    Ok(true)
}

fn rev(root: &Path, spec: &str) -> Option<String> {
    let out = output(root, &["rev-parse", "--verify", "-q", spec]).ok()?;
    out.ok.then(|| out.stdout.trim().to_string()).filter(|s| !s.is_empty())
}

fn is_ancestor(root: &Path, a: &str, b: &str) -> bool {
    output(root, &["merge-base", "--is-ancestor", a, b]).is_ok_and(|o| o.ok)
}

/// path → 'A' / 'M' / 'D' between two trees or commits.
fn changes(root: &Path, from: &str, to: &str) -> Result<BTreeMap<String, char>, String> {
    let out = run(root, &["diff", "--name-status", "--no-renames", "-z", from, to])?;
    let mut map = BTreeMap::new();
    let mut parts = out.split('\0').filter(|s| !s.is_empty());
    while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
        map.insert(path.to_string(), status.chars().next().unwrap_or('M'));
    }
    Ok(map)
}

fn blob(root: &Path, commit: &str, path: &str) -> Result<Vec<u8>, String> {
    let spec = format!("{commit}:{path}");
    let out = output(root, &["cat-file", "blob", &spec])?;
    if out.ok { Ok(out.raw) } else { Err(format!("cannot read {path} from {commit}")) }
}

fn write_file(root: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
    let full = root.join(path);
    if let Some(dir) = full.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&full, bytes).map_err(|e| format!("cannot write {path}: {e}"))
}

/// Who last changed `path` on their side: the machine name sync commits carry.
fn machine_of(root: &Path, commit: &str, path: &str) -> String {
    run(root, &["log", "-1", "--format=%an", commit, "--", path])
        .ok()
        .map(|s| file_safe(s.trim()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "another machine".into())
}

/// `<stem> (from <machine>).<ext>` next to `path`, numbered if that is taken.
fn copy_path(root: &Path, path: &str, machine: &str) -> String {
    let (dir, file) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    let (stem, ext) = match file.rfind('.') {
        Some(i) if i > 0 => (&file[..i], &file[i..]),
        _ => (file, ""),
    };
    for n in 1.. {
        let suffix = if n == 1 { String::new() } else { format!(" {n}") };
        let candidate = format!("{dir}{stem} (from {machine}{suffix}){ext}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Merge `theirs` into the checked-out branch, file by file, and commit the result
/// with both parents. The working tree must be clean (everything committed).
pub fn merge(root: &Path, machine: &str, theirs: &str, report: &mut Report) -> Result<(), String> {
    let Some(head) = rev(root, "HEAD") else {
        // Nothing here yet: take theirs as it is.
        run(root, &["update-ref", &format!("refs/heads/{BRANCH}"), theirs])?;
        run(root, &["reset", "-q", "--hard", theirs])?;
        report.changed.extend(changes(root, EMPTY_TREE, theirs)?.into_keys());
        return Ok(());
    };
    if is_ancestor(root, theirs, &head) {
        return Ok(());
    }
    if is_ancestor(root, &head, theirs) {
        report.changed.extend(changes(root, &head, theirs)?.into_keys());
        run(root, &["merge", "-q", "--ff-only", theirs])?;
        return Ok(());
    }
    let base = output(root, &["merge-base", &head, theirs])?;
    let base = if base.ok { base.stdout.trim().to_string() } else { EMPTY_TREE.to_string() };
    let ours = changes(root, &base, &head)?;
    let their_changes = changes(root, &base, theirs)?;

    for (path, t) in &their_changes {
        let o = ours.get(path).copied();
        match (o, *t) {
            // Only they changed it: take theirs.
            (None, 'D') => {
                let _ = std::fs::remove_file(root.join(path));
                report.changed.insert(path.clone());
            }
            (None, _) => {
                write_file(root, path, &blob(root, theirs, path)?)?;
                report.changed.insert(path.clone());
            }
            (Some('D'), 'D') => {}
            // An edit beats a delete.
            (Some(_), 'D') => {
                let what = label(root, path);
                report.notices.push(("restored", format!("{what} was deleted on another machine and edited here; kept")));
            }
            (Some('D'), _) => {
                write_file(root, path, &blob(root, theirs, path)?)?;
                report.changed.insert(path.clone());
                let what = label(root, path);
                report.notices.push(("restored", format!("{what} was edited on another machine; brought back")));
            }
            // Both changed it.
            (Some(_), _) => {
                if rev(root, &format!("{head}:{path}")) == rev(root, &format!("{theirs}:{path}")) {
                    continue;
                }
                // `project.json` describes the folder; one version is as good as the other.
                if path.ends_with(super::link::PROJECT_FILE) {
                    continue;
                }
                let from = machine_of(root, theirs, path);
                let copy = copy_path(root, path, &from);
                write_file(root, &copy, &blob(root, theirs, path)?)?;
                report.changed.insert(copy.clone());
                let copy_name = copy.rsplit('/').next().unwrap_or(&copy);
                report.notices.push((
                    "conflict",
                    format!(
                        "{} changed here and on {from}: yours kept, theirs saved as “{}”",
                        label(root, path),
                        copy_name.strip_suffix(".md").unwrap_or(copy_name)
                    ),
                ));
            }
        }
    }

    run(root, &["add", "-A"])?;
    let tree = run(root, &["write-tree"])?.trim().to_string();
    let msg = format!("notes: merge from {}", machine_of(root, theirs, "."));
    let commit = run_as(root, machine, &["commit-tree", &tree, "-p", &head, "-p", theirs, "-m", &msg])?
        .trim()
        .to_string();
    run(root, &["update-ref", "HEAD", &commit])?;
    Ok(())
}

/// Runs the part of a sync that touches the notes; see [`sync_once`].
pub type Apply<'a> = dyn Fn(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String> + 'a;

/// One sync: commit, fetch, merge, push. `apply` wraps the part that touches the
/// notes (commit and merge) so the app can hold the notes write lock for it alone.
pub fn sync_once(root: &Path, machine: &str, apply: &Apply) -> Result<Report, String> {
    let mut report = Report::default();
    commit_all(root, machine)?;
    for attempt in 0..2 {
        run_network(root, &["fetch", "-q", "origin"])?;
        let theirs = rev(root, &format!("refs/remotes/origin/{BRANCH}"));
        if let Some(theirs) = &theirs {
            apply(&mut || {
                // Anything saved while the fetch ran is part of "ours".
                commit_all(root, machine)?;
                merge(root, machine, theirs, &mut report)
            })?;
        }
        if rev(root, "HEAD").is_none() {
            return Ok(report); // nothing on either side yet
        }
        if theirs.is_some() && rev(root, "HEAD") == theirs {
            return Ok(report);
        }
        match run_network(root, &["push", "-q", "origin", &format!("HEAD:refs/heads/{BRANCH}")]) {
            Ok(_) => {
                report.pushed = true;
                return Ok(report);
            }
            // Someone pushed between our fetch and push: fetch and merge again.
            Err(_) if attempt == 0 => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(report)
}

// --- the app side ---------------------------------------------------------------------

fn emit_status(s: &Shared) {
    let _ = s.app.emit(STATUS_EVENT, s.status.clone());
}

fn notice(s: &mut Shared, kind: &'static str, text: String) {
    let n = Notice { at: now_ms(), kind, text };
    let _ = s.app.emit(NOTICE_EVENT, n.clone());
    s.notices.push(n);
    let excess = s.notices.len().saturating_sub(50);
    s.notices.drain(..excess);
}

/// Record a notice from elsewhere (linking).
pub fn add_notice(kind: &'static str, text: String) {
    if let Some(m) = shared().get() {
        notice(&mut m.lock().unwrap(), kind, text);
    }
}

fn remote_of(app: &AppHandle) -> Option<String> {
    app.state::<Db>().meta_get(META_REMOTE).ok().flatten().filter(|r| !r.is_empty())
}

/// Start the sync for this run of the app: pull now, then commit after changes and
/// retry failures. Without a remote it only sets up the status.
pub fn init(app: &AppHandle) {
    let remote = if available() { remote_of(app) } else { None };
    let status = Status {
        available: available(),
        remote: remote.clone(),
        state: if remote.is_some() { "idle" } else { "off" },
        last_sync: None,
        error: None,
        machine: machine_name(),
    };
    let _ = shared().set(Mutex::new(Shared {
        app: app.clone(),
        status,
        notices: Vec::new(),
        dirty_since: None,
        last_pull: None,
        failing_since: None,
        failures: 0,
        retry_at: None,
        reported_failing: false,
    }));
    std::thread::Builder::new()
        .name("notes sync timer".into())
        .spawn(timer)
        .expect("spawn the notes sync timer");
    if remote.is_some() {
        request(true);
    } else {
        // No sync: link what's obvious now (with sync, after the first pull).
        let app = app.clone();
        std::thread::spawn(move || after_pull(&app));
    }
}

fn enabled() -> bool {
    shared().get().is_some_and(|m| m.lock().unwrap().status.remote.is_some())
}

/// Something changed in the notes folder: commit it once the folder is quiet.
pub fn touched() {
    if let Some(m) = shared().get() {
        let mut s = m.lock().unwrap();
        if s.status.remote.is_some() {
            s.dirty_since = Some(Instant::now());
        }
    }
}

/// The window came back: pull if the last pull is five minutes old.
pub fn focused() {
    let stale = shared().get().is_some_and(|m| {
        let s = m.lock().unwrap();
        s.status.remote.is_some() && s.last_pull.is_none_or(|t| t.elapsed() >= FOCUS_PULL_AGE)
    });
    if stale {
        request(false);
    }
}

/// Fires the quiet-time commits and the retries.
fn timer() {
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let Some(m) = shared().get() else { continue };
        let due = {
            let mut s = m.lock().unwrap();
            let quiet = s.dirty_since.is_some_and(|t| t.elapsed() >= QUIET);
            let retry = s.retry_at.is_some_and(|t| Instant::now() >= t);
            if quiet {
                s.dirty_since = None;
            }
            if retry {
                s.retry_at = None;
            }
            quiet || retry
        };
        if due {
            request(false);
        }
    }
}

/// Queue a sync on the notes repo's git queue.
pub fn request(first: bool) {
    let Some(m) = shared().get() else { return };
    let app = m.lock().unwrap().app.clone();
    if !enabled() {
        return;
    }
    let Ok(root) = super::notes_root(&app) else { return };
    crate::gitqueue::submit(&root, move |root| run_sync(&app, root, first));
}

fn run_sync(app: &AppHandle, root: &Path, first: bool) {
    let Some(m) = shared().get() else { return };
    {
        let mut s = m.lock().unwrap();
        if s.status.remote.is_none() {
            return;
        }
        s.status.state = "syncing";
        s.dirty_since = None;
        emit_status(&s);
    }
    let machine = machine_name();
    let result = sync_once(root, &machine, &|work| {
        let _guard = super::write_lock();
        work()
    });
    let mut s = m.lock().unwrap();
    s.last_pull = Some(Instant::now());
    match result {
        Ok(report) => {
            s.status.state = "idle";
            s.status.last_sync = Some(now_ms());
            s.status.error = None;
            s.failing_since = None;
            s.failures = 0;
            s.reported_failing = false;
            for (kind, text) in report.notices.clone() {
                notice(&mut s, kind, text);
            }
            emit_status(&s);
            drop(s);
            announce(app, &report.changed);
            if first || !report.changed.is_empty() {
                after_pull(app);
            }
        }
        Err(e) => {
            let since = *s.failing_since.get_or_insert_with(Instant::now);
            s.failures += 1;
            // 30 s, 1 min, 2 min, … up to 15 min between tries.
            let wait = Duration::from_secs(30u64.saturating_mul(1 << s.failures.min(5).saturating_sub(1))).min(Duration::from_secs(900));
            s.retry_at = Some(Instant::now() + wait);
            s.status.state = "failing";
            s.status.error = Some(e.clone());
            if since.elapsed() >= REPORT_FAILING_AFTER && !s.reported_failing {
                s.reported_failing = true;
                notice(&mut s, "failing", format!("notes haven't synced for an hour: {e}"));
            }
            emit_status(&s);
        }
    }
}

/// Tell the panels and the toolbar which projects' files a pull changed.
fn announce(app: &AppHandle, changed: &BTreeSet<String>) {
    let mut notes = BTreeSet::new();
    let mut plugins = BTreeSet::new();
    for path in changed {
        let Some((folder, file)) = path.split_once('/') else { continue };
        for project in super::projects_in(folder) {
            if file == crate::plugins::FILE {
                plugins.insert(project.clone());
            }
            notes.insert(project);
        }
    }
    for p in notes {
        super::notify(app, &p);
    }
    for p in plugins {
        let _ = app.emit(crate::plugins::EVENT, serde_json::json!({ "projectId": p }));
    }
}

/// After a pull brings folders in: link the projects whose folder is now clear, and
/// describe the folders this machine uses so the others can find them.
fn after_pull(app: &AppHandle) {
    for (project, name) in super::link::link_obvious(app) {
        let _ = project;
        add_notice("linked", format!("linked to notes from another machine: {name}"));
    }
    super::link::describe_folders(app);
}

fn status_now() -> (Status, Vec<Notice>) {
    match shared().get() {
        Some(m) => {
            let s = m.lock().unwrap();
            (s.status.clone(), s.notices.clone())
        }
        None => (Status::default(), Vec::new()),
    }
}

fn set_remote(app: &AppHandle, remote: Option<String>) -> Result<(), String> {
    app.state::<Db>()
        .meta_set(META_REMOTE, remote.as_deref().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    if let Some(m) = shared().get() {
        let mut s = m.lock().unwrap();
        s.status.state = if remote.is_some() { "idle" } else { "off" };
        s.status.remote = remote;
        s.status.error = None;
        s.retry_at = None;
        emit_status(&s);
    }
    Ok(())
}

// --- commands ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    status: Status,
    notices: Vec<Notice>,
}

#[tauri::command]
pub fn notes_sync_status() -> StatusView {
    let (status, notices) = status_now();
    StatusView { status, notices }
}

/// Make the notes root a repo and create a private GitHub repo for it with `gh`.
/// The panel asks before calling this.
#[tauri::command]
pub async fn notes_sync_create(app: AppHandle, name: String) -> Result<(), String> {
    if !available() {
        return Err("notes sync runs in the installed app only".into());
    }
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().any(|c| !(c.is_ascii_alphanumeric() || "-_.".contains(c))) {
        return Err("a repo name is letters, digits, - _ and .".into());
    }
    let root = super::notes_root(&app)?;
    let gh = which::which("gh").map_err(|_| "the GitHub CLI (gh) isn't on PATH".to_string())?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        init_repo(&root)?;
        if output(&root, &["remote", "get-url", "origin"]).is_ok_and(|o| o.ok) {
            return Err("the notes folder already has a remote; join it instead".into());
        }
        commit_all(&root, &machine_name())?;
        let mut cmd = std::process::Command::new(gh);
        cmd.args(["repo", "create", &name, "--private", "--source"])
            .arg(&root)
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
        Ok(run(&root, &["remote", "get-url", "origin"])?.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .and_then(|url| set_remote(&app, Some(url)))?;
    request(true);
    Ok(())
}

/// Join an existing notes repo: this machine's notes (if any) are merged in.
#[tauri::command]
pub async fn notes_sync_join(app: AppHandle, url: String) -> Result<(), String> {
    if !available() {
        return Err("notes sync runs in the installed app only".into());
    }
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("paste the notes repo's URL".into());
    }
    let root = super::notes_root(&app)?;
    let check = url.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        init_repo(&root)?;
        if output(&root, &["remote", "get-url", "origin"]).is_ok_and(|o| o.ok) {
            run(&root, &["remote", "set-url", "origin", &check])?;
        } else {
            run(&root, &["remote", "add", "origin", &check])?;
        }
        // Fails now (wrong URL, no access) rather than on the first background sync.
        run_network(&root, &["ls-remote", "-q", "origin"]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())??;
    set_remote(&app, Some(url))?;
    request(true);
    Ok(())
}

/// Stop syncing. The folder stays a repo; joining again picks up where it was.
#[tauri::command]
pub fn notes_sync_disable(app: AppHandle) -> Result<(), String> {
    set_remote(&app, None)
}

/// Sync now (a note was closed, or "sync now").
#[tauri::command]
pub fn notes_sync_now() {
    request(false);
}

/// The window came back into focus.
#[tauri::command]
pub fn notes_sync_focus() {
    focused();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Lab {
        dir: PathBuf,
    }

    impl Lab {
        fn new(tag: &str) -> Lab {
            let dir = std::env::temp_dir().join(format!(
                "wb-sync-{tag}-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            run(&dir, &["init", "-q", "--bare", "-b", BRANCH, "remote.git"]).unwrap();
            Lab { dir }
        }
        /// A machine's notes root, joined to the shared remote.
        fn machine(&self, name: &str) -> PathBuf {
            let root = self.dir.join(name);
            init_repo(&root).unwrap();
            let url = self.dir.join("remote.git").to_string_lossy().replace('\\', "/");
            run(&root, &["remote", "add", "origin", &url]).unwrap();
            root
        }
        fn sync(&self, root: &Path, machine: &str) -> Report {
            sync_once(root, machine, &|work| work()).unwrap()
        }
    }

    impl Drop for Lab {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn put(root: &Path, path: &str, text: &str) {
        write_file(root, path, text.as_bytes()).unwrap();
    }

    fn get(root: &Path, path: &str) -> Option<String> {
        std::fs::read_to_string(root.join(path)).ok()
    }

    #[test]
    fn notes_travel_and_a_join_merges_both_sides() {
        let lab = Lab::new("join");
        let a = lab.machine("a");
        put(&a, "p1/project.json", r#"{"name":"Proj"}"#);
        put(&a, "p1/ideas.md", "from a");
        assert!(lab.sync(&a, "PC-A").pushed);
        let msg = run(&a, &["log", "-1", "--format=%s"]).unwrap();
        assert!(msg.starts_with("notes: "), "{msg}");

        // B already had notes of its own before joining: both survive.
        let b = lab.machine("b");
        put(&b, "p2/todo.md", "from b");
        let report = lab.sync(&b, "PC-B");
        assert!(report.changed.contains("p1/ideas.md"));
        assert_eq!(get(&b, "p1/ideas.md").as_deref(), Some("from a"));
        assert_eq!(get(&b, "p2/todo.md").as_deref(), Some("from b"));

        lab.sync(&a, "PC-A");
        assert_eq!(get(&a, "p2/todo.md").as_deref(), Some("from b"));
    }

    #[test]
    fn the_same_note_edited_on_both_keeps_both_texts() {
        let lab = Lab::new("conflict");
        let a = lab.machine("a");
        put(&a, "p/plan.md", "v1");
        lab.sync(&a, "PC-A");
        let b = lab.machine("b");
        lab.sync(&b, "PC-B");

        // Both edit offline; A syncs first.
        put(&a, "p/plan.md", "A's edit");
        put(&b, "p/plan.md", "B's edit");
        lab.sync(&a, "PC-A");
        let report = lab.sync(&b, "PC-B");
        assert_eq!(get(&b, "p/plan.md").as_deref(), Some("B's edit"), "yours stays under its name");
        assert_eq!(get(&b, "p/plan (from PC-A).md").as_deref(), Some("A's edit"));
        assert_eq!(report.notices.iter().filter(|(k, _)| *k == "conflict").count(), 1);

        // A gets both too, and nothing is in conflict any more.
        let report = lab.sync(&a, "PC-A");
        assert!(report.notices.is_empty(), "{:?}", report.notices);
        assert_eq!(get(&a, "p/plan.md").as_deref(), Some("B's edit"));
        assert_eq!(get(&a, "p/plan (from PC-A).md").as_deref(), Some("A's edit"));
    }

    #[test]
    fn an_edit_beats_a_delete_both_ways() {
        let lab = Lab::new("delete");
        let a = lab.machine("a");
        put(&a, "p/x.md", "x1");
        put(&a, "p/y.md", "y1");
        lab.sync(&a, "PC-A");
        let b = lab.machine("b");
        lab.sync(&b, "PC-B");

        // A deletes x and edits y; B edits x and deletes y.
        std::fs::remove_file(a.join("p/x.md")).unwrap();
        put(&a, "p/y.md", "y2");
        put(&b, "p/x.md", "x2");
        std::fs::remove_file(b.join("p/y.md")).unwrap();
        lab.sync(&a, "PC-A");
        lab.sync(&b, "PC-B");
        lab.sync(&a, "PC-A");
        for root in [&a, &b] {
            assert_eq!(get(root, "p/x.md").as_deref(), Some("x2"));
            assert_eq!(get(root, "p/y.md").as_deref(), Some("y2"));
        }
    }

    #[test]
    fn plugin_files_conflict_into_a_copy_the_toolbar_ignores() {
        let lab = Lab::new("plugins");
        let a = lab.machine("a");
        put(&a, "p/plugins.json", "{1}");
        lab.sync(&a, "PC-A");
        let b = lab.machine("b");
        lab.sync(&b, "PC-B");
        put(&a, "p/plugins.json", "{a}");
        put(&b, "p/plugins.json", "{b}");
        lab.sync(&a, "PC-A");
        lab.sync(&b, "PC-B");
        assert_eq!(get(&b, "p/plugins.json").as_deref(), Some("{b}"));
        assert_eq!(get(&b, "p/plugins (from PC-A).json").as_deref(), Some("{a}"));
    }

    #[test]
    fn offline_saves_sync_once_the_remote_is_back() {
        let lab = Lab::new("offline");
        let a = lab.machine("a");
        put(&a, "p/n.md", "one");
        lab.sync(&a, "PC-A");
        let remote = lab.dir.join("remote.git");
        let away = lab.dir.join("remote-away.git");
        std::fs::rename(&remote, &away).unwrap();
        put(&a, "p/n.md", "two");
        assert!(sync_once(&a, "PC-A", &|w| w()).is_err(), "the remote is gone");
        assert_eq!(get(&a, "p/n.md").as_deref(), Some("two"), "the save stands");
        std::fs::rename(&away, &remote).unwrap();
        assert!(lab.sync(&a, "PC-A").pushed);
        let b = lab.machine("b");
        lab.sync(&b, "PC-B");
        assert_eq!(get(&b, "p/n.md").as_deref(), Some("two"));
    }

    #[test]
    fn copies_and_machine_names_are_file_safe() {
        assert_eq!(file_safe("DESKTOP-1: \"x\""), "DESKTOP-1- -x");
        let root = std::env::temp_dir();
        assert_eq!(copy_path(&root, "p/a b.md", "PC"), "p/a b (from PC).md");
        assert_eq!(copy_path(&root, "README", "PC"), "README (from PC)");
    }
}
