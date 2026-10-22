//! Duck's long-term memory (step L1): markdown files in the workspace's `memory/`,
//! an index over them in `duck.db`, and a commit to the workspace's git repo for
//! every change Duck makes.
//!
//! - **The files.** One per topic: `decisions.md`, `preferences.md`, `people.md`,
//!   `goals.md`, `lessons.md` (what Duck learned about working with you), and
//!   `projects/<name>.md`, and the journal (step L2), `journal/<YYYY-MM>.md`, a
//!   bullet per day. Each entry is a bullet:
//!   `- 2026-10-22 — Decided SQLite for notes sync. Why: one file. (src: thread:…,
//!   conf: high, tags: синхронизация заметок)`. You can edit them; a bullet without
//!   the date or the parenthesis is still an entry. `core.md` (W4) is the profile
//!   every thread starts with, so it isn't indexed again here.
//! - **The index.** FTS5 with the trigram tokenizer, which matches substrings and so
//!   works for Russian and English alike without stemmers. A file watcher marks the
//!   folder dirty; the next search re-reads only the files whose size or time
//!   changed. **Project notes** (the notes root) get their own table the same way,
//!   read-only: a search can find them, nothing here writes them.
//! - **The search.** A query becomes its words (stop words dropped, the last letter
//!   or two cut off a long word so that "заметок" finds "заметки"), any of which can
//!   match; each hit says how many of the words it holds, which is what the engine's
//!   threshold reads.
//! - **Secrets** are refused before anything is written ([`secret_in`]).
//! - **Git.** The workspace becomes a repo on the first change, and each change is
//!   one commit of just its files, through the background git queue.
//! - **Consolidation** (step L2): the engine's nightly pass decides what to add,
//!   merge and retire, and [`apply`] makes all of it, and the day's journal bullet,
//!   in one go, for one commit.
//! - **The recall log** (step L2): every automatic recall, what it showed and what
//!   the reply used, in `recall_log`, for the hit rate ([`recall_stats`]).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::gitqueue;

pub const DIR: &str = "memory";
const CORE: &str = "memory/core.md";
/// The topic files there are (besides `projects/<name>`).
pub const TOPICS: [&str; 5] = ["decisions", "preferences", "people", "goals", "lessons"];
/// One entry's fact and reason together: an entry is a line, not a document.
pub const ENTRY_MAX: usize = 600;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_NOTE_BYTES: u64 = 2 * 1024 * 1024;
/// A note is indexed in chunks of about this many characters, so a hit can show
/// the part that matched.
const CHUNK_CHARS: usize = 800;
/// The most of a hit's text a search returns.
const HIT_CHARS: usize = 300;
const CONFIDENCES: [&str; 3] = ["high", "med", "low"];

// ── entries ──

/// One remembered entry, as its file has it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// `decisions`, `projects/quill`, `journal/2026-10`.
    pub topic: String,
    /// The file, relative to the workspace: `memory/decisions.md`.
    pub file: String,
    /// 1-based.
    pub line: usize,
    pub date: Option<String>,
    /// The fact (and its reason), without the date and the parenthesis.
    pub text: String,
    pub src: Option<String>,
    pub conf: Option<String>,
    pub tags: Option<String>,
    /// The bullet's whole text, without the `- `: what `forget` matches.
    pub raw: String,
}

/// What `remember` writes.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewEntry {
    /// The day, `YYYY-MM-DD` (the engine's, which knows the local date).
    pub date: String,
    pub fact: String,
    pub why: Option<String>,
    /// `thread:<id>` or `task:<id>`.
    pub src: Option<String>,
    /// `high`, `med` or `low`; `med` when absent.
    pub conf: Option<String>,
    /// Words to find it by, in both languages.
    pub tags: Option<String>,
}

/// The file a topic lives in, relative to the workspace.
pub fn topic_file(topic: &str) -> Result<String, String> {
    let t = topic.trim().to_lowercase();
    if TOPICS.contains(&t.as_str()) {
        return Ok(format!("{DIR}/{t}.md"));
    }
    if let Some(name) = t.strip_prefix("projects/") {
        let s = slug(name);
        if !s.is_empty() {
            return Ok(format!("{DIR}/projects/{s}.md"));
        }
    }
    Err(format!(
        "not a memory topic: {topic} (one of {}, or projects/<name>)",
        TOPICS.join(", ")
    ))
}

/// A file name from a project's name: lowercase letters and digits (any script)
/// joined by `-`, at most 48 characters.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let s: String = out.chars().take(48).collect();
    s.trim_matches('-').to_string()
}

/// The topic of a memory file: its path under `memory/`, without `.md`.
fn topic_of(file: &str) -> String {
    let t = file.strip_prefix("memory/").unwrap_or(file);
    t.strip_suffix(".md").unwrap_or(t).to_string()
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cleaned(s: Option<&str>) -> Option<String> {
    s.map(one_line).filter(|v| !v.is_empty())
}

/// The fact and its reason as an entry's text.
fn entry_text(e: &NewEntry) -> String {
    let mut s = one_line(&e.fact).trim_start_matches(['-', '*', '•', ' ']).to_string();
    if let Some(w) = cleaned(e.why.as_deref()) {
        if !s.ends_with(['.', '!', '?']) {
            s.push('.');
        }
        s.push_str(" Why: ");
        s.push_str(&w);
    }
    s
}

/// The bullet's text for a new entry (without the `- `).
pub fn format_entry(e: &NewEntry) -> String {
    let mut meta = Vec::new();
    if let Some(v) = cleaned(e.src.as_deref()) {
        meta.push(format!("src: {v}"));
    }
    meta.push(format!("conf: {}", cleaned(e.conf.as_deref()).unwrap_or_else(|| "med".into())));
    if let Some(v) = cleaned(e.tags.as_deref()) {
        meta.push(format!("tags: {v}"));
    }
    format!("{} — {} ({})", e.date.trim(), entry_text(e), meta.join(", "))
}

const KEYS: [&str; 3] = ["src:", "conf:", "tags:"];

/// Where a bullet's trailing `(src: …, conf: …)` starts, if it has one.
fn meta_start(s: &str) -> Option<usize> {
    if !s.ends_with(')') {
        return None;
    }
    s.match_indices('(').map(|(i, _)| i).rev().find(|&i| {
        let rest = s[i + 1..].trim_start();
        KEYS.iter().any(|k| rest.starts_with(k))
    })
}

/// `src`, `conf` and `tags` from inside the parenthesis. A key counts at the start
/// or after a `,` / `;`, so the tags (last) may hold commas.
fn parse_meta(inner: &str) -> [Option<String>; 3] {
    let mut marks: Vec<(usize, usize)> = Vec::new();
    for (k, key) in KEYS.iter().enumerate() {
        let mut from = 0;
        while let Some(p) = inner[from..].find(key) {
            let at = from + p;
            let before = inner[..at].trim_end();
            if before.is_empty() || before.ends_with(',') || before.ends_with(';') {
                marks.push((at, k));
            }
            from = at + key.len();
        }
    }
    marks.sort();
    let mut out: [Option<String>; 3] = Default::default();
    for (j, &(at, k)) in marks.iter().enumerate() {
        let end = marks.get(j + 1).map_or(inner.len(), |m| m.0);
        let v = inner[at + KEYS[k].len()..end].trim().trim_end_matches([',', ';']).trim();
        if !v.is_empty() && out[k].is_none() {
            out[k] = Some(v.to_string());
        }
    }
    out
}

/// A leading `YYYY-MM-DD` and what follows its separator.
fn split_date(body: &str) -> (Option<String>, &str) {
    let Some(head) = body.get(..10) else { return (None, body) };
    let b = head.as_bytes();
    let is_date = b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    if !is_date {
        return (None, body);
    }
    let rest = body[10..].trim_start();
    let rest = ["—", "–", "-", ":"]
        .iter()
        .find_map(|sep| rest.strip_prefix(sep))
        .unwrap_or(rest)
        .trim_start();
    (Some(head.to_string()), rest)
}

/// A bullet line's text, without the `- ` / `* `.
fn bullet(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let rest = t.strip_prefix("- ").or_else(|| t.strip_prefix("* "))?;
    let rest = rest.trim();
    (!rest.is_empty()).then_some(rest)
}

/// The entries in a memory file.
pub fn parse_file(file: &str, text: &str) -> Vec<Entry> {
    let topic = topic_of(file);
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let Some(raw) = bullet(line) else { continue };
        let (body, [src, conf, tags]) = match meta_start(raw) {
            Some(at) => (raw[..at].trim_end(), parse_meta(&raw[at + 1..raw.len() - 1])),
            None => (raw, Default::default()),
        };
        let (date, text) = split_date(body);
        out.push(Entry {
            topic: topic.clone(),
            file: file.to_string(),
            line: i + 1,
            date,
            text: text.to_string(),
            src,
            conf,
            tags,
            raw: raw.to_string(),
        });
    }
    out
}

fn norm(s: &str) -> String {
    one_line(s).to_lowercase()
}

// ── secrets ──

fn secret_patterns() -> &'static [(Regex, &'static str)] {
    static P: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    P.get_or_init(|| {
        [
            (r"sk-ant-[A-Za-z0-9_-]{8,}", "an Anthropic API key"),
            (r"\bsk-[A-Za-z0-9_-]{20,}", "an API key"),
            (r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}", "a GitHub token"),
            (r"\bxox[abprs]-[A-Za-z0-9-]{10,}", "a Slack token"),
            (r"\bAKIA[0-9A-Z]{16}\b", "an AWS key"),
            (r"\bAIza[0-9A-Za-z_-]{30,}", "a Google API key"),
            (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "a private key"),
            (r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", "a token"),
            (r"(?i)\b(?:password|passwd|passphrase|pwd|пароль)\b\s*[:=]\s*\S", "a password"),
            (r#"(?i)\b(?:password|passphrase|пароль)\b[^.\n]{0,24}["'`«][^"'`»\s]{4,}["'`»]"#, "a password"),
            (r"(?i)\b(?:api[ _-]?key|secret|token|bearer|токен|ключ)\b\s*[:=]\s*\S{6,}", "a key or token"),
        ]
        .into_iter()
        .map(|(p, what)| (Regex::new(p).expect("a valid secret pattern"), what))
        .collect()
    })
}

fn entropy(s: &str) -> f64 {
    let mut counts: HashMap<u8, usize> = HashMap::new();
    for b in s.bytes() {
        *counts.entry(b).or_default() += 1;
    }
    let n = s.len() as f64;
    counts.values().map(|&c| {
        let p = c as f64 / n;
        -p * p.log2()
    }).sum()
}

/// A long random-looking string: a key nobody named.
fn random_looking(word: &str) -> bool {
    let w = word.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    if w.len() < 24 || !w.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=_-".contains(&b)) {
        return false;
    }
    let hex = w.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    // A commit hash or a UUID is an id, not a secret.
    if hex && w.len() <= 40 {
        return false;
    }
    // Words joined by dashes (a slug, a branch name) aren't random.
    if w.contains(['-', '_']) && w.split(['-', '_']).all(|p| p.len() <= 12) {
        return false;
    }
    let classes = [
        w.bytes().any(|b| b.is_ascii_uppercase()),
        w.bytes().any(|b| b.is_ascii_lowercase()),
        w.bytes().any(|b| b.is_ascii_digit()),
    ]
    .iter()
    .filter(|x| **x)
    .count();
    classes >= 2 && entropy(w) >= 3.5
}

/// What kind of secret `text` seems to hold, if any.
pub fn secret_in(text: &str) -> Option<&'static str> {
    for (re, what) in secret_patterns() {
        if re.is_match(text) {
            return Some(what);
        }
    }
    text.split_whitespace().any(random_looking).then_some("a long random string (a key?)")
}

// ── files ──

/// A change to one memory file, for the thread's chip and its undo.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEdit {
    /// Relative to the workspace.
    pub file: String,
    /// Absolute.
    pub path: String,
    /// `None`: the edit made the file.
    pub before: Option<String>,
    /// `None`: the edit removed the file.
    pub after: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    /// `None` when it was already remembered (and nothing was written).
    pub edit: Option<FileEdit>,
    pub entry: Entry,
}

/// A memory file's path, relative to the workspace, checked: under `memory/`, a
/// `.md`, no `..`, and not `core.md` (W4's own commands write that).
pub fn check_file(file: &str) -> Result<PathBuf, String> {
    let f = file.replace('\\', "/");
    let p = Path::new(&f);
    let ok = f.starts_with("memory/")
        && f.ends_with(".md")
        && !f.eq_ignore_ascii_case(CORE)
        && p.components().all(|c| matches!(c, Component::Normal(_)));
    if ok { Ok(p.to_path_buf()) } else { Err(format!("not a memory file: {file}")) }
}

fn read_opt(path: &Path, max: u64) -> Result<Option<String>, String> {
    match std::fs::metadata(path) {
        Ok(m) if m.len() > max => Err(format!("{} is larger than {} KB", path.display(), max / 1024)),
        Ok(_) => std::fs::read(path)
            .map(|b| Some(String::from_utf8_lossy(&b).into_owned()))
            .map_err(|e| format!("cannot read {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

fn write_file(path: &Path, text: Option<&str>) -> Result<(), String> {
    match text {
        Some(t) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
            }
            std::fs::write(path, t).map_err(|e| format!("cannot write {}: {e}", path.display()))
        }
        None => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("cannot remove {}: {e}", path.display())),
        },
    }
}

/// A new topic file's head.
fn header(file: &str) -> String {
    let topic = topic_of(file);
    if let Some(month) = topic.strip_prefix("journal/") {
        return format!("# Journal, {month}\n\nWhat Duck wrote about each day when it tidied its memory. Edit freely.\n\n");
    }
    let title = match topic.strip_prefix("projects/") {
        Some(p) => format!("Project: {p}"),
        None => {
            let mut c = topic.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
    };
    format!("# {title}\n\nWhat Duck remembers, one entry per line: the date, the fact, where it came from. Edit freely.\n\n")
}

/// `text` with `line` added at its end, in its line endings.
fn appended(text: &str, line: &str) -> String {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    format!("{}{nl}- {line}{nl}", text.trim_end_matches(['\n', '\r']))
}

/// Add an entry to `topic`'s file in `workspace`. One whose text is already there
/// (in that file) isn't written again.
pub fn write(workspace: &Path, topic: &str, e: &NewEntry) -> Result<Written, String> {
    let fact = one_line(&e.fact);
    if fact.is_empty() {
        return Err("nothing to remember".into());
    }
    let text = entry_text(e);
    if text.chars().count() > ENTRY_MAX {
        return Err(format!("too long for one entry ({ENTRY_MAX} characters at most): keep the fact and the reason short"));
    }
    for part in [Some(e.fact.as_str()), e.why.as_deref(), e.tags.as_deref()].into_iter().flatten() {
        if let Some(what) = secret_in(part) {
            return Err(format!("refused: that looks like {what}. Secrets are never remembered."));
        }
    }
    if let Some(c) = cleaned(e.conf.as_deref()) {
        if !CONFIDENCES.contains(&c.as_str()) {
            return Err(format!("conf must be one of {}", CONFIDENCES.join(", ")));
        }
    }
    let file = topic_file(topic)?;
    let path = workspace.join(&file);
    let before = read_opt(&path, MAX_FILE_BYTES)?;
    if let Some(dup) = before.as_deref().and_then(|t| parse_file(&file, t).into_iter().find(|x| norm(&x.text) == norm(&text))) {
        return Ok(Written { edit: None, entry: dup });
    }
    let line = format_entry(e);
    let after = match before.as_deref() {
        Some(t) => appended(t, &line),
        None => format!("{}- {line}
", header(&file)),
    };
    write_file(&path, Some(&after))?;
    let entry = parse_file(&file, &after).into_iter().last().ok_or("the entry wasn't written")?;
    Ok(Written {
        edit: Some(FileEdit { file, path: path.to_string_lossy().into_owned(), before, after: Some(after) }),
        entry,
    })
}

/// An entry to forget: its file and its bullet's text.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Forget {
    pub file: String,
    pub raw: String,
}

/// Remove these entries from their files: one edit per file that had any.
pub fn forget(workspace: &Path, items: &[Forget]) -> Result<Vec<FileEdit>, String> {
    let mut by_file: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    for it in items {
        check_file(&it.file)?;
        by_file.entry(it.file.replace('\\', "/")).or_default().insert(norm(&it.raw));
    }
    let mut edits = Vec::new();
    for (file, gone) in by_file {
        let path = workspace.join(&file);
        let Some(before) = read_opt(&path, MAX_FILE_BYTES)? else { continue };
        let nl = if before.contains("\r\n") { "\r\n" } else { "\n" };
        let kept: Vec<&str> = before.lines().filter(|l| !bullet(l).is_some_and(|b| gone.contains(&norm(b)))).collect();
        if kept.len() == before.lines().count() {
            continue;
        }
        let mut after = kept.join(nl);
        if before.ends_with('\n') {
            after.push_str(nl);
        }
        write_file(&path, Some(&after))?;
        edits.push(FileEdit { file, path: path.to_string_lossy().into_owned(), before: Some(before), after: Some(after) });
    }
    Ok(edits)
}

/// Write a memory file over the text it was read as (`expected`; `None`: there
/// was none). `text: None` removes it. For an undo.
pub fn restore(workspace: &Path, file: &str, text: Option<&str>, expected: Option<&str>) -> Result<(), String> {
    let path = workspace.join(check_file(file)?);
    if read_opt(&path, MAX_FILE_BYTES)?.as_deref() != expected {
        return Err(format!("stale: {file} changed since"));
    }
    write_file(&path, text)
}

/// Every entry in the memory files (core.md aside), by file.
pub fn list(workspace: &Path) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for (file, _, _) in memory_files(workspace) {
        if let Some(text) = read_opt(&workspace.join(&file), MAX_FILE_BYTES)? {
            out.extend(parse_file(&file, &text));
        }
    }
    Ok(out)
}

// ── consolidation (step L2) ──

/// An entry a consolidation adds: a new one, or what a merge became.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Add {
    pub topic: String,
    pub entry: NewEntry,
}

/// The day's journal paragraph.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    /// `YYYY-MM-DD`: the day it's about.
    pub date: String,
    pub text: String,
}

/// What one consolidation run changes.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Apply {
    /// Removed first: the merged and the retired entries.
    #[serde(default)]
    pub remove: Vec<Forget>,
    #[serde(default)]
    pub add: Vec<Add>,
    pub journal: Option<Journal>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    /// One per file changed, from before the run to after it.
    pub edits: Vec<FileEdit>,
    /// What wasn't written, and why (a secret, too long, not a topic).
    pub skipped: Vec<String>,
}

/// The longest journal paragraph.
pub const JOURNAL_MAX: usize = 2000;

/// The journal file a day's bullet goes in: `memory/journal/2026-10.md`.
pub fn journal_file(date: &str) -> Result<String, String> {
    let d = date.trim();
    match split_date(d) {
        (Some(day), "") => Ok(format!("{DIR}/journal/{}.md", &day[..7])),
        _ => Err(format!("not a date: {date}")),
    }
}

/// Note a file's text before the run first touches it.
fn keep_before(before: &mut BTreeMap<String, Option<String>>, workspace: &Path, file: &str) -> Result<(), String> {
    let file = file.replace('\\', "/");
    if let std::collections::btree_map::Entry::Vacant(e) = before.entry(file) {
        let text = read_opt(&workspace.join(e.key()), MAX_FILE_BYTES)?;
        e.insert(text);
    }
    Ok(())
}

/// Make a consolidation's changes: the removals, then the additions, then the
/// journal bullet. An addition that can't be written (a secret, too long, not a
/// topic) is skipped and said; the rest still happen.
pub fn apply(workspace: &Path, a: &Apply) -> Result<Applied, String> {
    let mut before: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut skipped = Vec::new();
    for f in &a.remove {
        check_file(&f.file)?;
        keep_before(&mut before, workspace, &f.file)?;
    }
    forget(workspace, &a.remove)?;
    for add in &a.add {
        let file = match topic_file(&add.topic) {
            Ok(f) => f,
            Err(e) => {
                skipped.push(format!("{}: {e}", clip(&one_line(&add.entry.fact), 80)));
                continue;
            }
        };
        keep_before(&mut before, workspace, &file)?;
        if let Err(e) = write(workspace, &add.topic, &add.entry) {
            skipped.push(format!("{}: {e}", clip(&one_line(&add.entry.fact), 80)));
        }
    }
    if let Some(j) = &a.journal {
        let text = clip(&one_line(&j.text), JOURNAL_MAX);
        if let Some(what) = secret_in(&text) {
            skipped.push(format!("the journal: refused, it looks like it holds {what}"));
        } else if !text.is_empty() {
            let file = journal_file(&j.date)?;
            keep_before(&mut before, workspace, &file)?;
            let path = workspace.join(&file);
            let line = format!("{} — {text} (src: tidy)", j.date.trim());
            let after = match before.get(&file).cloned().flatten() {
                Some(t) => appended(&t, &line),
                None => format!("{}- {line}\n", header(&file)),
            };
            write_file(&path, Some(&after))?;
        }
    }
    let mut edits = Vec::new();
    for (file, b) in before {
        let path = workspace.join(&file);
        let after = read_opt(&path, MAX_FILE_BYTES)?;
        if after != b {
            edits.push(FileEdit { file, path: path.to_string_lossy().into_owned(), before: b, after });
        }
    }
    Ok(Applied { edits, skipped })
}

// ── the recall log (step L2) ──

/// One automatic recall: what was searched and shown, and what the reply used.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecallRow {
    pub at: i64,
    pub thread_id: String,
    /// The message searched (its start).
    pub query: String,
    /// Hits the search found, before the threshold.
    pub candidates: i64,
    /// Hits shown to the model.
    pub shown: i64,
    /// Of those, the ones the reply used.
    pub used: i64,
    /// Duck called `recall` itself in that turn.
    pub self_recall: bool,
    /// The hits shown, `[{label, file, line, matched, terms, used}]`.
    pub hits: serde_json::Value,
}

/// How long the log keeps a row.
const RECALL_LOG_DAYS: i64 = 90;
const QUERY_CHARS: usize = 300;

pub fn log_recall(conn: &Connection, r: &RecallRow) -> Result<(), String> {
    db(conn.execute(
        "INSERT INTO recall_log (at, thread_id, query, candidates, shown, used, self_recall, hits)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            r.at,
            r.thread_id,
            clip(&one_line(&r.query), QUERY_CHARS),
            r.candidates,
            r.shown,
            r.used,
            r.self_recall,
            r.hits.to_string()
        ],
    ))?;
    db(conn.execute("DELETE FROM recall_log WHERE at < ?1", [r.at - RECALL_LOG_DAYS * 86_400_000]))?;
    Ok(())
}

/// The hit rate since `since` (epoch ms).
#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecallStats {
    /// Messages searched.
    pub searched: i64,
    /// Messages that got at least one hit shown.
    pub with_hits: i64,
    /// Hits shown, and how many of them the reply used.
    pub shown: i64,
    pub used: i64,
    /// Turns where Duck called `recall` itself, and those of them where nothing
    /// had been shown: likely misses.
    pub self_recall: i64,
    pub missed: i64,
}

pub fn recall_stats(conn: &Connection, since: i64) -> Result<RecallStats, String> {
    db(conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(shown > 0), 0), COALESCE(SUM(shown), 0), COALESCE(SUM(used), 0),
                COALESCE(SUM(self_recall), 0), COALESCE(SUM(self_recall AND shown = 0), 0)
         FROM recall_log WHERE at >= ?1",
        [since],
        |r| {
            Ok(RecallStats {
                searched: r.get(0)?,
                with_hits: r.get(1)?,
                shown: r.get(2)?,
                used: r.get(3)?,
                self_recall: r.get(4)?,
                missed: r.get(5)?,
            })
        },
    ))
}

/// `(relative path, mtime ms, size)` of the memory files under `workspace`.
fn memory_files(workspace: &Path) -> Vec<(String, i64, i64)> {
    let mut out = Vec::new();
    let mut stack = vec![workspace.join(DIR)];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                stack.push(p);
            } else if name.ends_with(".md") {
                let rel = p.strip_prefix(workspace).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                if !rel.eq_ignore_ascii_case(CORE) {
                    out.push((rel, mtime(&m), m.len() as i64));
                }
            }
        }
    }
    out.sort();
    out
}

/// `(folder/name.md, mtime ms, size)` of the notes under the notes root.
fn note_files(root: &Path) -> Vec<(String, i64, i64)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else { return out };
    for folder in rd.flatten() {
        let fname = folder.file_name().to_string_lossy().into_owned();
        if fname.starts_with('.') || !folder.path().is_dir() {
            continue;
        }
        let Ok(notes) = std::fs::read_dir(folder.path()) else { continue };
        for n in notes.flatten() {
            let name = n.file_name().to_string_lossy().into_owned();
            let Ok(m) = n.metadata() else { continue };
            if m.is_file() && name.ends_with(".md") {
                out.push((format!("{fname}/{name}"), mtime(&m), m.len() as i64));
            }
        }
    }
    out.sort();
    out
}

fn mtime(m: &std::fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

// ── the index ──

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Memory,
    Note,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Kind::Memory => "memory",
            Kind::Note => "note",
        }
    }
    fn table(self) -> &'static str {
        match self {
            Kind::Memory => "memory_fts",
            Kind::Note => "notes_fts",
        }
    }
}

/// What the watchers have seen since the last search.
struct Watch {
    root: PathBuf,
    dirty: Arc<AtomicBool>,
    /// `None`: no watcher could be made, so every search rescans.
    _watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
struct Watches {
    memory: Option<Watch>,
    notes: Option<Watch>,
}

fn watches() -> &'static Mutex<Watches> {
    static W: OnceLock<Mutex<Watches>> = OnceLock::new();
    W.get_or_init(Mutex::default)
}

fn watch(dir: &Path) -> Watch {
    let dirty = Arc::new(AtomicBool::new(true));
    let flag = dirty.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| !p.components().any(|c| c.as_os_str() == ".git")) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    })
    .and_then(|mut w| w.watch(dir, RecursiveMode::Recursive).map(|()| w));
    if let Err(e) = &watcher {
        eprintln!("duck: no watcher on {}: {e}", dir.display());
    }
    Watch { root: dir.to_path_buf(), dirty, _watcher: watcher.ok() }
}

/// Whether the tree under `dir` needs a rescan: it's new, or it changed since.
fn needs_sync(slot: &mut Option<Watch>, dir: &Path) -> bool {
    if slot.as_ref().is_none_or(|w| w.root != dir) {
        *slot = Some(watch(dir));
    }
    let w = slot.as_ref().expect("just set");
    w.dirty.swap(false, Ordering::SeqCst) || w._watcher.is_none()
}

/// Bring the index up to date with `memory/` (and the notes root): the files
/// changed since the last time, or all of them after a move of the workspace.
pub fn ensure(conn: &Connection, workspace: &Path, notes: Option<&Path>) -> Result<(), String> {
    let mem_dir = workspace.join(DIR);
    std::fs::create_dir_all(&mem_dir).map_err(|e| format!("cannot create {}: {e}", mem_dir.display()))?;
    let (mem, note) = {
        let mut w = watches().lock().unwrap_or_else(|e| e.into_inner());
        let mem = needs_sync(&mut w.memory, &mem_dir);
        let note = match notes.filter(|n| n.is_dir()) {
            Some(n) => needs_sync(&mut w.notes, n),
            None => false,
        };
        (mem, note)
    };
    let mark = |slot: fn(&mut Watches) -> &mut Option<Watch>| {
        if let Some(w) = slot(&mut watches().lock().unwrap_or_else(|e| e.into_inner())).as_ref() {
            w.dirty.store(true, Ordering::SeqCst);
        }
    };
    if mem {
        if let Err(e) = sync(conn, Kind::Memory, workspace) {
            mark(|w| &mut w.memory);
            return Err(e);
        }
    }
    if let (true, Some(n)) = (note, notes) {
        if let Err(e) = sync(conn, Kind::Note, n) {
            mark(|w| &mut w.notes);
            return Err(e);
        }
    }
    Ok(())
}

fn db<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| format!("memory index: {e}"))
}

/// Re-read what changed under `root` into `kind`'s table.
fn sync(conn: &Connection, kind: Kind, root: &Path) -> Result<(), String> {
    let root_key = format!("memory_index_root:{}", kind.key());
    let root_s = root.to_string_lossy().into_owned();
    let tx = db(conn.unchecked_transaction())?;
    let indexed: Option<String> =
        db(tx.query_row("SELECT value FROM meta WHERE key = ?1", [&root_key], |r| r.get(0)).optional())?;
    if indexed.as_deref() != Some(root_s.as_str()) {
        db(tx.execute(&format!("DELETE FROM {}", kind.table()), []))?;
        db(tx.execute("DELETE FROM memory_index_files WHERE kind = ?1", [kind.key()]))?;
        db(tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (&root_key, &root_s),
        ))?;
    }
    let mut known: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut st = db(tx.prepare("SELECT path, mtime, size FROM memory_index_files WHERE kind = ?1"))?;
        let rows = db(st.query_map([kind.key()], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?)))))?;
        for r in rows {
            let (p, v) = db(r)?;
            known.insert(p, v);
        }
    }
    let files = match kind {
        Kind::Memory => memory_files(root),
        Kind::Note => note_files(root),
    };
    for (rel, mt, size) in &files {
        if known.remove(rel) != Some((*mt, *size)) {
            index_file(&tx, kind, root, rel, *mt, *size)?;
        }
    }
    for gone in known.keys() {
        drop_file(&tx, kind, gone)?;
    }
    db(tx.commit())
}

fn drop_file(conn: &Connection, kind: Kind, rel: &str) -> Result<(), String> {
    db(conn.execute(&format!("DELETE FROM {} WHERE path = ?1", kind.table()), [rel]))?;
    db(conn.execute("DELETE FROM memory_index_files WHERE kind = ?1 AND path = ?2", [kind.key(), rel]))?;
    Ok(())
}

fn index_file(conn: &Connection, kind: Kind, root: &Path, rel: &str, mt: i64, size: i64) -> Result<(), String> {
    drop_file(conn, kind, rel)?;
    let max = if kind == Kind::Memory { MAX_FILE_BYTES } else { MAX_NOTE_BYTES };
    // A file too big or unreadable is left out, and tried again when it changes.
    let text = read_opt(&root.join(rel), max).ok().flatten().unwrap_or_default();
    match kind {
        Kind::Memory => {
            let mut st = db(conn.prepare("INSERT INTO memory_fts (body, path, line, entry) VALUES (?1, ?2, ?3, ?4)"))?;
            for e in parse_file(rel, &text) {
                let body = format!("{} {} {}", e.topic, e.text, e.tags.as_deref().unwrap_or(""));
                let json = serde_json::to_string(&e).map_err(|x| x.to_string())?;
                db(st.execute(params![body, rel, e.line as i64, json]))?;
            }
        }
        Kind::Note => {
            let (folder, name) = rel.split_once('/').unwrap_or(("", rel));
            let name = name.strip_suffix(".md").unwrap_or(name);
            let project = crate::notes::link::read_project_file(&root.join(folder))
                .map(|f| f.name)
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| folder.to_string());
            let label = format!("note: {project} / {name}");
            let mut st = db(conn.prepare("INSERT INTO notes_fts (body, path, line, label) VALUES (?1, ?2, ?3, ?4)"))?;
            for (line, chunk) in chunks(&text) {
                db(st.execute(params![format!("{name}\n{chunk}"), rel, line as i64, label]))?;
            }
        }
    }
    db(conn.execute(
        "INSERT INTO memory_index_files (kind, path, mtime, size) VALUES (?1, ?2, ?3, ?4)",
        params![kind.key(), rel, mt, size],
    ))?;
    Ok(())
}

/// A note in pieces of about `CHUNK_CHARS`, cut at blank lines, each with the line
/// it starts on.
fn chunks(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut start = 1;
    for (i, line) in text.lines().enumerate() {
        if cur.is_empty() {
            if line.trim().is_empty() {
                continue;
            }
            start = i + 1;
        }
        cur.push_str(line);
        cur.push('\n');
        if line.trim().is_empty() && cur.chars().count() >= CHUNK_CHARS {
            out.push((start, std::mem::take(&mut cur).trim().to_string()));
        }
    }
    if !cur.trim().is_empty() {
        out.push((start, cur.trim().to_string()));
    }
    out
}

/// Re-read these memory files now (after Duck wrote them), not at the next search.
pub fn reindex(conn: &Connection, workspace: &Path, files: &[String]) -> Result<(), String> {
    for rel in files {
        let path = workspace.join(rel);
        match std::fs::metadata(&path) {
            Ok(m) => index_file(conn, Kind::Memory, workspace, rel, mtime(&m), m.len() as i64)?,
            Err(_) => drop_file(conn, Kind::Memory, rel)?,
        }
    }
    Ok(())
}

// ── search ──

const STOP: &[&str] = &[
    // English
    "the", "and", "for", "are", "but", "not", "you", "your", "all", "any", "can", "had", "her", "his", "was", "one",
    "our", "out", "has", "have", "this", "that", "with", "from", "they", "them", "then", "than", "what", "when",
    "where", "which", "who", "why", "how", "will", "would", "could", "should", "about", "there", "their", "these",
    "those", "into", "just", "like", "some", "very", "been", "also", "does", "did", "doing", "done", "let", "lets",
    "please", "want", "need", "know", "think", "make", "get", "got", "now", "yes", "okay", "its", "it's", "too",
    "more", "most", "much", "many", "say", "said", "tell", "told", "again", "back", "here", "over", "only", "other",
    "same", "such", "use", "using", "used", "way", "well", "were", "work", "today", "yesterday", "tomorrow",
    "remember", "recall", "duck", "write", "wrote",
    // Russian
    "это", "что", "как", "для", "так", "или", "мне", "меня", "мой", "моя", "мои", "его", "она", "они", "оно", "все",
    "всё", "уже", "еще", "ещё", "только", "можно", "нужно", "надо", "есть", "был", "была", "было", "были", "будет",
    "когда", "где", "там", "тут", "вот", "сейчас", "давай", "пожалуйста", "почему", "зачем", "который", "которая",
    "которые", "чтобы", "если", "тоже", "также", "очень", "просто", "через", "после", "перед", "сегодня", "вчера",
    "завтра", "помнишь", "запомни", "скажи", "сказал", "сказала", "знаешь", "думаю", "хочу", "нас", "вас", "наш",
    "ваш", "без", "над", "под", "при", "про", "даже", "потом", "теперь", "этот", "эта", "эти", "того", "тебя",
    "тебе", "себя", "ничего", "что-то", "какой", "какая", "какие",
];

/// A query's words, each cut to the part that survives inflection: lowercase, at
/// least three letters, stop words and numbers dropped, the last letter (five or
/// six letters) or two (seven or more) cut off.
pub fn terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in query.split(|c: char| !c.is_alphanumeric()) {
        let w = word.to_lowercase();
        let n = w.chars().count();
        if n < 3 || STOP.contains(&w.as_str()) || w.chars().all(|c| c.is_numeric()) {
            continue;
        }
        let keep = if n >= 7 { n - 2 } else if n >= 5 { n - 1 } else { n };
        let t: String = w.chars().take(keep).collect();
        if !out.contains(&t) {
            out.push(t);
        }
        if out.len() == 16 {
            break;
        }
    }
    out
}

/// A search hit: a memory entry or a piece of a note.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// `memory` or `note`.
    pub kind: &'static str,
    /// The topic (`decisions`), or `note: <project> / <name>`.
    pub label: String,
    pub text: String,
    /// Relative to the workspace (memory) or the notes root (a note).
    pub file: String,
    /// Absolute, to open it.
    pub path: String,
    pub line: usize,
    /// How many of the query's words it holds, of `terms`.
    pub matched: usize,
    pub terms: usize,
    /// The entry, for a memory hit.
    pub entry: Option<Entry>,
}

fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max).collect();
    t.push('…');
    t
}

/// The best `k` hits for `query`, most words matched first (then the index's own
/// rank). Notes are searched too when `notes` is given.
pub fn search(
    conn: &Connection,
    workspace: &Path,
    notes: Option<&Path>,
    query: &str,
    k: usize,
) -> Result<Vec<Hit>, String> {
    let ts = terms(query);
    if ts.is_empty() || k == 0 {
        return Ok(Vec::new());
    }
    let expr = ts.iter().map(|t| format!("\"{}\"", t.replace('"', "\"\""))).collect::<Vec<_>>().join(" OR ");
    let mut hits: Vec<(usize, usize, Hit)> = Vec::new();
    let count = |body: &str| {
        let b = body.to_lowercase();
        ts.iter().filter(|t| b.contains(t.as_str())).count()
    };
    {
        let mut st = db(conn.prepare(
            "SELECT body, path, line, entry FROM memory_fts WHERE memory_fts MATCH ?1 ORDER BY rank LIMIT 200",
        ))?;
        let rows = db(st.query_map([&expr], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?))
        }))?;
        for (rank, row) in rows.enumerate() {
            let (body, file, line, json) = db(row)?;
            let Ok(entry) = serde_json::from_str::<Entry>(&json) else { continue };
            let hit = Hit {
                kind: "memory",
                label: entry.topic.clone(),
                text: clip(&entry.text, HIT_CHARS),
                path: workspace.join(&file).to_string_lossy().into_owned(),
                file,
                line: line as usize,
                matched: count(&body),
                terms: ts.len(),
                entry: Some(entry),
            };
            hits.push((hit.matched, rank, hit));
        }
    }
    if let Some(root) = notes {
        let mut st = db(conn.prepare(
            "SELECT body, path, line, label FROM notes_fts WHERE notes_fts MATCH ?1 ORDER BY rank LIMIT 200",
        ))?;
        let rows = db(st.query_map([&expr], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?))
        }))?;
        for (rank, row) in rows.enumerate() {
            let (body, file, line, label) = db(row)?;
            let text = body.split_once('\n').map_or(body.as_str(), |(_, rest)| rest);
            let hit = Hit {
                kind: "note",
                label,
                text: clip(text, HIT_CHARS),
                path: root.join(&file).to_string_lossy().into_owned(),
                file,
                line: line as usize,
                matched: count(&body),
                terms: ts.len(),
                entry: None,
            };
            hits.push((hit.matched, rank, hit));
        }
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    Ok(hits.into_iter().take(k).map(|h| h.2).collect())
}

/// The memory entries holding every word of `query`: what `forget` would remove.
pub fn matching(conn: &Connection, workspace: &Path, query: &str) -> Result<Vec<Entry>, String> {
    Ok(search(conn, workspace, None, query, 50)?
        .into_iter()
        .filter(|h| h.matched == h.terms)
        .filter_map(|h| h.entry)
        .take(20)
        .collect())
}

// ── git ──

/// A commit message's subject from an entry's fact.
pub fn subject(prefix: &str, fact: &str) -> String {
    format!("memory: {prefix}{}", clip(&one_line(fact), 72))
}

/// Commit `files` in `workspace` (made a repo first if it isn't one), in the
/// background git queue. Failures are logged; memory works without git.
pub fn commit(workspace: &Path, files: Vec<String>, message: String) {
    gitqueue::submit(workspace, move |repo| {
        if let Err(e) = commit_now(repo, &files, &message) {
            eprintln!("duck: committing memory failed: {e}");
        }
    });
}

/// Commit just `files`' changes, as Duck. False when there was nothing to commit.
pub fn commit_now(repo: &Path, files: &[String], message: &str) -> Result<bool, String> {
    if !repo.join(".git").exists() {
        gitqueue::run(repo, &["init", "-q", "-b", "main"])?;
    }
    // A path that's neither on disk nor tracked (made and undone before its first
    // commit) is nothing to git.
    let mut paths: Vec<&str> = Vec::new();
    for f in files {
        let tracked = || gitqueue::run(repo, &["ls-files", "--", f]).is_ok_and(|o| !o.trim().is_empty());
        if repo.join(f).exists() || tracked() {
            paths.push(f);
        }
    }
    if paths.is_empty() {
        return Ok(false);
    }
    let with = |head: &[&'static str]| -> Vec<&str> {
        let mut v: Vec<&str> = head.to_vec();
        v.extend(paths.iter().copied());
        v
    };
    gitqueue::run(repo, &with(&["add", "-A", "--"]))?;
    if gitqueue::output(repo, &with(&["diff", "--cached", "--quiet", "--"]))?.ok {
        return Ok(false);
    }
    let mut args = vec![
        "-c", "user.name=Duck", "-c", "user.email=duck@workbench.local", "-c", "commit.gpgsign=false",
        "commit", "-q", "--no-verify", "-m", message, "--",
    ];
    args.extend(paths.iter().copied());
    gitqueue::run(repo, &args)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::db::DuckDb;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wb-memory-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn entry(fact: &str, tags: Option<&str>) -> NewEntry {
        NewEntry {
            date: "2026-10-22".into(),
            fact: fact.into(),
            why: Some("one file, no server".into()),
            src: Some("thread:t1".into()),
            conf: Some("high".into()),
            tags: tags.map(Into::into),
        }
    }

    #[test]
    fn an_entry_reads_back_as_written() {
        let line = format_entry(&entry("Decided SQLite (not Postgres) for notes sync", Some("синхронизация заметок, sync")));
        assert_eq!(
            line,
            "2026-10-22 — Decided SQLite (not Postgres) for notes sync. Why: one file, no server (src: thread:t1, conf: high, tags: синхронизация заметок, sync)"
        );
        let text = format!("{}- {line}
", header("memory/decisions.md"));
        let e = &parse_file("memory/decisions.md", &text)[0];
        assert_eq!(e.topic, "decisions");
        assert_eq!(e.date.as_deref(), Some("2026-10-22"));
        assert_eq!(e.text, "Decided SQLite (not Postgres) for notes sync. Why: one file, no server");
        assert_eq!(e.src.as_deref(), Some("thread:t1"));
        assert_eq!(e.conf.as_deref(), Some("high"));
        assert_eq!(e.tags.as_deref(), Some("синхронизация заметок, sync"));
        assert_eq!(e.line, 5);
        // A bullet you wrote yourself is an entry too.
        let mine = parse_file("memory/people.md", "# People\n\n* Ana runs the design team\n");
        assert_eq!(mine[0].text, "Ana runs the design team");
        assert_eq!(mine[0].date, None);
    }

    #[test]
    fn topics_are_checked() {
        assert_eq!(topic_file("Decisions").unwrap(), "memory/decisions.md");
        assert_eq!(topic_file("projects/Hollow Game").unwrap(), "memory/projects/hollow-game.md");
        assert_eq!(topic_file("projects/Утка").unwrap(), "memory/projects/утка.md");
        assert!(topic_file("core").is_err());
        assert!(topic_file("../etc").is_err());
        assert!(check_file("memory/core.md").is_err());
        assert!(check_file("memory/../x.md").is_err());
        assert!(check_file("memory/projects/q.md").is_ok());
    }

    #[test]
    fn secrets_are_refused_and_plain_words_are_not() {
        for s in [
            "my key is sk-ant-api03-abcdefghijklmnop",
            "token: ghp_abcdefghijklmnopqrstuvwxyz0123",
            "the wifi password: hunter2",
            "пароль: qwerty123",
            "api_key = 9f8e7d6c5b4a",
            "use aZ9bX8cY7dW6eV5fU4gT3hS2iR1jQ0kP",
            "AKIAIOSFODNN7EXAMPLE is the deploy key",
        ] {
            assert!(secret_in(s).is_some(), "{s}");
        }
        for s in [
            "decided SQLite for notes sync",
            "keeps passwords in 1Password, never in notes",
            "the password manager is Bitwarden",
            "session 3f2b9c1e-8d4a-4f6b-9e2d-7a1c5b8e0f3d is the backend",
            "fixed in commit 9c986fe2b1a4c7d8e9f0a1b2c3d4e5f6a7b8c9d0",
            "branch duck/notes-sync-sqlite-decision-2026 holds it",
            "синхронизация заметок через SQLite",
        ] {
            assert_eq!(secret_in(s), None, "{s}");
        }
    }

    #[test]
    fn terms_survive_inflection() {
        assert_eq!(terms("Let's work on the notes sync"), vec!["note", "sync"]);
        assert_eq!(terms("синхронизация заметок"), vec!["синхронизац", "замет"]);
        assert!(terms("the and 2026").is_empty());
    }

    #[test]
    fn recall_finds_entries_and_notes_in_either_language_and_forget_removes_them() {
        let ws = temp("ws");
        let notes = temp("notes");
        std::fs::create_dir_all(notes.join("p1")).unwrap();
        std::fs::write(notes.join("p1/project.json"), r#"{"name":"Workbench"}"#).unwrap();
        std::fs::write(
            notes.join("p1/auth.md"),
            "# Auth\n\nThe auth refactor moves tokens into the keychain.\n\nOther things.\n",
        )
        .unwrap();
        let db = DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();

        let w = write(&ws, "decisions", &entry("Decided SQLite for notes sync", Some("синхронизация заметок"))).unwrap();
        let edit = w.edit.unwrap();
        assert_eq!(edit.before, None);
        // The same fact again isn't written twice.
        assert!(write(&ws, "decisions", &entry("decided sqlite for notes  sync", None)).unwrap().edit.is_none());
        write(&ws, "preferences", &entry("Prefers dark themes", None)).unwrap();
        assert!(write(&ws, "decisions", &entry("the key is sk-ant-api03-zzzzzzzzzzzz", None)).is_err());

        ensure(&conn, &ws, Some(&notes)).unwrap();
        let en = search(&conn, &ws, Some(&notes), "a week later: so, about the notes sync", 3).unwrap();
        assert_eq!(en[0].label, "decisions");
        assert_eq!(en[0].matched, 2);
        let ru = search(&conn, &ws, Some(&notes), "что там с синхронизацией заметок?", 3).unwrap();
        assert_eq!(ru[0].kind, "memory");
        assert!(ru[0].text.starts_with("Decided SQLite"));
        let note = search(&conn, &ws, Some(&notes), "what did I write about the auth refactor", 3).unwrap();
        assert_eq!(note[0].kind, "note");
        assert_eq!(note[0].label, "note: Workbench / auth");
        assert!(note[0].text.contains("keychain"));

        // An edit of yours is picked up by the next search (the watcher, or the
        // rescan without one).
        let prefs = ws.join("memory/preferences.md");
        let t = std::fs::read_to_string(&prefs).unwrap();
        std::fs::write(&prefs, t.replace("dark themes", "light themes in the morning")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        ensure(&conn, &ws, Some(&notes)).unwrap();
        assert_eq!(search(&conn, &ws, None, "morning themes", 3).unwrap()[0].matched, 2);

        let found = matching(&conn, &ws, "notes sync").unwrap();
        assert_eq!(found.len(), 1);
        let items: Vec<Forget> = found.iter().map(|e| Forget { file: e.file.clone(), raw: e.raw.clone() }).collect();
        let edits = forget(&ws, &items).unwrap();
        assert_eq!(edits.len(), 1);
        assert!(!edits[0].after.as_deref().unwrap().contains("SQLite"));
        reindex(&conn, &ws, &[edits[0].file.clone()]).unwrap();
        assert!(search(&conn, &ws, None, "notes sync", 3).unwrap().is_empty());

        // The undo puts it back, only over what the forget left.
        assert!(restore(&ws, &edits[0].file, edits[0].before.as_deref(), Some("something else")).is_err());
        restore(&ws, &edits[0].file, edits[0].before.as_deref(), edits[0].after.as_deref()).unwrap();
        assert_eq!(list(&ws).unwrap().len(), 2);
    }

    #[test]
    fn a_consolidation_merges_retires_and_journals_in_one_edit_per_file() {
        let ws = temp("apply");
        let a = write(&ws, "decisions", &entry("Use Postgres for notes sync", None)).unwrap().entry;
        let b = write(&ws, "decisions", &entry("Notes sync will use Postgres", None)).unwrap().entry;
        let old = write(&ws, "goals", &entry("Ship the beta by October 1", None)).unwrap().entry;
        let plan = Apply {
            remove: vec![
                Forget { file: a.file.clone(), raw: a.raw.clone() },
                Forget { file: b.file.clone(), raw: b.raw.clone() },
                Forget { file: old.file.clone(), raw: old.raw.clone() },
            ],
            add: vec![
                Add { topic: "decisions".into(), entry: entry("Notes sync uses Postgres", Some("синхронизация заметок")) },
                Add { topic: "preferences".into(), entry: entry("token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", None) },
                Add { topic: "nonsense".into(), entry: entry("anything", None) },
            ],
            journal: Some(Journal { date: "2026-10-22".into(), text: "Worked on the notes sync.\nDecided Postgres.".into() }),
        };
        let done = apply(&ws, &plan).unwrap();
        let files: Vec<&str> = done.edits.iter().map(|e| e.file.as_str()).collect();
        assert_eq!(files, ["memory/decisions.md", "memory/goals.md", "memory/journal/2026-10.md"]);
        assert_eq!(done.skipped.len(), 2, "{:?}", done.skipped);
        let left: Vec<String> = list(&ws).unwrap().into_iter().map(|e| format!("{}: {}", e.topic, e.text)).collect();
        assert_eq!(
            left,
            [
                "decisions: Notes sync uses Postgres. Why: one file, no server",
                "journal/2026-10: Worked on the notes sync. Decided Postgres.",
            ]
        );
        let journal = std::fs::read_to_string(ws.join("memory/journal/2026-10.md")).unwrap();
        assert!(journal.starts_with("# Journal, 2026-10\n"), "{journal}");
        assert!(journal.ends_with("- 2026-10-22 — Worked on the notes sync. Decided Postgres. (src: tidy)\n"), "{journal}");
        // The edit runs from before the run to after it.
        let d = &done.edits[0];
        assert!(d.before.as_deref().unwrap().contains("Use Postgres for notes sync"));
        assert!(!d.after.as_deref().unwrap().contains("Use Postgres for notes sync"));
        assert!(journal_file("2026-10-22x").is_err());
    }

    #[test]
    fn the_recall_log_counts_hits_used_and_misses() {
        let d = DuckDb::open_in_memory().unwrap();
        let conn = d.conn.lock().unwrap();
        let row = |at: i64, shown: i64, used: i64, self_recall: bool| RecallRow {
            at,
            thread_id: "t".into(),
            query: "so, about the notes sync".into(),
            candidates: shown + 1,
            shown,
            used,
            self_recall,
            hits: serde_json::json!([]),
        };
        let day = 86_400_000;
        log_recall(&conn, &row(100 * day, 2, 1, false)).unwrap();
        log_recall(&conn, &row(100 * day + 1, 0, 0, true)).unwrap();
        log_recall(&conn, &row(100 * day + 2, 1, 1, true)).unwrap();
        log_recall(&conn, &row(100 * day + 3, 0, 0, false)).unwrap();
        assert_eq!(
            recall_stats(&conn, 0).unwrap(),
            RecallStats { searched: 4, with_hits: 2, shown: 3, used: 2, self_recall: 2, missed: 1 }
        );
        assert_eq!(recall_stats(&conn, 100 * day + 2).unwrap().searched, 2);
        // Rows past the keep are pruned by the next write.
        log_recall(&conn, &row(200 * day, 0, 0, false)).unwrap();
        assert_eq!(recall_stats(&conn, 0).unwrap().searched, 1);
    }

    #[test]
    fn each_change_is_one_commit() {
        let ws = temp("git");
        let w = write(&ws, "decisions", &entry("Decided SQLite for notes sync", None)).unwrap();
        let file = w.edit.unwrap().file;
        std::fs::write(ws.join("unrelated.txt"), "not memory").unwrap();
        assert!(commit_now(&ws, &[file.clone()], "memory: decided SQLite for notes sync").unwrap());
        // Nothing changed: no empty commit.
        assert!(!commit_now(&ws, &[file.clone()], "memory: again").unwrap());
        let items = vec![Forget { file: file.clone(), raw: parse_file(&file, &std::fs::read_to_string(ws.join(&file)).unwrap())[0].raw.clone() }];
        forget(&ws, &items).unwrap();
        assert!(commit_now(&ws, &[file.clone()], "memory: forgot SQLite").unwrap());
        let log = gitqueue::run(&ws, &["log", "--format=%an %s"]).unwrap();
        assert_eq!(log.lines().collect::<Vec<_>>(), ["Duck memory: forgot SQLite", "Duck memory: decided SQLite for notes sync"]);
        // Only the memory file was committed.
        let tracked = gitqueue::run(&ws, &["ls-files"]).unwrap();
        assert_eq!(tracked.trim(), file);
        // A file made and removed before any commit is nothing to commit.
        assert!(!commit_now(&ws, &["memory/goals.md".into()], "memory: x").unwrap());
    }
}
