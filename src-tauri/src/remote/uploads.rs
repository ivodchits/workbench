//! Files from the phone for a session (`POST /api/session/upload`).
//!
//! The phone's console composer attaches pictures and files to a prompt. Each goes
//! up on its own as the request body, `?instance=` naming the session and `?name=`
//! the file, and is put where the session can use it:
//!
//! - **An image** (PNG, JPEG, GIF or WebP by its bytes, up to [`IMAGE_MAX`]) goes
//!   to the desktop composer's paste folder (`sys::pasted`). The answer's `file`
//!   is its name there, which the phone puts in the prompt as an `[image …]` token;
//!   sending pastes its path into the TUI on its own, which attaches it as an
//!   `[Image #N]` — the same route as an image pasted on the desktop.
//! - **Anything else** (and an image too big for that) is saved in the session's
//!   working folder, under [`UPLOAD_DIR`], whose own `.gitignore` keeps it out of
//!   git. The answer's `file` is its full path, which the phone writes into the
//!   prompt so Claude can read it. Files there older than [`KEEP_DAYS`] are
//!   removed on the next upload.
//!
//! The phone names an instance only, never a path: the folder is the registry's,
//! and the file name is cleaned to one path component. A session on another
//! machine (an SSH project) has no folder here, so it is refused.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;

use super::server::{authed, bearer, client_addr};
use super::RemoteState;
use crate::assistant::attachments::clean_name;
use crate::db::Db;
use crate::sys::pasted;

/// The biggest file the phone may send (as Duck's uploads, `src/pwa/uploads.ts`).
pub(super) const FILE_MAX: usize = 25 * 1024 * 1024;
/// The biggest image attached as one; a bigger one is saved as a file.
const IMAGE_MAX: usize = 5 * 1024 * 1024;
/// Where a session's files from the phone go, in its working folder.
pub const UPLOAD_DIR: &str = ".workbench-uploads";
/// Files in [`UPLOAD_DIR`] are kept this long.
const KEEP_DAYS: u64 = 7;

#[derive(Deserialize)]
pub(super) struct UploadQuery {
    #[serde(default)]
    instance: String,
    #[serde(default)]
    name: String,
}

/// What became of an upload.
#[derive(Debug, Serialize, PartialEq)]
pub(super) struct Upload {
    /// `image`: attached as a picture; `file`: saved for Claude to read.
    kind: &'static str,
    /// The file's name as saved.
    name: String,
    size: usize,
    /// An image's name in the paste folder, or a file's full path.
    file: String,
}

fn refuse(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

pub(super) async fn session_upload(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> Response {
    if let Err(refusal) = authed(&state, bearer(&headers).as_deref(), &client_addr(peer, &headers)) {
        return refusal;
    }
    if body.is_empty() {
        return refuse(StatusCode::BAD_REQUEST, "the file is empty");
    }
    if body.len() > FILE_MAX {
        return refuse(StatusCode::PAYLOAD_TOO_LARGE, &format!("over {} MB", FILE_MAX / (1024 * 1024)));
    }
    let folder = {
        let db = state.app.state::<Db>();
        let conn = db.conn.lock().expect("db lock poisoned");
        let Ok(instance) = crate::registry::get_instance(&conn, &q.instance) else {
            return refuse(StatusCode::NOT_FOUND, "no such session");
        };
        let remote = crate::registry::get_project(&conn, &instance.project_id)
            .map(|p| p.remote_ssh_dest.is_some())
            .unwrap_or(false);
        if remote {
            return refuse(StatusCode::BAD_REQUEST, "this session runs on another machine: files can't be sent to it");
        }
        PathBuf::from(instance.working_dir)
    };
    let name = q.name;
    match tauri::async_runtime::spawn_blocking(move || store(&folder, &name, &body)).await {
        Ok(Ok(upload)) => Json(upload).into_response(),
        Ok(Err(e)) => refuse(StatusCode::INTERNAL_SERVER_ERROR, &e),
        Err(e) => refuse(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// The paste folder's extension for an image the TUI can attach, from its bytes.
fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    match image::guess_format(bytes).ok()? {
        image::ImageFormat::Png => Some("png"),
        image::ImageFormat::Jpeg => Some("jpg"),
        image::ImageFormat::Gif => Some("gif"),
        image::ImageFormat::WebP => Some("webp"),
        _ => None,
    }
}

/// Put `bytes`, named `name` by the phone, where the session in `folder` can use it.
fn store(folder: &Path, name: &str, bytes: &[u8]) -> Result<Upload, String> {
    let name = clean_name(name);
    if bytes.len() <= IMAGE_MAX {
        if let Some(ext) = image_ext(bytes) {
            let file = pasted::save_image(bytes, ext)?;
            return Ok(Upload { kind: "image", name, size: bytes.len(), file });
        }
    }
    if !folder.is_dir() {
        return Err(format!("the session's folder is missing: {}", folder.display()));
    }
    let dir = folder.join(UPLOAD_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    // Ignores the folder and itself, so nothing here shows up in git.
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(&ignore, "# Files sent from the phone (Workbench).\n*\n");
    }
    prune(&dir, Duration::from_secs(KEEP_DAYS * 24 * 3600));
    let path = free_path(&dir, &name);
    std::fs::write(&path, bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name);
    Ok(Upload { kind: "file", name, size: bytes.len(), file: path.to_string_lossy().into_owned() })
}

/// `name` in `dir`, or `name-2`, `name-3`, … when it's taken.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut path = dir.join(name);
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}{ext}"));
        n += 1;
    }
    path
}

/// Remove the files in `dir` last changed longer than `age` ago (not `.gitignore`).
fn prune(dir: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        if entry.file_name() == ".gitignore" {
            continue;
        }
        let old = entry
            .metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|d| d >= age);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("wb-uploads-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn png() -> Vec<u8> {
        let mut out = Vec::new();
        image::RgbImage::new(2, 2)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn an_image_goes_to_the_paste_folder_as_a_token_name() {
        let folder = tmp();
        let up = store(&folder, "photo.png", &png()).unwrap();
        assert_eq!(up.kind, "image");
        assert_eq!(up.name, "photo.png");
        // The composer's token takes 8 hex digits and the extension.
        assert_eq!(up.file.len(), 12);
        assert!(up.file.ends_with(".png"));
        let saved = PathBuf::from(pasted::pasted_image_dir()).join(&up.file);
        assert!(saved.exists());
        let _ = std::fs::remove_file(saved);
        // Nothing was put in the session's folder.
        assert!(!folder.join(UPLOAD_DIR).exists());
    }

    #[test]
    fn the_bytes_decide_what_is_an_image() {
        let folder = tmp();
        let up = store(&folder, "fake.png", b"not a picture").unwrap();
        assert_eq!(up.kind, "file");
        assert_eq!(std::fs::read(&up.file).unwrap(), b"not a picture");
    }

    #[test]
    fn a_file_lands_in_the_ignored_upload_folder_without_clobbering() {
        let folder = tmp();
        let a = store(&folder, "../notes.txt", b"one").unwrap();
        let b = store(&folder, "notes.txt", b"two").unwrap();
        let dir = folder.join(UPLOAD_DIR);
        assert_eq!(PathBuf::from(&a.file), dir.join("notes.txt"));
        assert_eq!(PathBuf::from(&b.file), dir.join("notes-2.txt"));
        assert_eq!(b.name, "notes-2.txt");
        assert_eq!(std::fs::read_to_string(dir.join(".gitignore")).unwrap().lines().last(), Some("*"));
    }

    #[test]
    fn a_missing_folder_is_refused() {
        let folder = tmp().join("gone");
        assert!(store(&folder, "a.txt", b"x").is_err());
    }

    #[test]
    fn prune_keeps_new_files_and_the_ignore() {
        let dir = tmp();
        std::fs::write(dir.join(".gitignore"), "*").unwrap();
        std::fs::write(dir.join("new.txt"), "x").unwrap();
        prune(&dir, Duration::from_secs(3600));
        assert!(dir.join("new.txt").exists());
        prune(&dir, Duration::ZERO);
        assert!(!dir.join("new.txt").exists());
        assert!(dir.join(".gitignore").exists());
    }
}
