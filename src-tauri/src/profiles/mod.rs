//! Claude profiles (profiles plan, step P1.1).
//!
//! A profile is a Claude Code config dir, given to a project's consoles as
//! `CLAUDE_CONFIG_DIR`, so different projects can run under different accounts.
//! **Personal** is implicit (no row): it's whatever `claude` uses without Workbench,
//! i.e. Workbench's own `CLAUDE_CONFIG_DIR` if set, else `~/.claude`. A project with
//! no `profile_id` runs on Personal and its consoles get no override.
//!
//! Profile dirs may share parts of Personal through symlinks and junctions (the
//! `settings.json` symlink, a `projects/` junction). [`real`] resolves those, and
//! [`distinct_dirs`] de-duplicates on the resolved path, so a shared file is
//! written once and a shared folder is scanned once.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::db::Db;

pub mod seed;

/// The environment variable Claude Code reads its config dir from.
pub const CONFIG_DIR_ENV: &str = "CLAUDE_CONFIG_DIR";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub config_dir: String,
    /// Whether the dir holds a claude.ai login (see [`logged_in`]).
    pub logged_in: bool,
    /// How many projects use this profile.
    pub project_count: i64,
}

/// Personal's config dir: Workbench's own `CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub fn personal_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os(CONFIG_DIR_ENV).filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    home_dir().map(|h| h.join(".claude"))
}

/// `path` with symlinks and junctions resolved, without Windows' `\\?\` prefix (so
/// it still compares and displays like an ordinary path). A path that doesn't
/// exist (yet) is returned as given.
pub fn real(path: &Path) -> PathBuf {
    match std::fs::canonicalize(path) {
        Ok(p) => strip_verbatim(p),
        Err(_) => path.to_path_buf(),
    }
}

fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// Whether `dir` holds a claude.ai login: a credentials file, or an account recorded
/// in its `.claude.json` (where the macOS keychain keeps the secret itself).
pub fn logged_in(dir: &Path) -> bool {
    logged_in_with(dir, &dir.join(".claude.json"))
}

/// [`logged_in`] with the `.claude.json` given separately (Personal's default one
/// lives in the home dir, not in `~/.claude`).
fn logged_in_with(dir: &Path, claude_json: &Path) -> bool {
    if dir.join(".credentials.json").is_file() {
        return true;
    }
    std::fs::read_to_string(claude_json)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .is_some_and(|v| v.get("oauthAccount").is_some_and(|a| !a.is_null()))
}

/// The config dir a project's consoles get as `CLAUDE_CONFIG_DIR`, or `None` for
/// Personal (no override). A profile whose row is gone also falls back to Personal.
pub fn config_dir_for_project(conn: &Connection, project_id: &str) -> Option<PathBuf> {
    conn.query_row(
        "SELECT p.config_dir FROM projects j JOIN profiles p ON p.id = j.profile_id
         WHERE j.id = ?1",
        [project_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .map(PathBuf::from)
}

/// The profile dir `project_id` runs under, `None` for Personal (or no project).
/// For the managers (MCP, skills) that act for a project (profiles plan P2.2).
pub fn dir_for(db: &Db, project_id: Option<&str>) -> Option<PathBuf> {
    let id = project_id.filter(|s| !s.is_empty())?;
    let conn = db.conn.lock().ok()?;
    config_dir_for_project(&conn, id)
}

/// The config dir a project's Claude uses: its profile's, else Personal's.
pub fn effective_dir(profile_dir: Option<&Path>) -> Option<PathBuf> {
    profile_dir.map(Path::to_path_buf).or_else(personal_dir)
}

/// Where Claude Code keeps `.claude.json` (user and local MCP servers, the account)
/// for a profile dir, or for Personal (`None`): inside the config dir when
/// `CLAUDE_CONFIG_DIR` names one, else `~/.claude.json`.
pub fn claude_json_path(profile_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(d) = profile_dir {
        return Some(d.join(".claude.json"));
    }
    if let Some(d) = std::env::var_os(CONFIG_DIR_ENV).filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d).join(".claude.json"));
    }
    home_dir().map(|h| h.join(".claude.json"))
}

/// [`config_dir_for_project`] for the project `instance_id` belongs to.
pub fn config_dir_for_instance(conn: &Connection, instance_id: &str) -> Option<PathBuf> {
    let project_id: String = conn
        .query_row("SELECT project_id FROM instances WHERE id = ?1", [instance_id], |r| r.get(0))
        .ok()?;
    config_dir_for_project(conn, &project_id)
}

/// Every config dir in use, Personal first, de-duplicated on the resolved path.
/// Dirs that don't exist are left out.
pub fn distinct_dirs(conn: &Connection) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = personal_dir().into_iter().collect();
    if let Ok(mut stmt) = conn.prepare("SELECT config_dir FROM profiles ORDER BY created_at") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            dirs.extend(rows.flatten().map(PathBuf::from));
        }
    }
    dedupe_real(dirs)
}

/// Every distinct real `settings.json` the profiles use, Personal's first (step
/// P1.2): where Workbench installs its hooks and statusline. A profile whose
/// `settings.json` is a link to Personal's adds nothing; one that has none yet is
/// listed by its own path, so the install creates it.
pub fn settings_files(conn: &Connection) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in distinct_dirs(conn) {
        let file = real(&dir.join("settings.json"));
        if !out.iter().any(|o| same_path(o, &file)) {
            out.push(file);
        }
    }
    out
}

/// Every distinct real `projects/` folder (where Claude Code keeps transcripts),
/// Personal's first. A junctioned `projects/` is listed once.
pub fn projects_dirs(conn: &Connection) -> Vec<PathBuf> {
    dedupe_real(distinct_dirs(conn).into_iter().map(|d| d.join("projects")))
}

/// Every path a transcript under some profile's `projects/` may be reported by: each
/// dir as configured *and* as resolved, so a hook path through a junction
/// (`.claude-team/projects/...` linked to Personal's) is still recognized.
pub fn projects_roots(conn: &Connection) -> Vec<PathBuf> {
    let mut raw: Vec<PathBuf> = personal_dir().into_iter().collect();
    if let Ok(mut stmt) = conn.prepare("SELECT config_dir FROM profiles") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            raw.extend(rows.flatten().map(PathBuf::from));
        }
    }
    let mut out = Vec::new();
    for dir in raw {
        let projects = dir.join("projects");
        let resolved = real(&projects);
        out.push(projects);
        out.push(resolved);
    }
    out
}

/// Which profile a config dir belongs to: `Some(None)` for Personal, `Some(Some(id))`
/// for a stored profile, `None` for a dir Workbench doesn't know. Compared after
/// resolving links; an empty `dir` is Personal (no override).
pub fn profile_for_dir(conn: &Connection, dir: &str) -> Option<Option<String>> {
    if dir.trim().is_empty() {
        return Some(None);
    }
    let resolved = real(Path::new(dir.trim()));
    if personal_dir().is_some_and(|p| same_path(&real(&p), &resolved)) {
        return Some(None);
    }
    list(conn)
        .ok()?
        .into_iter()
        .find(|p| same_path(&real(Path::new(&p.config_dir)), &resolved))
        .map(|p| Some(p.id))
}

/// The profile id of the project `instance_id` belongs to: `None` for Personal.
pub fn profile_for_instance(conn: &Connection, instance_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT j.profile_id FROM instances i JOIN projects j ON j.id = i.project_id
         WHERE i.id = ?1",
        [instance_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

/// Keep the first of each set of paths that resolve to the same place, as its
/// resolved form; drop paths that don't exist.
pub fn dedupe_real(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for p in paths {
        if !p.exists() {
            continue;
        }
        let r = real(&p);
        if !out.iter().any(|o| same_path(o, &r)) {
            out.push(r);
        }
    }
    out
}

pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// Turn what the user typed into an absolute dir: `~` expanded, surrounding quotes
/// and whitespace dropped. Claude Code is given an absolute path only.
fn normalize_dir(input: &str) -> Result<PathBuf, String> {
    let s = input.trim().trim_matches('"').trim();
    if s.is_empty() {
        return Err("choose a folder for the profile".into());
    }
    let p = match s.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            home_dir().ok_or("no home folder to expand ~")?.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(s),
    };
    if !p.is_absolute() {
        return Err(format!("{} is not a full path", p.display()));
    }
    Ok(p)
}

// --- storage ----------------------------------------------------------------

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Profile>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.config_dir,
                (SELECT COUNT(*) FROM projects j WHERE j.profile_id = p.id)
         FROM profiles p ORDER BY p.created_at",
    )?;
    let rows = stmt.query_map([], |r| {
        let dir: String = r.get(2)?;
        Ok(Profile {
            id: r.get(0)?,
            name: r.get(1)?,
            logged_in: logged_in(Path::new(&dir)),
            config_dir: dir,
            project_count: r.get(3)?,
        })
    })?;
    rows.collect()
}

/// Add a profile for `config_dir`. An existing dir is adopted as it is; a missing
/// one is created empty, and its first `claude` asks you to log in. Personal's own
/// dir, or one another profile already uses, is refused.
pub fn add(conn: &Connection, name: &str, config_dir: &str) -> Result<Profile, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("give the profile a name".into());
    }
    let dir = normalize_dir(config_dir)?;
    if dir.exists() && !dir.is_dir() {
        return Err(format!("{} is a file, not a folder", dir.display()));
    }
    let resolved = real(&dir);
    if personal_dir().is_some_and(|p| same_path(&real(&p), &resolved)) {
        return Err("that folder is Personal's own config".into());
    }
    if list(conn)
        .map_err(|e| e.to_string())?
        .iter()
        .any(|p| same_path(&real(Path::new(&p.config_dir)), &resolved))
    {
        return Err("another profile already uses that folder".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let id = uuid::Uuid::new_v4().to_string();
    let dir_s = dir.to_string_lossy().into_owned();
    conn.execute(
        "INSERT INTO profiles (id, name, config_dir, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, name, dir_s, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(Profile {
        id,
        name: name.to_owned(),
        logged_in: logged_in(&dir),
        config_dir: dir_s,
        project_count: 0,
    })
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("give the profile a name".into());
    }
    conn.execute("UPDATE profiles SET name = ?2 WHERE id = ?1", [id, name])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Forget a profile: its projects go back to Personal; the dir stays on disk.
pub fn remove(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE projects SET profile_id = NULL WHERE profile_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM profiles WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

// --- commands ---------------------------------------------------------------

fn lock(db: &Db) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| format!("db lock poisoned: {e}"))
}

/// Personal's dir and whether it's logged in, for the Profiles section's first row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalProfile {
    pub config_dir: Option<String>,
    pub logged_in: bool,
}

#[tauri::command]
pub fn profiles_personal() -> PersonalProfile {
    let dir = personal_dir();
    let json = claude_json_path(None);
    PersonalProfile {
        logged_in: match (dir.as_deref(), json.as_deref()) {
            (Some(d), Some(j)) => logged_in_with(d, j),
            _ => false,
        },
        config_dir: dir.map(|d| d.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub fn profiles_list(db: State<'_, Db>) -> Result<Vec<Profile>, String> {
    list(&*lock(&db)?).map_err(|e| e.to_string())
}

/// Add a profile, then install Workbench's hooks and statusline into its
/// `settings.json` (a no-op when that file is a link to one already done). With
/// `seed`, a new or empty folder first gets a copy of Personal's setup (step P2.1);
/// a folder that already holds something is adopted as it is.
#[tauri::command]
pub fn profiles_add(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    name: String,
    config_dir: String,
    seed: Option<bool>,
) -> Result<Profile, String> {
    let empty = normalize_dir(&config_dir).is_ok_and(|d| seed::is_empty_dir(&d));
    let mut profile = add(&*lock(&db)?, &name, &config_dir)?;
    if seed.unwrap_or(false) && empty {
        if let Some(personal) = personal_dir() {
            let chained = db.meta_get(crate::statusline::CHAINED_KEY).ok().flatten();
            let json = claude_json_path(None);
            match seed::seed(&personal, json.as_deref(), chained.as_deref(), Path::new(&profile.config_dir)) {
                Ok(s) => eprintln!("[profiles] seeded {} with {}", profile.config_dir, s.items.join(", ")),
                // The profile exists either way; an incomplete copy is reported.
                Err(e) => return Err(format!("the profile was added, but copying Personal failed: {e}")),
            }
        }
        profile.logged_in = logged_in(Path::new(&profile.config_dir));
    }
    crate::hooks::reinstall(&app);
    Ok(profile)
}

#[tauri::command]
pub fn profiles_rename(db: State<'_, Db>, id: String, name: String) -> Result<(), String> {
    rename(&*lock(&db)?, &id, &name)
}

#[tauri::command]
pub fn profiles_remove(db: State<'_, Db>, id: String) -> Result<(), String> {
    remove(&*lock(&db)?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        crate::db::Db::open_in_memory().unwrap().conn.into_inner().unwrap()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wb-profiles-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn project(c: &Connection, profile_id: Option<String>) -> String {
        crate::registry::insert_project(
            c,
            crate::registry::NewProject {
                name: "p".into(),
                root_path: "/p".into(),
                default_branch: None,
                group_id: None,
                worktree_setup_command: None,
                worktree_copy_env: false,
                remote_ssh_dest: None,
                remote_dir: None,
                default_model: None,
                default_permission_mode: None,
                profile_id,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn a_project_resolves_its_profile_dir_and_personal_has_none() {
        let c = conn();
        let dir = temp_dir("resolve");
        let prof = add(&c, "Team", dir.to_str().unwrap()).unwrap();
        let team = project(&c, Some(prof.id.clone()));
        let personal = project(&c, None);
        assert_eq!(config_dir_for_project(&c, &team), Some(dir.clone()));
        assert_eq!(config_dir_for_project(&c, &personal), None);
        assert_eq!(list(&c).unwrap()[0].project_count, 1);

        // Removing the profile returns its project to Personal.
        remove(&c, &prof.id).unwrap();
        assert_eq!(config_dir_for_project(&c, &team), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn add_refuses_a_duplicate_dir_and_a_relative_path() {
        let c = conn();
        let dir = temp_dir("dup");
        add(&c, "A", dir.to_str().unwrap()).unwrap();
        assert!(add(&c, "B", dir.to_str().unwrap()).is_err());
        assert!(add(&c, "C", "relative/dir").is_err());
        assert!(add(&c, " ", dir.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn add_creates_a_missing_dir() {
        let c = conn();
        let parent = temp_dir("create");
        let dir = parent.join("new-profile");
        let p = add(&c, "New", dir.to_str().unwrap()).unwrap();
        assert!(dir.is_dir());
        assert!(!p.logged_in);
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn logged_in_reads_credentials_or_the_account_record() {
        let dir = temp_dir("login");
        assert!(!logged_in(&dir));
        std::fs::write(dir.join(".claude.json"), r#"{"mcpServers":{}}"#).unwrap();
        assert!(!logged_in(&dir));
        std::fs::write(dir.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"x"}}"#).unwrap();
        assert!(logged_in(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dedupe_real_collapses_a_linked_dir() {
        let base = temp_dir("dedupe");
        let target = base.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let link = base.join("link");
        #[cfg(windows)]
        let linked = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .is_ok_and(|o| o.status.success());
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&target, &link).is_ok();
        let missing = base.join("missing");
        let out = dedupe_real([target.clone(), link.clone(), missing]);
        if linked {
            assert_eq!(out.len(), 1, "{out:?}");
            // A file reached through the link resolves to the real one.
            std::fs::write(target.join("settings.json"), "{}").unwrap();
            assert!(same_path(&real(&link.join("settings.json")), &real(&target.join("settings.json"))));
        }
        assert!(same_path(&out[0], &real(&target)));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn normalize_expands_home_and_strips_quotes() {
        let home = home_dir().unwrap();
        assert_eq!(normalize_dir("~/.claude-team").unwrap(), home.join(".claude-team"));
        assert_eq!(normalize_dir("~").unwrap(), home);
        let abs = home.join("x");
        assert_eq!(normalize_dir(&format!("\"{}\"", abs.display())).unwrap(), abs);
    }
}
