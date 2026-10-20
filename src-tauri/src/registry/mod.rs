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
    /// SSH destination for a *remote* project (step 3.12) — an alias from
    /// `~/.ssh/config` or `user@host`. `None` ⇒ a normal local project.
    pub remote_ssh_dest: Option<String>,
    /// Working directory on the remote host (step 3.12); mirrored into
    /// `root_path` too so display code that reads the root keeps working.
    pub remote_dir: Option<String>,
    /// The model new sessions in this project run on unless they pick their own
    /// (step M1); `None` leaves Claude Code's default.
    pub default_model: Option<String>,
    /// The permission mode new sessions in this project start in unless they pick
    /// their own (step M4); `None` leaves Claude Code's default.
    pub default_permission_mode: Option<String>,
    /// The folder this project's notes live in, shared across machines (step N3);
    /// `None` until its notes are linked or started.
    pub notes_key: Option<String>,
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
    /// While true, `task_note` follows the agent's terminal title (live mirror);
    /// a manual edit flips it false so the user's note is never overwritten.
    pub task_note_auto: bool,
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
    /// Optional per-instance accent color (step 3.9). Overlays the active theme's
    /// structural accent on this instance's card + console; `None` inherits it.
    pub accent: Option<String>,
    /// For a remote project's instance (step 3.12): the tmux session name on the
    /// host (`wb-<short id>`, or an adopted name). `None` for a local instance.
    pub remote_tmux_session: Option<String>,
    /// The model this session launches and resumes on (`claude --model`, step M1);
    /// `None` inherits the project's `default_model`.
    pub model: Option<String>,
    /// The permission mode this session launches and resumes in
    /// (`claude --permission-mode`, step M4); `None` inherits the project's
    /// `default_permission_mode`.
    pub permission_mode: Option<String>,
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
    /// SSH destination for a remote project (step 3.12); omit/None for local.
    pub remote_ssh_dest: Option<String>,
    /// Working directory on the remote host (step 3.12).
    pub remote_dir: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_permission_mode: Option<String>,
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
    pub remote_ssh_dest: Option<Option<String>>,
    pub remote_dir: Option<Option<String>>,
    pub default_model: Option<Option<String>>,
    pub default_permission_mode: Option<Option<String>>,
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
    /// Override the tmux session name (step 3.12) — used when *adopting* an existing
    /// remote session. Omit to default to `wb-<short id>` for a remote project's
    /// instance (and stays `None` for a local one).
    pub remote_tmux_session: Option<String>,
    /// The model to run on (step M1); omit to inherit the project's default.
    #[serde(default)]
    pub model: Option<String>,
    /// The permission mode to start in (step M4); omit to inherit the project's.
    #[serde(default)]
    pub permission_mode: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstancePatch {
    pub title: Option<String>,
    pub task_note: Option<String>,
    pub task_note_auto: Option<bool>,
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
    /// `Some(None)` clears the accent (back to the theme default); `Some(Some(_))`
    /// sets it; `None` leaves it untouched.
    pub accent: Option<Option<String>>,
    /// Remote tmux session name (step 3.12); `Some(None)` clears it, `None` leaves it.
    pub remote_tmux_session: Option<Option<String>>,
    /// The session's model (step M1), applied at its next launch or resume;
    /// `Some(None)` goes back to the project default.
    pub model: Option<Option<String>>,
    /// The session's permission mode (step M4), likewise.
    pub permission_mode: Option<Option<String>>,
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

/// Whether `m` can go to `claude --model` (step M1): an alias or a full model id,
/// optionally with a `[1m]`-style suffix. It starts with a letter or digit so it
/// can't read as another flag, and holds nothing a shell would read as syntax
/// except the brackets, which the remote launch quotes.
pub fn valid_model(m: &str) -> bool {
    m.len() <= 64
        && m.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && m
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || ".-[]".contains(c))
}

/// Normalize a model field: trimmed, blank → `None`, and an invalid value is an
/// error rather than something stored and later passed to `claude`.
fn clean_model(m: Option<String>) -> rusqlite::Result<Option<String>> {
    match m.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) {
        Some(v) if !valid_model(&v) => Err(rusqlite::Error::ToSqlConversionFailure(
            format!("not a model name: {v:?}").into(),
        )),
        m => Ok(m),
    }
}

/// Whether `m` reads as a `claude --permission-mode` value (step M4): a short
/// camelCase word (`acceptEdits`, `plan`, …). Which words the installed Claude Code
/// accepts is checked at launch (`pty::permission_modes`); this only keeps a value
/// from reading as another flag or as shell syntax.
pub fn valid_permission_mode(m: &str) -> bool {
    m.len() <= 32
        && m.starts_with(|c: char| c.is_ascii_lowercase())
        && m.chars().all(|c| c.is_ascii_alphabetic())
}

/// Normalize a permission-mode field like [`clean_model`].
fn clean_permission_mode(m: Option<String>) -> rusqlite::Result<Option<String>> {
    match m.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) {
        Some(v) if !valid_permission_mode(&v) => Err(rusqlite::Error::ToSqlConversionFailure(
            format!("not a permission mode: {v:?}").into(),
        )),
        m => Ok(m),
    }
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
        remote_ssh_dest: r.get(7)?,
        remote_dir: r.get(8)?,
        sort_order: r.get(9)?,
        created_at: r.get(10)?,
        default_model: r.get(11)?,
        notes_key: r.get(12)?,
        default_permission_mode: r.get(13)?,
    })
}

const PROJECT_COLS: &str = "id, group_id, name, root_path, default_branch, \
    worktree_setup_command, worktree_copy_env, remote_ssh_dest, remote_dir, \
    sort_order, created_at, default_model, notes_key, default_permission_mode";

pub fn insert_project(conn: &Connection, input: NewProject) -> rusqlite::Result<Project> {
    // Normalize an empty/whitespace setup command to NULL so "configured" is a
    // simple `IS NOT NULL` check downstream.
    let setup_cmd = input
        .worktree_setup_command
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    // A remote project carries no local setup; normalize its fields to a clean
    // "remote when dest is non-empty" shape.
    let remote_ssh_dest = input
        .remote_ssh_dest
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    let remote_dir = input
        .remote_dir
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
        remote_ssh_dest,
        remote_dir,
        default_model: clean_model(input.default_model)?,
        default_permission_mode: clean_permission_mode(input.default_permission_mode)?,
        notes_key: None,
        sort_order: 0,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO projects (id, group_id, name, root_path, default_branch,
            worktree_setup_command, worktree_copy_env, remote_ssh_dest, remote_dir,
            sort_order, created_at, default_model, default_permission_mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            project.id,
            project.group_id,
            project.name,
            project.root_path,
            project.default_branch,
            project.worktree_setup_command,
            project.worktree_copy_env,
            project.remote_ssh_dest,
            project.remote_dir,
            project.sort_order,
            project.created_at,
            project.default_model,
            project.default_permission_mode,
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
    if let Some(dest) = patch.remote_ssh_dest {
        p.remote_ssh_dest = dest.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    }
    if let Some(dir) = patch.remote_dir {
        p.remote_dir = dir.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    }
    if let Some(m) = patch.default_model {
        p.default_model = clean_model(m)?;
    }
    if let Some(m) = patch.default_permission_mode {
        p.default_permission_mode = clean_permission_mode(m)?;
    }
    if let Some(sort_order) = patch.sort_order {
        p.sort_order = sort_order;
    }
    conn.execute(
        "UPDATE projects
         SET group_id = ?2, name = ?3, root_path = ?4, default_branch = ?5,
             worktree_setup_command = ?6, worktree_copy_env = ?7,
             remote_ssh_dest = ?8, remote_dir = ?9, sort_order = ?10, default_model = ?11,
             default_permission_mode = ?12
         WHERE id = ?1",
        rusqlite::params![
            p.id,
            p.group_id,
            p.name,
            p.root_path,
            p.default_branch,
            p.worktree_setup_command,
            p.worktree_copy_env,
            p.remote_ssh_dest,
            p.remote_dir,
            p.sort_order,
            p.default_model,
            p.default_permission_mode,
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
        task_note_auto: r.get(17)?,
        accent: r.get(18)?,
        remote_tmux_session: r.get(19)?,
        model: r.get(20)?,
        permission_mode: r.get(21)?,
    })
}

const INSTANCE_COLS: &str = "id, project_id, title, task_note, worktree_on, branch, \
    last_session_id, working_dir, status, input_tokens, output_tokens, \
    cache_creation_tokens, cache_read_tokens, cost_usd, sort_order, created_at, \
    last_activity_at, task_note_auto, accent, remote_tmux_session, model, permission_mode";

pub fn insert_instance(conn: &Connection, input: NewInstance) -> rusqlite::Result<Instance> {
    // Resolve the parent project once: its root path is the default working dir,
    // and whether it's remote decides the tmux session default (step 3.12).
    let project = get_project(conn, &input.project_id)?;
    let working_dir = input.working_dir.unwrap_or_else(|| project.root_path.clone());
    // A note supplied at creation is the user's own text, so it isn't auto-mirrored;
    // an empty/omitted note starts in auto mode so the terminal title can fill it.
    let task_note = input.task_note.unwrap_or_default();
    let task_note_auto = task_note.trim().is_empty();
    let id = new_id();
    // A remote project's instance runs as a tmux session: use the caller's name when
    // adopting an existing one, else default to `wb-<short id>`. Local instances
    // carry no session name.
    let remote_tmux_session = if project.remote_ssh_dest.is_some() {
        Some(
            input
                .remote_tmux_session
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("wb-{}", &id[..8])),
        )
    } else {
        None
    };
    let instance = Instance {
        id,
        project_id: input.project_id,
        title: input.title,
        task_note,
        task_note_auto,
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
        accent: None,
        remote_tmux_session,
        model: clean_model(input.model)?,
        permission_mode: clean_permission_mode(input.permission_mode)?,
    };
    conn.execute(
        "INSERT INTO instances (id, project_id, title, task_note, worktree_on, branch,
            last_session_id, working_dir, status, input_tokens, output_tokens,
            cache_creation_tokens, cache_read_tokens, cost_usd, sort_order, created_at,
            last_activity_at, task_note_auto, accent, remote_tmux_session, model,
            permission_mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
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
            instance.task_note_auto,
            instance.accent,
            instance.remote_tmux_session,
            instance.model,
            instance.permission_mode,
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
    if let Some(v) = patch.task_note_auto {
        i.task_note_auto = v;
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
    if let Some(v) = patch.accent {
        i.accent = v;
    }
    if let Some(v) = patch.remote_tmux_session {
        i.remote_tmux_session = v;
    }
    if let Some(v) = patch.model {
        i.model = clean_model(v)?;
    }
    if let Some(v) = patch.permission_mode {
        i.permission_mode = clean_permission_mode(v)?;
    }
    conn.execute(
        "UPDATE instances SET
            title = ?2, task_note = ?3, worktree_on = ?4, branch = ?5, last_session_id = ?6,
            working_dir = ?7, status = ?8, input_tokens = ?9, output_tokens = ?10,
            cache_creation_tokens = ?11, cache_read_tokens = ?12, cost_usd = ?13,
            sort_order = ?14, last_activity_at = ?15, task_note_auto = ?16, accent = ?17,
            remote_tmux_session = ?18, model = ?19, permission_mode = ?20
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
            i.task_note_auto,
            i.accent,
            i.remote_tmux_session,
            i.model,
            i.permission_mode,
        ],
    )?;
    Ok(i)
}

/// Apply a terminal-title-derived note, but only while the instance is still
/// auto-mirroring (the user hasn't manually edited it). Returns the updated row
/// when the note actually changed, else `None` (mirroring off, or title unchanged)
/// so the caller can skip a needless reload.
pub fn mirror_task_note(
    conn: &Connection,
    id: &str,
    title: &str,
) -> rusqlite::Result<Option<Instance>> {
    let mut i = get_instance(conn, id)?;
    if !i.task_note_auto || i.task_note == title {
        return Ok(None);
    }
    i.task_note = title.to_owned();
    conn.execute(
        "UPDATE instances SET task_note = ?2 WHERE id = ?1",
        rusqlite::params![i.id, i.task_note],
    )?;
    Ok(Some(i))
}

/// The model `instance_id` launches on (step M1): its own, else its project's
/// default. `None` when neither is set, when the id isn't an instance (a project
/// shell), or when a stored value somehow isn't a valid model name.
pub fn launch_model(conn: &Connection, instance_id: &str) -> Option<String> {
    let i = get_instance(conn, instance_id).ok()?;
    let m = match i.model {
        Some(m) => m,
        None => get_project(conn, &i.project_id).ok()?.default_model?,
    };
    valid_model(&m).then_some(m)
}

/// The permission mode `instance_id` launches in (step M4), resolved like
/// [`launch_model`].
pub fn launch_permission_mode(conn: &Connection, instance_id: &str) -> Option<String> {
    let i = get_instance(conn, instance_id).ok()?;
    let m = match i.permission_mode {
        Some(m) => m,
        None => get_project(conn, &i.project_id).ok()?.default_permission_mode?,
    };
    valid_permission_mode(&m).then_some(m)
}

pub fn delete_instance(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM instances WHERE id = ?1", [id])?;
    Ok(())
}

/// Write just the latest-turn token figures for an instance — the components of
/// its current context window (transcript tailer, step 3.1). A targeted UPDATE
/// rather than a full-row read-modify-write, so it never clobbers a column the
/// status engine may have changed concurrently (e.g. `status`). Silently does
/// nothing if the row is gone (killed mid-poll).
pub fn set_instance_tokens(
    conn: &Connection,
    id: &str,
    input_tokens: i64,
    output_tokens: i64,
    cache_creation_tokens: i64,
    cache_read_tokens: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE instances SET input_tokens = ?2, output_tokens = ?3,
            cache_creation_tokens = ?4, cache_read_tokens = ?5 WHERE id = ?1",
        rusqlite::params![
            id,
            input_tokens,
            output_tokens,
            cache_creation_tokens,
            cache_read_tokens
        ],
    )?;
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
    let project = insert_project(&conn, input).map_err(|e| e.to_string())?;
    crate::notes::refresh_keys(&conn);
    Ok(project)
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
    delete_project(&conn, &id).map_err(|e| e.to_string())?;
    crate::notes::refresh_keys(&conn);
    Ok(())
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

/// Mirror a terminal-title-derived note into `task_note`, gated on the instance's
/// auto flag (a manual edit turns it off). Returns the updated row, or `None` when
/// nothing changed — so the frontend only reloads on a real change.
#[tauri::command]
pub fn mirror_instance_task_note(
    db: State<'_, Db>,
    id: String,
    title: String,
) -> Result<Option<Instance>, String> {
    let conn = lock(&db)?;
    mirror_task_note(&conn, &id, &title).map_err(|e| e.to_string())
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
                remote_ssh_dest: None,
                remote_dir: None,
                group_id: Some(group.id.clone()),
                default_model: None,
                default_permission_mode: None,
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
                remote_tmux_session: None,
                model: None,
                permission_mode: None,
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
                remote_ssh_dest: None,
                remote_dir: None,
                group_id: None,
                default_model: None,
                default_permission_mode: None,
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
                remote_tmux_session: None,
                model: None,
                permission_mode: None,
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
                accent: Some(Some("#8b7cf6".into())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.title, "t"); // untouched
        assert_eq!(updated.task_note, "now doing X");
        assert_eq!(updated.status, InstanceStatus::NeedsYou);
        assert_eq!(updated.last_session_id.as_deref(), Some("sess-123"));
        assert_eq!(updated.accent.as_deref(), Some("#8b7cf6"));

        // An omitted accent leaves it; an explicit `Some(None)` clears it.
        let kept = update_instance(
            &c,
            &inst.id,
            InstancePatch { task_note: Some("y".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(kept.accent.as_deref(), Some("#8b7cf6"));
        let cleared = update_instance(
            &c,
            &inst.id,
            InstancePatch { accent: Some(None), ..Default::default() },
        )
        .unwrap();
        assert_eq!(cleared.accent, None);
    }

    #[test]
    fn mirror_follows_title_until_manually_edited() {
        let c = conn();
        let project = insert_project(
            &c,
            NewProject {
                name: "p".into(),
                root_path: "/p".into(),
                default_branch: None,
                worktree_setup_command: None,
                worktree_copy_env: false,
                remote_ssh_dest: None,
                remote_dir: None,
                group_id: None,
                default_model: None,
                default_permission_mode: None,
            },
        )
        .unwrap();
        // No note at creation -> starts in auto-mirror mode.
        let inst = insert_instance(
            &c,
            NewInstance {
                project_id: project.id.clone(),
                title: "t".into(),
                task_note: None,
                worktree_on: None,
                branch: None,
                working_dir: None,
                remote_tmux_session: None,
                model: None,
                permission_mode: None,
            },
        )
        .unwrap();
        assert!(inst.task_note_auto);

        // Title mirrors in while auto is on.
        let m = mirror_task_note(&c, &inst.id, "running the test suite").unwrap();
        assert_eq!(m.unwrap().task_note, "running the test suite");

        // An unchanged title is a no-op (None -> no reload).
        assert!(mirror_task_note(&c, &inst.id, "running the test suite")
            .unwrap()
            .is_none());

        // A manual edit turns mirroring off...
        update_instance(
            &c,
            &inst.id,
            InstancePatch {
                task_note: Some("my own note".into()),
                task_note_auto: Some(false),
                ..Default::default()
            },
        )
        .unwrap();

        // ...so a later title no longer clobbers it.
        assert!(mirror_task_note(&c, &inst.id, "some new title")
            .unwrap()
            .is_none());
        assert_eq!(get_instance(&c, &inst.id).unwrap().task_note, "my own note");

        // A note supplied at creation starts with mirroring off.
        let manual = insert_instance(
            &c,
            NewInstance {
                project_id: project.id.clone(),
                title: "t2".into(),
                task_note: Some("typed up front".into()),
                worktree_on: None,
                branch: None,
                working_dir: None,
                remote_tmux_session: None,
                model: None,
                permission_mode: None,
            },
        )
        .unwrap();
        assert!(!manual.task_note_auto);
    }

    #[test]
    fn remote_project_instance_defaults_a_tmux_session() {
        let c = conn();
        // A remote project: dest set, root mirrors the remote dir.
        let remote = insert_project(
            &c,
            NewProject {
                name: "srv".into(),
                root_path: "/home/me/proj".into(),
                default_branch: None,
                worktree_setup_command: None,
                worktree_copy_env: false,
                remote_ssh_dest: Some("myserver".into()),
                remote_dir: Some("/home/me/proj".into()),
                group_id: None,
                default_model: None,
                default_permission_mode: None,
            },
        )
        .unwrap();
        assert_eq!(remote.remote_ssh_dest.as_deref(), Some("myserver"));

        // An instance under it auto-gets a `wb-<short id>` session name.
        let inst = insert_instance(
            &c,
            NewInstance {
                project_id: remote.id.clone(),
                title: "1".into(),
                task_note: None,
                worktree_on: None,
                branch: None,
                working_dir: None,
                remote_tmux_session: None,
                model: None,
                permission_mode: None,
            },
        )
        .unwrap();
        let session = inst.remote_tmux_session.expect("remote instance has a session");
        assert!(session.starts_with("wb-"), "got {session}");
        assert_eq!(session, format!("wb-{}", &inst.id[..8]));

        // Adopting an existing session keeps the supplied name.
        let adopted = insert_instance(
            &c,
            NewInstance {
                project_id: remote.id.clone(),
                title: "legacy".into(),
                task_note: None,
                worktree_on: None,
                branch: None,
                working_dir: None,
                remote_tmux_session: Some("old-session".into()),
                model: None,
                permission_mode: None,
            },
        )
        .unwrap();
        assert_eq!(adopted.remote_tmux_session.as_deref(), Some("old-session"));

        // A local project's instance carries no session name.
        let local = insert_project(
            &c,
            NewProject {
                name: "local".into(),
                root_path: "/p".into(),
                default_branch: None,
                worktree_setup_command: None,
                worktree_copy_env: false,
                remote_ssh_dest: None,
                remote_dir: None,
                group_id: None,
                default_model: None,
                default_permission_mode: None,
            },
        )
        .unwrap();
        let local_inst = insert_instance(
            &c,
            NewInstance {
                project_id: local.id,
                title: "1".into(),
                task_note: None,
                worktree_on: None,
                branch: None,
                working_dir: None,
                remote_tmux_session: None,
                model: None,
                permission_mode: None,
            },
        )
        .unwrap();
        assert_eq!(local_inst.remote_tmux_session, None);
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
                remote_ssh_dest: None,
                remote_dir: None,
                group_id: None,
                default_model: None,
                default_permission_mode: None,
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
                remote_tmux_session: None,
                model: None,
                permission_mode: None,
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
                remote_ssh_dest: None,
                remote_dir: None,
                group_id: Some(group.id.clone()),
                default_model: None,
                default_permission_mode: None,
            },
        )
        .unwrap();

        delete_group(&c, &group.id).unwrap();

        let reread = get_project(&c, &project.id).unwrap();
        assert_eq!(reread.group_id, None, "group_id should be set to NULL");
    }

    #[test]
    fn model_names_are_validated() {
        for ok in ["opus", "sonnet", "claude-opus-5-5", "opus[1m]", "claude-3.5-x"] {
            assert!(valid_model(ok), "{ok}");
        }
        for bad in ["", "-x", "--model", "Opus", "opus; rm -rf /", "a b", "o'pus", "$(x)", "opus\n"] {
            assert!(!valid_model(bad), "{bad:?}");
        }
        assert_eq!(clean_model(Some("  opus ".into())).unwrap().as_deref(), Some("opus"));
        assert_eq!(clean_model(Some("  ".into())).unwrap(), None);
        assert!(clean_model(Some("x y".into())).is_err());
    }

    #[test]
    fn launch_model_inherits_the_project_default() {
        let c = conn();
        let project = insert_project(
            &c,
            NewProject {
                name: "p".into(),
                root_path: "/p".into(),
                default_branch: None,
                worktree_setup_command: None,
                worktree_copy_env: false,
                remote_ssh_dest: None,
                remote_dir: None,
                group_id: None,
                default_model: None,
                default_permission_mode: None,
            },
        )
        .unwrap();
        let new = |model: Option<&str>| NewInstance {
            project_id: project.id.clone(),
            title: "i".into(),
            task_note: None,
            worktree_on: None,
            branch: None,
            working_dir: None,
            remote_tmux_session: None,
            model: model.map(str::to_owned),
            permission_mode: None,
        };
        let own = insert_instance(&c, new(Some("opus"))).unwrap();
        let inherits = insert_instance(&c, new(None)).unwrap();
        assert!(insert_instance(&c, new(Some("--dangerously-skip-permissions"))).is_err());

        assert_eq!(launch_model(&c, &own.id).as_deref(), Some("opus"));
        assert_eq!(launch_model(&c, &inherits.id), None);
        assert_eq!(launch_model(&c, "a-project-shell"), None);

        let patch = ProjectPatch { default_model: Some(Some("haiku".into())), ..Default::default() };
        update_project(&c, &project.id, patch).unwrap();
        assert_eq!(launch_model(&c, &inherits.id).as_deref(), Some("haiku"));
        assert_eq!(launch_model(&c, &own.id).as_deref(), Some("opus"));

        // Clearing the instance's own model goes back to the project's.
        let patch = InstancePatch { model: Some(None), ..Default::default() };
        update_instance(&c, &own.id, patch).unwrap();
        assert_eq!(launch_model(&c, &own.id).as_deref(), Some("haiku"));

        let bad = InstancePatch { model: Some(Some("op us".into())), ..Default::default() };
        assert!(update_instance(&c, &own.id, bad).is_err());
    }

    #[test]
    fn launch_permission_mode_inherits_and_is_validated() {
        for ok in ["acceptEdits", "plan", "dontAsk", "default"] {
            assert!(valid_permission_mode(ok), "{ok}");
        }
        for bad in ["", "-x", "--model", "Plan", "plan;x", "accept edits", "auto'", "a1"] {
            assert!(!valid_permission_mode(bad), "{bad:?}");
        }

        let c = conn();
        let project = insert_project(
            &c,
            NewProject {
                name: "p".into(),
                root_path: "/p".into(),
                default_branch: None,
                worktree_setup_command: None,
                worktree_copy_env: false,
                remote_ssh_dest: None,
                remote_dir: None,
                group_id: None,
                default_model: None,
                default_permission_mode: Some(" acceptEdits ".into()),
            },
        )
        .unwrap();
        assert_eq!(project.default_permission_mode.as_deref(), Some("acceptEdits"));
        let new = |mode: Option<&str>| NewInstance {
            project_id: project.id.clone(),
            title: "i".into(),
            task_note: None,
            worktree_on: None,
            branch: None,
            working_dir: None,
            remote_tmux_session: None,
            model: None,
            permission_mode: mode.map(str::to_owned),
        };
        let own = insert_instance(&c, new(Some("plan"))).unwrap();
        let inherits = insert_instance(&c, new(None)).unwrap();
        assert!(insert_instance(&c, new(Some("--dangerously-skip-permissions"))).is_err());

        assert_eq!(launch_permission_mode(&c, &own.id).as_deref(), Some("plan"));
        assert_eq!(launch_permission_mode(&c, &inherits.id).as_deref(), Some("acceptEdits"));
        assert_eq!(launch_permission_mode(&c, "a-project-shell"), None);

        // Clearing the project's default leaves Claude Code's own.
        let patch = ProjectPatch { default_permission_mode: Some(None), ..Default::default() };
        update_project(&c, &project.id, patch).unwrap();
        assert_eq!(launch_permission_mode(&c, &inherits.id), None);

        let patch = InstancePatch { permission_mode: Some(None), ..Default::default() };
        update_instance(&c, &own.id, patch).unwrap();
        assert_eq!(launch_permission_mode(&c, &own.id), None);
    }
}
