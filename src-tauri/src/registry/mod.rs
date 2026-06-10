//! Project registry (step 1.2).
//!
//! The typed data model and CRUD for the three core concepts from design §3:
//! **Group → Project → Instance**. CRUD is expressed as free functions over a
//! `&Connection` (so tests can drive an in-memory database directly), with thin
//! `#[tauri::command]` wrappers that lock the managed `Db` and map errors to
//! strings for the frontend.
//!
//! IDs are minted as UUID strings — consistent with the session-id minting in
//! `pty` (decision 12) and race-free across concurrent creates. The hook-driven
//! status engine, live token/cost figures, and worktree provisioning land in
//! later phases; here `status` and the token/cost columns are plain persisted
//! fields with sensible defaults.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;

/// Lifecycle/attention state of an instance (design §4.4 status palette). In
/// step 1.2 this is a stored field only; the sticky precedence state machine
/// that drives it from the hook stream arrives in Phase 2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceStatus {
    Idle,
    Working,
    NeedsYou,
    Done,
    Closed,
}

impl InstanceStatus {
    fn as_str(self) -> &'static str {
        match self {
            InstanceStatus::Idle => "idle",
            InstanceStatus::Working => "working",
            InstanceStatus::NeedsYou => "needs_you",
            InstanceStatus::Done => "done",
            InstanceStatus::Closed => "closed",
        }
    }

    /// Parse a stored status, falling back to `Idle` for anything unrecognized
    /// so a future-written value never makes a row unreadable.
    fn from_stored(s: &str) -> Self {
        match s {
            "working" => InstanceStatus::Working,
            "needs_you" => InstanceStatus::NeedsYou,
            "done" => InstanceStatus::Done,
            "closed" => InstanceStatus::Closed,
            _ => InstanceStatus::Idle,
        }
    }
}

// ---------------------------------------------------------------------------
// Domain types (camelCase at the JS boundary; snake_case in SQLite).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub root_path: String,
    pub default_branch: Option<String>,
    /// Optional shell command run in a freshly provisioned worktree (step 2.5).
    pub worktree_setup_command: Option<String>,
    /// Re-seed the repo root's `.env*` files into new worktrees (step 2.5).
    pub worktree_copy_env: bool,
    pub sort_order: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub task_note: String,
    pub worktree_on: bool,
    pub branch: Option<String>,
    pub last_session_id: Option<String>,
    pub working_dir: String,
    pub status: InstanceStatus,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub cost_usd: f64,
    pub sort_order: i64,
    pub created_at: i64,
    pub last_activity_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// Inputs. `New*` carries the fields needed to create; `*Patch` carries optional
// fields to update — a `None` leaves the existing value untouched.
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPatch {
    pub name: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    pub name: String,
    pub root_path: String,
    pub default_branch: Option<String>,
    pub group_id: Option<String>,
    pub worktree_setup_command: Option<String>,
    #[serde(default)]
    pub worktree_copy_env: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    pub name: Option<String>,
    pub root_path: Option<String>,
    pub default_branch: Option<Option<String>>,
    pub group_id: Option<Option<String>>,
    pub worktree_setup_command: Option<Option<String>>,
    pub worktree_copy_env: Option<bool>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewInstance {
    pub project_id: String,
    pub title: String,
    pub task_note: Option<String>,
    pub worktree_on: Option<bool>,
    pub branch: Option<String>,
    /// Defaults to the parent project's root path when omitted.
    pub working_dir: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstancePatch {
    pub title: Option<String>,
    pub task_note: Option<String>,
    pub worktree_on: Option<bool>,
    pub branch: Option<Option<String>>,
    pub last_session_id: Option<Option<String>>,
    pub working_dir: Option<String>,
    pub status: Option<InstanceStatus>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_creation_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub sort_order: Option<i64>,
    pub last_activity_at: Option<Option<i64>>,
}

// ---------------------------------------------------------------------------
// CRUD — free functions over a connection.
// ---------------------------------------------------------------------------

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// --- groups ---

pub fn insert_group(conn: &Connection, name: &str) -> rusqlite::Result<Group> {
    let group = Group {
        id: new_id(),
        name: name.to_owned(),
        sort_order: 0,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO groups (id, name, sort_order, created_at) VALUES (?1, ?2, ?3, ?4)",
        (&group.id, &group.name, group.sort_order, group.created_at),
    )?;
    Ok(group)
}

pub fn list_groups(conn: &Connection) -> rusqlite::Result<Vec<Group>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, sort_order, created_at FROM groups ORDER BY sort_order, name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Group {
            id: r.get(0)?,
            name: r.get(1)?,
            sort_order: r.get(2)?,
            created_at: r.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn update_group(conn: &Connection, id: &str, patch: GroupPatch) -> rusqlite::Result<Group> {
    let mut group = get_group(conn, id)?;
    if let Some(name) = patch.name {
        group.name = name;
    }
    if let Some(sort_order) = patch.sort_order {
        group.sort_order = sort_order;
    }
    conn.execute(
        "UPDATE groups SET name = ?2, sort_order = ?3 WHERE id = ?1",
        (&group.id, &group.name, group.sort_order),
    )?;
    Ok(group)
}

pub fn delete_group(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM groups WHERE id = ?1", [id])?;
    Ok(())
}

fn get_group(conn: &Connection, id: &str) -> rusqlite::Result<Group> {
    conn.query_row(
        "SELECT id, name, sort_order, created_at FROM groups WHERE id = ?1",
        [id],
        |r| {
            Ok(Group {
                id: r.get(0)?,
                name: r.get(1)?,
                sort_order: r.get(2)?,
                created_at: r.get(3)?,
            })
        },
    )
}

// --- projects ---

fn row_to_project(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        group_id: r.get(1)?,
        name: r.get(2)?,
        root_path: r.get(3)?,
        default_branch: r.get(4)?,
        worktree_setup_command: r.get(5)?,
        worktree_copy_env: r.get(6)?,
        sort_order: r.get(7)?,
        created_at: r.get(8)?,
    })
}

const PROJECT_COLS: &str = "id, group_id, name, root_path, default_branch, \
    worktree_setup_command, worktree_copy_env, sort_order, created_at";

pub fn insert_project(conn: &Connection, input: NewProject) -> rusqlite::Result<Project> {
    // Normalize an empty/whitespace setup command to NULL so "configured" is a
    // simple `IS NOT NULL` check downstream.
    let setup_cmd = input
        .worktree_setup_command
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    let project = Project {
        id: new_id(),
        group_id: input.group_id,
        name: input.name,
        root_path: input.root_path,
        default_branch: input.default_branch,
        worktree_setup_command: setup_cmd,
        worktree_copy_env: input.worktree_copy_env,
        sort_order: 0,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO projects (id, group_id, name, root_path, default_branch,
            worktree_setup_command, worktree_copy_env, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            project.id,
            project.group_id,
            project.name,
            project.root_path,
            project.default_branch,
            project.worktree_setup_command,
            project.worktree_copy_env,
            project.sort_order,
            project.created_at,
        ],
    )?;
    Ok(project)
}

pub fn list_projects(conn: &Connection) -> rusqlite::Result<Vec<Project>> {
    let sql = format!("SELECT {PROJECT_COLS} FROM projects ORDER BY sort_order, name");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_project)?;
    rows.collect()
}

pub fn get_project(conn: &Connection, id: &str) -> rusqlite::Result<Project> {
    let sql = format!("SELECT {PROJECT_COLS} FROM projects WHERE id = ?1");
    conn.query_row(&sql, [id], row_to_project)
}

pub fn update_project(
    conn: &Connection,
    id: &str,
    patch: ProjectPatch,
) -> rusqlite::Result<Project> {
    let mut p = get_project(conn, id)?;
    if let Some(name) = patch.name {
        p.name = name;
    }
    if let Some(root_path) = patch.root_path {
        p.root_path = root_path;
    }
    if let Some(default_branch) = patch.default_branch {
        p.default_branch = default_branch;
    }
    if let Some(group_id) = patch.group_id {
        p.group_id = group_id;
    }
    if let Some(setup) = patch.worktree_setup_command {
        // Normalize blank → NULL so "configured" stays an `IS NOT NULL` check.
        p.worktree_setup_command = setup.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    }
    if let Some(copy_env) = patch.worktree_copy_env {
        p.worktree_copy_env = copy_env;
    }
    if let Some(sort_order) = patch.sort_order {
        p.sort_order = sort_order;
    }
    conn.execute(
        "UPDATE projects
         SET group_id = ?2, name = ?3, root_path = ?4, default_branch = ?5,
             worktree_setup_command = ?6, worktree_copy_env = ?7, sort_order = ?8
         WHERE id = ?1",
        rusqlite::params![
            p.id,
            p.group_id,
            p.name,
            p.root_path,
            p.default_branch,
            p.worktree_setup_command,
            p.worktree_copy_env,
            p.sort_order,
        ],
    )?;
    Ok(p)
}

pub fn delete_project(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    Ok(())
}

// --- instances ---

fn row_to_instance(r: &Row) -> rusqlite::Result<Instance> {
    let status: String = r.get(8)?;
    Ok(Instance {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        task_note: r.get(3)?,
        worktree_on: r.get(4)?,
        branch: r.get(5)?,
        last_session_id: r.get(6)?,
        working_dir: r.get(7)?,
        status: InstanceStatus::from_stored(&status),
        input_tokens: r.get(9)?,
        output_tokens: r.get(10)?,
        cache_creation_tokens: r.get(11)?,
        cache_read_tokens: r.get(12)?,
        cost_usd: r.get(13)?,
        sort_order: r.get(14)?,
        created_at: r.get(15)?,
        last_activity_at: r.get(16)?,
    })
}

const INSTANCE_COLS: &str = "id, project_id, title, task_note, worktree_on, branch, \
    last_session_id, working_dir, status, input_tokens, output_tokens, \
    cache_creation_tokens, cache_read_tokens, cost_usd, sort_order, created_at, \
    last_activity_at";

pub fn insert_instance(conn: &Connection, input: NewInstance) -> rusqlite::Result<Instance> {
    // Default the working dir to the parent project's root when not provided.
    let working_dir = match input.working_dir {
        Some(dir) => dir,
        None => get_project(conn, &input.project_id)?.root_path,
    };
    let instance = Instance {
        id: new_id(),
        project_id: input.project_id,
        title: input.title,
        task_note: input.task_note.unwrap_or_default(),
        worktree_on: input.worktree_on.unwrap_or(false),
        branch: input.branch,
        last_session_id: None,
        working_dir,
        status: InstanceStatus::Idle,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        cost_usd: 0.0,
        sort_order: 0,
        created_at: now(),
        last_activity_at: None,
    };
    conn.execute(
        "INSERT INTO instances (id, project_id, title, task_note, worktree_on, branch,
            last_session_id, working_dir, status, input_tokens, output_tokens,
            cache_creation_tokens, cache_read_tokens, cost_usd, sort_order, created_at,
            last_activity_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        rusqlite::params![
            instance.id,
            instance.project_id,
            instance.title,
            instance.task_note,
            instance.worktree_on,
            instance.branch,
            instance.last_session_id,
            instance.working_dir,
            instance.status.as_str(),
            instance.input_tokens,
            instance.output_tokens,
            instance.cache_creation_tokens,
            instance.cache_read_tokens,
            instance.cost_usd,
            instance.sort_order,
            instance.created_at,
            instance.last_activity_at,
        ],
    )?;
    Ok(instance)
}

/// List instances, optionally scoped to one project. Ordered for stable rail
/// rendering.
pub fn list_instances(
    conn: &Connection,
    project_id: Option<&str>,
) -> rusqlite::Result<Vec<Instance>> {
    match project_id {
        Some(pid) => {
            let sql = format!(
                "SELECT {INSTANCE_COLS} FROM instances WHERE project_id = ?1 \
                 ORDER BY sort_order, created_at"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([pid], row_to_instance)?;
            rows.collect()
        }
        None => {
            let sql = format!(
                "SELECT {INSTANCE_COLS} FROM instances ORDER BY project_id, sort_order, created_at"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([], row_to_instance)?;
            rows.collect()
        }
    }
}

pub fn get_instance(conn: &Connection, id: &str) -> rusqlite::Result<Instance> {
    let sql = format!("SELECT {INSTANCE_COLS} FROM instances WHERE id = ?1");
    conn.query_row(&sql, [id], row_to_instance)
}

pub fn update_instance(
    conn: &Connection,
    id: &str,
    patch: InstancePatch,
) -> rusqlite::Result<Instance> {
    let mut i = get_instance(conn, id)?;
    if let Some(v) = patch.title {
        i.title = v;
    }
    if let Some(v) = patch.task_note {
        i.task_note = v;
    }
    if let Some(v) = patch.worktree_on {
        i.worktree_on = v;
    }
    if let Some(v) = patch.branch {
        i.branch = v;
    }
    if let Some(v) = patch.last_session_id {
        i.last_session_id = v;
    }
    if let Some(v) = patch.working_dir {
        i.working_dir = v;
    }
    if let Some(v) = patch.status {
        i.status = v;
    }
    if let Some(v) = patch.input_tokens {
        i.input_tokens = v;
    }
    if let Some(v) = patch.output_tokens {
        i.output_tokens = v;
    }
    if let Some(v) = patch.cache_creation_tokens {
        i.cache_creation_tokens = v;
    }
    if let Some(v) = patch.cache_read_tokens {
        i.cache_read_tokens = v;
    }
    if let Some(v) = patch.cost_usd {
        i.cost_usd = v;
    }
    if let Some(v) = patch.sort_order {
        i.sort_order = v;
    }
    if let Some(v) = patch.last_activity_at {
        i.last_activity_at = v;
    }
    conn.execute(
        "UPDATE instances SET
            title = ?2, task_note = ?3, worktree_on = ?4, branch = ?5, last_session_id = ?6,
            working_dir = ?7, status = ?8, input_tokens = ?9, output_tokens = ?10,
            cache_creation_tokens = ?11, cache_read_tokens = ?12, cost_usd = ?13,
            sort_order = ?14, last_activity_at = ?15
         WHERE id = ?1",
        rusqlite::params![
            i.id,
            i.title,
            i.task_note,
            i.worktree_on,
            i.branch,
            i.last_session_id,
            i.working_dir,
            i.status.as_str(),
            i.input_tokens,
            i.output_tokens,
            i.cache_creation_tokens,
            i.cache_read_tokens,
            i.cost_usd,
            i.sort_order,
            i.last_activity_at,
        ],
    )?;
    Ok(i)
}

pub fn delete_instance(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM instances WHERE id = ?1", [id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — lock the managed Db and map errors to strings.
// ---------------------------------------------------------------------------

/// Lock the connection, returning a frontend-friendly error if the mutex is
/// poisoned.
fn lock(db: &Db) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| format!("db lock poisoned: {e}"))
}

#[tauri::command]
pub fn create_group(db: State<'_, Db>, name: String) -> Result<Group, String> {
    let conn = lock(&db)?;
    insert_group(&conn, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_groups(db: State<'_, Db>) -> Result<Vec<Group>, String> {
    let conn = lock(&db)?;
    list_groups(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn edit_group(db: State<'_, Db>, id: String, patch: GroupPatch) -> Result<Group, String> {
    let conn = lock(&db)?;
    update_group(&conn, &id, patch).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_group(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = lock(&db)?;
    delete_group(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_project(db: State<'_, Db>, input: NewProject) -> Result<Project, String> {
    let conn = lock(&db)?;
    insert_project(&conn, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_projects(db: State<'_, Db>) -> Result<Vec<Project>, String> {
    let conn = lock(&db)?;
    list_projects(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn edit_project(
    db: State<'_, Db>,
    id: String,
    patch: ProjectPatch,
) -> Result<Project, String> {
    let conn = lock(&db)?;
    update_project(&conn, &id, patch).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_project(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = lock(&db)?;
    delete_project(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_instance(db: State<'_, Db>, input: NewInstance) -> Result<Instance, String> {
    let conn = lock(&db)?;
    insert_instance(&conn, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_instances(
    db: State<'_, Db>,
    project_id: Option<String>,
) -> Result<Vec<Instance>, String> {
    let conn = lock(&db)?;
    list_instances(&conn, project_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_instance_cmd(db: State<'_, Db>, id: String) -> Result<Instance, String> {
    let conn = lock(&db)?;
    get_instance(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn edit_instance(
    db: State<'_, Db>,
    id: String,
    patch: InstancePatch,
) -> Result<Instance, String> {
    let conn = lock(&db)?;
    update_instance(&conn, &id, patch).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_instance(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = lock(&db)?;
    delete_instance(&conn, &id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests — round-trip Group → Project → Instance through an in-memory database.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::OptionalExtension;

    fn conn() -> Connection {
        let db = Db::open_in_memory().unwrap();
        db.conn.into_inner().unwrap()
    }

    #[test]
    fn group_project_instance_round_trip() {
        let c = conn();

        let group = insert_group(&c, "CoPicnic").unwrap();
        let project = insert_project(
            &c,
            NewProject {
                name: "copicnic-web".into(),
                root_path: "/work/copicnic-web".into(),
                default_branch: Some("main".into()),
                worktree_setup_command: None,
                worktree_copy_env: false,
                group_id: Some(group.id.clone()),
            },
        )
        .unwrap();

        // No working_dir given -> defaults to the project root.
        let instance = insert_instance(
            &c,
            NewInstance {
                project_id: project.id.clone(),
                title: "invoice-fix".into(),
                task_note: Some("fixing June invoice rounding bug".into()),
                worktree_on: None,
                branch: None,
                working_dir: None,
            },
        )
        .unwrap();
        assert_eq!(instance.working_dir, "/work/copicnic-web");
        assert_eq!(instance.status, InstanceStatus::Idle);
        assert!(!instance.worktree_on);

        // Re-read from storage and confirm the fields survived.
        let fetched = get_instance(&c, &instance.id).unwrap();
        assert_eq!(fetched.title, "invoice-fix");
        assert_eq!(fetched.task_note, "fixing June invoice rounding bug");
        assert_eq!(fetched.project_id, project.id);

        assert_eq!(list_groups(&c).unwrap().len(), 1);
        assert_eq!(list_projects(&c).unwrap().len(), 1);
        assert_eq!(list_instances(&c, Some(&project.id)).unwrap().len(), 1);
    }

    #[test]
    fn patch_updates_only_provided_fields() {
        let c = conn();
        let project = insert_project(
            &c,
            NewProject {
                name: "p".into(),
                root_path: "/p".into(),
                default_branch: None,
                worktree_setup_command: None,
                worktree_copy_env: false,
                group_id: None,
            },
        )
        .unwrap();
        let inst = insert_instance(
            &c,
            NewInstance {
                project_id: project.id.clone(),
                title: "t".into(),
                task_note: None,
                worktree_on: None,
                branch: None,
                working_dir: None,
            },
        )
        .unwrap();

        let updated = update_instance(
            &c,
            &inst.id,
            InstancePatch {
                task_note: Some("now doing X".into()),
                status: Some(InstanceStatus::NeedsYou),
                last_session_id: Some(Some("sess-123".into())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.title, "t"); // untouched
        assert_eq!(updated.task_note, "now doing X");
        assert_eq!(updated.status, InstanceStatus::NeedsYou);
        assert_eq!(updated.last_session_id.as_deref(), Some("sess-123"));
    }

    #[test]
    fn deleting_project_cascades_to_instances() {
        let c = conn();
        let project = insert_project(
            &c,
            NewProject {
                name: "p".into(),
                root_path: "/p".into(),
                default_branch: None,
                worktree_setup_command: None,
                worktree_copy_env: false,
                group_id: None,
            },
        )
        .unwrap();
        let inst = insert_instance(
            &c,
            NewInstance {
                project_id: project.id.clone(),
                title: "t".into(),
                task_note: None,
                worktree_on: None,
                branch: None,
                working_dir: None,
            },
        )
        .unwrap();

        delete_project(&c, &project.id).unwrap();

        let gone: Option<String> = c
            .query_row("SELECT id FROM instances WHERE id = ?1", [&inst.id], |r| {
                r.get(0)
            })
            .optional()
            .unwrap();
        assert!(gone.is_none(), "instance should cascade-delete with project");
    }

    #[test]
    fn deleting_group_nulls_project_group_id() {
        let c = conn();
        let group = insert_group(&c, "g").unwrap();
        let project = insert_project(
            &c,
            NewProject {
                name: "p".into(),
                root_path: "/p".into(),
                default_branch: None,
                worktree_setup_command: None,
                worktree_copy_env: false,
                group_id: Some(group.id.clone()),
            },
        )
        .unwrap();

        delete_group(&c, &group.id).unwrap();

        let reread = get_project(&c, &project.id).unwrap();
        assert_eq!(reread.group_id, None, "group_id should be set to NULL");
    }
}
