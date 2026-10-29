//! In-game saves shared with RetroArch (office plan O5.3e): a Library game's battery
//! save (`.srm`) lives where RetroArch keeps it on this PC, under the name RetroArch
//! gives it, so the same file loads in RetroArch on Steam, and on the phone through
//! Syncthing.
//!
//! - The folder is RetroArch's own, read from its `retroarch.cfg` (Steam's install
//!   first, then `%APPDATA%\RetroArch`): `savefile_directory`, put in the game's folder
//!   when that's `default` or `savefiles_in_content_dir` is on, then sorted into the
//!   content's folder name and the core's name as `sort_savefiles_by_content_enable`
//!   and `sort_savefiles_enable` say. A folder chosen by hand (`office.saves` in the app
//!   DB) takes the place of `savefile_directory`, still sorted as the config says. With
//!   neither, saves stay in the app-data dir (`office-saves/`, sorted by core).
//! - The name is the game's own without its extension, the image inside a zip for a
//!   zipped one, as RetroArch names it: `Sunset Riders (USA).srm`.
//! - `GET /office/api/library/save?path=` — the save, with its version (a hash of it,
//!   `none` for no file) in `x-save-version`.
//! - `PUT /office/api/library/save?path=` — writes it, only over the version the page
//!   last had (`x-save-base`); otherwise 409 with the version on disk, so a save
//!   Syncthing brought meanwhile is never overwritten unasked. With `x-save-force` it
//!   writes anyway, keeping the copy on disk as a backup first.
//! - `PUT /office/api/library/save/backup?path=` — keeps the page's copy as a backup
//!   (when the one on disk is taken instead).
//! - `POST /office/api/library/saves` — choose the folder by hand, in a dialog on this PC.
//!
//! Backups go to the app-data dir (`office-save-backups/`), never into the synced
//! folder.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use super::super::server::bearer;
use super::super::RemoteState;
use super::library::{folder, inside, listing, rom_name, system_of_file, GameQuery};

const SAVES_KEY: &str = "office.saves";
const OWN_DIR: &str = "office-saves";
const BACKUP_DIR: &str = "office-save-backups";
/// The largest save taken (a GBA's flash or a PlayStation memory card is 128 KB; this
/// is plenty).
pub(super) const SAVE_MAX: usize = 1024 * 1024;
const VERSION: &str = "x-save-version";

/// The folder RetroArch names a core's saves by (its `library_name`), by system.
fn core_dir(system: &str) -> &'static str {
    match system {
        "md" => "Genesis Plus GX",
        "nes" => "FCEUmm",
        "snes" => "Snes9x",
        "gb" => "Gambatte",
        "gba" => "mGBA",
        "ps" => "PCSX-ReARMed",
        _ => "Other",
    }
}

/// `key = "value"` lines, as RetroArch writes its config.
fn read_cfg(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let (k, v) = line.split_once('=')?;
            let v = v.trim();
            let v = v.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(v);
            Some((k.trim().to_string(), v.to_string()))
        })
        .collect()
}

/// Where saves go, and how they're sorted.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SaveDirs {
    /// The saves folder; None when saves go beside each game.
    base: Option<PathBuf>,
    by_content: bool,
    by_core: bool,
    /// "retroarch", "hand" or "office".
    from: &'static str,
}

/// The saves folder `cfg` (RetroArch's, in `ra_dir`) names.
fn dirs_of(ra_dir: &Path, cfg: &HashMap<String, String>) -> SaveDirs {
    let on = |k: &str| cfg.get(k).is_some_and(|v| v == "true");
    let dir = cfg.get("savefile_directory").map(String::as_str).unwrap_or("default");
    let base = if on("savefiles_in_content_dir") || dir.is_empty() || dir == "default" {
        None
    } else if let Some(rest) = dir.strip_prefix(':') {
        // `:` is RetroArch's own folder.
        Some(ra_dir.join(rest.trim_start_matches(['\\', '/'])))
    } else {
        Some(PathBuf::from(dir))
    };
    SaveDirs { base, by_content: on("sort_savefiles_by_content_enable"), by_core: on("sort_savefiles_enable"), from: "retroarch" }
}

/// RetroArch's config on this PC: Steam's install, else a standalone one's.
pub(super) fn retroarch() -> Option<(PathBuf, HashMap<String, String>)> {
    let mut dirs: Vec<PathBuf> = crate::assistant::steam::steam_root()
        .map(|root| crate::assistant::steam::libraries(&root).into_iter().map(|l| l.join("steamapps").join("common").join("RetroArch")).collect())
        .unwrap_or_default();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("RetroArch"));
    }
    dirs.into_iter().find_map(|d| {
        let text = std::fs::read_to_string(d.join("retroarch.cfg")).ok()?;
        Some((d, read_cfg(&text)))
    })
}

fn hand_folder(state: &RemoteState) -> Option<PathBuf> {
    let saved = state.app.state::<crate::db::Db>().meta_get(SAVES_KEY).ok()??;
    let v: serde_json::Value = serde_json::from_str(&saved).ok()?;
    v.get("folder")?.as_str().map(PathBuf::from)
}

/// Where this PC's saves go: by hand, else RetroArch's, else the office's own.
pub(super) fn save_dirs(state: &RemoteState) -> Option<SaveDirs> {
    let found = retroarch().map(|(d, cfg)| dirs_of(&d, &cfg));
    if let Some(base) = hand_folder(state) {
        let (by_content, by_core) = found.as_ref().map_or((false, true), |f| (f.by_content, f.by_core));
        return Some(SaveDirs { base: Some(base), by_content, by_core, from: "hand" });
    }
    if found.is_some() {
        return found;
    }
    let own = state.app.path().app_data_dir().ok()?.join(OWN_DIR);
    Some(SaveDirs { base: Some(own), by_content: false, by_core: true, from: "office" })
}

/// The listing's account of where saves go: the folder, or none for beside each game.
pub(super) fn shown(dirs: &SaveDirs) -> serde_json::Value {
    json!({ "folder": dirs.base.as_ref().map(|b| b.to_string_lossy()), "from": dirs.from })
}

/// The save file for `content` (a game's image, `inner` its name inside a zip) of
/// `system`, as RetroArch would name it.
fn save_file(dirs: &SaveDirs, content: &Path, inner: &str, system: &str) -> Option<PathBuf> {
    let beside = content.parent()?;
    let mut dir = match &dirs.base {
        None => beside.to_path_buf(),
        Some(base) => {
            let mut dir = base.clone();
            if dirs.by_content {
                dir.push(beside.file_name()?);
            }
            dir
        }
    };
    if dirs.base.is_some() && dirs.by_core {
        dir.push(core_dir(system));
    }
    let stem = Path::new(inner).file_stem()?.to_string_lossy().into_owned();
    Some(dir.join(format!("{stem}.srm")))
}

/// A save's version: a hash of its bytes; `none` for no file.
fn version(bytes: Option<&[u8]>) -> String {
    bytes.map_or_else(|| "none".to_string(), |b| Sha256::digest(b)[..8].iter().map(|x| format!("{x:02x}")).collect())
}

/// Writes `bytes` whole or not at all: aside, then moved over the old file.
fn write_whole(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut part = file.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    std::fs::write(&part, bytes)?;
    std::fs::rename(&part, file)
}

/// Keeps `bytes` as a backup of `file`, named with the time: `<name>.<secs>.<who>.srm`.
fn back_up(backups: &Path, file: &Path, who: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let to = backups.join(format!("{stem}.{secs}.{who}.srm"));
    write_whole(&to, bytes)?;
    Ok(to)
}

/// What `?path=` names: the save file for that Library game.
async fn locate(state: &Arc<RemoteState>, rel: String) -> Result<PathBuf, StatusCode> {
    let root = folder(state).ok_or(StatusCode::NOT_FOUND)?;
    let dirs = save_dirs(state).ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::task::spawn_blocking(move || {
        let content = inside(&root, &rel).ok_or(StatusCode::NOT_FOUND)?;
        let (inner, system) = rom_name(&content).zip(system_of_file(&content)).ok_or(StatusCode::NOT_FOUND)?;
        save_file(&dirs, &content, &inner, system).ok_or(StatusCode::NOT_FOUND)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

fn with_version(code: StatusCode, v: &str, body: Vec<u8>) -> Response {
    let mut res = (code, [(header::CACHE_CONTROL, "no-store")], body).into_response();
    if let Ok(v) = HeaderValue::from_str(v) {
        res.headers_mut().insert(VERSION, v);
    }
    res
}

pub(super) async fn get_save(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Query(q): Query<GameQuery>) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let file = match locate(&state, q.path).await {
        Ok(f) => f,
        Err(code) => return code.into_response(),
    };
    match std::fs::read(&file) {
        Ok(bytes) => with_version(StatusCode::OK, &version(Some(&bytes)), bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => with_version(StatusCode::OK, "none", Vec::new()),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// What a write did.
#[derive(Debug, PartialEq)]
enum Put {
    Written(String),
    /// The file on disk isn't the version the page had: its version.
    Changed(String),
}

/// Writes `bytes` to `file` over `base` only, unless `force`, which keeps what was there
/// as a backup first.
fn put(file: &Path, backups: &Path, bytes: &[u8], base: &str, force: bool) -> std::io::Result<Put> {
    let now = match std::fs::read(file) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let on_disk = version(now.as_deref());
    let new = version(Some(bytes));
    if on_disk == new {
        return Ok(Put::Written(new));
    }
    if on_disk != base {
        if !force {
            return Ok(Put::Changed(on_disk));
        }
        if let Some(old) = &now {
            back_up(backups, file, "disk", old)?;
        }
    }
    write_whole(file, bytes)?;
    Ok(Put::Written(new))
}

fn backups_dir(state: &RemoteState) -> Option<PathBuf> {
    state.app.path().app_data_dir().ok().map(|d| d.join(BACKUP_DIR))
}

pub(super) async fn put_save(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Query(q): Query<GameQuery>, body: Bytes) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(base) = headers.get("x-save-base").and_then(|v| v.to_str().ok()).map(str::to_string) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let force = headers.contains_key("x-save-force");
    if body.is_empty() || body.len() > SAVE_MAX {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(backups) = backups_dir(&state) else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let file = match locate(&state, q.path).await {
        Ok(f) => f,
        Err(code) => return code.into_response(),
    };
    match tokio::task::spawn_blocking(move || put(&file, &backups, &body, &base, force)).await {
        Ok(Ok(Put::Written(v))) => with_version(StatusCode::OK, &v, Vec::new()),
        Ok(Ok(Put::Changed(v))) => with_version(StatusCode::CONFLICT, &v, Vec::new()),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub(super) async fn put_backup(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Query(q): Query<GameQuery>, body: Bytes) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if body.is_empty() || body.len() > SAVE_MAX {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(backups) = backups_dir(&state) else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let file = match locate(&state, q.path).await {
        Ok(f) => f,
        Err(code) => return code.into_response(),
    };
    match back_up(&backups, &file, "tv", &body) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Opens a folder dialog on this PC; the folder chosen (if any) becomes the saves folder.
pub(super) async fn choose(State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let app = state.app.clone();
    let start = save_dirs(&state).and_then(|d| d.base);
    let picked = tokio::task::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("RetroArch's saves folder");
        if let Some(dir) = start.filter(|d| d.is_dir()) {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_pick_folder().and_then(|f| f.into_path().ok())
    })
    .await;
    let Ok(picked) = picked else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    if let Some(dir) = picked {
        let saved = json!({ "folder": dir.to_string_lossy() }).to_string();
        if state.app.state::<crate::db::Db>().meta_set(SAVES_KEY, &saved).is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    listing(&state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-saves-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const STEAM_CFG: &str = r#"
savefile_directory = ":\saves"
savefiles_in_content_dir = "false"
sort_savefiles_by_content_enable = "false"
sort_savefiles_enable = "true"
savestate_directory = ":\states"
"#;

    #[test]
    fn reads_the_saves_folder_from_retroarchs_config() {
        let ra = Path::new(r"C:\Steam\steamapps\common\RetroArch");
        let d = dirs_of(ra, &read_cfg(STEAM_CFG));
        assert_eq!(d, SaveDirs { base: Some(ra.join("saves")), by_content: false, by_core: true, from: "retroarch" });
        let own = dirs_of(ra, &read_cfg("savefile_directory = \"D:/Sync/saves\"\nsort_savefiles_by_content_enable = \"true\""));
        assert_eq!((own.base, own.by_content, own.by_core), (Some(PathBuf::from("D:/Sync/saves")), true, false));
        assert_eq!(dirs_of(ra, &read_cfg("savefile_directory = \"default\"")).base, None);
        assert_eq!(dirs_of(ra, &read_cfg("savefile_directory = \":\\saves\"\nsavefiles_in_content_dir = \"true\"")).base, None);
        assert_eq!(dirs_of(ra, &read_cfg("")).base, None);
    }

    #[test]
    fn names_a_save_as_retroarch_does() {
        let game = Path::new("G:/games/sega/Sunset Riders (USA).md");
        let sorted = SaveDirs { base: Some("S:/saves".into()), by_content: false, by_core: true, from: "retroarch" };
        assert_eq!(save_file(&sorted, game, "Sunset Riders (USA).md", "md").unwrap(), Path::new("S:/saves/Genesis Plus GX/Sunset Riders (USA).srm"));
        let both = SaveDirs { by_content: true, ..sorted.clone() };
        assert_eq!(save_file(&both, game, "Sunset Riders (USA).md", "md").unwrap(), Path::new("S:/saves/sega/Genesis Plus GX/Sunset Riders (USA).srm"));
        let flat = SaveDirs { by_core: false, ..sorted.clone() };
        // A zipped game takes the name of the image inside.
        assert_eq!(save_file(&flat, Path::new("G:/games/Tank.zip"), "Tank (E).nes", "nes").unwrap(), Path::new("S:/saves/Tank (E).srm"));
        let beside = SaveDirs { base: None, by_content: true, by_core: true, from: "retroarch" };
        assert_eq!(save_file(&beside, game, "Sunset Riders (USA).md", "md").unwrap(), Path::new("G:/games/sega/Sunset Riders (USA).srm"));
    }

    #[test]
    fn writes_only_over_the_version_it_had() {
        let dir = tmp("put");
        let file = dir.join("saves/FCEUmm/a.srm");
        let backups = dir.join("backups");
        // No file yet: written over "none".
        let Put::Written(v1) = put(&file, &backups, b"one", "none", false).unwrap() else { panic!() };
        assert_eq!(v1, version(Some(b"one")));
        let Put::Written(v2) = put(&file, &backups, b"two", &v1, false).unwrap() else { panic!() };
        // Syncthing brings the phone's save meanwhile.
        std::fs::write(&file, b"phone").unwrap();
        assert_eq!(put(&file, &backups, b"three", &v2, false).unwrap(), Put::Changed(version(Some(b"phone"))));
        assert_eq!(std::fs::read(&file).unwrap(), b"phone");
        assert!(!backups.exists());
        // The same bytes as on disk are no conflict.
        assert_eq!(put(&file, &backups, b"phone", &v2, false).unwrap(), Put::Written(version(Some(b"phone"))));
        // Kept anyway: the phone's copy is backed up first.
        std::fs::write(&file, b"phone2").unwrap();
        assert!(matches!(put(&file, &backups, b"three", &v2, true).unwrap(), Put::Written(_)));
        assert_eq!(std::fs::read(&file).unwrap(), b"three");
        let kept: Vec<_> = std::fs::read_dir(&backups).unwrap().flatten().map(|e| std::fs::read(e.path()).unwrap()).collect();
        assert_eq!(kept, vec![b"phone2".to_vec()]);
        assert!(!dir.join("saves/FCEUmm/a.srm.part").exists());
    }
}
