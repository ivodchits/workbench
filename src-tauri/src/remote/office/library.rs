//! The TV console's Library (office plan O5.3d): your game images, played in the page
//! through Nostalgist.js (RetroArch's libretro cores compiled to WebAssembly).
//!
//! - `GET /office/api/core/{name}/{js|wasm}` — a core, unpacked from the zips built into
//!   Workbench (`resources/cores/`, from Nostalgist's own build of RetroArch). None is
//!   fetched from the web.
//! - `GET /office/api/library` — the folder chosen and the games in it.
//! - `POST /office/api/library/folder` — choose the folder, in a dialog on this PC.
//! - `GET /office/api/library/rom?path=` — one game's image, out of its zip if zipped
//!   (its name inside in `x-rom-name`).
//! - `GET`/`PUT /office/api/library/state?path=` — the game's save state, kept in the
//!   app-data dir (`office-states/`), never beside the image.
//!
//! The folder lives in the app DB's `meta` table (`office.library`). Only files under
//! it are read. No images ship with Workbench. In-game saves are RetroArch's, shared
//! with it (`saves.rs`, O5.3e); a save state notes which of them it was kept with.

use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use super::super::server::bearer;
use super::super::RemoteState;

const FOLDER_KEY: &str = "office.library";
/// Where save states go, under the app-data dir.
const STATES_DIR: &str = "office-states";
/// The largest image read (a CD's worth is out of scope), and save state taken.
const ROM_MAX: u64 = 64 * 1024 * 1024;
pub(super) const STATE_MAX: usize = 32 * 1024 * 1024;
/// How deep, and how many files, a scan of the folder goes.
const SCAN_DEPTH: usize = 4;
const SCAN_FILES: usize = 4000;
/// The header naming an in-game save's version (`saves.rs`).
const SAVE_VERSION: &str = "x-save-version";

/// The cores built in, by the name Nostalgist knows them by.
const CORES: &[(&str, &[u8])] = &[
    ("genesis_plus_gx", include_bytes!("../../../resources/cores/genesis_plus_gx_libretro.zip")),
    ("fceumm", include_bytes!("../../../resources/cores/fceumm_libretro.zip")),
    ("snes9x", include_bytes!("../../../resources/cores/snes9x_libretro.zip")),
    ("gambatte", include_bytes!("../../../resources/cores/gambatte_libretro.zip")),
    ("mgba", include_bytes!("../../../resources/cores/mgba_libretro.zip")),
];

/// The system a file is for, by its extension; `bin` only when no `.cue` sits beside
/// it (a CD's track, not a cartridge).
fn system_of(name: &str, cue_beside: bool) -> Option<&'static str> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "md" | "gen" | "smd" => "md",
        "bin" if !cue_beside => "md",
        "nes" => "nes",
        "sfc" | "smc" => "snes",
        "gb" | "gbc" => "gb",
        "gba" => "gba",
        _ => return None,
    })
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Entry {
    /// Under the folder, with `/` between parts.
    path: String,
    title: String,
    system: &'static str,
    size: u64,
    /// A save state is kept for it.
    state: bool,
}

/// What a zip holds that a core plays: the first such entry's name and system.
fn zipped(bytes: impl Read + std::io::Seek) -> Option<(String, &'static str)> {
    let mut zip = zip::ZipArchive::new(bytes).ok()?;
    (0..zip.len()).find_map(|i| {
        let f = zip.by_index(i).ok()?;
        if f.is_dir() {
            return None;
        }
        let name = f.name().rsplit('/').next()?.to_string();
        system_of(&name, false).map(|s| (name, s))
    })
}

/// The games under `root`, by path.
fn scan(root: &Path, states: &Path) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut seen = 0;
    let mut dirs = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = dirs.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<_> = read.flatten().collect();
        files.sort_by_key(|e| e.file_name());
        let names: Vec<String> = files.iter().map(|e| e.file_name().to_string_lossy().to_ascii_lowercase()).collect();
        for e in &files {
            seen += 1;
            if seen > SCAN_FILES {
                return out;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = e.file_type() else { continue };
            if kind.is_dir() {
                if depth + 1 < SCAN_DEPTH {
                    dirs.push((e.path(), depth + 1));
                }
                continue;
            }
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            let stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let cue = names.contains(&format!("{}.cue", stem.to_ascii_lowercase()));
            let system = if name.to_ascii_lowercase().ends_with(".zip") {
                if size > ROM_MAX {
                    continue;
                }
                std::fs::File::open(e.path()).ok().and_then(zipped).map(|(_, s)| s)
            } else {
                system_of(&name, cue)
            };
            let Some(system) = system else { continue };
            let Ok(rel) = e.path().strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")) else { continue };
            let state = state_file(states, &rel).is_file();
            out.push(Entry { path: rel, title: stem, system, size, state });
        }
    }
    out.sort_by(|a, b| (a.system, a.title.to_lowercase()).cmp(&(b.system, b.title.to_lowercase())));
    out
}

/// `rel` under `root`, when it names a file there: no `..`, no absolute part, and
/// nowhere else once links are followed.
pub(super) fn inside(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let root = root.canonicalize().ok()?;
    let file = root.join(rel).canonicalize().ok()?;
    (file.starts_with(&root) && file.is_file()).then_some(file)
}

/// Where a game's save state is kept: named by a hash of its path, so any path makes a
/// plain file name.
fn state_file(states: &Path, rel: &str) -> PathBuf {
    let hash = Sha256::digest(rel.as_bytes());
    let name: String = hash[..12].iter().map(|b| format!("{b:02x}")).collect();
    states.join(format!("{name}.state"))
}

pub(super) fn folder(state: &RemoteState) -> Option<PathBuf> {
    let saved = state.app.state::<crate::db::Db>().meta_get(FOLDER_KEY).ok()??;
    let v: serde_json::Value = serde_json::from_str(&saved).ok()?;
    v.get("folder")?.as_str().map(PathBuf::from)
}

fn states_dir(state: &RemoteState) -> Option<PathBuf> {
    state.app.path().app_data_dir().ok().map(|d| d.join(STATES_DIR))
}

/// The folder and its games, scanned off the async threads (a cloud drive is slow).
pub(super) async fn listing(state: &Arc<RemoteState>) -> Response {
    let saves = super::saves::save_dirs(state).map(|d| super::saves::shown(&d));
    let Some(root) = folder(state) else {
        return Json(json!({ "folder": null, "games": [], "saves": saves })).into_response();
    };
    let Some(states) = states_dir(state) else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let shown = root.to_string_lossy().into_owned();
    let found = tokio::task::spawn_blocking(move || root.is_dir().then(|| scan(&root, &states))).await;
    match found {
        Ok(Some(games)) => ([(header::CACHE_CONTROL, "no-store")], Json(json!({ "folder": shown, "games": games, "saves": saves }))).into_response(),
        Ok(None) => Json(json!({ "folder": shown, "games": [], "missing": true, "saves": saves })).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub(super) async fn get(State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    listing(&state).await
}

/// Opens a folder dialog on this PC; the folder chosen (if any) becomes the Library's.
pub(super) async fn choose(State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let app = state.app.clone();
    let start = folder(&state);
    let picked = tokio::task::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("The Library's games");
        if let Some(dir) = start {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_pick_folder().and_then(|f| f.into_path().ok())
    })
    .await;
    let Ok(picked) = picked else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    if let Some(dir) = picked {
        let saved = json!({ "folder": dir.to_string_lossy() }).to_string();
        if state.app.state::<crate::db::Db>().meta_set(FOLDER_KEY, &saved).is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    listing(&state).await
}

#[derive(Deserialize)]
pub(super) struct GameQuery {
    pub(super) path: String,
}

/// The name of the image `file` is, or holds if a zip.
pub(super) fn rom_name(file: &Path) -> Option<String> {
    let name = file.file_name()?.to_string_lossy().into_owned();
    if !name.to_ascii_lowercase().ends_with(".zip") {
        return Some(name);
    }
    std::fs::File::open(file).ok().and_then(zipped).map(|(n, _)| n)
}

/// The system of the game `file` is, or holds if a zip.
pub(super) fn system_of_file(file: &Path) -> Option<&'static str> {
    let name = file.file_name()?.to_string_lossy().into_owned();
    if name.to_ascii_lowercase().ends_with(".zip") {
        return std::fs::File::open(file).ok().and_then(zipped).map(|(_, s)| s);
    }
    system_of(&name, false)
}

/// The image's bytes and its file name; a zip gives its first image.
fn read_rom(file: &Path) -> Result<(String, Vec<u8>), StatusCode> {
    let len = std::fs::metadata(file).map_err(|_| StatusCode::NOT_FOUND)?.len();
    if len > ROM_MAX {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let bytes = std::fs::read(file).map_err(|_| StatusCode::NOT_FOUND)?;
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !name.to_ascii_lowercase().ends_with(".zip") {
        return Ok((name, bytes));
    }
    let (inner, _) = zipped(Cursor::new(&bytes)).ok_or(StatusCode::UNPROCESSABLE_ENTITY)?;
    let mut zip = zip::ZipArchive::new(Cursor::new(&bytes)).map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
    let mut entry = (0..zip.len())
        .find(|&i| zip.by_index(i).is_ok_and(|f| f.name().rsplit('/').next() == Some(inner.as_str())))
        .and_then(|i| zip.by_index(i).ok())
        .ok_or(StatusCode::UNPROCESSABLE_ENTITY)?;
    if entry.size() > ROM_MAX {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let mut out = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut out).map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
    Ok((inner, out))
}

pub(super) async fn rom(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Query(q): Query<GameQuery>) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(root) = folder(&state) else { return StatusCode::NOT_FOUND.into_response() };
    let read = tokio::task::spawn_blocking(move || inside(&root, &q.path).ok_or(StatusCode::NOT_FOUND).and_then(|f| read_rom(&f))).await;
    match read {
        Ok(Ok((name, bytes))) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                (header::CACHE_CONTROL, "no-store".to_string()),
                (header::HeaderName::from_static("x-rom-name"), urlencoding(&name)),
            ],
            bytes,
        )
            .into_response(),
        Ok(Err(code)) => code.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// A header-safe form of `s` (percent-encoded beyond plain ASCII), for the page's
/// `decodeURIComponent`.
fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b' ' | b'(' | b')' | b',' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub(super) async fn get_state(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Query(q): Query<GameQuery>) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(states) = states_dir(&state) else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let file = state_file(&states, &q.path);
    match std::fs::read(&file) {
        Ok(bytes) => {
            // The in-game save's version when the state was kept (O5.3e).
            let save = std::fs::read_to_string(file.with_extension("save")).unwrap_or_default();
            let mut res = ([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-store")], bytes).into_response();
            if let Ok(v) = header::HeaderValue::from_str(save.trim()) {
                res.headers_mut().insert(SAVE_VERSION, v);
            }
            res
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Keeps a game's save state, for a game in the folder.
pub(super) async fn put_state(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Query(q): Query<GameQuery>, body: Bytes) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if body.is_empty() || body.len() > STATE_MAX {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let (Some(root), Some(states)) = (folder(&state), states_dir(&state)) else { return StatusCode::NOT_FOUND.into_response() };
    if inside(&root, &q.path).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let file = state_file(&states, &q.path);
    let written = std::fs::create_dir_all(&states).and_then(|_| {
        // Whole or not at all: written aside, then moved over the old one.
        let part = file.with_extension("part");
        std::fs::write(&part, &body)?;
        std::fs::rename(&part, &file)?;
        // Which in-game save it goes with, so a newer one from elsewhere isn't resumed
        // over (O5.3e).
        let save = headers.get(SAVE_VERSION).and_then(|v| v.to_str().ok()).unwrap_or("");
        std::fs::write(file.with_extension("save"), save)
    });
    match written {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// One part of a built-in core: its script or its WebAssembly. They never change
/// within a build, so the page may keep them.
pub(super) async fn core(State(state): State<Arc<RemoteState>>, headers: HeaderMap, UrlPath((name, part)): UrlPath<(String, String)>) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(&(_, zipped)) = CORES.iter().find(|(n, _)| *n == name) else { return StatusCode::NOT_FOUND.into_response() };
    let (suffix, kind) = match part.as_str() {
        "js" => (".js", "text/javascript"),
        "wasm" => (".wasm", "application/wasm"),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    match unpack(zipped, suffix) {
        Some(bytes) => ([(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, "private, max-age=86400")], bytes).into_response(),
        None => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// The file in `zipped` whose name ends in `suffix`.
fn unpack(zipped: &[u8], suffix: &str) -> Option<Vec<u8>> {
    let mut zip = zip::ZipArchive::new(Cursor::new(zipped)).ok()?;
    let i = (0..zip.len()).find(|&i| zip.by_index(i).is_ok_and(|f| f.name().ends_with(suffix)))?;
    let mut f = zip.by_index(i).ok()?;
    let mut out = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut out).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-library-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn zip_of(name: &str, bytes: &[u8]) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut out);
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
        zip.finish().unwrap();
        out.into_inner()
    }

    #[test]
    fn knows_each_system_by_its_extension() {
        assert_eq!(system_of("Sunset Riders (USA).md", false), Some("md"));
        assert_eq!(system_of("a.GEN", false), Some("md"));
        assert_eq!(system_of("a.bin", false), Some("md"));
        assert_eq!(system_of("a.bin", true), None);
        assert_eq!(system_of("a.nes", false), Some("nes"));
        assert_eq!(system_of("a.smc", false), Some("snes"));
        assert_eq!(system_of("a.gbc", false), Some("gb"));
        assert_eq!(system_of("a.gba", false), Some("gba"));
        assert_eq!(system_of("a.iso", false), None);
        assert_eq!(system_of("desktop.ini", false), None);
    }

    #[test]
    fn scans_the_folder_with_zips_opened() {
        let root = tmp("scan");
        let states = root.join("states-elsewhere");
        std::fs::create_dir_all(root.join("sega")).unwrap();
        std::fs::create_dir_all(root.join("ps")).unwrap();
        std::fs::write(root.join("sega/Sunset Riders (USA).md"), b"rom").unwrap();
        std::fs::write(root.join("sega/desktop.ini"), b"x").unwrap();
        std::fs::write(root.join("Tank.zip"), zip_of("inner/tank.nes", b"nes")).unwrap();
        std::fs::write(root.join("notes.zip"), zip_of("readme.txt", b"hi")).unwrap();
        std::fs::write(root.join("ps/game.bin"), b"cd").unwrap();
        std::fs::write(root.join("ps/game.cue"), b"cue").unwrap();
        std::fs::create_dir_all(&states).unwrap();
        std::fs::write(state_file(&states, "sega/Sunset Riders (USA).md"), b"s").unwrap();
        let found = scan(&root, &states);
        let got: Vec<_> = found.iter().map(|e| (e.path.as_str(), e.system, e.state)).collect();
        assert_eq!(got, vec![("sega/Sunset Riders (USA).md", "md", true), ("Tank.zip", "nes", false)]);
        assert_eq!(found[0].title, "Sunset Riders (USA)");
        assert_eq!(found[0].size, 3);
        let (name, bytes) = read_rom(&root.join("Tank.zip")).unwrap();
        assert_eq!((name.as_str(), bytes.as_slice()), ("tank.nes", b"nes".as_slice()));
        assert_eq!(read_rom(&root.join("notes.zip")).unwrap_err(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn reads_only_inside_the_folder() {
        let root = tmp("inside");
        std::fs::create_dir_all(root.join("lib")).unwrap();
        std::fs::write(root.join("lib/a.nes"), b"x").unwrap();
        std::fs::write(root.join("secret.txt"), b"x").unwrap();
        let lib = root.join("lib");
        assert!(inside(&lib, "a.nes").is_some());
        assert!(inside(&lib, "../secret.txt").is_none());
        assert!(inside(&lib, root.join("secret.txt").to_str().unwrap()).is_none());
        assert!(inside(&lib, "missing.nes").is_none());
        assert!(inside(&lib, "").is_none());
    }

    #[test]
    fn names_a_state_by_its_game() {
        let dir = Path::new("states");
        let a = state_file(dir, "sega/a.md");
        assert_eq!(a, state_file(dir, "sega/a.md"));
        assert_ne!(a, state_file(dir, "sega/b.md"));
        assert!(a.file_name().unwrap().to_str().unwrap().chars().all(|c| c.is_ascii_alphanumeric() || c == '.'));
    }

    #[test]
    fn unpacks_every_built_in_core() {
        for (name, zipped) in CORES {
            let js = unpack(zipped, ".js").unwrap_or_else(|| panic!("{name} js"));
            let wasm = unpack(zipped, ".wasm").unwrap_or_else(|| panic!("{name} wasm"));
            assert!(js.len() > 10_000, "{name}");
            assert_eq!(&wasm[..4], b"\0asm", "{name}");
        }
    }

    #[test]
    fn encodes_a_rom_name_for_a_header() {
        assert_eq!(urlencoding("Sunset Riders (USA).md"), "Sunset Riders (USA).md");
        assert_eq!(urlencoding("é/x"), "%C3%A9%2Fx");
    }
}
