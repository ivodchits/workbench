//! Which notes folder a project uses (step N3).
//!
//! A project's id is random per machine, so two machines can't find each other's
//! notes by it. Each notes folder carries a `project.json` (`{name, origin}`, the
//! origin being the repo's normalized `origin` URL), and a project with no notes
//! key is linked by that:
//! - its own folder, if it already has one (it wrote notes before it was linked);
//! - otherwise the one unlinked folder whose origin matches its own;
//! - with several matches, or no remote and folders to choose from, the notes panel
//!   asks (link to one of them, or start new notes);
//! - with nothing to choose from, it starts new notes (its key is its own id).
//!
//! Linking only sets `projects.notes_key`; the notes module resolves the folder
//! through it ([`super::folder_of`]), so nothing else changes.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::{check_project, notes_root};
use crate::db::Db;

/// The file in each notes folder that says whose notes they are.
pub const PROJECT_FILE: &str = "project.json";

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct ProjectFile {
    pub name: String,
    /// The repo's `origin`, normalized ([`normalize_origin`]); `None` without one.
    #[serde(default)]
    pub origin: Option<String>,
}

/// An unlinked notes folder a project could take.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub folder: String,
    pub name: String,
    pub origin: Option<String>,
    /// How many notes it holds.
    pub notes: usize,
}

/// Where a project's notes stand, for the notes panel.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    pub linked: bool,
    /// Set when this call linked the project to an existing folder by its origin:
    /// that folder's project name.
    pub linked_to: Option<String>,
    /// When the panel has to ask: the folders to choose from.
    pub candidates: Vec<Candidate>,
}

/// One string for the same repo however its URL is written: no scheme, user,
/// trailing `.git` or slash, `host:path` (scp form) as `host/path`, lower case.
pub fn normalize_origin(url: &str) -> Option<String> {
    let mut s = url.trim().to_ascii_lowercase();
    if s.is_empty() {
        return None;
    }
    for scheme in ["https://", "http://", "ssh://", "git://", "git+ssh://", "file://"] {
        if let Some(rest) = s.strip_prefix(scheme) {
            s = rest.to_string();
            break;
        }
    }
    // user@host…
    if let Some(at) = s.find('@') {
        if !s[..at].contains('/') {
            s = s[at + 1..].to_string();
        }
    }
    // host:path (scp form), but not host:port/path.
    if let Some(colon) = s.find(':') {
        let (host, rest) = (&s[..colon], &s[colon + 1..]);
        let port = rest.split('/').next().is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
        s = if port {
            format!("{host}{}", &rest[rest.find('/').unwrap_or(rest.len())..])
        } else {
            format!("{host}/{rest}")
        };
    }
    let s = s.trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s).trim_end_matches('/');
    (!s.is_empty()).then(|| s.to_string())
}

pub fn read_project_file(dir: &Path) -> Option<ProjectFile> {
    serde_json::from_slice(&std::fs::read(dir.join(PROJECT_FILE)).ok()?).ok()
}

/// Write `project.json` when it is missing or says something else.
pub fn write_project_file(dir: &Path, file: &ProjectFile) -> Result<(), String> {
    if read_project_file(dir).as_ref() == Some(file) {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(file).map_err(|e| e.to_string())? + "\n";
    let tmp = dir.join("project.json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(PROJECT_FILE)).map_err(|e| e.to_string())
}

/// The folders in the notes root no project here is linked to.
pub fn unlinked_folders(root: &Path, taken: &HashSet<String>) -> Vec<Candidate> {
    let Ok(read) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let Some(folder) = entry.file_name().to_str().map(str::to_string) else { continue };
        if !entry.path().is_dir() || check_project(&folder).is_err() || taken.contains(&folder) {
            continue;
        }
        let file = read_project_file(&entry.path()).unwrap_or_default();
        let notes = std::fs::read_dir(entry.path())
            .map(|r| r.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "md")).count())
            .unwrap_or(0);
        out.push(Candidate {
            name: if file.name.is_empty() { folder.clone() } else { file.name },
            folder,
            origin: file.origin,
            notes,
        });
    }
    out.sort_by_key(|c| c.name.to_lowercase());
    out
}

/// What linking decides for a project with no key, given its own folder's state,
/// its origin and the unlinked folders.
#[derive(Debug, PartialEq)]
pub enum Decision {
    /// Use this folder.
    Use(String),
    /// Use this folder, found by its origin.
    Matched(String),
    /// Ask among these.
    Ask(Vec<Candidate>),
}

pub fn decide(project_id: &str, own_folder_exists: bool, origin: Option<&str>, unlinked: &[Candidate]) -> Decision {
    if own_folder_exists {
        return Decision::Use(project_id.to_string());
    }
    let others: Vec<&Candidate> = unlinked.iter().filter(|c| c.folder != project_id).collect();
    if let Some(origin) = origin {
        let matches: Vec<Candidate> = others.iter().filter(|c| c.origin.as_deref() == Some(origin)).map(|c| (*c).clone()).collect();
        return match matches.len() {
            0 => Decision::Use(project_id.to_string()),
            1 => Decision::Matched(matches[0].folder.clone()),
            _ => Decision::Ask(matches),
        };
    }
    if others.is_empty() {
        Decision::Use(project_id.to_string())
    } else {
        Decision::Ask(others.into_iter().cloned().collect())
    }
}

// --- the app side ----------------------------------------------------------------------

/// A project's `origin` URL, normalized: read with git, locally or over SSH.
pub fn project_origin(project: &crate::registry::Project) -> Option<String> {
    let url = match &project.remote_ssh_dest {
        Some(dest) => {
            let dir = project.remote_dir.as_deref().unwrap_or(&project.root_path);
            ssh_origin(dest, dir)?
        }
        None => crate::gitqueue::run(Path::new(&project.root_path), &["remote", "get-url", "origin"]).ok()?,
    };
    normalize_origin(&url)
}

/// `git remote get-url origin` on an SSH host. Never prompts (`BatchMode`); a host
/// that needs a password just has no origin here.
fn ssh_origin(dest: &str, dir: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("ssh");
    cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", dest, "--"])
        .arg(format!("git -C '{}' remote get-url origin", dir.replace('\'', "'\\''")))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if std::time::Instant::now() > deadline => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    Some(out.trim().to_string()).filter(|s| !s.is_empty())
}

fn project(app: &AppHandle, project_id: &str) -> Result<crate::registry::Project, String> {
    let db = app.state::<Db>();
    let conn = db.conn.lock().map_err(|_| "db lock poisoned")?;
    crate::registry::get_project(&conn, project_id).map_err(|e| format!("unknown project: {e}"))
}

/// Every notes key in use here (a project's own id counts while it has no key).
fn taken(app: &AppHandle) -> Result<HashSet<String>, String> {
    let db = app.state::<Db>();
    let conn = db.conn.lock().map_err(|_| "db lock poisoned")?;
    let projects = crate::registry::list_projects(&conn).map_err(|e| e.to_string())?;
    Ok(projects.into_iter().filter_map(|p| p.notes_key).collect())
}

/// Link `project_id` to `folder`, write the folder's `project.json` if it has none,
/// and tell the panels.
fn set_key(app: &AppHandle, root: &Path, project: &crate::registry::Project, folder: &str) -> Result<(), String> {
    check_project(folder)?;
    {
        let db = app.state::<Db>();
        let conn = db.conn.lock().map_err(|_| "db lock poisoned")?;
        conn.execute("UPDATE projects SET notes_key = ?2 WHERE id = ?1", (&project.id, folder))
            .map_err(|e| e.to_string())?;
        super::refresh_keys(&conn);
    }
    let dir = root.join(folder);
    if read_project_file(&dir).is_none() {
        let origin = project_origin(project);
        write_project_file(&dir, &ProjectFile { name: project.name.clone(), origin })?;
    }
    super::notify(app, &project.id);
    let _ = app.emit(crate::plugins::EVENT, serde_json::json!({ "projectId": project.id }));
    Ok(())
}

/// Where a project's notes stand; links it when the answer is clear.
pub fn status(app: &AppHandle, project_id: &str) -> Result<LinkStatus, String> {
    let project = project(app, project_id)?;
    if project.notes_key.is_some() {
        return Ok(LinkStatus { linked: true, linked_to: None, candidates: Vec::new() });
    }
    let root = notes_root(app)?;
    let unlinked = unlinked_folders(&root, &taken(app)?);
    let origin = project_origin(&project);
    match decide(project_id, root.join(project_id).is_dir(), origin.as_deref(), &unlinked) {
        Decision::Use(folder) => {
            set_key(app, &root, &project, &folder)?;
            Ok(LinkStatus { linked: true, linked_to: None, candidates: Vec::new() })
        }
        Decision::Matched(folder) => {
            let name = unlinked.iter().find(|c| c.folder == folder).map(|c| c.name.clone());
            set_key(app, &root, &project, &folder)?;
            Ok(LinkStatus { linked: true, linked_to: name, candidates: Vec::new() })
        }
        Decision::Ask(candidates) => Ok(LinkStatus { linked: false, linked_to: None, candidates }),
    }
}

/// Link every project with no key whose folder is clear without asking: its own
/// folder, or the one folder matching its origin. Never starts new notes (a
/// machine that is still joining would otherwise fork every project's notes).
/// Returns `(project id, folder name)` for the ones linked by origin.
pub fn link_obvious(app: &AppHandle) -> Vec<(String, String)> {
    let Ok(root) = notes_root(app) else { return Vec::new() };
    let projects = {
        let db = app.state::<Db>();
        let Ok(conn) = db.conn.lock() else { return Vec::new() };
        crate::registry::list_projects(&conn).unwrap_or_default()
    };
    let mut linked = Vec::new();
    for p in projects.iter().filter(|p| p.notes_key.is_none()) {
        let Ok(taken) = taken(app) else { break };
        let unlinked = unlinked_folders(&root, &taken);
        let own = root.join(&p.id).is_dir();
        // Only look the origin up when there's something it could match.
        let origin = if own || unlinked.is_empty() { None } else { project_origin(p) };
        match decide(&p.id, own, origin.as_deref(), &unlinked) {
            Decision::Use(folder) if own => {
                let _ = set_key(app, &root, p, &folder);
            }
            Decision::Matched(folder) => {
                let name = unlinked.iter().find(|c| c.folder == folder).map(|c| c.name.clone()).unwrap_or_default();
                if set_key(app, &root, p, &folder).is_ok() {
                    linked.push((p.id.clone(), name));
                }
            }
            _ => {}
        }
    }
    linked
}

/// Give every linked folder its `project.json` (a folder from before N3 has none),
/// so another machine can match it.
pub fn describe_folders(app: &AppHandle) {
    let Ok(root) = notes_root(app) else { return };
    let projects = {
        let db = app.state::<Db>();
        let Ok(conn) = db.conn.lock() else { return };
        crate::registry::list_projects(&conn).unwrap_or_default()
    };
    for p in projects {
        let Some(key) = &p.notes_key else { continue };
        let dir: PathBuf = root.join(key);
        if !dir.is_dir() || read_project_file(&dir).is_some_and(|f| f.origin.is_some()) {
            continue;
        }
        let origin = project_origin(&p);
        let name = read_project_file(&dir).map(|f| f.name).filter(|n| !n.is_empty()).unwrap_or(p.name.clone());
        let _ = write_project_file(&dir, &ProjectFile { name, origin });
    }
}

// --- commands ---------------------------------------------------------------------------

#[tauri::command]
pub fn notes_link_status(app: AppHandle, project_id: String) -> Result<LinkStatus, String> {
    status(&app, &project_id)
}

/// Link a project to an existing notes folder (the panel's "link to existing notes…").
#[tauri::command]
pub fn notes_link(app: AppHandle, project_id: String, folder: String) -> Result<(), String> {
    let project = project(&app, &project_id)?;
    let root = notes_root(&app)?;
    if !taken(&app)?.contains(&folder) && !root.join(&folder).is_dir() {
        return Err("that notes folder doesn't exist".into());
    }
    if taken(&app)?.contains(&folder) {
        return Err("another project here already uses those notes".into());
    }
    set_key(&app, &root, &project, &folder)
}

/// Start a project's own notes (the panel's "start new notes").
#[tauri::command]
pub fn notes_start_new(app: AppHandle, project_id: String) -> Result<(), String> {
    let project = project(&app, &project_id)?;
    let root = notes_root(&app)?;
    set_key(&app, &root, &project, &project_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_normalize_to_one_string() {
        let want = Some("github.com/ivodchits/workbench".to_string());
        for url in [
            "https://github.com/ivodchits/workbench.git",
            "https://github.com/ivodchits/workbench",
            "https://user@github.com/IVODCHITS/Workbench/",
            "git@github.com:ivodchits/workbench.git",
            "ssh://git@github.com/ivodchits/workbench.git",
            "ssh://git@github.com:22/ivodchits/workbench",
        ] {
            assert_eq!(normalize_origin(url), want, "{url}");
        }
        assert_eq!(normalize_origin("  "), None);
    }

    fn cand(folder: &str, origin: Option<&str>) -> Candidate {
        Candidate { folder: folder.into(), name: folder.into(), origin: origin.map(Into::into), notes: 1 }
    }

    #[test]
    fn linking_decides_like_the_plan() {
        let o = "github.com/a/b";
        let folders = [cand("f1", Some(o)), cand("f2", Some("github.com/x/y")), cand("f3", None)];
        // Its own folder wins.
        assert_eq!(decide("p", true, Some(o), &folders), Decision::Use("p".into()));
        // One origin match links.
        assert_eq!(decide("p", false, Some(o), &folders), Decision::Matched("f1".into()));
        // Several matches ask.
        let two = [cand("f1", Some(o)), cand("f4", Some(o))];
        assert!(matches!(decide("p", false, Some(o), &two), Decision::Ask(c) if c.len() == 2));
        // A remote with no match starts new notes.
        assert_eq!(decide("p", false, Some("github.com/new/repo"), &folders), Decision::Use("p".into()));
        // No remote, folders to choose from: ask; nothing to choose from: start new.
        assert!(matches!(decide("p", false, None, &folders), Decision::Ask(c) if c.len() == 3));
        assert_eq!(decide("p", false, None, &[]), Decision::Use("p".into()));
    }

    #[test]
    fn unlinked_folders_skip_taken_and_odd_names() {
        let root = std::env::temp_dir().join(format!("wb-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for f in ["aaaa-1", "bbbb-2", ".git", "not a key"] {
            std::fs::create_dir_all(root.join(f)).unwrap();
        }
        write_project_file(&root.join("bbbb-2"), &ProjectFile { name: "Bee".into(), origin: Some("h/o/r".into()) }).unwrap();
        std::fs::write(root.join("bbbb-2").join("idea.md"), "x").unwrap();
        let taken: HashSet<String> = ["aaaa-1".to_string()].into();
        let got = unlinked_folders(&root, &taken);
        assert_eq!(got, vec![Candidate { folder: "bbbb-2".into(), name: "Bee".into(), origin: Some("h/o/r".into()), notes: 1 }]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
