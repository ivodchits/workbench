//! A Library game on a disc (office plan O5.3f, the PlayStation): a CD image is far too
//! big to hand the page whole, so the page reads it as the core does, a piece at a time.
//!
//! - A disc is a `.cue` and the tracks it names beside it, or one `.chd` or `.pbp`.
//! - `GET /office/api/library/disc?path=` — the files it's made of, the one the core
//!   opens first: `{"files": [{"name", "size"}]}`.
//! - `GET /office/api/library/disc/part?path=&file=` — one of them, or the bytes of it a
//!   `Range: bytes=a-b` asks for (at most [`PART_MAX`]).
//! - `GET /office/api/library/bios` — the PlayStation's BIOS from RetroArch's system
//!   folder, its name in `x-bios-name`; 404 with none, when the core makes do with its
//!   own stand-in.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::super::server::bearer;
use super::super::RemoteState;
use super::library::{folder, inside, GameQuery};

/// The most a ranged read returns.
const PART_MAX: u64 = 8 * 1024 * 1024;
/// The largest `.cue` read (they're a few hundred bytes).
const CUE_MAX: u64 = 64 * 1024;
/// The BIOS files PCSX ReARMed looks for, in its order.
const BIOS: &[&str] = &["scph5501.bin", "scph1001.bin", "scph7001.bin", "scph101.bin", "psxonpsp660.bin", "scph5500.bin", "scph5502.bin"];

/// The files a `.cue` names, in its order: `FILE "name" BINARY`, quoted or not.
fn cue_files(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.get(..5).filter(|k| k.eq_ignore_ascii_case("file ")).map(|_| line[5..].trim()) else { continue };
        let name = match rest.strip_prefix('"') {
            Some(q) => q.split('"').next().unwrap_or(""),
            None => rest.rsplit_once(' ').map_or(rest, |(n, _)| n),
        };
        if !name.is_empty() && !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// The file in `dir` named `name`, whatever its case (a cue's often isn't the file's),
/// as the folder spells it; only a plain name, never a path.
fn beside(dir: &Path, name: &str) -> Option<PathBuf> {
    if name.contains(['/', '\\']) || name == "." || name == ".." {
        return None;
    }
    let mut found: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().filter(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name)).collect();
    // The exact spelling first, where the case is all that differs.
    found.sort_by_key(|e| e.file_name().to_string_lossy() != name);
    found.into_iter().map(|e| e.path()).find(|p| p.is_file())
}

/// A disc's files, the one opened first first: a cue and its tracks, or the image alone.
pub(super) fn disc_files(disc: &Path) -> Option<Vec<PathBuf>> {
    let ext = disc.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "chd" | "pbp" => Some(vec![disc.to_path_buf()]),
        "cue" => {
            if std::fs::metadata(disc).ok()?.len() > CUE_MAX {
                return None;
            }
            let text = std::fs::read_to_string(disc).ok()?;
            let dir = disc.parent()?;
            let mut out = vec![disc.to_path_buf()];
            for name in cue_files(&text) {
                out.push(beside(dir, &name)?);
            }
            Some(out)
        }
        _ => None,
    }
}

/// A disc's size: all its files'; 0 when any is empty (a cloud copy that never
/// uploaded), as the Library shows an empty file.
pub(super) fn disc_size(disc: &Path) -> u64 {
    let sizes: Vec<u64> = disc_files(disc).unwrap_or_default().iter().map(|f| std::fs::metadata(f).map_or(0, |m| m.len())).collect();
    if sizes.contains(&0) {
        return 0;
    }
    sizes.iter().sum()
}

#[derive(Serialize)]
struct DiscFile {
    name: String,
    size: u64,
}

fn name_of(file: &Path) -> String {
    file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The disc `rel` names in the Library's folder, and its files.
async fn located(state: &Arc<RemoteState>, rel: String) -> Result<Vec<PathBuf>, StatusCode> {
    let root = folder(state).ok_or(StatusCode::NOT_FOUND)?;
    tokio::task::spawn_blocking(move || {
        let disc = inside(&root, &rel).ok_or(StatusCode::NOT_FOUND)?;
        let files = disc_files(&disc).ok_or(StatusCode::NOT_FOUND)?;
        // A track named by the cue is beside it, so in the folder too; checked anyway.
        let root = root.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
        files.into_iter().map(|f| f.canonicalize().ok().filter(|f| f.starts_with(&root)).ok_or(StatusCode::NOT_FOUND)).collect()
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

pub(super) async fn get(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Query(q): Query<GameQuery>) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match located(&state, q.path).await {
        Ok(files) => {
            let files: Vec<DiscFile> = files.iter().map(|f| DiscFile { name: name_of(f), size: std::fs::metadata(f).map_or(0, |m| m.len()) }).collect();
            ([(header::CACHE_CONTROL, "no-store")], Json(json!({ "files": files }))).into_response()
        }
        Err(code) => code.into_response(),
    }
}

/// `bytes=a-b` (or `bytes=a-`) as the range it asks of a file `len` long, `end`
/// exclusive and no more than [`PART_MAX`]; None when it's past the end or malformed.
fn range_of(header: &str, len: u64) -> Option<(u64, u64)> {
    let (a, b) = header.trim().strip_prefix("bytes=")?.split_once('-')?;
    let start: u64 = a.trim().parse().ok()?;
    let last = if b.trim().is_empty() { len.checked_sub(1)? } else { b.trim().parse::<u64>().ok()?.min(len.checked_sub(1)?) };
    if start > last {
        return None;
    }
    Some((start, (last + 1).min(start + PART_MAX)))
}

#[derive(Deserialize)]
pub(super) struct PartQuery {
    path: String,
    file: String,
}

pub(super) async fn part(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Query(q): Query<PartQuery>) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let files = match located(&state, q.path).await {
        Ok(f) => f,
        Err(code) => return code.into_response(),
    };
    let Some(file) = files.into_iter().find(|f| name_of(f) == q.file) else { return StatusCode::NOT_FOUND.into_response() };
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let read = tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, u64, u64, u64), StatusCode> {
        let mut f = std::fs::File::open(&file).map_err(|_| StatusCode::NOT_FOUND)?;
        let len = f.metadata().map_err(|_| StatusCode::NOT_FOUND)?.len();
        let (start, end) = match range {
            Some(r) => range_of(&r, len).ok_or(StatusCode::RANGE_NOT_SATISFIABLE)?,
            None if len <= PART_MAX => (0, len),
            None => return Err(StatusCode::PAYLOAD_TOO_LARGE),
        };
        f.seek(SeekFrom::Start(start)).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let mut out = vec![0; (end - start) as usize];
        f.read_exact(&mut out).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        Ok((out, start, end, len))
    })
    .await;
    match read {
        Ok(Ok((bytes, start, end, len))) if end - start < len => (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                (header::CACHE_CONTROL, "no-store".to_string()),
                (header::CONTENT_RANGE, format!("bytes {start}-{}/{len}", end - 1)),
            ],
            bytes,
        )
            .into_response(),
        Ok(Ok((bytes, ..))) => ([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-store")], bytes).into_response(),
        Ok(Err(code)) => code.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// RetroArch's system folder (`system_directory`, `:` its own folder; `default` its
/// `system` folder).
fn system_dir(ra_dir: &Path, dir: Option<&str>) -> PathBuf {
    match dir.unwrap_or("default") {
        "" | "default" => ra_dir.join("system"),
        d => match d.strip_prefix(':') {
            Some(rest) => ra_dir.join(rest.trim_start_matches(['\\', '/'])),
            None => PathBuf::from(d),
        },
    }
}

/// The first BIOS file in `dir` PCSX ReARMed would take.
fn bios_in(dir: &Path) -> Option<PathBuf> {
    BIOS.iter().find_map(|name| beside(dir, name))
}

pub(super) async fn bios(State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let found = tokio::task::spawn_blocking(|| {
        let (ra, cfg) = super::saves::retroarch()?;
        let file = bios_in(&system_dir(&ra, cfg.get("system_directory").map(String::as_str)))?;
        // A BIOS is 512 KB; anything much bigger isn't one.
        let bytes = std::fs::read(&file).ok().filter(|b| b.len() <= 4 * 1024 * 1024)?;
        Some((name_of(&file).to_ascii_lowercase(), bytes))
    })
    .await
    .ok()
    .flatten();
    match found {
        Some((name, bytes)) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                (header::CACHE_CONTROL, "no-store".to_string()),
                (header::HeaderName::from_static("x-bios-name"), name),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-disc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_the_tracks_a_cue_names() {
        let cue = "FILE \"CTR - Crash Team Racing (USA).bin\" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n";
        assert_eq!(cue_files(cue), vec!["CTR - Crash Team Racing (USA).bin"]);
        let tracks = "FILE \"a (Track 1).bin\" BINARY\nTRACK 01 MODE2/2352\nfile \"a (Track 2).bin\" BINARY\nTRACK 02 AUDIO\nFILE plain.bin BINARY\n";
        assert_eq!(cue_files(tracks), vec!["a (Track 1).bin", "a (Track 2).bin", "plain.bin"]);
        assert!(cue_files("REM nothing\n").is_empty());
    }

    #[test]
    fn makes_a_disc_of_a_cue_and_its_tracks() {
        let dir = tmp("files");
        std::fs::write(dir.join("Game.cue"), "FILE \"game.BIN\" BINARY\nFILE \"Game (Track 2).bin\" BINARY\n").unwrap();
        std::fs::write(dir.join("Game.bin"), vec![0; 2352]).unwrap();
        std::fs::write(dir.join("Game (Track 2).bin"), vec![0; 100]).unwrap();
        let files = disc_files(&dir.join("Game.cue")).unwrap();
        let names: Vec<_> = files.iter().map(|f| name_of(f)).collect();
        // Found whatever its case.
        assert_eq!(names, vec!["Game.cue", "Game.bin", "Game (Track 2).bin"]);
        assert_eq!(disc_size(&dir.join("Game.cue")), 2352 + 100 + 56);
        std::fs::write(dir.join("Game (Track 2).bin"), b"").unwrap();
        assert_eq!(disc_size(&dir.join("Game.cue")), 0);
        std::fs::write(dir.join("Game (Track 2).bin"), vec![0; 100]).unwrap();
        // A track that isn't there, or one elsewhere, makes no disc.
        std::fs::write(dir.join("Lost.cue"), "FILE \"gone.bin\" BINARY\n").unwrap();
        assert!(disc_files(&dir.join("Lost.cue")).is_none());
        std::fs::write(dir.join("Out.cue"), "FILE \"../secret.bin\" BINARY\n").unwrap();
        assert!(disc_files(&dir.join("Out.cue")).is_none());
        std::fs::write(dir.join("One.chd"), b"chd").unwrap();
        assert_eq!(disc_files(&dir.join("One.chd")).unwrap(), vec![dir.join("One.chd")]);
        assert!(disc_files(&dir.join("Game.bin")).is_none());
    }

    #[test]
    fn reads_a_range_of_a_file() {
        assert_eq!(range_of("bytes=0-1023", 4096), Some((0, 1024)));
        assert_eq!(range_of("bytes=4000-", 4096), Some((4000, 4096)));
        assert_eq!(range_of("bytes=4000-9999", 4096), Some((4000, 4096)));
        assert_eq!(range_of("bytes=0-", 100 * 1024 * 1024), Some((0, PART_MAX)));
        assert_eq!(range_of("bytes=4096-", 4096), None);
        assert_eq!(range_of("bytes=9-3", 4096), None);
        assert_eq!(range_of("items=0-1", 4096), None);
        assert_eq!(range_of("bytes=0-0", 0), None);
    }

    #[test]
    fn finds_a_bios_in_retroarchs_system_folder() {
        let ra = tmp("bios");
        assert_eq!(system_dir(&ra, Some(":\\system")), ra.join("system"));
        assert_eq!(system_dir(&ra, Some("default")), ra.join("system"));
        assert_eq!(system_dir(&ra, Some("D:/bios")), PathBuf::from("D:/bios"));
        let sys = ra.join("system");
        std::fs::create_dir_all(&sys).unwrap();
        assert!(bios_in(&sys).is_none());
        std::fs::write(sys.join("SCPH1001.BIN"), b"b").unwrap();
        assert_eq!(bios_in(&sys).map(|f| name_of(&f)), Some("SCPH1001.BIN".to_string()));
        std::fs::write(sys.join("scph5501.bin"), b"b").unwrap();
        assert_eq!(bios_in(&sys).map(|f| name_of(&f)), Some("scph5501.bin".to_string()));
    }
}
