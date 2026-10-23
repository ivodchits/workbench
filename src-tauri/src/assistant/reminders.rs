//! Duck's reminders (step H8): `reminders.json` at the root of Duck's repo (the
//! workspace), beside its memory, so a reminder is versioned, backed up and moved
//! with the repo like what Duck remembers.
//!
//! - **The file.** `{"reminders": [...]}`, one record each: id, title, details,
//!   project, due (a local `2026-10-24T10:00`, or a date), state (open, done,
//!   dismissed), created, closed, createdIn, and (step H4) repeat and snoozedUntil.
//!   Fields this version doesn't know are kept as they are, so a later step's
//!   survive an older write.
//! - **Writes** go through [`put`]: one record replaced, made or removed, over what
//!   the writer saw it as (`before`), refused with `stale:` when it changed since
//!   (a hand edit, the phone). Each write commits just this file, as Duck.
//! - **A hand edit** is welcome: the watcher ([`assistant_reminders_watch`]) tells
//!   the engine to read the file again. A file that doesn't parse is reported and
//!   never written over until it's fixed.
//! - **Delivery bookkeeping** (whether a timed reminder was announced) is in
//!   `duck.db`'s `meta` as `reminder_seen:<id>`: it changes often, means nothing in
//!   a backup, and would otherwise make a commit each time.
//! - **Timers** (step H4) are short and matter only for minutes: `duck.db` only,
//!   `duck_timer:<id>`, never the file.
//! - **A push's buttons** (step H4): a reminder pushed to the phone carries a
//!   one-use token (`reminder_action:<token>`, a day long) that its Done and Snooze
//!   buttons send back. The service worker can't sign in, and the token can only
//!   close or snooze that one reminder.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use regex::Regex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, State};

use super::{lock, memory, workspace, Assistant};

pub const FILE: &str = "reminders.json";
/// The event a change to the file emits (Duck's write or yours).
pub const EVENT: &str = "duck-reminders-changed";
const MAX_FILE_BYTES: usize = 1024 * 1024;
const TITLE_MAX: usize = 200;
const DETAILS_MAX: usize = 4000;
const SEEN: &str = "reminder_seen:";
const TIMER: &str = "duck_timer:";
const ACTION: &str = "reminder_action:";
/// How long a push's buttons work.
const ACTION_TTL_MS: i64 = 24 * 3600 * 1000;
/// The event a push's button emits: `{id, action}`.
pub const ACTION_EVENT: &str = "duck-reminder-action";
/// A burst of events (one save is several) is told once, after this.
const SETTLE: Duration = Duration::from_millis(400);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ReminderState {
    Open,
    Done,
    Dismissed,
}

/// How a reminder comes back once it's done (step H4).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    Daily,
    Weekdays,
    Weekly,
    Monthly,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProjectTag {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    /// The short header the widget shows.
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectTag>,
    /// Local time, `YYYY-MM-DDTHH:MM`, or a day, `YYYY-MM-DD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    pub state: ReminderState,
    pub created: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed: Option<String>,
    /// The thread it was asked for in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_in: Option<String>,
    /// Comes back at the next time after it's done; needs a due.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<Repeat>,
    /// Put off until this local time (`YYYY-MM-DDTHH:MM`): it comes up then, not before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<String>,
    /// What a later version added, kept.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Default)]
struct RemindersFile {
    reminders: Vec<Reminder>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// The file as Duck reads it.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemindersView {
    pub path: String,
    pub reminders: Vec<Reminder>,
    /// What's wrong with the file (it's then neither read nor written); null when
    /// it's fine or absent.
    pub problem: Option<String>,
}

fn id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_-]{1,40}$").unwrap())
}

fn due_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d)?$").unwrap())
}

/// What's wrong with one record, if anything.
fn check_one(r: &Reminder) -> Result<(), String> {
    let name = if r.title.is_empty() { r.id.clone() } else { format!("\"{}\"", r.title) };
    if !id_re().is_match(&r.id) {
        return Err(format!("{name}: the id must be 1–40 letters, digits, - or _"));
    }
    let title = r.title.trim();
    if title.is_empty() || title.chars().count() > TITLE_MAX || title.contains('\n') {
        return Err(format!("{name}: the title must be one line of 1–{TITLE_MAX} characters"));
    }
    if r.details.as_ref().is_some_and(|d| d.chars().count() > DETAILS_MAX) {
        return Err(format!("{name}: the details are over {DETAILS_MAX} characters"));
    }
    if let Some(due) = &r.due {
        if !due_re().is_match(due) {
            return Err(format!("{name}: due \"{due}\" isn't YYYY-MM-DD or YYYY-MM-DDTHH:MM"));
        }
    }
    if r.repeat.is_some() && r.due.is_none() {
        return Err(format!("{name}: a repeating reminder needs a due time"));
    }
    if let Some(until) = &r.snoozed_until {
        if !due_re().is_match(until) || !until.contains('T') {
            return Err(format!("{name}: snoozedUntil \"{until}\" isn't YYYY-MM-DDTHH:MM"));
        }
    }
    if r.project.as_ref().is_some_and(|p| p.id.is_empty()) {
        return Err(format!("{name}: the project has no id"));
    }
    Ok(())
}

fn check(list: &[Reminder]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for r in list {
        check_one(r)?;
        if !ids.insert(r.id.as_str()) {
            return Err(format!("two reminders have the id {}", r.id));
        }
    }
    Ok(())
}

pub fn path(ws: &Path) -> PathBuf {
    ws.join(FILE)
}

/// The file parsed and checked; `Ok(None)` when there is none.
fn load(ws: &Path) -> Result<Option<RemindersFile>, String> {
    let bytes = match std::fs::read(path(ws)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {FILE}: {e}")),
    };
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("{FILE} is over {} KB", MAX_FILE_BYTES / 1024));
    }
    let text = String::from_utf8(bytes).map_err(|_| format!("{FILE} isn't UTF-8 text"))?;
    let file: RemindersFile =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("{FILE} doesn't parse: {e}"))?;
    check(&file.reminders).map_err(|e| format!("{FILE}: {e}"))?;
    Ok(Some(file))
}

pub fn read(ws: &Path) -> RemindersView {
    let path_s = path(ws).to_string_lossy().into_owned();
    match load(ws) {
        Ok(f) => RemindersView { path: path_s, reminders: f.map(|f| f.reminders).unwrap_or_default(), problem: None },
        Err(problem) => RemindersView { path: path_s, reminders: Vec::new(), problem: Some(problem) },
    }
}

/// One writer at a time: a read-change-write isn't interleaved with another.
fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Make record `id` be `after` (None removes it), provided it's `before` now (None:
/// it doesn't exist). Returns the file as written; the commit follows in the
/// background with `message`.
pub fn put(
    ws: &Path,
    id: &str,
    before: Option<&Reminder>,
    after: Option<Reminder>,
    message: &str,
) -> Result<RemindersView, String> {
    if let Some(a) = &after {
        if a.id != id {
            return Err(format!("the record's id {} isn't {id}", a.id));
        }
        check_one(a)?;
    }
    let _guard = write_lock();
    let mut file = load(ws).map_err(|e| format!("{e}. Fix the file first: it isn't written over while it's broken."))?.unwrap_or_default();
    let at = file.reminders.iter().position(|r| r.id == id);
    let now = at.map(|i| &file.reminders[i]);
    if now != before {
        return Err(match (now, before) {
            (None, Some(_)) => format!("stale: the reminder {id} isn't in {FILE} any more"),
            (Some(_), None) => format!("stale: a reminder {id} is already in {FILE}"),
            _ => format!("stale: the reminder {id} changed since it was read"),
        });
    }
    match (at, after) {
        (Some(i), Some(a)) => file.reminders[i] = a,
        (Some(i), None) => {
            file.reminders.remove(i);
        }
        (None, Some(a)) => file.reminders.push(a),
        (None, None) => {}
    }
    let mut text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    text.push('\n');
    if text.len() > MAX_FILE_BYTES {
        return Err(format!("{FILE} would be over {} KB: archive the old reminders", MAX_FILE_BYTES / 1024));
    }
    replace(&path(ws), text.as_bytes())?;
    memory::commit(ws, vec![FILE.into()], message.to_string());
    Ok(RemindersView { path: path(ws).to_string_lossy().into_owned(), reminders: file.reminders, problem: None })
}

fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no folder for the file")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let tmp = path.with_file_name(format!("{FILE}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| format!("cannot save {FILE}: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot save {FILE}: {e}")
    })
}

// ── delivery bookkeeping ──

/// Every `<prefix><id>` value in `meta`, by id.
fn rows(conn: &Connection, prefix: &str) -> Result<Vec<(String, String)>, String> {
    let mut st = conn
        .prepare("SELECT substr(key, ?1), value FROM meta WHERE key LIKE ?2")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map((prefix.len() as i64 + 1, format!("{prefix}%")), |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn set_row(conn: &Connection, prefix: &str, id: &str, value: Option<&str>) -> Result<(), String> {
    if !id_re().is_match(id) {
        return Err(format!("bad id {id}"));
    }
    let key = format!("{prefix}{id}");
    match value {
        Some(v) if v.len() > 1024 => Err("the value is too large".into()),
        Some(v) => super::trust::set_meta(conn, &key, v),
        None => conn.execute("DELETE FROM meta WHERE key = ?1", [&key]).map(|_| ()).map_err(|e| e.to_string()),
    }
}

/// Every `reminder_seen:<id>` value, by id.
pub fn seen(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    rows(conn, SEEN)
}

pub fn set_seen(conn: &Connection, id: &str, value: Option<&str>) -> Result<(), String> {
    set_row(conn, SEEN, id, value)
}

/// Every running timer, `[id, json]` (step H4).
pub fn timers(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    rows(conn, TIMER)
}

pub fn set_timer(conn: &Connection, id: &str, value: Option<&str>) -> Result<(), String> {
    set_row(conn, TIMER, id, value)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// A one-use token for a push's buttons on reminder `id`, good for a day. Old
/// ones are dropped as new ones are made.
pub fn issue_action(conn: &Connection, id: &str, now: i64) -> Result<String, String> {
    use base64::Engine;
    use rand_core::RngCore;
    for (token, v) in rows(conn, ACTION)? {
        let exp = serde_json::from_str::<Value>(&v).ok().and_then(|v| v["exp"].as_i64()).unwrap_or(0);
        if exp <= now {
            set_row(conn, ACTION, &token, None)?;
        }
    }
    let mut bytes = [0u8; 16];
    rand_core::OsRng.fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    set_row(conn, ACTION, &token, Some(&serde_json::json!({ "id": id, "exp": now + ACTION_TTL_MS }).to_string()))?;
    Ok(token)
}

/// The reminder a push's token is for, used up; None when it's unknown or old.
pub fn take_action(conn: &Connection, token: &str, now: i64) -> Option<String> {
    if !id_re().is_match(token) {
        return None;
    }
    let key = format!("{ACTION}{token}");
    let v: String = conn.query_row("SELECT value FROM meta WHERE key = ?1", [&key], |r| r.get(0)).ok()?;
    let _ = conn.execute("DELETE FROM meta WHERE key = ?1", [&key]);
    let v: Value = serde_json::from_str(&v).ok()?;
    if v["exp"].as_i64()? <= now {
        return None;
    }
    v["id"].as_str().map(str::to_string)
}

// ── the watcher ──

struct Watching {
    dir: PathBuf,
    _watcher: RecommendedWatcher,
}

fn watching() -> &'static Mutex<Option<Watching>> {
    static W: Mutex<Option<Watching>> = Mutex::new(None);
    &W
}

/// Watch the workspace's `reminders.json` (replacing the watch of another
/// workspace); a change emits [`EVENT`] once it settles.
fn watch(app: &AppHandle, ws: &Path) -> Result<(), String> {
    let mut w = watching().lock().unwrap_or_else(|e| e.into_inner());
    if w.as_ref().is_some_and(|x| x.dir == ws) {
        return Ok(());
    }
    std::fs::create_dir_all(ws).map_err(|e| e.to_string())?;
    let dirty = Arc::new(AtomicBool::new(false));
    let sink = dirty.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if ev.paths.iter().any(|p| p.file_name().is_some_and(|n| n == FILE)) {
            sink.store(true, Ordering::SeqCst);
        }
    })
    .map_err(|e| e.to_string())?;
    // The folder, not the file: an atomic save replaces the file.
    watcher.watch(ws, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
    *w = Some(Watching { dir: ws.to_path_buf(), _watcher: watcher });
    let app = app.clone();
    let dir = ws.to_path_buf();
    std::thread::spawn(move || loop {
        std::thread::sleep(SETTLE);
        // A newer watch took over: this thread ends.
        if !watching().lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|x| x.dir == dir) {
            return;
        }
        if dirty.swap(false, Ordering::SeqCst) {
            let _ = app.emit(EVENT, ());
        }
    });
    Ok(())
}

// ── commands ──

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn assistant_reminders_read(workspace: Option<String>) -> Result<RemindersView, String> {
    blocking(move || Ok(read(&workspace::resolve(workspace.as_deref())?))).await
}

#[tauri::command]
pub async fn assistant_reminders_put(
    workspace: Option<String>,
    id: String,
    before: Option<Reminder>,
    after: Option<Reminder>,
    message: String,
) -> Result<RemindersView, String> {
    blocking(move || put(&workspace::resolve(workspace.as_deref())?, &id, before.as_ref(), after, &message)).await
}

#[tauri::command]
pub fn assistant_reminders_watch(app: AppHandle, workspace: Option<String>) -> Result<(), String> {
    watch(&app, &workspace::resolve(workspace.as_deref())?)
}

#[tauri::command]
pub fn assistant_reminders_seen(ctx: State<'_, Arc<Assistant>>) -> Result<Vec<(String, String)>, String> {
    seen(&lock(&ctx))
}

#[tauri::command]
pub fn assistant_reminder_seen_set(ctx: State<'_, Arc<Assistant>>, id: String, value: Option<String>) -> Result<(), String> {
    set_seen(&lock(&ctx), &id, value.as_deref())
}

#[tauri::command]
pub fn assistant_timers(ctx: State<'_, Arc<Assistant>>) -> Result<Vec<(String, String)>, String> {
    timers(&lock(&ctx))
}

#[tauri::command]
pub fn assistant_timer_set(ctx: State<'_, Arc<Assistant>>, id: String, value: Option<String>) -> Result<(), String> {
    set_timer(&lock(&ctx), &id, value.as_deref())
}

/// Push a reminder (or a timer) to the phones: with `actions`, its Done and Snooze
/// buttons, which come back through `POST /api/reminders/action`. Tapping it opens
/// Duck on `thread_id`.
#[tauri::command]
pub fn assistant_reminder_push(
    app: AppHandle,
    ctx: State<'_, Arc<Assistant>>,
    id: String,
    thread_id: String,
    title: String,
    body: String,
    actions: bool,
) -> Result<(), String> {
    let token = if actions { Some(issue_action(&lock(&ctx), &id, now_ms())?) } else { None };
    crate::remote::push::send_all(
        &app,
        serde_json::json!({
            "title": title,
            "body": body,
            "threadId": thread_id,
            "tag": format!("reminder-{id}"),
            "reminder": token.map(|t| serde_json::json!({ "id": id, "token": t })),
        }),
    );
    Ok(())
}

/// A push's button: the reminder its token is for, and what to do, to the engine.
pub fn act(app: &AppHandle, token: &str, action: &str) -> Result<(), &'static str> {
    use tauri::Manager;
    if action != "done" && action != "snooze" {
        return Err("unknown action");
    }
    let ctx = app.try_state::<Arc<Assistant>>().ok_or("Duck isn't running")?;
    let id = take_action(&lock(&ctx), token, now_ms()).ok_or("this notification's buttons have expired")?;
    app.emit(ACTION_EVENT, serde_json::json!({ "id": id, "action": action })).map_err(|_| "Duck isn't running")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::db::DuckDb;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wb-reminders-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rem(id: &str, title: &str) -> Reminder {
        Reminder {
            id: id.into(),
            title: title.into(),
            details: None,
            project: None,
            due: None,
            state: ReminderState::Open,
            created: "2026-10-23T12:00".into(),
            closed: None,
            created_in: None,
            repeat: None,
            snoozed_until: None,
            extra: Map::new(),
        }
    }

    #[test]
    fn adds_closes_and_refuses_a_stale_write() {
        let ws = temp("put");
        assert_eq!(read(&ws).reminders, vec![]);
        let a = rem("r1", "call the bank");
        put(&ws, "r1", None, Some(a.clone()), "reminders: added").unwrap();
        // Adding the same id again is stale.
        assert!(put(&ws, "r1", None, Some(a.clone()), "x").unwrap_err().starts_with("stale:"));
        let done = Reminder { state: ReminderState::Done, closed: Some("2026-10-23T13:00".into()), ..a.clone() };
        let v = put(&ws, "r1", Some(&a), Some(done.clone()), "reminders: done").unwrap();
        assert_eq!(v.reminders, vec![done.clone()]);
        // A write over what it no longer is is refused.
        assert!(put(&ws, "r1", Some(&a), None, "x").unwrap_err().starts_with("stale:"));
        // Undoing the add removes it.
        assert_eq!(put(&ws, "r1", Some(&done), None, "undo").unwrap().reminders, vec![]);
        let text = std::fs::read_to_string(path(&ws)).unwrap();
        assert!(text.contains("\"reminders\": []"), "{text}");
    }

    #[test]
    fn keeps_fields_it_does_not_know_and_reports_a_broken_file() {
        let ws = temp("hand");
        std::fs::write(
            path(&ws),
            r#"{"reminders":[{"id":"r1","title":"water the plants","state":"open","created":"2026-10-23","due":"2026-10-24","repeat":"weekly","colour":"red"}],"note":"mine"}"#,
        )
        .unwrap();
        let v = read(&ws);
        assert_eq!(v.problem, None);
        let r = v.reminders[0].clone();
        assert_eq!(r.repeat, Some(Repeat::Weekly));
        assert_eq!(r.extra.get("colour"), Some(&Value::from("red")));
        put(&ws, "r2", None, Some(rem("r2", "b")), "x").unwrap();
        let text = std::fs::read_to_string(path(&ws)).unwrap();
        assert!(text.contains("\"repeat\": \"weekly\"") && text.contains("\"colour\": \"red\"") && text.contains("\"note\": \"mine\""), "{text}");

        let broken = "{\"reminders\": [ {\"id\": \"r1\", ";
        std::fs::write(path(&ws), broken).unwrap();
        let v = read(&ws);
        assert!(v.problem.as_deref().is_some_and(|p| p.contains("doesn't parse")), "{v:?}");
        assert!(put(&ws, "r3", None, Some(rem("r3", "c")), "x").is_err());
        assert_eq!(std::fs::read_to_string(path(&ws)).unwrap(), broken);

        std::fs::write(path(&ws), r#"{"reminders":[{"id":"r1","title":"x","state":"open","created":"d","due":"Friday"}]}"#).unwrap();
        assert!(read(&ws).problem.unwrap().contains("isn't YYYY-MM-DD"));
    }

    #[test]
    fn checks_what_it_writes() {
        let ws = temp("check");
        let bad = Reminder { due: Some("2026-13-01".into()), ..rem("r1", "x") };
        assert!(put(&ws, "r1", None, Some(bad), "x").is_err());
        assert!(put(&ws, "r1", None, Some(rem("r1", "")), "x").is_err());
        assert!(put(&ws, "r2", None, Some(rem("r1", "x")), "x").is_err());
        assert!(put(&ws, "r1", None, Some(Reminder { repeat: Some(Repeat::Daily), ..rem("r1", "x") }), "x").is_err(), "a repeat needs a due");
        let snoozed = Reminder { snoozed_until: Some("2026-10-24".into()), ..rem("r1", "x") };
        assert!(put(&ws, "r1", None, Some(snoozed), "x").is_err(), "a snooze needs a time");
        let ok = Reminder { due: Some("2026-10-24T10:00".into()), ..rem("r1", "send the invoice") };
        assert!(put(&ws, "r1", None, Some(ok), "x").is_ok());
    }

    #[test]
    fn keeps_the_bookkeeping_by_id() {
        let db = DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        set_seen(&conn, "r1", Some(r#"{"announced":1}"#)).unwrap();
        set_seen(&conn, "r2", Some("{}")).unwrap();
        set_seen(&conn, "r2", None).unwrap();
        assert_eq!(seen(&conn).unwrap(), vec![("r1".to_string(), r#"{"announced":1}"#.to_string())]);
        assert!(set_seen(&conn, "../x", Some("1")).is_err());
        set_timer(&conn, "t1", Some("{}")).unwrap();
        assert_eq!(timers(&conn).unwrap().len(), 1);
        assert_eq!(seen(&conn).unwrap().len(), 1, "timers aren't bookkeeping");
    }

    #[test]
    fn a_push_token_works_once_and_for_a_day() {
        let db = DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let t = issue_action(&conn, "r1", 1_000).unwrap();
        assert_eq!(take_action(&conn, &t, 2_000).as_deref(), Some("r1"));
        assert_eq!(take_action(&conn, &t, 2_000), None, "used up");
        let old = issue_action(&conn, "r2", 1_000).unwrap();
        assert_eq!(take_action(&conn, &old, 1_000 + ACTION_TTL_MS), None, "expired");
        let stale = issue_action(&conn, "r3", 1_000).unwrap();
        issue_action(&conn, "r4", 1_000 + ACTION_TTL_MS).unwrap();
        assert_eq!(take_action(&conn, &stale, 0), None, "dropped as a new one was made");
        assert_eq!(take_action(&conn, "nope/..", 0), None);
    }
}
