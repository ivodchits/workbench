//! Toolbar drafts (assistant plan W5, delegated edits): Duck hands a toolbar change
//! to a Claude Code session, which writes it as a draft that the user reviews on
//! Duck's card before it goes live.
//!
//! - **The skill.** Workbench owns a Claude Code plugin with one skill,
//!   `workbench:plugins` (the drafting workflow and the file format, embedded from
//!   `resources/claude-plugin/`). It is written to app data and loaded with
//!   `--plugin-dir` by the sessions that draft, and by no other: nothing is
//!   installed, and no settings of the user's are touched.
//! - **The draft.** A folder per project in app data, outside the notes folder (so a
//!   draft never syncs). [`start`] fills it with a copy of the live `plugins.json` and
//!   `scripts/`, and the session edits that copy.
//! - **The session.** Registered here by instance id (`plugin_draft_sessions`), so
//!   every launch and resume of it gets `--permission-mode default`, `--plugin-dir`,
//!   `--add-dir <draft>` and `--settings <file>`: an allow rule for edits under the
//!   draft folder and nothing else. The settings file lives outside the draft
//!   folder, so the session can't rewrite its own permissions. Anything else it
//!   wants still asks (checked with the CLI: a write beside the folder is refused).

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{data_dir, FILE, MAX_FILE_BYTES, SCRIPTS};
use crate::notes::{check_project, notes_root};

/// The plugin's name: its skill is `/workbench:plugins`.
const PLUGIN: &str = "workbench";
const SKILL_FILES: [(&str, &str); 2] = [
    ("SKILL.md", include_str!("../../resources/claude-plugin/skills/plugins/SKILL.md")),
    ("reference.md", include_str!("../../resources/claude-plugin/skills/plugins/reference.md")),
];

/// Scripts copied into or read from a draft: a page of text each, a handful.
const MAX_SCRIPTS: usize = 20;

fn base(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(if cfg!(debug_assertions) { "duck-sessions.dev" } else { "duck-sessions" }))
}

/// The plugin folder `--plugin-dir` names.
fn plugin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base(app)?.join("claude-plugin").join(PLUGIN))
}

/// A project's draft folder.
pub fn draft_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    check_project(project_id)?;
    Ok(base(app)?.join("plugin-drafts").join(project_id))
}

fn settings_path(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    check_project(project_id)?;
    Ok(base(app)?.join("settings").join(format!("{project_id}.json")))
}

/// Write the skill's files where they differ from this build's (best-effort at
/// start; [`start`] makes sure again).
pub fn ensure_skill(app: &AppHandle) -> Result<PathBuf, String> {
    let root = plugin_dir(app)?;
    let dir = root.join("skills").join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    for (name, text) in SKILL_FILES {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(text) {
            std::fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        }
    }
    Ok(root)
}

/// A path as Claude Code's permission rules read an absolute one: POSIX form with a
/// leading `//` and the drive lowercased (`C:\Users\x` → `//c/Users/x`).
pub fn rule_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s).to_string();
    let mut chars = s.chars();
    match (chars.next(), chars.next()) {
        (Some(d), Some(':')) if d.is_ascii_alphabetic() => {
            format!("//{}{}", d.to_ascii_lowercase(), &s[2..])
        }
        _ => format!("//{}", s.trim_start_matches('/')),
    }
}

/// The session-only settings: edits and new files under the draft folder (an
/// `Edit` rule covers every file-editing tool, Write included).
fn settings_json(draft: &Path) -> String {
    let rule = format!("Edit({}/**)", rule_path(draft));
    serde_json::json!({ "permissions": { "allow": [rule] } }).to_string()
}

/// Make a fresh draft for `project_id` from its live file and scripts, and register
/// `instance_id` as the session that drafts it. Returns the draft folder.
pub fn start(app: &AppHandle, conn: &Connection, project_id: &str, instance_id: &str) -> Result<PathBuf, String> {
    ensure_skill(app)?;
    let draft = draft_dir(app, project_id)?;
    if draft.exists() {
        std::fs::remove_dir_all(&draft).map_err(|e| format!("cannot clear the old draft: {e}"))?;
    }
    std::fs::create_dir_all(draft.join(SCRIPTS)).map_err(|e| format!("cannot create the draft: {e}"))?;
    let live = data_dir(&notes_root(app)?, project_id)?;
    copy_if_there(&live.join(FILE), &draft.join(FILE))?;
    if let Ok(entries) = std::fs::read_dir(live.join(SCRIPTS)) {
        for e in entries.flatten().take(MAX_SCRIPTS) {
            if e.path().is_file() {
                copy_if_there(&e.path(), &draft.join(SCRIPTS).join(e.file_name()))?;
            }
        }
    }
    let settings = settings_path(app, project_id)?;
    std::fs::create_dir_all(settings.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&settings, settings_json(&draft)).map_err(|e| format!("cannot write the session settings: {e}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO plugin_draft_sessions (instance_id, project_id) VALUES (?1, ?2)",
        params![instance_id, project_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(draft)
}

fn copy_if_there(from: &Path, to: &Path) -> Result<(), String> {
    match std::fs::copy(from, to) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("cannot copy {}: {e}", from.display())),
        _ => Ok(()),
    }
}

/// The extra `claude` arguments for a drafting session; empty for any other.
pub fn launch_args(app: &AppHandle, conn: &Connection, instance_id: &str) -> Vec<String> {
    let project: Option<String> = conn
        .query_row(
            "SELECT project_id FROM plugin_draft_sessions WHERE instance_id = ?1",
            params![instance_id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(project) = project else { return Vec::new() };
    let (Ok(plugin), Ok(draft), Ok(settings)) =
        (ensure_skill(app), draft_dir(app, &project), settings_path(app, &project))
    else {
        return Vec::new();
    };
    if !settings.is_file() {
        // Without its allow rule the session would ask for every write: launch it
        // with the rule written again rather than without it.
        let _ = std::fs::create_dir_all(settings.parent().unwrap());
        let _ = std::fs::write(&settings, settings_json(&draft));
    }
    let _ = std::fs::create_dir_all(&draft);
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    vec![
        // The user's own default mode (auto, say) would let it write anywhere; in
        // the default mode the rule covers the draft folder and everything else asks.
        "--permission-mode".into(),
        "default".into(),
        "--plugin-dir".into(),
        s(plugin),
        "--add-dir".into(),
        s(draft),
        "--settings".into(),
        s(settings),
    ]
}

/// A draft as the session left it.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    path: String,
    /// The draft's `plugins.json`; `None` when there is none.
    text: Option<String>,
    scripts: Vec<DraftScript>,
}

#[derive(Serialize, Debug)]
pub struct DraftScript {
    name: String,
    text: String,
}

pub fn read(app: &AppHandle, project_id: &str) -> Result<Draft, String> {
    let draft = draft_dir(app, project_id)?;
    let text = read_capped(&draft.join(FILE))?;
    let mut scripts = Vec::new();
    if let Ok(entries) = std::fs::read_dir(draft.join(SCRIPTS)) {
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        if names.len() > MAX_SCRIPTS {
            return Err(format!("the draft has more than {MAX_SCRIPTS} scripts"));
        }
        for name in names {
            if let Some(text) = read_capped(&draft.join(SCRIPTS).join(&name))? {
                scripts.push(DraftScript { name, text });
            }
        }
    }
    Ok(Draft { path: draft.to_string_lossy().into_owned(), text, scripts })
}

fn read_capped(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(b) if b.len() > MAX_FILE_BYTES => {
            Err(format!("{} is over {} KB", path.display(), MAX_FILE_BYTES / 1024))
        }
        Ok(b) => String::from_utf8(b)
            .map(Some)
            .map_err(|_| format!("{} isn't UTF-8 text", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Drop a project's draft, its settings and its sessions' registration (they launch
/// as ordinary sessions from then on).
pub fn clear(app: &AppHandle, conn: &Connection, project_id: &str) -> Result<(), String> {
    let draft = draft_dir(app, project_id)?;
    if draft.exists() {
        std::fs::remove_dir_all(&draft).map_err(|e| format!("cannot delete the draft: {e}"))?;
    }
    let _ = std::fs::remove_file(settings_path(app, project_id)?);
    conn.execute("DELETE FROM plugin_draft_sessions WHERE project_id = ?1", params![project_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// --- commands -----------------------------------------------------------------------

#[tauri::command]
pub fn plugins_draft_start(app: AppHandle, project_id: String, instance_id: String) -> Result<String, String> {
    let db = app.state::<crate::db::Db>();
    let conn = db.conn.lock().unwrap();
    Ok(start(&app, &conn, &project_id, &instance_id)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn plugins_draft_read(app: AppHandle, project_id: String) -> Result<Draft, String> {
    read(&app, &project_id)
}

#[tauri::command]
pub fn plugins_draft_clear(app: AppHandle, project_id: String) -> Result<(), String> {
    let db = app.state::<crate::db::Db>();
    let conn = db.conn.lock().unwrap();
    clear(&app, &conn, &project_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_paths_are_posix_with_a_lowercase_drive() {
        assert_eq!(
            rule_path(Path::new(r"C:\Users\me\AppData\Roaming\wb\plugin-drafts\p1")),
            "//c/Users/me/AppData/Roaming/wb/plugin-drafts/p1"
        );
        assert_eq!(rule_path(Path::new(r"\\?\D:\x")), "//d/x");
        assert_eq!(rule_path(Path::new("/home/me/x")), "//home/me/x");
    }

    #[test]
    fn settings_allow_edits_under_the_draft_only() {
        let v: serde_json::Value = serde_json::from_str(&settings_json(Path::new(r"C:\d\p1"))).unwrap();
        assert_eq!(v["permissions"]["allow"], serde_json::json!(["Edit(//c/d/p1/**)"]));
    }

    #[test]
    fn the_skill_has_its_frontmatter() {
        let (_, skill) = SKILL_FILES[0];
        assert!(skill.starts_with("---\nname: plugins\n"));
    }
}
