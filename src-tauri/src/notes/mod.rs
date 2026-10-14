//! Project notes (step N1): plain markdown files, one folder per project, under the
//! app data dir (`notes/<projectId>/<noteId>.md`; `notes.dev/` for a debug build,
//! like the database). Private to this machine, untouched by branch switches and
//! worktrees, never in `git status`, and the same for local and SSH projects.
//!
//! Notes go through this module rather than the generic `fs` commands, so the
//! desktop and the phone (step R8, through the remote server) share one set of
//! rules:
//! - A note is named by project id and note id, never by a path. The note id is
//!   the file's stem — the name shown in the list — and is checked so it can never
//!   leave its folder.
//! - Every read returns the note's revision (a hash of its bytes) and every write
//!   says which revision it was based on. A write based on a stale revision is
//!   refused (`STALE`), so two writers can't silently overwrite each other.
//! - Every change emits `notes-changed { projectId }`.
//!
//! The file operations take the notes root explicitly so the tests can run them in
//! a temp dir; the Tauri commands resolve the root and emit the event.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The event every change emits, with the project id.
pub const EVENT: &str = "notes-changed";

/// A refused write starts with this, so a caller can tell it from other errors.
pub const STALE: &str = "stale:";

/// The largest note this module reads or writes. Notes are prose, not data dumps.
const MAX_NOTE_BYTES: usize = 2 * 1024 * 1024;

/// Longest note name, in characters.
const MAX_NAME: usize = 120;

/// One writer at a time: a write checks the revision, then replaces the file, and
/// nothing may happen in between.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// A note in a project's list.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    /// The note's name, which is also its id.
    pub id: String,
    /// Last modified, ms since the epoch.
    pub modified: u64,
    pub size: u64,
}

/// A note's text and the revision it was read at.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub content: String,
    pub revision: String,
    /// The file on disk, for an `@path` reference. Never taken back as input.
    pub path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Changed {
    project_id: String,
}

/// The notes root for this build.
pub fn notes_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(if cfg!(debug_assertions) { "notes.dev" } else { "notes" }))
}

/// FNV-1a over the bytes: a revision that is the same for the same content in any
/// process, and cheap at note sizes.
pub fn revision_of(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Project ids are UUIDs; anything that could name another folder is refused.
fn check_project(project_id: &str) -> Result<(), String> {
    let ok = !project_id.is_empty()
        && project_id.len() <= 64
        && project_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("not a project id: {project_id}"))
    }
}

/// A note name must be a plain file name on every platform: no separators or
/// characters Windows forbids, no leading or trailing dot or space, not a reserved
/// device name, not empty, not too long.
pub fn check_name(name: &str) -> Result<(), String> {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if name.trim().is_empty() {
        return Err("a note needs a name".into());
    }
    if name.chars().count() > MAX_NAME {
        return Err(format!("a note name is at most {MAX_NAME} characters"));
    }
    if let Some(c) = name.chars().find(|c| r#"<>:"/\|?*"#.contains(*c) || c.is_control()) {
        return Err(format!("a note name can't contain {c:?}"));
    }
    if name.starts_with(['.', ' ']) || name.ends_with(['.', ' ']) {
        return Err("a note name can't start or end with a dot or a space".into());
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(format!("\"{name}\" is a name Windows reserves"));
    }
    Ok(())
}

fn note_path(root: &Path, project_id: &str, id: &str) -> Result<PathBuf, String> {
    check_project(project_id)?;
    check_name(id)?;
    Ok(root.join(project_id).join(format!("{id}.md")))
}

fn read_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "this note no longer exists".to_string(),
        _ => format!("cannot read the note: {e}"),
    })?;
    if bytes.len() > MAX_NOTE_BYTES {
        return Err("this note is too large to open".into());
    }
    Ok(bytes)
}

/// The project's notes, most recently changed first.
pub fn list(root: &Path, project_id: &str) -> Result<Vec<NoteMeta>, String> {
    check_project(project_id)?;
    let dir = root.join(project_id);
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("cannot list notes: {e}")),
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        // A file someone dropped in by hand with a name we wouldn't make is left
        // alone rather than offered with an id the other commands would refuse.
        if check_name(&id).is_err() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        out.push(NoteMeta { id, modified, size: meta.len() });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

pub fn read(root: &Path, project_id: &str, id: &str) -> Result<Note, String> {
    let path = note_path(root, project_id, id)?;
    let bytes = read_bytes(&path)?;
    let revision = revision_of(&bytes);
    let content = String::from_utf8(bytes).map_err(|_| "this note isn't UTF-8 text".to_string())?;
    Ok(Note { id: id.to_string(), content, revision, path: path.to_string_lossy().into_owned() })
}

/// Replace a note's text. `base` is the revision the text was edited from: when the
/// file no longer has it, nothing is written and the error starts with `STALE`.
/// `None` writes regardless (an explicit overwrite). Returns the new revision.
pub fn write(root: &Path, project_id: &str, id: &str, content: &str, base: Option<&str>) -> Result<String, String> {
    if content.len() > MAX_NOTE_BYTES {
        return Err("this note is too large to save".into());
    }
    let path = note_path(root, project_id, id)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(base) = base {
        match std::fs::read(&path) {
            Ok(bytes) if revision_of(&bytes) != base => {
                return Err(format!("{STALE} the note changed since it was opened"));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(format!("{STALE} the note was deleted"));
            }
            Err(e) => return Err(format!("cannot read the note: {e}")),
        }
    }
    replace(&path, content.as_bytes())?;
    Ok(revision_of(content.as_bytes()))
}

/// Write through a temp file and a rename, so a reader never sees half a note.
fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no folder for the note")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create the notes folder: {e}"))?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("cannot save the note: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot save the note: {e}")
    })
}

/// Make an empty note. Refused when one by that name exists.
pub fn create(root: &Path, project_id: &str, id: &str) -> Result<Note, String> {
    let path = note_path(root, project_id, id)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if path.exists() {
        return Err(format!("there is already a note called \"{id}\""));
    }
    replace(&path, b"")?;
    Ok(Note { id: id.to_string(), content: String::new(), revision: revision_of(b""), path: path.to_string_lossy().into_owned() })
}

/// Make a note holding `content`, named `name` or, when that is taken, the first
/// free "name 2", "name 3", … (the phone's quick capture names a note after its
/// first line, which may repeat).
pub fn create_unique(root: &Path, project_id: &str, name: &str, content: &str) -> Result<Note, String> {
    if content.len() > MAX_NOTE_BYTES {
        return Err("this note is too large to save".into());
    }
    check_name(name)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    for n in 1..1000 {
        let id = if n == 1 { name.to_string() } else { format!("{name} {n}") };
        let path = note_path(root, project_id, &id)?;
        if path.exists() {
            continue;
        }
        replace(&path, content.as_bytes())?;
        return Ok(Note {
            id,
            content: content.to_string(),
            revision: revision_of(content.as_bytes()),
            path: path.to_string_lossy().into_owned(),
        });
    }
    Err(format!("too many notes called \"{name}\""))
}

/// Rename a note. Refused when another note has the new name; a change of case
/// alone is allowed (on a case-insensitive disk it is the same file).
pub fn rename(root: &Path, project_id: &str, id: &str, to: &str) -> Result<(), String> {
    let from = note_path(root, project_id, id)?;
    let dest = note_path(root, project_id, to)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !from.exists() {
        return Err("this note no longer exists".into());
    }
    if id != to && !id.eq_ignore_ascii_case(to) && dest.exists() {
        return Err(format!("there is already a note called \"{to}\""));
    }
    std::fs::rename(&from, &dest).map_err(|e| format!("cannot rename the note: {e}"))
}

pub fn delete(root: &Path, project_id: &str, id: &str) -> Result<(), String> {
    let path = note_path(root, project_id, id)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot delete the note: {e}")),
    }
}

/// Tell every view that a project's notes changed: the desktop panels through the
/// event, connected phones through the remote socket (step R8).
pub fn notify(app: &AppHandle, project_id: &str) {
    let _ = app.emit(EVENT, Changed { project_id: project_id.to_string() });
    crate::remote::push_notes_changed(app, project_id);
}

// --- commands -------------------------------------------------------------------

#[tauri::command]
pub fn notes_list(app: AppHandle, project_id: String) -> Result<Vec<NoteMeta>, String> {
    list(&notes_root(&app)?, &project_id)
}

#[tauri::command]
pub fn notes_read(app: AppHandle, project_id: String, id: String) -> Result<Note, String> {
    read(&notes_root(&app)?, &project_id, &id)
}

#[tauri::command]
pub fn notes_write(
    app: AppHandle,
    project_id: String,
    id: String,
    content: String,
    base_revision: Option<String>,
) -> Result<String, String> {
    let revision = write(&notes_root(&app)?, &project_id, &id, &content, base_revision.as_deref())?;
    notify(&app, &project_id);
    Ok(revision)
}

#[tauri::command]
pub fn notes_create(app: AppHandle, project_id: String, id: String) -> Result<Note, String> {
    let note = create(&notes_root(&app)?, &project_id, &id)?;
    notify(&app, &project_id);
    Ok(note)
}

#[tauri::command]
pub fn notes_rename(app: AppHandle, project_id: String, id: String, to: String) -> Result<(), String> {
    rename(&notes_root(&app)?, &project_id, &id, &to)?;
    notify(&app, &project_id);
    Ok(())
}

#[tauri::command]
pub fn notes_delete(app: AppHandle, project_id: String, id: String) -> Result<(), String> {
    delete(&notes_root(&app)?, &project_id, &id)?;
    notify(&app, &project_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "7f1e2d3c-0000-4000-8000-000000000001";

    fn root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wb-notes-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn create_write_read_list() {
        let r = root();
        assert_eq!(list(&r, P).unwrap(), vec![]);
        let note = create(&r, P, "ideas").unwrap();
        assert_eq!(note.content, "");
        let rev = write(&r, P, "ideas", "# Ideas\n", Some(&note.revision)).unwrap();
        let back = read(&r, P, "ideas").unwrap();
        assert_eq!(back.content, "# Ideas\n");
        assert_eq!(back.revision, rev);
        assert_eq!(list(&r, P).unwrap().iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["ideas"]);
        assert!(create(&r, P, "ideas").is_err(), "a second note by the same name");
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn a_stale_write_is_refused() {
        let r = root();
        let note = create(&r, P, "plan").unwrap();
        // Someone else (the phone) saves first.
        write(&r, P, "plan", "theirs", Some(&note.revision)).unwrap();
        let err = write(&r, P, "plan", "mine", Some(&note.revision)).unwrap_err();
        assert!(err.starts_with(STALE), "{err}");
        assert_eq!(read(&r, P, "plan").unwrap().content, "theirs");
        // An explicit overwrite goes through.
        write(&r, P, "plan", "mine", None).unwrap();
        assert_eq!(read(&r, P, "plan").unwrap().content, "mine");
        // A note deleted meanwhile is stale too, not silently recreated.
        let rev = read(&r, P, "plan").unwrap().revision;
        delete(&r, P, "plan").unwrap();
        assert!(write(&r, P, "plan", "again", Some(&rev)).unwrap_err().starts_with(STALE));
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn create_unique_picks_a_free_name() {
        let r = root();
        assert_eq!(create_unique(&r, P, "idea", "one").unwrap().id, "idea");
        assert_eq!(create_unique(&r, P, "idea", "two").unwrap().id, "idea 2");
        assert_eq!(read(&r, P, "idea 2").unwrap().content, "two");
        assert!(create_unique(&r, P, "../x", "").is_err());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn rename_and_delete() {
        let r = root();
        create(&r, P, "a").unwrap();
        create(&r, P, "b").unwrap();
        assert!(rename(&r, P, "a", "b").is_err(), "onto another note");
        rename(&r, P, "a", "A").unwrap(); // case only
        rename(&r, P, "A", "c").unwrap();
        let ids: Vec<_> = list(&r, P).unwrap().into_iter().map(|n| n.id).collect();
        assert!(ids.contains(&"c".to_string()) && ids.contains(&"b".to_string()) && ids.len() == 2);
        delete(&r, P, "c").unwrap();
        delete(&r, P, "c").unwrap(); // already gone: fine
        assert_eq!(list(&r, P).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn names_and_projects_cannot_escape() {
        for bad in ["", " ", "../x", "a/b", "a\\b", "c:", ".hidden", "trail.", "CON", "nul.txt", "a*b"] {
            assert!(check_name(bad).is_err(), "{bad:?} should be refused");
        }
        for good in ["ideas", "Plan for v2", "2026-10-14 standup", "naïve café"] {
            assert!(check_name(good).is_ok(), "{good:?} should be allowed");
        }
        let r = root();
        assert!(list(&r, "../etc").is_err());
        assert!(read(&r, "a/b", "x").is_err());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn revisions_follow_content() {
        assert_eq!(revision_of(b"x"), revision_of(b"x"));
        assert_ne!(revision_of(b"x"), revision_of(b"y"));
        assert_eq!(revision_of(b"").len(), 16);
    }
}
