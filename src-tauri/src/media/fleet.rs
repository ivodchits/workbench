//! Another machine's files (improvement plan S3): a session on the laptop showed
//! something, and its strip is drawn here.
//!
//! - **What's fetched:** pictures up to [`IMAGE_MAX`] and video or sound up to
//!   [`AV_MAX`], whole, from that machine's `/api/media/<id>` over the peer link's
//!   session, into a cache on this machine ([`CACHE_MAX`], the least recently used
//!   going first). The webview then gets them by `wbmedia://…/m/<machine>/<id>`, with
//!   `Range`, from the cache.
//! - **Bigger than that:** nothing is fetched unless asked (`?big=1`, "fetch anyway"),
//!   and then each range the player asks for is passed through, not cached.
//! - **What's said about a file** comes from `/api/media/<id>/info` first, so its
//!   size and type are known before anything is fetched.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::http::{header, StatusCode};
use tauri::{AppHandle, Manager};

use super::serve::{file, Answer};
use crate::fleet::view::FleetView;

pub const IMAGE_MAX: u64 = 20 * 1024 * 1024;
pub const AV_MAX: u64 = 50 * 1024 * 1024;
pub const CACHE_MAX: u64 = 500 * 1024 * 1024;

/// What another machine says about one of its files (its `MediaInfo`, without the
/// path: that stays over there).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerMedia {
    pub id: String,
    pub kind: String,
    pub mime: String,
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub caption: Option<String>,
    pub state: String,
}

/// Whether a file this size is fetched without asking.
pub fn within_limits(kind: &str, size: u64) -> bool {
    match kind {
        "image" => size <= IMAGE_MAX,
        "video" | "audio" => size <= AV_MAX,
        _ => false,
    }
}

fn hex(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit())
}

fn safe(machine: &str) -> String {
    machine.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect()
}

fn view(app: &AppHandle) -> Option<Arc<FleetView>> {
    app.try_state::<Arc<FleetView>>().map(|v| v.inner().clone())
}

fn cache_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("fleet-media");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// What machine `machine` says about these files; the ones it doesn't know are left
/// out.
pub async fn infos(app: &AppHandle, machine: &str, ids: &[String]) -> Result<Vec<PeerMedia>, String> {
    let view = view(app).ok_or("the fleet isn't running")?;
    let mut out = Vec::new();
    for id in ids.iter().filter(|id| hex(id)) {
        let resp = view.get(machine, &format!("/api/media/{id}/info"), None).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("that machine refused ({})", resp.status()));
        }
        let body = resp.bytes().await.map_err(|e| format!("that machine’s answer broke off: {e}"))?;
        let info: PeerMedia = serde_json::from_slice(&body).map_err(|e| format!("a strange answer: {e}"))?;
        out.push(info);
    }
    Ok(out)
}

/// Keep the cache under [`CACHE_MAX`]: the least recently used files go first, never
/// `keep`.
pub fn evict(dir: &Path, keep: &Path, max: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, u64, SystemTime)> = entries
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok().filter(|m| m.is_file())?;
            Some((e.path(), m.len(), m.modified().unwrap_or(SystemTime::UNIX_EPOCH)))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.2);
    for (path, len, _) in files {
        if total <= max {
            break;
        }
        if path == keep {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

/// Mark a cached file as just used.
fn touch(path: &Path) {
    if let Ok(f) = std::fs::File::options().write(true).open(path) {
        let _ = f.set_modified(SystemTime::now());
    }
}

fn bare(status: StatusCode) -> Answer {
    Answer { status, headers: Vec::new(), body: Vec::new() }
}

async fn from_cache(path: PathBuf, mime: String, range: Option<String>) -> Answer {
    tauri::async_runtime::spawn_blocking(move || {
        touch(&path);
        file(&path.to_string_lossy(), &mime, range.as_deref())
    })
    .await
    .unwrap_or_else(|_| bare(StatusCode::INTERNAL_SERVER_ERROR))
}

/// Answer the webview's `/m/<machine>/<id>`.
pub async fn serve(app: &AppHandle, rest: &str, range: Option<&str>, big: bool) -> Answer {
    let Some((machine, id)) = rest.split_once('/') else {
        return bare(StatusCode::NOT_FOUND);
    };
    if machine.is_empty() || !hex(id) {
        return bare(StatusCode::NOT_FOUND);
    }
    let Some(dir) = cache_dir(app) else {
        return bare(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let cached = dir.join(format!("{}-{id}", safe(machine)));
    let range = range.map(str::to_string);
    let info = match infos(app, machine, &[id.to_string()]).await {
        Ok(mut v) if !v.is_empty() => v.remove(0),
        Ok(_) => return bare(StatusCode::NOT_FOUND),
        // That machine is away: what's cached still shows.
        Err(_) if cached.is_file() => {
            let mime = super::classify(Path::new(id)).1.to_string();
            return from_cache(cached, mime, range).await;
        }
        Err(_) => return bare(StatusCode::BAD_GATEWAY),
    };
    if info.state == "gone" {
        let _ = std::fs::remove_file(&cached);
        return bare(StatusCode::GONE);
    }
    // Cached as it is now over there (a file that changed is fetched again).
    if std::fs::metadata(&cached).is_ok_and(|m| m.len() == info.size) {
        return from_cache(cached, info.mime, range).await;
    }
    let Some(view) = view(app) else {
        return bare(StatusCode::SERVICE_UNAVAILABLE);
    };
    if within_limits(&info.kind, info.size) {
        let body = match view.get(machine, &format!("/api/media/{id}"), None).await {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) => b,
                Err(_) => return bare(StatusCode::BAD_GATEWAY),
            },
            Ok(r) => return bare(r.status()),
            Err(_) => return bare(StatusCode::BAD_GATEWAY),
        };
        let part = dir.join(format!("{}-{id}.part", safe(machine)));
        if std::fs::write(&part, &body).is_err() || std::fs::rename(&part, &cached).is_err() {
            let _ = std::fs::remove_file(&part);
            return bare(StatusCode::INTERNAL_SERVER_ERROR);
        }
        evict(&dir, &cached, CACHE_MAX);
        return from_cache(cached, info.mime, range).await;
    }
    if !big {
        // Too big to fetch without being asked: the strip offers "fetch anyway".
        return bare(StatusCode::PAYLOAD_TOO_LARGE);
    }
    // Asked for anyway: each range straight from that machine, not cached.
    match view.get(machine, &format!("/api/media/{id}"), range.as_deref()).await {
        Ok(r) => {
            let status = r.status();
            let mut headers = Vec::new();
            for name in [header::CONTENT_TYPE, header::CONTENT_RANGE, header::ACCEPT_RANGES, header::CONTENT_LENGTH] {
                if let Some(v) = r.headers().get(&name).and_then(|v| v.to_str().ok()) {
                    headers.push((name, v.to_string()));
                }
            }
            headers.push((header::CACHE_CONTROL, "no-store".to_string()));
            match r.bytes().await {
                Ok(b) => Answer { status, headers, body: b.to_vec() },
                Err(_) => bare(StatusCode::BAD_GATEWAY),
            }
        }
        Err(_) => bare(StatusCode::BAD_GATEWAY),
    }
}

/// What machine `machine` says about these files of its sessions.
#[tauri::command]
pub async fn fleet_media_info(app: AppHandle, machine: String, ids: Vec<String>) -> Result<Vec<PeerMedia>, String> {
    infos(&app, &machine, &ids).await
}
