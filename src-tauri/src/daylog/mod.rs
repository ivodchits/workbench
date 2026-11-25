//! The daily log (improvement plan J1): its files in Duck's repo, and the git reads
//! the capture takes from each machine's projects. The passes themselves are the
//! webview's (`src/assistant/daylog.ts`), on the main's core.
//!
//! - **The files**, in Duck's workspace (so the fleet's mirrors get them, F5.2):
//!   - `daylog/notes/<day>.jsonl`: the capture's rough notes, one JSON object a line,
//!     only ever added to. A save is a union by note id ([`union`]), never a drop.
//!   - `daylog/days/<day>.json`: the day's entries, as the tidy last wrote them (or
//!     a hand edit).
//!   - `daylog/state.json`: where each machine's sessions were read to, and when
//!     each day was last tidied.
//!
//!   Each save is one commit, on the git queue, as the memory's are.
//! - **Git** ([`activity`]): a project's commits on any branch since a time, with
//!   their messages (`Revert "…"` marked), and the branch resets in its reflog,
//!   which undo earlier work.
//! - **The copy read** ([`copy`]): the main reads its own workspace; another machine
//!   reads its mirror of the main's, as of the last sync (J2's window).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::git::run::{exec, Spec};

pub const DIR: &str = "daylog";
const STATE: &str = "daylog/state.json";
/// A commit's message body is cut to this.
const BODY_MAX: usize = 600;
/// Commits read from one project in one go, at most.
const COMMITS_MAX: &str = "400";
/// The reflog entries looked through, at most.
const REFLOG_MAX: &str = "300";

// ── git ──

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    /// Committed at, epoch seconds.
    pub at: i64,
    pub subject: String,
    pub body: String,
    /// A `Revert "…"` commit: it undoes earlier work.
    pub revert: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReset {
    pub at: i64,
    /// The reflog's words (`reset: moving to HEAD~2`).
    pub what: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitActivity {
    /// Oldest first.
    pub commits: Vec<GitCommit>,
    pub resets: Vec<GitReset>,
}

/// `git log`'s output in the `%H %ct %s %b` form [`activity`] asks for.
pub fn parse_log(out: &str) -> Vec<GitCommit> {
    let mut v: Vec<GitCommit> = out
        .split('\x1e')
        .filter_map(|rec| {
            let mut f = rec.trim_start_matches(['\n', '\r']).splitn(4, '\x1f');
            let hash = f.next()?.trim().to_string();
            let at = f.next()?.trim().parse().ok()?;
            let subject = f.next()?.trim().to_string();
            let mut body = f.next().unwrap_or("").trim().to_string();
            if hash.len() < 7 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            if body.len() > BODY_MAX {
                let mut cut = BODY_MAX;
                while !body.is_char_boundary(cut) {
                    cut -= 1;
                }
                body.truncate(cut);
                body.push_str(" …");
            }
            let revert = subject.starts_with("Revert \"") || subject.starts_with("Revert '");
            Some(GitCommit { hash, at, subject, body, revert })
        })
        .collect();
    v.sort_by_key(|c| c.at);
    v
}

/// The reflog's resets after `since`, from `%gd %gs` lines read with `--date=unix`
/// (`HEAD@{1732460000}`).
pub fn parse_reflog(out: &str, since: i64) -> Vec<GitReset> {
    let mut v: Vec<GitReset> = out
        .lines()
        .filter_map(|l| {
            let (sel, what) = l.split_once('\x1f')?;
            let at: i64 = sel.rsplit_once("@{")?.1.trim_end_matches('}').parse().ok()?;
            let what = what.trim();
            (at > since && what.starts_with("reset:")).then(|| GitReset { at, what: what.to_string() })
        })
        .collect();
    v.sort_by_key(|r| r.at);
    v
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = exec(dir, Spec::local(args)).ok()?;
    out.ok.then_some(out.stdout)
}

/// `dir`'s commits on any branch after `since` (epoch seconds), and its resets.
/// A folder that isn't a repo has none.
pub fn activity(dir: &Path, since: i64) -> GitActivity {
    if git(dir, &["rev-parse", "--git-dir"]).is_none() {
        return GitActivity::default();
    }
    let after = format!("--since=@{}", since + 1);
    let log = git(
        dir,
        &["log", "--all", "--no-merges", "-n", COMMITS_MAX, &after, "--format=%H%x1f%ct%x1f%s%x1f%b%x1e"],
    )
    .unwrap_or_default();
    let reflog =
        git(dir, &["reflog", "show", "--date=unix", "-n", REFLOG_MAX, "--format=%gd%x1f%gs", "HEAD"]).unwrap_or_default();
    GitActivity {
        commits: parse_log(&log).into_iter().filter(|c| c.at > since).collect(),
        resets: parse_reflog(&reflog, since),
    }
}

/// A project's git activity since `since` (epoch seconds), for the capture.
#[tauri::command(async)]
pub fn daylog_git(dir: String, since: i64) -> Result<GitActivity, String> {
    let p = PathBuf::from(&dir);
    if !p.is_absolute() {
        return Err(format!("not a folder: {dir}"));
    }
    Ok(activity(&p, since))
}

// ── the files ──

/// `YYYY-MM-DD`.
pub fn day_ok(day: &str) -> bool {
    let b = day.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn notes_file(day: &str) -> String {
    format!("{DIR}/notes/{day}.jsonl")
}

fn day_file(day: &str) -> String {
    format!("{DIR}/days/{day}.json")
}

fn note_id(n: &Value) -> Option<&str> {
    n.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn parse_notes(text: &str) -> Vec<Value> {
    text.lines().filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok()).filter(|n| note_id(n).is_some()).collect()
}

pub fn read_notes(ws: &Path, day: &str) -> Vec<Value> {
    std::fs::read_to_string(ws.join(notes_file(day))).map(|t| parse_notes(&t)).unwrap_or_default()
}

/// `have` with each of `more` whose id it doesn't hold, in time order (then by id).
/// The number added comes back too. Nothing is ever dropped.
pub fn union(mut have: Vec<Value>, more: Vec<Value>) -> (Vec<Value>, usize) {
    let mut ids: HashSet<String> = have.iter().filter_map(note_id).map(String::from).collect();
    let mut added = 0;
    for n in more {
        let Some(id) = note_id(&n).map(String::from) else { continue };
        if ids.insert(id) {
            have.push(n);
            added += 1;
        }
    }
    let at = |n: &Value| n.get("at").and_then(Value::as_i64).unwrap_or(0);
    have.sort_by(|a, b| at(a).cmp(&at(b)).then_with(|| note_id(a).cmp(&note_id(b))));
    (have, added)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayFiles {
    pub notes: Vec<Value>,
    /// Null before the day's first tidy.
    pub entries: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub state: Option<Value>,
    pub days: BTreeMap<String, DayFiles>,
}

pub fn load(ws: &Path, days: &[String]) -> Result<Loaded, String> {
    let state = std::fs::read_to_string(ws.join(STATE)).ok().and_then(|t| serde_json::from_str(&t).ok());
    let mut out = Loaded { state, days: BTreeMap::new() };
    for day in days {
        if !day_ok(day) {
            return Err(format!("not a day: {day}"));
        }
        let entries = std::fs::read_to_string(ws.join(day_file(day))).ok().and_then(|t| serde_json::from_str(&t).ok());
        out.days.insert(day.clone(), DayFiles { notes: read_notes(ws, day), entries });
    }
    Ok(out)
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    /// Notes to add, by day.
    #[serde(default)]
    pub notes: BTreeMap<String, Vec<Value>>,
    /// Days' entries to write whole.
    #[serde(default)]
    pub days: BTreeMap<String, Value>,
    #[serde(default)]
    pub state: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    /// Notes added (those already there aren't counted).
    pub added: usize,
    /// The files written, relative to the workspace.
    pub files: Vec<String>,
}

/// Write a run's changes. The commit is the caller's ([`daylog_save`]).
pub fn save(ws: &Path, s: &Save) -> Result<Saved, String> {
    let mut out = Saved::default();
    for (day, more) in &s.notes {
        if !day_ok(day) {
            return Err(format!("not a day: {day}"));
        }
        if more.is_empty() {
            continue;
        }
        let (all, added) = union(read_notes(ws, day), more.clone());
        if added == 0 {
            continue;
        }
        let text: String = all.iter().map(|n| format!("{n}\n")).collect();
        let f = notes_file(day);
        write_atomic(&ws.join(&f), &text)?;
        out.added += added;
        out.files.push(f);
    }
    for (day, entries) in &s.days {
        if !day_ok(day) {
            return Err(format!("not a day: {day}"));
        }
        let f = day_file(day);
        let text = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())? + "\n";
        if std::fs::read_to_string(ws.join(&f)).is_ok_and(|t| t == text) {
            continue;
        }
        write_atomic(&ws.join(&f), &text)?;
        out.files.push(f);
    }
    if let Some(state) = &s.state {
        let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())? + "\n";
        if !std::fs::read_to_string(ws.join(STATE)).is_ok_and(|t| t == text) {
            write_atomic(&ws.join(STATE), &text)?;
            out.files.push(STATE.to_string());
        }
    }
    Ok(out)
}

/// The days that have entries, each with how many are shown (not hidden).
pub fn days(ws: &Path) -> Vec<(String, usize)> {
    let Ok(rd) = std::fs::read_dir(ws.join(DIR).join("days")) else { return Vec::new() };
    let mut v: Vec<(String, usize)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let day = name.strip_suffix(".json")?.to_string();
            if !day_ok(&day) {
                return None;
            }
            let text = std::fs::read_to_string(e.path()).ok()?;
            let v: Value = serde_json::from_str(&text).ok()?;
            let n = v["entries"].as_array().map_or(0, |a| a.iter().filter(|x| x["hidden"] != Value::Bool(true)).count());
            Some((day, n))
        })
        .collect();
    v.sort();
    v
}

/// The notes of `since_day` and after in this workspace.
pub fn recent_notes(ws: &Path, since_day: &str) -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(ws.join(DIR).join("notes")) else { return Vec::new() };
    let mut days: Vec<String> = rd
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".jsonl").map(String::from))
        .filter(|d| day_ok(d) && d.as_str() >= since_day)
        .collect();
    days.sort();
    days.iter().flat_map(|d| read_notes(ws, d)).collect()
}

/// The notes of `since_day` and after on the branches a promotion kept
/// (`fleet/before-term-*`, F6.1): what this machine wrote as an old main.
pub fn branch_notes(ws: &Path, since_day: &str) -> Vec<Value> {
    let Some(branches) = git(ws, &["for-each-ref", "--format=%(refname:short)", "refs/heads/fleet/"]) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for br in branches.lines().map(str::trim).filter(|b| b.starts_with("fleet/before-term-")) {
        let tree = format!("{br}:{DIR}/notes");
        let Some(names) = git(ws, &["ls-tree", "--name-only", &tree]) else { continue };
        for name in names.lines() {
            let Some(day) = name.trim().strip_suffix(".jsonl") else { continue };
            if !day_ok(day) || day < since_day {
                continue;
            }
            if let Some(text) = git(ws, &["show", &format!("{br}:{DIR}/notes/{name}")]) {
                out.extend(parse_notes(&text));
            }
        }
    }
    out
}

/// The workspace this machine reads the log from: Duck's own when Duck runs here,
/// else the mirror of the main's (when it has one).
fn copy(app: &AppHandle) -> Result<(PathBuf, bool), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let own = crate::assistant::workspace::resolve_configured(&dir)?;
    if let Some(fleet) = crate::fleet::get(app) {
        if let Some(mirror) = fleet.duck_mirror() {
            if crate::fleet::files::head(&mirror).is_some() {
                return Ok((mirror, true));
            }
        }
    }
    Ok((own, false))
}

// ── commands ──

#[tauri::command(async)]
pub fn daylog_load(workspace: Option<String>, days: Vec<String>) -> Result<Loaded, String> {
    let ws = crate::assistant::workspace::resolve(workspace.as_deref())?;
    load(&ws, &days)
}

/// Save a run's changes and commit them, as one commit. The window hears of it
/// (`daylog-changed`).
#[tauri::command(async)]
pub fn daylog_save(app: AppHandle, workspace: Option<String>, save: Save, message: String) -> Result<Saved, String> {
    let ws = crate::assistant::workspace::resolve(workspace.as_deref())?;
    let saved = self::save(&ws, &save)?;
    if !saved.files.is_empty() {
        crate::assistant::memory::commit(&ws, saved.files.clone(), message);
        let _ = app.emit("daylog-changed", ());
    }
    Ok(saved)
}

/// This workspace's notes since `since_day`, and those on the branches a promotion
/// kept: what a split left on this machine (F6.2), for the main to take in.
#[tauri::command(async)]
pub fn daylog_own_notes(app: AppHandle, since_day: String) -> Result<Vec<Value>, String> {
    if !day_ok(&since_day) {
        return Err(format!("not a day: {since_day}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let ws = crate::assistant::workspace::resolve_configured(&dir)?;
    let mut v = recent_notes(&ws, &since_day);
    v.extend(branch_notes(&ws, &since_day));
    Ok(v)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    pub day: String,
    pub entries: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Copy {
    /// The main's, mirrored here (else this machine's own).
    pub mirrored: bool,
    /// The copy's last commit, epoch seconds.
    pub synced_at: Option<i64>,
    pub days: Vec<DayCount>,
    /// The log's state's `backfill` (null: not offered yet), and whether there's a
    /// state at all (the log has run).
    pub backfill: Option<String>,
    pub started: bool,
}

/// The days with entries in the copy this machine reads (J2).
#[tauri::command(async)]
pub fn daylog_days(app: AppHandle) -> Result<Copy, String> {
    let (ws, mirrored) = copy(&app)?;
    let synced_at = git(&ws, &["log", "-1", "--format=%ct", "--", DIR]).and_then(|s| s.trim().parse().ok());
    let state: Option<Value> = std::fs::read_to_string(ws.join(STATE)).ok().and_then(|t| serde_json::from_str(&t).ok());
    Ok(Copy {
        mirrored,
        synced_at,
        backfill: state.as_ref().and_then(|s| s["backfill"].as_str().map(String::from)),
        started: state.is_some(),
        days: days(&ws).into_iter().map(|(day, entries)| DayCount { day, entries }).collect(),
    })
}

/// One day's entries in the copy this machine reads (J2).
#[tauri::command(async)]
pub fn daylog_day(app: AppHandle, day: String) -> Result<Option<Value>, String> {
    if !day_ok(&day) {
        return Err(format!("not a day: {day}"));
    }
    let (ws, _) = copy(&app)?;
    Ok(std::fs::read_to_string(ws.join(day_file(&day))).ok().and_then(|t| serde_json::from_str(&t).ok()))
}

#[cfg(test)]
mod tests;
