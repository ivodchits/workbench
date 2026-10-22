//! Duck's skills (step S2): `skills/<name>/SKILL.md` in Duck's workspace (the
//! Duck repo, so they're versioned with its memory and config), read for the
//! engine and written by `draft_skill` once you allow it.
//!
//! - A skill is a folder with a `SKILL.md`: frontmatter (`name`, `description`,
//!   and Duck's own `tools`, `mode`, `title`, `effort`, `pauses`) and a body, the
//!   instructions `load_skill` returns. This module only reads the fields; what
//!   they mean is the engine's (`src/assistant/skills.ts`).
//! - The list is cached, and a watcher on `skills/` marks it stale on any change,
//!   so a hand-edited or new file is read on the next turn without a restart.
//! - A write goes over the text it was read as (`expected`), like the config files,
//!   and is committed in the workspace's repo by the caller.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::skills::{frontmatter, is_kebab_case};

pub const DIR: &str = "skills";
const FILE: &str = "SKILL.md";
const MAX_BYTES: usize = 64 * 1024;
const MAX_SKILLS: usize = 200;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    /// The folder's name: the skill's name.
    pub name: String,
    /// The `SKILL.md`'s absolute path (what the editor opens).
    pub path: String,
    /// `skills/<name>/SKILL.md`, the path in the workspace.
    pub rel: String,
    /// The frontmatter's `key: value` lines, in file order.
    pub fields: Vec<(String, String)>,
    pub body: String,
    /// The whole file, as read (what a write goes over).
    pub text: String,
    /// Why the file can't be used as it is; empty when it can.
    pub problems: Vec<String>,
}

/// `skills/<name>/SKILL.md` for a name that can be a folder; an error otherwise.
pub fn check(name: &str) -> Result<String, String> {
    if is_kebab_case(name) && name.len() <= 64 {
        Ok(format!("{DIR}/{name}/{FILE}"))
    } else {
        Err(format!("a skill's name is lowercase words joined by hyphens (morning-briefing), at most 64 characters: {name}"))
    }
}

fn read_text(p: &Path) -> Result<Option<String>, String> {
    match std::fs::read(p) {
        Ok(b) if b.len() > MAX_BYTES => Err(format!("{} is larger than 64 KB", p.display())),
        Ok(b) => Ok(Some(String::from_utf8_lossy(&b).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", p.display())),
    }
}

fn read_one(dir: &Path, name: &str) -> Option<SkillFile> {
    let p = dir.join(name).join(FILE);
    let mut problems = Vec::new();
    let text = match read_text(&p) {
        Ok(Some(t)) => t,
        Ok(None) => return None,
        Err(e) => {
            problems.push(e);
            String::new()
        }
    };
    if !is_kebab_case(name) {
        problems.push("the folder's name isn't lowercase words joined by hyphens".into());
    }
    let has_frontmatter = frontmatter(&text).is_some();
    let (fields, body) = match frontmatter(&text) {
        Some((f, b)) => (f, b.trim().to_owned()),
        None => {
            if problems.is_empty() {
                problems.push("it doesn't open with a --- frontmatter block".into());
            }
            (Vec::new(), String::new())
        }
    };
    let get = |k: &str| fields.iter().find(|(f, _)| f == k).map(|(_, v)| v.as_str());
    match get("name") {
        Some(n) if n != name => problems.push(format!("its name ({n}) isn't its folder's ({name})")),
        _ => {}
    }
    if has_frontmatter && get("description").is_none_or(|d| d.trim().is_empty()) {
        problems.push("it has no description (what Duck matches a request against)".into());
    }
    Some(SkillFile {
        name: name.to_owned(),
        path: p.to_string_lossy().into_owned(),
        rel: format!("{DIR}/{name}/{FILE}"),
        fields,
        body,
        text,
        problems,
    })
}

fn scan(dir: &Path) -> Vec<SkillFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort();
    names.iter().filter_map(|n| read_one(dir, n)).take(MAX_SKILLS).collect()
}

struct Cache {
    root: PathBuf,
    dirty: Arc<AtomicBool>,
    _watcher: Option<RecommendedWatcher>,
    list: Vec<SkillFile>,
}

fn cache() -> &'static Mutex<Option<Cache>> {
    static C: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();
    C.get_or_init(Mutex::default)
}

fn watch(dir: &Path) -> Cache {
    let dirty = Arc::new(AtomicBool::new(true));
    let flag = dirty.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            flag.store(true, Ordering::SeqCst);
        }
    })
    .and_then(|mut w| w.watch(dir, RecursiveMode::Recursive).map(|()| w));
    if let Err(e) = &watcher {
        eprintln!("duck: no watcher on {}: {e}", dir.display());
    }
    Cache { root: dir.to_path_buf(), dirty, _watcher: watcher.ok(), list: Vec::new() }
}

/// Every skill in `<ws>/skills/`, by name: read again only after a change.
pub fn list(ws: &Path) -> Result<Vec<SkillFile>, String> {
    let dir = ws.join(DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let mut c = cache().lock().unwrap_or_else(|e| e.into_inner());
    if c.as_ref().is_none_or(|c| c.root != dir) {
        *c = Some(watch(&dir));
    }
    let c = c.as_mut().expect("just set");
    if c.dirty.swap(false, Ordering::SeqCst) || c._watcher.is_none() {
        c.list = scan(&dir);
    }
    Ok(c.list.clone())
}

/// Write skill `name`'s `SKILL.md` over the text it was read as (`expected`,
/// `None`: there was none). Returns the path to commit.
pub fn write(ws: &Path, name: &str, text: &str, expected: Option<&str>) -> Result<String, String> {
    let rel = check(name)?;
    if text.len() > MAX_BYTES {
        return Err(format!("skills/{name}/SKILL.md would be larger than 64 KB"));
    }
    let p = ws.join(&rel);
    if read_text(&p)?.as_deref() != expected {
        return Err(format!("stale: {rel} changed since it was read"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(&p, text).map_err(|e| format!("cannot write {}: {e}", p.display()))?;
    // Read again at once, before the watcher's event arrives.
    if let Some(c) = cache().lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        c.dirty.store(true, Ordering::SeqCst);
    }
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wb-skills-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const BRIEFING: &str = "---\nname: morning-briefing\ndescription: \"Good morning: the day's plan\"\ntools: [get_time, list_sessions]\n---\n\nSay good morning.\n";

    #[test]
    fn skills_are_read_with_their_fields_and_problems() {
        let ws = temp("read");
        assert_eq!(list(&ws).unwrap(), vec![]);
        assert_eq!(write(&ws, "morning-briefing", BRIEFING, None).unwrap(), "skills/morning-briefing/SKILL.md");
        let dir = ws.join(DIR);
        std::fs::create_dir_all(dir.join("Bad Name")).unwrap();
        std::fs::write(dir.join("Bad Name").join(FILE), "---\nname: x\n---\n").unwrap();
        std::fs::create_dir_all(dir.join("plain")).unwrap();
        std::fs::write(dir.join("plain").join(FILE), "no frontmatter").unwrap();
        // A folder without a SKILL.md isn't a skill.
        std::fs::create_dir_all(dir.join("empty")).unwrap();

        let all = scan(&dir);
        assert_eq!(all.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Bad Name", "morning-briefing", "plain"]);
        let b = &all[1];
        assert_eq!(b.problems, Vec::<String>::new());
        assert_eq!(b.body, "Say good morning.");
        assert_eq!(b.text, BRIEFING);
        assert!(b.fields.contains(&("description".into(), "Good morning: the day's plan".into())));
        assert!(b.fields.contains(&("tools".into(), "[get_time, list_sessions]".into())));
        assert_eq!(all[0].problems.len(), 3, "{:?}", all[0].problems);
        assert_eq!(all[2].problems, ["it doesn't open with a --- frontmatter block"]);
    }

    #[test]
    fn a_write_goes_over_what_was_read_and_is_listed_at_once() {
        let ws = temp("write");
        write(&ws, "interviewer", "---\nname: interviewer\ndescription: d\nmode: interviewer\n---\nAsk.", None).unwrap();
        assert_eq!(list(&ws).unwrap().len(), 1);
        let stale = write(&ws, "interviewer", "x", None).unwrap_err();
        assert!(stale.starts_with("stale:"), "{stale}");
        let before = list(&ws).unwrap()[0].text.clone();
        write(&ws, "interviewer", "---\nname: interviewer\ndescription: e\n---\nAsk more.", Some(&before)).unwrap();
        assert_eq!(list(&ws).unwrap()[0].body, "Ask more.");
        assert!(write(&ws, "../config", "x", None).is_err());
        assert!(write(&ws, "Morning", "x", None).is_err());
    }
}
