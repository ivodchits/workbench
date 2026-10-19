//! Project toolbar plugins (step K1): per-project controls in the title bar that run
//! the project's commands, described in a JSON file Workbench reads at runtime.
//!
//! The file is `plugins.json` in the project's notes folder
//! (`<app data>/notes/<projectId>/`, next to its notes and any `scripts/` the actions
//! call), so it stays out of the repo and moves with the notes. The notes list shows
//! `.md` files only, so it never appears there.
//!
//! Declarative on purpose: Workbench draws the controls itself and no plugin code
//! runs in the webview. An action is an argv that runs as an ordinary process in a
//! task PTY, and the webview never hands over that argv: it names the action and
//! the field values, and [`prepare_task`] re-reads the file, checks the values and
//! fills in the placeholders here (the rules are in [`format`]).
//!
//! A watcher on the notes root emits `plugins-changed { projectId }` whenever a
//! project's file changes, however it was written (the editor, Duck, a sync pull),
//! and the toolbar redraws from a fresh read.

pub mod format;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::notes::{check_project, notes_root, revision_of, STALE};
use format::{PluginFile, Problem};

/// The file's name in the project's notes folder.
pub const FILE: &str = "plugins.json";

/// The event a change to a project's file emits, with the project id.
pub const EVENT: &str = "plugins-changed";

/// A plugin file is a page of JSON, not data.
const MAX_FILE_BYTES: usize = 256 * 1024;

/// How long the watcher gathers events before it emits: one save is often several
/// (a temp file, a rename).
const SETTLE: Duration = Duration::from_millis(150);

/// What a new file starts with: one harmless action, to show the shape.
const STARTER: &str = r#"{
  "version": 1,
  "plugins": [
    {
      "id": "example",
      "label": "example",
      "actions": [
        { "id": "status", "label": "git status", "run": ["git", "status"] }
      ]
    }
  ]
}
"#;

/// Check and replace in one step, so a write based on a stale revision can't slip
/// in between.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// A project's plugin file as the toolbar needs it.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginsView {
    /// Where the file is (or would be), for the editor.
    path: String,
    /// The revision of the text read; `None` when there is no file.
    revision: Option<String>,
    /// The parsed file, when it exists and has no problems.
    file: Option<PluginFile>,
    /// Everything wrong with it; empty when it's fine or absent.
    problems: Vec<Problem>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Changed {
    project_id: String,
}

/// The project's notes folder: the plugin file, and `{data}` in an action.
fn data_dir(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    check_project(project_id)?;
    Ok(root.join(project_id))
}

pub fn read(root: &Path, project_id: &str) -> Result<PluginsView, String> {
    let path = data_dir(root, project_id)?.join(FILE);
    let path_s = path.to_string_lossy().into_owned();
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PluginsView { path: path_s, revision: None, file: None, problems: Vec::new() });
        }
        Err(e) => return Err(format!("cannot read {FILE}: {e}")),
    };
    let revision = Some(revision_of(&bytes));
    let problem = |message: String| PluginsView {
        path: path_s.clone(),
        revision: revision.clone(),
        file: None,
        problems: vec![Problem { path: String::new(), message }],
    };
    if bytes.len() > MAX_FILE_BYTES {
        return Ok(problem(format!("the file is over {} KB", MAX_FILE_BYTES / 1024)));
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return Ok(problem("the file isn't UTF-8 text".into()));
    };
    Ok(match format::parse(text.trim_start_matches('\u{feff}')) {
        Ok(file) => PluginsView { path: path_s, revision, file: Some(file), problems: Vec::new() },
        Err(problems) => PluginsView { path: path_s, revision, file: None, problems },
    })
}

/// Replace the file with `text`. It must parse: a writer (Duck) gets the problems
/// back instead of leaving the toolbar broken. `base` is the revision the text was
/// edited from, refused with an error starting [`STALE`] when the file moved on;
/// `None` writes regardless. Returns the new revision.
pub fn write(root: &Path, project_id: &str, text: &str, base: Option<&str>) -> Result<String, String> {
    if text.len() > MAX_FILE_BYTES {
        return Err(format!("the file is over {} KB", MAX_FILE_BYTES / 1024));
    }
    if let Err(problems) = format::parse(text) {
        let list: Vec<String> = problems
            .iter()
            .map(|p| if p.path.is_empty() { p.message.clone() } else { format!("{}: {}", p.path, p.message) })
            .collect();
        return Err(format!("not saved, the file has problems:\n{}", list.join("\n")));
    }
    let path = data_dir(root, project_id)?.join(FILE);
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(base) = base {
        match std::fs::read(&path) {
            Ok(bytes) if revision_of(&bytes) != base => {
                return Err(format!("{STALE} {FILE} changed since it was read"));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(format!("{STALE} {FILE} was deleted"));
            }
            Err(e) => return Err(format!("cannot read {FILE}: {e}")),
        }
    }
    replace(&path, text.as_bytes())?;
    Ok(revision_of(text.as_bytes()))
}

/// Make the file with the starter text when there is none. Returns its path.
pub fn init(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    let path = data_dir(root, project_id)?.join(FILE);
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !path.exists() {
        replace(&path, STARTER.as_bytes())?;
    }
    Ok(path)
}

/// Write through a temp file and a rename, so a reader never sees half a file.
fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no folder for the file")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("cannot save {FILE}: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot save {FILE}: {e}")
    })
}

fn notify_changed(app: &AppHandle, project_id: &str) {
    let _ = app.emit(EVENT, Changed { project_id: project_id.to_string() });
}

// --- task runs ----------------------------------------------------------------------

/// What the toolbar sends to run an action: which one, and the fields' values
/// (a checkbox's as "true" or "false"). Never an argv.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskRequest {
    pub project_id: String,
    pub plugin_id: String,
    pub action_id: String,
    #[serde(default)]
    pub values: HashMap<String, String>,
}

/// A task ready to spawn.
pub struct TaskCommand {
    /// What actually runs, with a batch file or script wrapped in its interpreter.
    pub argv: Vec<String>,
    /// The action's argv with its placeholders filled in, for the task panel.
    pub shown: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

/// Turn a run request into the command to spawn, reading the file fresh so the
/// toolbar can't run an action the file no longer has.
pub fn prepare_task(app: &AppHandle, req: &TaskRequest) -> Result<TaskCommand, String> {
    let root = notes_root(app)?;
    let view = read(&root, &req.project_id)?;
    let file = view.file.ok_or_else(|| format!("{FILE} has problems; fix them before running an action"))?;
    let plugin = file
        .plugins
        .iter()
        .find(|p| p.id == req.plugin_id)
        .ok_or_else(|| format!("{FILE} has no plugin \"{}\"", req.plugin_id))?;
    let action = plugin
        .actions
        .iter()
        .find(|a| a.id == req.action_id)
        .ok_or_else(|| format!("plugin \"{}\" has no action \"{}\"", req.plugin_id, req.action_id))?;

    let project = {
        let db = app.state::<crate::db::Db>();
        let conn = db.conn.lock().unwrap();
        crate::registry::get_project(&conn, &req.project_id).map_err(|e| format!("unknown project: {e}"))?
    };
    let project_root = project.root_path.clone();
    let branch = if format::uses(action, "branch") {
        crate::git::current_branch(Path::new(&project_root)).unwrap_or_default()
    } else {
        String::new()
    };
    let builtins = format::Builtins {
        root: project_root,
        data: data_dir(&root, &req.project_id)?.to_string_lossy().into_owned(),
        branch,
    };
    let resolved = format::resolve(plugin, action, &req.values, &builtins)?;
    let cwd = PathBuf::from(&resolved.cwd);
    if !cwd.is_dir() {
        return Err(match project.remote_ssh_dest {
            Some(dest) => format!(
                "{} isn't a folder on this machine: actions run here, not on {dest}",
                cwd.display()
            ),
            None => format!("working directory does not exist: {}", cwd.display()),
        });
    }
    let exe = find_program(&resolved.argv[0], &cwd)?;
    let pwsh = which::which("pwsh")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "powershell.exe".into());
    let argv = format::spawn_argv(&resolved, &exe, &pwsh)?;
    Ok(TaskCommand { argv, shown: resolved.argv, cwd, env: resolved.env })
}

/// The program to start: a path (relative to the working dir) as given, a bare
/// name off PATH (with `PATHEXT` on Windows, so `npm` finds `npm.cmd`).
fn find_program(arg0: &str, cwd: &Path) -> Result<PathBuf, String> {
    let p = Path::new(arg0);
    if p.is_absolute() || p.components().count() > 1 {
        let full = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
        return if full.is_file() { Ok(full) } else { Err(format!("{} doesn't exist", full.display())) };
    }
    which::which(arg0).map_err(|_| format!("`{arg0}` isn't on PATH"))
}

// --- the watcher --------------------------------------------------------------------

/// Kept in Tauri state for the app's life: dropping a watcher stops it.
struct PluginsWatcher(#[allow(dead_code)] RecommendedWatcher);

/// Watch the notes root for plugin files changing. Best-effort: without a watcher
/// the toolbar still reloads on "Plugins: reload" and after its own writes.
pub fn init_watcher(app: &AppHandle) {
    if let Err(e) = start_watcher(app) {
        eprintln!("[plugins] watcher failed: {e}");
    }
}

fn start_watcher(app: &AppHandle) -> Result<(), String> {
    let root = notes_root(app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let pending: Arc<Mutex<HashSet<String>>> = Arc::default();
    let sink = pending.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        for p in &ev.paths {
            if let Some(project) = project_of(p) {
                sink.lock().unwrap().insert(project);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    app.manage(PluginsWatcher(watcher));

    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(SETTLE);
        let changed: Vec<String> = pending.lock().unwrap().drain().collect();
        for project in changed {
            notify_changed(&app, &project);
        }
    });
    Ok(())
}

/// The project a changed path's plugin file belongs to, if it is one.
fn project_of(path: &Path) -> Option<String> {
    if path.file_name()?.to_str()? != FILE {
        return None;
    }
    let project = path.parent()?.file_name()?.to_str()?;
    check_project(project).ok()?;
    Some(project.to_string())
}

// --- commands -----------------------------------------------------------------------

#[tauri::command]
pub fn plugins_read(app: AppHandle, project_id: String) -> Result<PluginsView, String> {
    read(&notes_root(&app)?, &project_id)
}

#[tauri::command]
pub fn plugins_write(
    app: AppHandle,
    project_id: String,
    text: String,
    base_revision: Option<String>,
) -> Result<String, String> {
    let revision = write(&notes_root(&app)?, &project_id, &text, base_revision.as_deref())?;
    notify_changed(&app, &project_id);
    Ok(revision)
}

/// Make the project's file if it has none (with a starter plugin) and return its
/// path, for "Plugins: edit".
#[tauri::command]
pub fn plugins_init(app: AppHandle, project_id: String) -> Result<String, String> {
    let path = init(&notes_root(&app)?, &project_id)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    const P: &str = "7f1e2d3c-0000-4000-8000-000000000002";

    fn root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wb-plugins-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn absent_starter_and_problems() {
        let r = root();
        let v = read(&r, P).unwrap();
        assert!(v.file.is_none() && v.problems.is_empty() && v.revision.is_none());

        let path = init(&r, P).unwrap();
        assert!(path.ends_with(FILE));
        let v = read(&r, P).unwrap();
        assert_eq!(v.file.expect("the starter parses").plugins[0].id, "example");

        std::fs::write(&path, r#"{ "version": 1, "plugins": [ { "id": "x" } ] }"#).unwrap();
        let v = read(&r, P).unwrap();
        assert!(v.file.is_none());
        assert_eq!(v.problems[0].path, "plugins[0].actions");
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn writes_must_parse_and_be_current() {
        let r = root();
        init(&r, P).unwrap();
        let rev = read(&r, P).unwrap().revision.unwrap();
        let err = write(&r, P, "{ \"version\": 1 }", Some(&rev)).unwrap_err();
        assert!(err.contains("plugins: missing"), "{err}");

        let good = r#"{ "version": 1, "plugins": [] }"#;
        let next = write(&r, P, good, Some(&rev)).unwrap();
        assert!(write(&r, P, good, Some(&rev)).unwrap_err().starts_with(STALE), "the old revision is stale");
        assert_eq!(write(&r, P, good, Some(&next)).unwrap(), next);
        assert!(write(&r, "../x", good, None).is_err());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn only_plugin_files_name_a_project() {
        assert_eq!(project_of(&PathBuf::from(format!("/n/{P}/{FILE}"))), Some(P.to_string()));
        assert_eq!(project_of(&PathBuf::from(format!("/n/{P}/ideas.md"))), None);
        assert_eq!(project_of(&PathBuf::from(format!("/n/{P}/plugins.json.tmp"))), None);
        assert_eq!(project_of(&PathBuf::from("/n/not a project/plugins.json")), None);
    }
}
