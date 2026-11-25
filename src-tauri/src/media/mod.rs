//! Media in sessions (improvement plan S2): the `show_media` tool Workbench gives its
//! own sessions, the files it registers, and how they're served to the webview.
//!
//! - **The tool.** An HTTP MCP server at `/mcp/<instance>` on the hook server's port
//!   ([`router`]), handed to `claude` with `--mcp-config` when Workbench starts a
//!   console ([`launch_args`], from `pty::session_args`). The URL names the instance,
//!   and a token derived from it and a secret made at startup ([`MediaState::token`])
//!   says the call really is that session's. A `claude` started by hand has neither.
//! - **Registered files only.** A call checks each file and records it in
//!   `session_media`. Nothing serves a path: [`serve`] answers `wbmedia://<id>` for a
//!   registered id, as the file is now, with `Range` so a video plays without being
//!   read whole.
//! - **The result** names what was shown and ends with `media: <id> <id> …`, the line
//!   the transcript (here, and relayed to other machines) reads.
//! - **Opening apps anyway** ([`refuse`]): a hook answer refuses a shell command that
//!   only opens a media file, while the setting is on (it is by default).

pub mod refuse;
pub mod serve;

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::Bytes;
use axum::extract::{Path as UrlPath, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use rand_core::{OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;

/// Where the tool is served; the instance id follows.
pub const MCP_PREFIX: &str = "/mcp/";
/// The MCP server's name in the session's config: the tool is
/// `mcp__workbench__show_media` to Claude Code.
pub const SERVER_NAME: &str = "workbench";
/// The tool as Claude Code names it.
pub const TOOL_NAME: &str = "mcp__workbench__show_media";
/// Told to every session Workbench starts, after Claude Code's own prompt.
pub const PROMPT_LINE: &str = "To show the user a picture, video or sound file (a chart, a screenshot, a render, a recording), call the show_media tool: it shows the file in this session. Don't open media files in other apps (start, Invoke-Item, explorer, open).";
/// The event the webview hears when a session showed something.
pub const SHOWN_EVENT: &str = "media-shown";
/// At most this many files in one call.
const MAX_PATHS: usize = 50;
/// The setting for refusing commands that open media in other apps ("0" = off).
pub const REFUSE_KEY: &str = "media_refuse_open";

/// The secret the per-session tokens come from, made at startup: a session started
/// by an earlier run (its console is gone with it) has no way in.
pub struct MediaState {
    secret: [u8; 32],
}

impl Default for MediaState {
    fn default() -> Self {
        let mut secret = [0u8; 32];
        OsRng.fill_bytes(&mut secret);
        Self { secret }
    }
}

impl MediaState {
    /// The token session `instance_id` gets, and the one its calls must carry.
    pub fn token(&self, instance_id: &str) -> String {
        let mut h = Sha256::new();
        h.update(self.secret);
        h.update(b"media:");
        h.update(instance_id.as_bytes());
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }
}

// ── what a file is ──

/// How a file is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Image,
    Video,
    Audio,
    /// Can't be played here: a card with "open externally" and "show in folder".
    File,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Image => "image",
            Kind::Video => "video",
            Kind::Audio => "audio",
            Kind::File => "file",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "image" => Kind::Image,
            "video" => Kind::Video,
            "audio" => Kind::Audio,
            _ => Kind::File,
        }
    }

    fn word(self) -> &'static str {
        match self {
            Kind::Image => "picture",
            Kind::Video => "video",
            Kind::Audio => "sound",
            Kind::File => "file",
        }
    }
}

/// A file's kind and media type, by its extension.
pub fn classify(path: &Path) -> (Kind, &'static str) {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => (Kind::Image, "image/png"),
        "jpg" | "jpeg" => (Kind::Image, "image/jpeg"),
        "gif" => (Kind::Image, "image/gif"),
        "webp" => (Kind::Image, "image/webp"),
        "avif" => (Kind::Image, "image/avif"),
        "bmp" => (Kind::Image, "image/bmp"),
        "svg" => (Kind::Image, "image/svg+xml"),
        "mp4" | "m4v" => (Kind::Video, "video/mp4"),
        "webm" => (Kind::Video, "video/webm"),
        // Plays when it's H.264; otherwise the viewer says it can't and offers the app.
        "mov" => (Kind::Video, "video/mp4"),
        "mp3" => (Kind::Audio, "audio/mpeg"),
        "wav" => (Kind::Audio, "audio/wav"),
        "ogg" | "oga" => (Kind::Audio, "audio/ogg"),
        "m4a" => (Kind::Audio, "audio/mp4"),
        "flac" => (Kind::Audio, "audio/flac"),
        _ => (Kind::File, "application/octet-stream"),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    let mut bytes = [0u8; 12];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// "12 KB", "1.2 GB".
pub fn size_words(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut v = bytes as f64 / 1024.0;
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    if v < 10.0 {
        format!("{v:.1} {}", UNITS[unit])
    } else {
        format!("{v:.0} {}", UNITS[unit])
    }
}

// ── the registry (`session_media`) ──

/// A registered file, as it is now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub id: String,
    pub instance_id: String,
    pub kind: Kind,
    pub mime: String,
    /// The file name.
    pub name: String,
    pub path: String,
    /// Its size now (when shown, if it's gone).
    pub size: u64,
    pub shown_at: i64,
    pub caption: Option<String>,
    /// "ok", "changed" (since it was shown; it's served as it is now) or "gone".
    pub state: &'static str,
}

struct Row {
    id: String,
    instance_id: String,
    path: String,
    size: i64,
    mime: String,
    kind: String,
    modified: i64,
    shown_at: i64,
    caption: Option<String>,
}

const COLUMNS: &str = "id, instance_id, path, size, mime, kind, modified, shown_at, caption";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        instance_id: r.get(1)?,
        path: r.get(2)?,
        size: r.get(3)?,
        mime: r.get(4)?,
        kind: r.get(5)?,
        modified: r.get(6)?,
        shown_at: r.get(7)?,
        caption: r.get(8)?,
    })
}

impl Row {
    fn info(self) -> MediaInfo {
        let meta = std::fs::metadata(&self.path).ok().filter(|m| m.is_file());
        let state = match &meta {
            None => "gone",
            Some(m) if m.len() as i64 != self.size || modified_ms(m) != self.modified => "changed",
            Some(_) => "ok",
        };
        let name = Path::new(&self.path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.path.clone());
        MediaInfo {
            id: self.id,
            instance_id: self.instance_id,
            kind: Kind::parse(&self.kind),
            mime: self.mime,
            name,
            path: self.path,
            size: meta.map(|m| m.len()).unwrap_or(self.size.max(0) as u64),
            shown_at: self.shown_at,
            caption: self.caption,
            state,
        }
    }
}

/// A file checked and ready to record.
struct Checked {
    path: PathBuf,
    size: u64,
    modified: i64,
    kind: Kind,
    mime: &'static str,
}

/// Check every path (relative ones against `cwd`); all of them, or why not.
fn check(paths: &[String], cwd: Option<&Path>) -> Result<Vec<Checked>, String> {
    let mut out = Vec::new();
    let mut missing = Vec::new();
    for p in paths {
        let raw = PathBuf::from(p.trim());
        let full = if raw.is_absolute() {
            raw
        } else if let Some(cwd) = cwd {
            cwd.join(raw)
        } else {
            missing.push(format!("{p} (not an absolute path)"));
            continue;
        };
        match std::fs::metadata(&full) {
            Ok(m) if m.is_file() => {
                let path = std::fs::canonicalize(&full).unwrap_or(full);
                let path = strip_verbatim(path);
                let (kind, mime) = classify(&path);
                out.push(Checked { size: m.len(), modified: modified_ms(&m), kind, mime, path });
            }
            Ok(_) => missing.push(format!("{} (not a file)", full.display())),
            Err(_) => missing.push(format!("{} (not found)", full.display())),
        }
    }
    if missing.is_empty() {
        Ok(out)
    } else {
        Err(format!("Nothing was shown. {}", missing.join("; ")))
    }
}

/// `canonicalize` gives `\\?\C:\…` on Windows; the plain form is what people read.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

/// Register `paths` for `instance_id` and say what was shown: the tool result's
/// text, with the `media:` line, and the new ids. A missing file is an error, and
/// then nothing is registered.
pub fn show(
    conn: &Connection,
    instance_id: &str,
    paths: &[String],
    caption: Option<&str>,
    cwd: Option<&Path>,
) -> Result<(String, Vec<String>), String> {
    if paths.is_empty() {
        return Err("Give at least one path.".into());
    }
    if paths.len() > MAX_PATHS {
        return Err(format!("At most {MAX_PATHS} files in one call."));
    }
    let files = check(paths, cwd)?;
    let caption = caption.map(str::trim).filter(|c| !c.is_empty());
    let shown_at = now_ms();
    let mut ids = Vec::new();
    let mut said = Vec::new();
    for f in &files {
        let id = new_id();
        conn.execute(
            &format!("INSERT INTO session_media ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"),
            params![
                id,
                instance_id,
                f.path.to_string_lossy(),
                f.size as i64,
                f.mime,
                f.kind.as_str(),
                f.modified,
                shown_at,
                caption
            ],
        )
        .map_err(|e| format!("Couldn't record {}: {e}", f.path.display()))?;
        let name = f.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let note = if f.kind == Kind::File { ", shown as a file card: it can't play here" } else { "" };
        said.push(format!("{name} ({}, {}{note})", f.kind.word(), size_words(f.size)));
        ids.push(id);
    }
    let text = format!("Shown in the session: {}.\nmedia: {}", said.join(", "), ids.join(" "));
    Ok((text, ids))
}

/// The registered files with these ids, as they are now, in the order asked.
pub fn infos(conn: &Connection, ids: &[String]) -> Vec<MediaInfo> {
    ids.iter().filter_map(|id| lookup(conn, id)).collect()
}

/// A session's files, newest first.
pub fn list(conn: &Connection, instance_id: &str) -> Vec<MediaInfo> {
    let Ok(mut stmt) = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM session_media WHERE instance_id = ?1 ORDER BY shown_at DESC, rowid DESC"
    )) else {
        return Vec::new();
    };
    stmt.query_map([instance_id], row)
        .map(|rows| rows.flatten().map(Row::info).collect())
        .unwrap_or_default()
}

/// One registered file.
pub fn lookup(conn: &Connection, id: &str) -> Option<MediaInfo> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM session_media WHERE id = ?1"), [id], row)
        .optional()
        .ok()
        .flatten()
        .map(Row::info)
}

// ── launching a session with the tool ──

/// What a console of `instance_id` gets at launch: the tool's MCP config (written to
/// a file, which survives any launcher's quoting), the tool allowed, and the line
/// that says to use it.
/// Empty when the hook server isn't up.
pub fn launch_args(app: &AppHandle, instance_id: &str) -> Vec<String> {
    let Some(port) = crate::hooks::port(app) else {
        return Vec::new();
    };
    let Some(state) = app.try_state::<MediaState>() else {
        return Vec::new();
    };
    let Ok(dir) = app.path().app_data_dir().map(|d| d.join("media")) else {
        return Vec::new();
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return Vec::new();
    }
    let file = dir.join(format!("{}.mcp.json", safe_name(instance_id)));
    if std::fs::write(&file, mcp_config(port, instance_id, &state.token(instance_id))).is_err() {
        return Vec::new();
    }
    // Allowed up front: showing a file the session can already read needs no
    // prompt. Both list flags take several values, so each is followed by a flag.
    vec![
        "--mcp-config".into(),
        file.to_string_lossy().into_owned(),
        "--allowedTools".into(),
        TOOL_NAME.into(),
        "--append-system-prompt".into(),
        PROMPT_LINE.into(),
    ]
}

fn safe_name(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect()
}

/// The `--mcp-config` JSON for one session.
pub fn mcp_config(port: u16, instance_id: &str, token: &str) -> String {
    json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}{MCP_PREFIX}{instance_id}"),
                "headers": { "Authorization": format!("Bearer {token}") }
            }
        }
    })
    .to_string()
}

// ── the MCP server ──

/// The protocol versions we answer as; another is answered with the first.
const VERSIONS: [&str; 3] = ["2025-06-18", "2025-11-25", "2025-03-26"];

pub fn tool() -> Value {
    json!({
        "name": "show_media",
        "description": "Show pictures, videos or sound files to the user right here in this Workbench session: they appear as thumbnails under this call and open in a viewer inside the session. Use it whenever you'd otherwise open a file in another app (start, Invoke-Item, explorer, open) — those windows pile up. Works for png, jpg, gif, webp, avif, bmp, svg, mp4, webm, mov (H.264), mp3, wav, ogg, m4a and flac; any other file is shown as a card the user can open. Every path must exist.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "description": "The files to show, absolute or relative to your working directory, in the order to show them."
                },
                "caption": { "type": "string", "description": "A short line said under them." }
            },
            "required": ["paths"]
        }
    })
}

pub fn router(app: AppHandle) -> Router {
    Router::new().route(&format!("{MCP_PREFIX}{{instance}}"), any(handle)).with_state(app)
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

/// Constant-time-ish comparison: the token is a secret.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn tool_result(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

async fn handle(
    State(app): State<AppHandle>,
    UrlPath(instance_id): UrlPath<String>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(state) = app.try_state::<MediaState>() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if !same(bearer(&headers).unwrap_or(""), &state.token(&instance_id)) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if method != Method::POST {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, "not JSON").into_response();
    };
    // A notification (or a response) needs no answer.
    let Some(id) = msg.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response();
    };
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let answer = if method == "tools/call" {
        let app = app.clone();
        let instance = instance_id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || call(&app, &instance, &params))
            .await
            .unwrap_or_else(|e| tool_result(format!("show_media failed: {e}"), true));
        Ok(result)
    } else {
        answer(method, &params)
    };
    let reply = match answer {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    };
    ([(header::CONTENT_TYPE, "application/json")], reply.to_string()).into_response()
}

fn answer(method: &str, params: &Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = VERSIONS.iter().find(|v| **v == asked).unwrap_or(&VERSIONS[0]);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": [tool()] })),
        m => Err((-32601, format!("method not found: {m}"))),
    }
}

/// The paths and caption a `show_media` call asked for.
fn arguments(params: &Value) -> Result<(Vec<String>, Option<String>), String> {
    if params.get("name").and_then(Value::as_str) != Some("show_media") {
        return Err("The only tool here is show_media.".into());
    }
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let paths: Vec<String> = match &args["paths"] {
        Value::Array(a) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        // A single path given as a string.
        Value::String(s) => vec![s.clone()],
        _ => Vec::new(),
    };
    Ok((paths, args.get("caption").and_then(Value::as_str).map(str::to_string)))
}

fn call(app: &AppHandle, instance_id: &str, params: &Value) -> Value {
    let (paths, caption) = match arguments(params) {
        Ok(a) => a,
        Err(e) => return tool_result(e, true),
    };
    let db = app.state::<Db>();
    let Ok(conn) = db.conn.lock() else {
        return tool_result("Workbench's database is busy; try again.".into(), true);
    };
    let cwd: Option<PathBuf> = conn
        .query_row("SELECT working_dir FROM instances WHERE id = ?1", [instance_id], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .map(PathBuf::from);
    let shown = show(&conn, instance_id, &paths, caption.as_deref(), cwd.as_deref());
    drop(conn);
    match shown {
        Ok((text, ids)) => {
            let _ = app.emit(SHOWN_EVENT, json!({ "instanceId": instance_id, "ids": ids }));
            tool_result(text, false)
        }
        Err(e) => tool_result(e, true),
    }
}

// ── commands ──

/// The registered files with these ids, as they are now.
#[tauri::command]
pub fn media_info(db: tauri::State<'_, Db>, ids: Vec<String>) -> Result<Vec<MediaInfo>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    Ok(infos(&conn, &ids))
}

/// A session's files, newest first (the terminal view's tray).
#[tauri::command]
pub fn media_list(db: tauri::State<'_, Db>, instance_id: String) -> Result<Vec<MediaInfo>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    Ok(list(&conn, &instance_id))
}

/// Whether a command that only opens a media file in another app is refused.
#[tauri::command]
pub fn media_refuse_get(db: tauri::State<'_, Db>) -> bool {
    refusing(&db)
}

#[tauri::command]
pub fn media_refuse_set(db: tauri::State<'_, Db>, on: bool) -> Result<(), String> {
    db.meta_set(REFUSE_KEY, if on { "1" } else { "0" }).map_err(|e| e.to_string())
}

/// On unless turned off.
pub fn refusing(db: &Db) -> bool {
    !matches!(db.meta_get(REFUSE_KEY), Ok(Some(v)) if v == "0")
}

#[cfg(test)]
mod tests;
