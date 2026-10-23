//! Duck's worker sessions (assistant plan D1): the folder they work in, each task's
//! folder, and the launch flags that hold a worker to its tier and its allow list.
//!
//! - **The workspace.** `~/repos/Duck` (`Duck.dev` for a debug build: a sibling,
//!   never a subfolder, since Claude Code would load the parent's `CLAUDE.md`), or
//!   the folder Duck's settings name. [`prepare`] makes it, with `tasks/` and a
//!   `CLAUDE.md` describing the worker's role and the result contract.
//! - **A task.** `tasks/<date>-<slug>/brief.md`, written by Duck ([`new_task`]); the
//!   worker writes `result.md` and `result.json` beside it, and [`result`] reads them
//!   back. Both only ever touch folders under the workspace's `tasks/`.
//! - **The worker.** Registered by instance id (`worker_sessions`, in the main
//!   database) before its first launch, so every launch and resume gets `--effort`,
//!   its permission mode (`dontAsk` in the workspace: the allow list and nothing
//!   else), `--settings <file>` with the allow list (in app data, so the worker can't
//!   rewrite its own permissions) and, unless it's a browser or code task,
//!   `--strict-mcp-config` with no servers (each one would start its own Firefox
//!   bridge, ~140 MB).
//! - **Core memory (W4).** `memory/core.md`, Duck's profile of you: [`read_core`], and
//!   [`write_core`], which writes only over the text the engine read.
//!
//! The task records themselves (`assistant_tasks`) live in `duck.db`, as JSON the
//! engine writes; this module only stores and lists them.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::plugins::draft::rule_path;

const TASKS: &str = "tasks";
const BRIEF: &str = "brief.md";
const RESULT_JSON: &str = "result.json";
const RESULT_MD: &str = "result.md";
const MAX_BRIEF_BYTES: usize = 64 * 1024;
const MAX_JSON_BYTES: u64 = 64 * 1024;
const MAX_MD_BYTES: u64 = 256 * 1024;

/// Claude Code's `--effort` levels.
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// The Firefox tools a browser worker may use without asking (X0's list: reading,
/// listing, opening and closing tabs, navigating).
const FIREFOX_TOOLS: [&str; 10] = [
    "debug_websocket_status",
    "browsers_list",
    "tabs_list",
    "tabs_create",
    "tabs_close",
    "content_get_text",
    "content_snapshot",
    "navigation_go_to_url",
    "list_windows",
    "get_current_window",
];

const CLAUDE_MD: &str = r#"# Duck's workspace

You are a worker for Duck, the user's assistant. Duck hands you one task at a time.
Each task has a folder under `tasks/` with a `brief.md`: read it, do the task, and
finish by writing the two result files in that same folder.

1. `result.md`: a one-line **headline** first, then the findings, the sources (URLs
   or file paths), open questions, and a suggested next step.
2. `result.json`: exactly this shape, valid JSON and nothing else in the file:

   ```json
   {"status": "done", "headline": "one sentence", "question": null}
   ```

   - `status`: `done` when the brief is fulfilled; `blocked` when something outside
     your control stopped you (say what in `headline`); `needs_decision` when the
     user has to choose before you can go on (put the choice in `question`).
   - `headline`: the answer or outcome in one sentence, as you'd say it aloud.
   - `question`: the question for the user, or `null`.

Rules:
- Work only inside this folder. Nothing outside it is allowed, and tools that aren't
  allowed fail: work around them rather than retrying.
- Don't ask the user anything interactively; put questions in `result.json`.
- Never push, publish or send anything anywhere.
- A follow-up prompt may ask for more on the same task: update both result files.
"#;

/// The workspace when Duck's settings name none.
pub fn default_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let name = if cfg!(debug_assertions) { "Duck.dev" } else { "Duck" };
    Some(PathBuf::from(home).join("repos").join(name))
}

/// The workspace folder: `dir` (absolute, no `..`) or the default.
pub fn resolve(dir: Option<&str>) -> Result<PathBuf, String> {
    match dir.map(str::trim).filter(|d| !d.is_empty()) {
        None => default_dir().ok_or_else(|| "no home folder for Duck's workspace".into()),
        Some(d) => {
            let p = PathBuf::from(d);
            if !p.is_absolute() || p.components().any(|c| c == Component::ParentDir) {
                return Err(format!("Duck's workspace must be an absolute folder: {d}"));
            }
            Ok(p)
        }
    }
}

/// Make the workspace (and its `tasks/`), and write its `CLAUDE.md` if it has none.
/// A `CLAUDE.md` already there is the user's to edit and is left alone. Its
/// `.gitignore` keeps `data/` (the invoice exports) out of any backup remote.
pub fn prepare(dir: &Path) -> Result<(), String> {
    if dir.exists() && !dir.is_dir() {
        return Err(format!("{} is a file, not a folder", dir.display()));
    }
    let tasks = dir.join(TASKS);
    std::fs::create_dir_all(&tasks).map_err(|e| format!("cannot create {}: {e}", tasks.display()))?;
    let md = dir.join("CLAUDE.md");
    if !md.exists() {
        std::fs::write(&md, CLAUDE_MD).map_err(|e| format!("cannot write {}: {e}", md.display()))?;
    }
    ignore_data(dir)
}

/// The folder for the morning routine's local data (invoice exports).
pub const DATA: &str = "data";

/// Add `data/` to the workspace's `.gitignore`, unless a line already covers it.
fn ignore_data(dir: &Path) -> Result<(), String> {
    let path = dir.join(".gitignore");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let covered = text
        .lines()
        .map(str::trim)
        .any(|l| matches!(l, "data" | "data/" | "/data" | "/data/"));
    if covered {
        return Ok(());
    }
    let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
    std::fs::write(&path, format!("{text}{sep}{DATA}/\n"))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// A folder name from a task's title: lowercase ASCII words joined by `-`, at most
/// 48 characters; `task` when nothing is left (a title in Cyrillic, say).
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    let s = out.trim_matches('-').to_string();
    if s.is_empty() { "task".into() } else { s }
}

/// Make `tasks/<date>-<slug>` (with `-2`, `-3`, … when it's taken) and write its
/// `brief.md`. Returns the folder.
pub fn new_task(dir: &Path, date: &str, title: &str, brief: &str) -> Result<PathBuf, String> {
    let valid_date = date.len() == 10
        && date.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    if !valid_date {
        return Err(format!("not a date: {date}"));
    }
    if brief.len() > MAX_BRIEF_BYTES {
        return Err(format!("the brief is longer than {} KB", MAX_BRIEF_BYTES / 1024));
    }
    prepare(dir)?;
    let base = format!("{date}-{}", slug(title));
    let tasks = dir.join(TASKS);
    for n in 1..1000 {
        let name = if n == 1 { base.clone() } else { format!("{base}-{n}") };
        let folder = tasks.join(&name);
        match std::fs::create_dir(&folder) {
            Ok(()) => {
                std::fs::write(folder.join(BRIEF), brief).map_err(|e| format!("cannot write the brief: {e}"))?;
                return Ok(folder);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("cannot create {}: {e}", folder.display())),
        }
    }
    Err("too many tasks with that name today".into())
}

/// `folder`, if it is a task folder of the workspace `dir`.
pub fn task_folder(dir: &Path, folder: &str) -> Result<PathBuf, String> {
    let tasks = std::fs::canonicalize(dir.join(TASKS)).map_err(|e| format!("no tasks folder: {e}"))?;
    let f = std::fs::canonicalize(folder).map_err(|e| format!("no task folder {folder}: {e}"))?;
    if f.parent() != Some(tasks.as_path()) {
        return Err(format!("{folder} isn't a task folder of Duck's workspace"));
    }
    Ok(f)
}

/// A task's result files as the worker left them.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    /// `result.json`'s text; `None` when there is none.
    pub json: Option<String>,
    /// When `result.json` was last written, epoch ms.
    pub json_modified: Option<u64>,
    /// `result.md`'s text, cut at 256 KB.
    pub md: Option<String>,
}

pub fn result(dir: &Path, folder: &str) -> Result<TaskResult, String> {
    let f = task_folder(dir, folder)?;
    let read = |name: &str, cap: u64| -> Result<Option<(String, u64)>, String> {
        let path = f.join(name);
        let Ok(meta) = std::fs::metadata(&path) else { return Ok(None) };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        let bytes = std::fs::read(&path).map_err(|e| format!("cannot read {name}: {e}"))?;
        let cut = &bytes[..bytes.len().min(cap as usize)];
        Ok(Some((String::from_utf8_lossy(cut).into_owned(), modified)))
    };
    let json = read(RESULT_JSON, MAX_JSON_BYTES)?;
    let md = read(RESULT_MD, MAX_MD_BYTES)?;
    Ok(TaskResult {
        json_modified: json.as_ref().map(|j| j.1),
        json: json.map(|j| j.0),
        md: md.map(|m| m.0),
    })
}

/// Write a task's result files (step D2's API worker, which has no file tools of
/// its own): `result.md`, then `result.json`, so a reader that sees a fresh
/// `result.json` finds the matching `result.md`.
pub fn write_result(dir: &Path, folder: &str, md: &str, json: &str) -> Result<(), String> {
    let f = task_folder(dir, folder)?;
    if md.len() as u64 > MAX_MD_BYTES || json.len() as u64 > MAX_JSON_BYTES {
        return Err("the result is too large".into());
    }
    std::fs::write(f.join(RESULT_MD), md).map_err(|e| format!("cannot write {RESULT_MD}: {e}"))?;
    std::fs::write(f.join(RESULT_JSON), json).map_err(|e| format!("cannot write {RESULT_JSON}: {e}"))
}

// ── core memory (step W4) ──

/// Duck's always-loaded profile: `memory/core.md` in the workspace. The engine
/// edits it with `remember_core` and `forget`; you edit it in the editor.
const MEMORY: &str = "memory";
const CORE: &str = "core.md";
/// Far above the profile's ~2k tokens: a cap on what one read or write moves.
const MAX_CORE_BYTES: usize = 64 * 1024;

pub fn core_path(dir: &Path) -> PathBuf {
    dir.join(MEMORY).join(CORE)
}

/// `core.md`'s text, or `None` when there is none yet.
pub fn read_core(dir: &Path) -> Result<Option<String>, String> {
    let path = core_path(dir);
    match std::fs::read(&path) {
        Ok(bytes) if bytes.len() > MAX_CORE_BYTES => Err(format!("{} is larger than 64 KB", path.display())),
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Write `core.md`, but only over the text it was read as (`expected`, `None`:
/// there was no file), so an edit you saved since is never overwritten.
pub fn write_core(dir: &Path, text: &str, expected: Option<&str>) -> Result<(), String> {
    if text.len() > MAX_CORE_BYTES {
        return Err("core memory is larger than 64 KB".into());
    }
    if read_core(dir)?.as_deref() != expected {
        return Err("stale: core.md changed since it was read".into());
    }
    let path = core_path(dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

// ── the worker's launch ──

/// What a worker is, as Duck registers it.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSpec {
    /// The workspace, and the task's folder in it.
    pub workspace: String,
    pub folder: String,
    pub effort: String,
    /// `browser` keeps the user's MCP servers (Firefox); `code` works in a project,
    /// in that project's own mode, with only the task folder added. Anything else
    /// works in the workspace under `dontAsk`.
    pub kind: String,
}

fn base(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(if cfg!(debug_assertions) { "duck-sessions.dev" } else { "duck-sessions" }).join("workers"))
}

fn check_instance(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(format!("not an instance id: {id}"));
    }
    Ok(())
}

/// The worker's allow list: the workspace (or, for code, the task folder), the web
/// tools, and for a browser task the Firefox tools.
pub fn allow_rules(spec: &WorkerSpec, workspace: &Path, folder: &Path) -> Vec<String> {
    let code = spec.kind == "code";
    let place = rule_path(if code { folder } else { workspace });
    let mut rules: Vec<String> = ["Read", "Edit", "Write"].iter().map(|t| format!("{t}({place}/**)")).collect();
    if !code {
        rules.extend(["WebSearch".to_string(), "WebFetch".to_string()]);
    }
    if spec.kind == "browser" {
        rules.extend(FIREFOX_TOOLS.iter().map(|t| format!("mcp__firefox__{t}")));
    }
    rules
}

/// Register `instance_id` as a worker: write its settings file and its row. Called
/// before its first launch.
pub fn register(app: &AppHandle, conn: &Connection, instance_id: &str, spec: &WorkerSpec) -> Result<(), String> {
    check_instance(instance_id)?;
    if !EFFORTS.contains(&spec.effort.as_str()) {
        return Err(format!("not an effort level: {}", spec.effort));
    }
    let workspace = resolve(Some(&spec.workspace))?;
    let folder = task_folder(&workspace, &spec.folder)?;
    let code = spec.kind == "code";
    let dir = base(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let settings = dir.join(format!("{instance_id}.json"));
    let json = serde_json::json!({ "permissions": { "allow": allow_rules(spec, &workspace, &folder) } });
    std::fs::write(&settings, json.to_string()).map_err(|e| format!("cannot write the worker's settings: {e}"))?;
    let strict = spec.kind != "browser" && !code;
    if strict {
        let none = dir.join("no-mcp.json");
        if !none.is_file() {
            std::fs::write(&none, r#"{"mcpServers":{}}"#).map_err(|e| format!("cannot write {}: {e}", none.display()))?;
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO worker_sessions (instance_id, effort, permission_mode, strict_mcp, add_dir)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            instance_id,
            spec.effort,
            if code { None } else { Some("dontAsk") },
            strict,
            code.then(|| folder.to_string_lossy().into_owned()),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The extra `claude` arguments for a worker; empty for any other session.
pub fn launch_args(app: &AppHandle, conn: &Connection, instance_id: &str) -> Vec<String> {
    let row: Option<(String, Option<String>, bool, Option<String>)> = conn
        .query_row(
            "SELECT effort, permission_mode, strict_mcp, add_dir FROM worker_sessions WHERE instance_id = ?1",
            params![instance_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .ok()
        .flatten();
    let Some((effort, mode, strict, add_dir)) = row else { return Vec::new() };
    let Ok(dir) = base(app) else { return Vec::new() };
    let settings = dir.join(format!("{instance_id}.json"));
    let mut args = Vec::new();
    if EFFORTS.contains(&effort.as_str()) {
        args.extend(["--effort".into(), effort]);
    }
    if let Some(m) = mode.filter(|m| crate::registry::valid_permission_mode(m)) {
        args.extend(["--permission-mode".into(), m]);
    }
    if settings.is_file() {
        args.extend(["--settings".into(), settings.to_string_lossy().into_owned()]);
    }
    if strict {
        args.extend([
            "--strict-mcp-config".into(),
            "--mcp-config".into(),
            dir.join("no-mcp.json").to_string_lossy().into_owned(),
        ]);
    }
    if let Some(d) = add_dir {
        args.extend(["--add-dir".into(), d]);
    }
    args
}

// ── task records (duck.db) ──

/// Store a task's record (JSON the engine writes).
pub fn put_task(conn: &Connection, id: &str, data: &str, now: i64) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("not a task id".into());
    }
    if data.len() > 64 * 1024 {
        return Err("a task record is at most 64 KB".into());
    }
    conn.execute(
        "INSERT INTO assistant_tasks (id, data, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        params![id, data, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The most recently updated `limit` task records, newest first.
pub fn list_tasks(conn: &Connection, limit: u32) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT data FROM assistant_tasks ORDER BY updated_at DESC, id LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![limit], |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wb-workspace-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn slugs_are_short_ascii_words() {
        assert_eq!(slug("Research: Tauri auto-update!"), "research-tauri-auto-update");
        assert_eq!(slug("  --x--  "), "x");
        assert_eq!(slug("исследование"), "task");
        assert!(slug(&"word ".repeat(40)).len() <= 48);
    }

    #[test]
    fn a_task_folder_gets_its_brief_and_a_free_name() {
        let ws = scratch("task");
        let a = new_task(&ws, "2026-10-20", "Auto update", "# brief").unwrap();
        let b = new_task(&ws, "2026-10-20", "Auto update", "# again").unwrap();
        assert!(a.ends_with("tasks/2026-10-20-auto-update"));
        assert!(b.ends_with("tasks/2026-10-20-auto-update-2"));
        assert_eq!(std::fs::read_to_string(b.join(BRIEF)).unwrap(), "# again");
        assert!(ws.join("CLAUDE.md").is_file());
        assert!(new_task(&ws, "20-10-2026", "x", "").is_err());
        assert!(new_task(&ws, "2026-10-20", "x", &"y".repeat(MAX_BRIEF_BYTES + 1)).is_err());
        std::fs::remove_dir_all(ws).unwrap();
    }

    #[test]
    fn prepare_keeps_the_users_claude_md() {
        let ws = scratch("keep");
        std::fs::write(ws.join("CLAUDE.md"), "mine").unwrap();
        prepare(&ws).unwrap();
        assert_eq!(std::fs::read_to_string(ws.join("CLAUDE.md")).unwrap(), "mine");
        assert!(ws.join(TASKS).is_dir());
        std::fs::remove_dir_all(ws).unwrap();
    }

    #[test]
    fn prepare_ignores_data_once() {
        let ws = scratch("ignore");
        std::fs::write(ws.join(".gitignore"), "*.tmp").unwrap();
        prepare(&ws).unwrap();
        prepare(&ws).unwrap();
        assert_eq!(std::fs::read_to_string(ws.join(".gitignore")).unwrap(), "*.tmp\ndata/\n");
        std::fs::remove_dir_all(ws).unwrap();
    }

    #[test]
    fn results_are_read_only_from_task_folders() {
        let ws = scratch("result");
        let t = new_task(&ws, "2026-10-20", "r", "b").unwrap();
        let ts = t.to_string_lossy().into_owned();
        assert_eq!(result(&ws, &ts).unwrap(), TaskResult::default());
        std::fs::write(t.join(RESULT_JSON), r#"{"status":"done"}"#).unwrap();
        std::fs::write(t.join(RESULT_MD), "# yes").unwrap();
        let r = result(&ws, &ts).unwrap();
        assert_eq!(r.json.as_deref(), Some(r#"{"status":"done"}"#));
        assert_eq!(r.md.as_deref(), Some("# yes"));
        assert!(r.json_modified.unwrap() > 0);
        // The workspace itself, a folder beside it, and `..` out of a task folder.
        assert!(result(&ws, &ws.to_string_lossy()).is_err());
        assert!(result(&ws, &ws.join(TASKS).to_string_lossy()).is_err());
        assert!(result(&ws, &t.join("..").join("..").to_string_lossy()).is_err());
        std::fs::remove_dir_all(ws).unwrap();
    }

    #[test]
    fn results_are_written_only_into_task_folders() {
        let ws = scratch("write");
        let t = new_task(&ws, "2026-10-20", "w", "b").unwrap();
        write_result(&ws, &t.to_string_lossy(), "# done", r#"{"status":"done"}"#).unwrap();
        let r = result(&ws, &t.to_string_lossy()).unwrap();
        assert_eq!((r.md.as_deref(), r.json.as_deref()), (Some("# done"), Some(r#"{"status":"done"}"#)));
        assert!(write_result(&ws, &ws.join(TASKS).to_string_lossy(), "x", "{}").is_err());
        std::fs::remove_dir_all(ws).unwrap();
    }

    #[test]
    fn core_memory_is_written_only_over_what_was_read() {
        let ws = scratch("core");
        assert_eq!(read_core(&ws).unwrap(), None);
        write_core(&ws, "# Core
", None).unwrap();
        assert_eq!(read_core(&ws).unwrap().as_deref(), Some("# Core
"));
        assert!(write_core(&ws, "x", None).unwrap_err().starts_with("stale"));
        assert!(write_core(&ws, "x", Some("# Old
")).unwrap_err().starts_with("stale"));
        write_core(&ws, "# Core
- a
", Some("# Core
")).unwrap();
        assert!(core_path(&ws).ends_with("memory/core.md"));
        std::fs::remove_dir_all(ws).unwrap();
    }

    #[test]
    fn the_allow_list_fits_the_kind() {
        let ws = PathBuf::from(r"C:\Users\me\repos\Duck");
        let folder = ws.join("tasks").join("2026-10-20-x");
        let spec = |kind: &str| WorkerSpec {
            workspace: String::new(),
            folder: String::new(),
            effort: "medium".into(),
            kind: kind.into(),
        };
        let research = allow_rules(&spec("research"), &ws, &folder);
        assert_eq!(
            research,
            [
                "Read(//c/Users/me/repos/Duck/**)",
                "Edit(//c/Users/me/repos/Duck/**)",
                "Write(//c/Users/me/repos/Duck/**)",
                "WebSearch",
                "WebFetch"
            ]
        );
        assert!(allow_rules(&spec("browser"), &ws, &folder).contains(&"mcp__firefox__tabs_list".to_string()));
        let code = allow_rules(&spec("code"), &ws, &folder);
        assert_eq!(code.len(), 3);
        assert!(code[1].starts_with("Edit(//c/Users/me/repos/Duck/tasks/2026-10-20-x/"));
    }

    #[test]
    fn task_records_round_trip_newest_first() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE assistant_tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);")
            .unwrap();
        put_task(&conn, "a", "{1}", 1).unwrap();
        put_task(&conn, "b", "{2}", 2).unwrap();
        put_task(&conn, "a", "{3}", 3).unwrap();
        assert_eq!(list_tasks(&conn, 10).unwrap(), ["{3}", "{2}"]);
        assert!(put_task(&conn, "", "{}", 1).is_err());
    }
}
