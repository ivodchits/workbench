//! Google Drive files of any kind for Duck (an uploaded .xlsx, a .docx, a PDF, a
//! Google Doc or Sheet, a folder), over the same sign-in as [`super::sheets`].
//!
//! Reads: [`assistant_drive_search`] lists files by name, folder, kind and when they
//! last changed (the latest first), and [`assistant_drive_file`] is one file's
//! metadata with its folders' names. Changes: [`assistant_drive_copy`] copies a file
//! under a new name (into a given folder, else the original's), which only ever
//! reads the original; [`assistant_drive_rename`], [`assistant_drive_move`],
//! [`assistant_drive_create_folder`] and [`assistant_drive_trash`] (Drive's trash,
//! restorable for 30 days; nothing here deletes for good). Files to and from the
//! PC: [`assistant_drive_download`] saves a file into the workspace's `data/drive/`
//! (a Google Doc, Sheet or Slides exported as docx, xlsx or pptx), and
//! [`assistant_drive_upload`] puts a local file (5 MB at most) into Drive.
//!
//! Renaming, moving and trashing a file Duck didn't make needs the full `drive`
//! scope ([`super::google::DRIVE_FULL`]); without it Google refuses and the error says to
//! reconnect. Which calls ask first is the engine's (the tools' tiers).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use super::google::{pct, GoogleAuth};
use super::sheets::{multipart, parse_json, Google};
use super::{workspace, Assistant};

const DRIVE: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const FIELDS: &str = "id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,trashed,ownedByMe";
/// What a search returns by default, and at most.
const LIST_DEFAULT: u32 = 20;
const LIST_MAX: u32 = 50;
/// The largest file [`assistant_drive_download`] saves.
const MAX_DOWNLOAD: u64 = 50 * 1024 * 1024;
/// The largest file [`assistant_drive_upload`] sends (one multipart request).
const MAX_UPLOAD: u64 = 5 * 1024 * 1024;

/// A Drive file as Duck sees it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    id: String,
    name: String,
    mime_type: String,
    /// A short name for the kind (`xlsx`, `google_sheet`, `folder`, …), else the MIME type.
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created: Option<String>,
    /// The folders it's in, by id.
    parents: Vec<String>,
    /// The folders' names, where they were looked up (one file's metadata).
    #[serde(skip_serializing_if = "Option::is_none")]
    folders: Option<Vec<String>>,
    link: String,
    trashed: bool,
    owned_by_me: bool,
}

/// What [`assistant_drive_search`] looks for; every part optional.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DriveQuery {
    /// Words the name contains.
    name: Option<String>,
    /// A folder's id (`root` for My Drive): only files directly in it.
    folder: Option<String>,
    /// One of [`KINDS`].
    kind: Option<String>,
    /// `YYYY-MM-DD` or an RFC 3339 time.
    modified_after: Option<String>,
    modified_before: Option<String>,
    limit: Option<u32>,
}

/// The kinds a search can ask for, each a Drive query on the MIME type.
pub const KINDS: [(&str, &str); 13] = [
    ("any", ""),
    ("folder", "mimeType='application/vnd.google-apps.folder'"),
    ("google_sheet", "mimeType='application/vnd.google-apps.spreadsheet'"),
    ("google_doc", "mimeType='application/vnd.google-apps.document'"),
    ("google_slides", "mimeType='application/vnd.google-apps.presentation'"),
    ("xlsx", "mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'"),
    ("docx", "mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document'"),
    ("pptx", "mimeType='application/vnd.openxmlformats-officedocument.presentationml.presentation'"),
    ("pdf", "mimeType='application/pdf'"),
    ("csv", "mimeType='text/csv'"),
    ("image", "mimeType contains 'image/'"),
    (
        "spreadsheet",
        "(mimeType='application/vnd.google-apps.spreadsheet' or mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or mimeType='application/vnd.ms-excel' or mimeType='text/csv')",
    ),
    (
        "document",
        "(mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType='application/msword')",
    ),
];

/// A short name for `mime`.
fn kind_of(mime: &str) -> String {
    let named = match mime {
        "application/vnd.google-apps.folder" => "folder",
        "application/vnd.google-apps.spreadsheet" => "google_sheet",
        "application/vnd.google-apps.document" => "google_doc",
        "application/vnd.google-apps.presentation" => "google_slides",
        "application/vnd.google-apps.shortcut" => "shortcut",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "application/pdf" => "pdf",
        "text/csv" => "csv",
        m if m.starts_with("image/") => "image",
        m => m,
    };
    named.to_string()
}

/// Drive's `files.list` query for `q`: never the trash.
fn search_q(q: &DriveQuery) -> Result<String, String> {
    let mut parts = vec!["trashed=false".to_string()];
    if let Some(name) = q.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        let name: String = name.chars().take(200).collect();
        parts.push(format!("name contains {}", quote(&name)));
    }
    if let Some(folder) = q.folder.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        check_folder_id(folder)?;
        parts.push(format!("{} in parents", quote(folder)));
    }
    if let Some(kind) = q.kind.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        let (_, clause) = KINDS
            .iter()
            .find(|(k, _)| *k == kind)
            .ok_or_else(|| format!("not a kind: {kind} (one of {})", KINDS.map(|k| k.0).join(", ")))?;
        if !clause.is_empty() {
            parts.push(clause.to_string());
        }
    }
    for (op, t) in [(">", &q.modified_after), ("<", &q.modified_before)] {
        if let Some(t) = t.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            parts.push(format!("modifiedTime {op} {}", quote(&rfc3339(t)?)));
        }
    }
    Ok(parts.join(" and "))
}

fn search_url(q: &DriveQuery) -> Result<String, String> {
    let limit = q.limit.unwrap_or(LIST_DEFAULT).clamp(1, LIST_MAX);
    Ok(format!(
        "{DRIVE}?q={}&orderBy=modifiedTime%20desc&pageSize={limit}&fields={}&supportsAllDrives=true&includeItemsFromAllDrives=true",
        pct(&search_q(q)?),
        pct(&format!("files({FIELDS})"))
    ))
}

/// A string literal in a Drive query.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\\', r"\\").replace('\'', r"\'"))
}

/// `YYYY-MM-DD` as midnight UTC; an RFC 3339 time as it is.
fn rfc3339(t: &str) -> Result<String, String> {
    let digits = |s: &str, at: &[usize]| {
        s.bytes().enumerate().all(|(i, b)| if at.contains(&i) { true } else { b.is_ascii_digit() })
    };
    let date_ok = t.len() >= 10 && t.is_char_boundary(10) && digits(&t[..10], &[4, 7]) && &t[4..5] == "-" && &t[7..8] == "-";
    if !date_ok {
        return Err(format!("not a date: {t} (YYYY-MM-DD)"));
    }
    if t.len() == 10 {
        return Ok(format!("{t}T00:00:00Z"));
    }
    let rest = &t[10..];
    let ok = rest.starts_with('T')
        && rest.len() <= 30
        && rest[1..].bytes().all(|b| b.is_ascii_digit() || matches!(b, b':' | b'.' | b'Z' | b'+' | b'-'));
    if ok {
        Ok(t.to_string())
    } else {
        Err(format!("not a time: {t}"))
    }
}

/// A Drive file id: letters, digits, `-` and `_`.
fn check_id(id: &str) -> Result<(), String> {
    let ok = (10..=200).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(format!("not a Drive file id: {id}"))
    }
}

/// A folder's id, or `root` (My Drive).
fn check_folder_id(id: &str) -> Result<(), String> {
    if id == "root" {
        Ok(())
    } else {
        check_id(id)
    }
}

/// A name for a file in Drive.
fn check_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 255 || n.chars().any(char::is_control) {
        return Err(format!("not a file name: \"{name}\""));
    }
    Ok(n.to_string())
}

fn file_of(v: &Value) -> Option<DriveFile> {
    let id = v.get("id")?.as_str()?.to_string();
    let mime_type = v.get("mimeType").and_then(Value::as_str).unwrap_or("").to_string();
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Some(DriveFile {
        name: s("name").unwrap_or_default(),
        kind: kind_of(&mime_type),
        size: s("size").and_then(|n| n.parse().ok()),
        modified: s("modifiedTime"),
        created: s("createdTime"),
        parents: v
            .get("parents")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|p| p.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        folders: None,
        link: s("webViewLink").unwrap_or_else(|| format!("https://drive.google.com/open?id={id}")),
        trashed: v.get("trashed").and_then(Value::as_bool).unwrap_or(false),
        owned_by_me: v.get("ownedByMe").and_then(Value::as_bool).unwrap_or(false),
        id,
        mime_type,
    })
}

fn file_url(id: &str) -> String {
    format!("{DRIVE}/{id}?fields={}&supportsAllDrives=true", pct(FIELDS))
}

async fn meta(g: &Google<'_>, id: &str) -> Result<DriveFile, String> {
    check_id(id)?;
    file_of(&g.json(&file_url(id)).await?).ok_or_else(|| "Google's reply had no file".into())
}

/// The folder `id` (`root`: My Drive), which must be one.
async fn folder(g: &Google<'_>, id: &str) -> Result<DriveFile, String> {
    check_folder_id(id)?;
    let f = file_of(&g.json(&file_url(id)).await?).ok_or("Google's reply had no folder")?;
    if f.mime_type != FOLDER_MIME {
        return Err(format!("\"{}\" isn't a folder ({})", f.name, f.kind));
    }
    if f.trashed {
        return Err(format!("the folder \"{}\" is in the trash", f.name));
    }
    Ok(f)
}

fn g<'a>(ctx: &'a Assistant, auth: &'a GoogleAuth, client_id: &'a str) -> Google<'a> {
    Google { client: &ctx.client, auth, client_id: client_id.trim() }
}

/// Files matching `query`, the latest changed first.
#[tauri::command]
pub async fn assistant_drive_search(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    query: DriveQuery,
) -> Result<Vec<DriveFile>, String> {
    let g = g(&ctx, &auth, &client_id);
    let v = g.json(&search_url(&query)?).await?;
    Ok(v.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(file_of).collect())
}

/// One file's metadata, with its folders' names.
#[tauri::command]
pub async fn assistant_drive_file(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    file_id: String,
) -> Result<DriveFile, String> {
    let g = g(&ctx, &auth, &client_id);
    let mut f = meta(&g, &file_id).await?;
    let mut names = Vec::new();
    for p in &f.parents {
        let name = match g.json(&format!("{DRIVE}/{p}?fields=name&supportsAllDrives=true")).await {
            Ok(v) => v.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            Err(_) => String::new(),
        };
        names.push(name);
    }
    f.folders = Some(names);
    Ok(f)
}

/// Copy `file_id` as `name` into `folder` (the original's first folder when
/// absent). Refuses a folder, and a name already taken in the target folder. The
/// original is only read.
#[tauri::command]
pub async fn assistant_drive_copy(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    file_id: String,
    name: String,
    folder: Option<String>,
) -> Result<DriveFile, String> {
    let name = check_name(&name)?;
    let g = g(&ctx, &auth, &client_id);
    let source = meta(&g, &file_id).await?;
    if source.mime_type == FOLDER_MIME {
        return Err("Drive can't copy a folder: create a folder and copy its files".into());
    }
    let target = match folder.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(f) => Some(folder_id(&g, f).await?),
        None => source.parents.first().cloned(),
    };
    if let Some(t) = &target {
        if let Some(taken) = named_in(&g, &name, t).await? {
            return Err(format!("that folder already has a file named \"{name}\": {}", taken.link));
        }
    }
    let mut body = json!({ "name": name });
    if let Some(t) = &target {
        body["parents"] = json!([t]);
    }
    let v = g
        .post(&format!("{DRIVE}/{}/copy?fields={}&supportsAllDrives=true", source.id, pct(FIELDS)), &body)
        .await?;
    let copy = file_of(&v).ok_or("Google's reply had no file")?;
    if copy.id == source.id {
        return Err("Google returned the original instead of a copy".into());
    }
    Ok(copy)
}

/// The folder's id after checking it is one.
async fn folder_id(g: &Google<'_>, id: &str) -> Result<String, String> {
    Ok(folder(g, id).await?.id)
}

/// A file named exactly `name` in `folder`, not trashed.
async fn named_in(g: &Google<'_>, name: &str, folder: &str) -> Result<Option<DriveFile>, String> {
    let q = format!("name = {} and {} in parents and trashed=false", quote(name), quote(folder));
    let url = format!(
        "{DRIVE}?q={}&pageSize=1&fields={}&supportsAllDrives=true&includeItemsFromAllDrives=true",
        pct(&q),
        pct(&format!("files({FIELDS})"))
    );
    let v = g.json(&url).await?;
    Ok(v.get("files").and_then(Value::as_array).and_then(|a| a.first()).and_then(file_of))
}

/// A file renamed, with its name before.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Renamed {
    file: DriveFile,
    was: String,
}

/// Rename `file_id` to `name`.
#[tauri::command]
pub async fn assistant_drive_rename(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    file_id: String,
    name: String,
) -> Result<Renamed, String> {
    let name = check_name(&name)?;
    let g = g(&ctx, &auth, &client_id);
    let before = meta(&g, &file_id).await?;
    if before.name == name {
        return Err(format!("it's already named \"{name}\""));
    }
    let v = g
        .patch(&format!("{DRIVE}/{}?fields={}&supportsAllDrives=true", before.id, pct(FIELDS)), &json!({ "name": name }))
        .await?;
    Ok(Renamed { file: file_of(&v).ok_or("Google's reply had no file")?, was: before.name })
}

/// A file moved, with the folders it was in.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    file: DriveFile,
    from: Vec<String>,
}

/// Move `file_id` into `folder`, out of every folder it was in.
#[tauri::command]
pub async fn assistant_drive_move(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    file_id: String,
    folder: String,
) -> Result<Moved, String> {
    let g = g(&ctx, &auth, &client_id);
    let file = meta(&g, &file_id).await?;
    let to = folder_id(&g, folder.trim()).await?;
    if file.id == to {
        return Err("a folder can't go into itself".into());
    }
    if file.parents.len() == 1 && file.parents[0] == to {
        return Err(format!("\"{}\" is already in that folder", file.name));
    }
    let url = move_url(&file.id, &to, &file.parents);
    let v = g.patch(&url, &json!({})).await?;
    Ok(Moved { file: file_of(&v).ok_or("Google's reply had no file")?, from: file.parents })
}

fn move_url(id: &str, to: &str, from: &[String]) -> String {
    let remove: Vec<&str> = from.iter().map(String::as_str).filter(|p| *p != to).collect();
    let mut url = format!("{DRIVE}/{id}?addParents={}&fields={}&supportsAllDrives=true", pct(to), pct(FIELDS));
    if !remove.is_empty() {
        url.push_str(&format!("&removeParents={}", pct(&remove.join(","))));
    }
    url
}

/// Make a folder `name` in `parent` (My Drive when absent).
#[tauri::command]
pub async fn assistant_drive_create_folder(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    name: String,
    parent: Option<String>,
) -> Result<DriveFile, String> {
    let name = check_name(&name)?;
    let g = g(&ctx, &auth, &client_id);
    let mut body = json!({ "name": name, "mimeType": FOLDER_MIME });
    if let Some(p) = parent.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        body["parents"] = json!([folder_id(&g, p).await?]);
    }
    let v = g.post(&format!("{DRIVE}?fields={}&supportsAllDrives=true", pct(FIELDS)), &body).await?;
    file_of(&v).ok_or_else(|| "Google's reply had no folder".into())
}

/// Put `file_id` in Drive's trash (restorable there for 30 days).
#[tauri::command]
pub async fn assistant_drive_trash(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    file_id: String,
) -> Result<DriveFile, String> {
    let g = g(&ctx, &auth, &client_id);
    let file = meta(&g, &file_id).await?;
    if file.trashed {
        return Err(format!("\"{}\" is already in the trash", file.name));
    }
    let v = g
        .patch(&format!("{DRIVE}/{}?fields={}&supportsAllDrives=true", file.id, pct(FIELDS)), &json!({ "trashed": true }))
        .await?;
    file_of(&v).ok_or_else(|| "Google's reply had no file".into())
}

/// A file saved on the PC.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    file: DriveFile,
    path: String,
    bytes: u64,
    /// The format a Google file was exported as.
    #[serde(skip_serializing_if = "Option::is_none")]
    exported_as: Option<&'static str>,
}

/// What a Google-native file is exported as: (MIME type, extension).
fn export_as(mime: &str) -> Option<(&'static str, &'static str)> {
    match mime {
        "application/vnd.google-apps.document" => {
            Some(("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"))
        }
        "application/vnd.google-apps.spreadsheet" => {
            Some(("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"))
        }
        "application/vnd.google-apps.presentation" => {
            Some(("application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"))
        }
        "application/vnd.google-apps.drawing" => Some(("image/png", "png")),
        _ => None,
    }
}

/// A Drive name as a Windows file name: no reserved characters, no trailing dots
/// or spaces, at most 150 characters.
fn local_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
        .take(150)
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4);
    if cleaned.is_empty() || reserved {
        format!("file {cleaned}").trim().to_string()
    } else {
        cleaned
    }
}

/// `dir/name`, or `dir/name (2).ext`, … when it's taken.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("a free name")
}

/// Save `file_id` into `<workspace>/data/drive/`: a Google file exported (docx,
/// xlsx, pptx, png), any other as it is. Never a folder; 50 MB at most.
#[tauri::command]
pub async fn assistant_drive_download(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    workspace: String,
    file_id: String,
) -> Result<Downloaded, String> {
    let g = g(&ctx, &auth, &client_id);
    let file = meta(&g, &file_id).await?;
    if file.mime_type == FOLDER_MIME {
        return Err("that's a folder: download its files one by one".into());
    }
    if file.size.is_some_and(|s| s > MAX_DOWNLOAD) {
        return Err(format!("\"{}\" is over 50 MB: open it in Drive instead", file.name));
    }
    let (bytes, name, exported_as) = match export_as(&file.mime_type) {
        Some((mime, ext)) => {
            let b = g.get(&format!("{DRIVE}/{}/export?mimeType={}", file.id, pct(mime))).await?;
            let name = if file.name.to_ascii_lowercase().ends_with(&format!(".{ext}")) {
                file.name.clone()
            } else {
                format!("{}.{ext}", file.name)
            };
            (b, name, Some(ext))
        }
        None if file.mime_type.starts_with("application/vnd.google-apps.") => {
            return Err(format!("a {} can't be downloaded as a file", file.kind));
        }
        None => (g.get(&format!("{DRIVE}/{}?alt=media&supportsAllDrives=true", file.id)).await?, file.name.clone(), None),
    };
    if bytes.len() as u64 > MAX_DOWNLOAD {
        return Err(format!("\"{}\" is over 50 MB: open it in Drive instead", file.name));
    }
    let ws = workspace::resolve(Some(&workspace))?;
    workspace::prepare(&ws)?;
    let dir = ws.join(workspace::DATA).join("drive");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = free_path(&dir, &local_name(&name));
    std::fs::write(&path, &bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(Downloaded { file, path: path.to_string_lossy().into_owned(), bytes: bytes.len() as u64, exported_as })
}

/// A local file's MIME type, by its extension.
fn mime_of(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xls" => "application/vnd.ms-excel",
        "doc" => "application/msword",
        "pdf" => "application/pdf",
        "csv" => "text/csv",
        "txt" | "md" => "text/plain",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// The local file `path` to upload: absolute, a file, 5 MB at most.
fn upload_source(path: &str) -> Result<(PathBuf, u64), String> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() || p.components().any(|c| c == std::path::Component::ParentDir) {
        return Err(format!("give the file's full path: {path}"));
    }
    let m = std::fs::metadata(&p).map_err(|e| format!("cannot open {}: {e}", p.display()))?;
    if !m.is_file() {
        return Err(format!("{} isn't a file", p.display()));
    }
    if m.len() > MAX_UPLOAD {
        return Err(format!("{} is over 5 MB: upload it in Drive instead", p.display()));
    }
    Ok((p, m.len()))
}

/// Upload the local file `path` as `name` (its own name when absent) into `folder`
/// (My Drive when absent). The file goes up as it is, not converted.
#[tauri::command]
pub async fn assistant_drive_upload(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    path: String,
    name: Option<String>,
    folder: Option<String>,
) -> Result<DriveFile, String> {
    let (p, _) = upload_source(&path)?;
    let own = p.file_name().and_then(|n| n.to_str()).unwrap_or("upload").to_string();
    let name = check_name(name.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(&own))?;
    let g = g(&ctx, &auth, &client_id);
    let mime = mime_of(&p);
    let mut meta = json!({ "name": name, "mimeType": mime });
    if let Some(f) = folder.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        meta["parents"] = json!([folder_id(&g, f).await?]);
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
    let body = multipart(&meta, mime, &bytes);
    let v = g
        .send(
            reqwest::Method::POST,
            &format!("{UPLOAD}?uploadType=multipart&fields={}&supportsAllDrives=true", pct(FIELDS)),
            Some(&body),
        )
        .await
        .and_then(|b| parse_json(&b))?;
    file_of(&v).ok_or_else(|| "Google's reply had no file".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "1AbC_defGhIjKlMnOpQrStUvWxYz0123456789";

    fn q(name: Option<&str>, folder: Option<&str>, kind: Option<&str>, after: Option<&str>) -> DriveQuery {
        DriveQuery {
            name: name.map(str::to_string),
            folder: folder.map(str::to_string),
            kind: kind.map(str::to_string),
            modified_after: after.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn builds_a_search() {
        assert_eq!(search_q(&DriveQuery::default()).unwrap(), "trashed=false");
        let s = search_q(&q(Some("Igor's TinyWizard Invoice"), Some(ID), Some("xlsx"), Some("2026-09-01"))).unwrap();
        assert_eq!(
            s,
            format!(
                "trashed=false and name contains 'Igor\\'s TinyWizard Invoice' and '{ID}' in parents and \
                 mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and \
                 modifiedTime > '2026-09-01T00:00:00Z'"
            )
        );
        assert!(search_q(&q(None, Some("root"), Some("any"), None)).unwrap().ends_with("'root' in parents"));
        assert!(search_q(&q(None, None, Some("spreadsheet"), None)).unwrap().contains("vnd.google-apps.spreadsheet' or"));
        assert!(search_q(&q(None, None, Some("movie"), None)).unwrap_err().contains("not a kind"));
        assert!(search_q(&q(None, Some("x' or 'a"), None, None)).is_err());
        assert!(search_q(&q(None, None, None, Some("last week"))).is_err());
        let url = search_url(&DriveQuery { limit: Some(500), ..Default::default() }).unwrap();
        assert!(url.contains("orderBy=modifiedTime%20desc&pageSize=50&"), "{url}");
        assert!(url.contains("includeItemsFromAllDrives=true"));
    }

    #[test]
    fn reads_times() {
        assert_eq!(rfc3339("2026-10-02").unwrap(), "2026-10-02T00:00:00Z");
        assert_eq!(rfc3339("2026-10-02T09:30:00+02:00").unwrap(), "2026-10-02T09:30:00+02:00");
        assert!(rfc3339("2026-10-02T09:30' or ").is_err());
        assert!(rfc3339("02.10.2026").is_err());
        assert!(rfc3339("").is_err());
    }

    #[test]
    fn checks_ids_and_names() {
        assert!(check_id(ID).is_ok());
        assert!(check_id("root").is_err());
        assert!(check_folder_id("root").is_ok());
        assert!(check_id("../etc/passwd").is_err());
        assert_eq!(check_name("  Igor Vodchits TinyWizard Invoice 2026_10.xlsx ").unwrap(), "Igor Vodchits TinyWizard Invoice 2026_10.xlsx");
        assert!(check_name(" ").is_err());
        assert!(check_name("a\nb").is_err());
        assert!(check_name(&"x".repeat(256)).is_err());
    }

    #[test]
    fn reads_a_file() {
        let v = json!({
            "id": ID, "name": "Igor Vodchits TinyWizard Invoice 2026_09.xlsx",
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "size": "18234", "modifiedTime": "2026-09-30T10:00:00.000Z", "parents": ["folder1"],
            "webViewLink": "https://docs.google.com/spreadsheets/d/x/edit", "ownedByMe": true
        });
        let f = file_of(&v).unwrap();
        assert_eq!((f.kind.as_str(), f.size, f.parents.clone(), f.trashed, f.owned_by_me), ("xlsx", Some(18234), vec!["folder1".to_string()], false, true));
        let folder = file_of(&json!({"id": "f", "mimeType": FOLDER_MIME})).unwrap();
        assert_eq!((folder.kind.as_str(), folder.link.as_str()), ("folder", "https://drive.google.com/open?id=f"));
        assert_eq!(kind_of("image/jpeg"), "image");
        assert_eq!(kind_of("application/zip"), "application/zip");
        assert!(file_of(&json!({"name": "no id"})).is_none());
    }

    #[test]
    fn moves_out_of_the_old_folders() {
        let url = move_url(ID, "to", &["a".into(), "b".into()]);
        assert!(url.contains("addParents=to&"), "{url}");
        assert!(url.ends_with("&removeParents=a%2Cb"), "{url}");
        assert!(!move_url(ID, "to", &["to".into()]).contains("removeParents"));
    }

    #[test]
    fn exports_google_files_as_office_files() {
        assert_eq!(export_as("application/vnd.google-apps.spreadsheet").map(|e| e.1), Some("xlsx"));
        assert_eq!(export_as("application/vnd.google-apps.document").map(|e| e.1), Some("docx"));
        assert_eq!(export_as("application/pdf"), None);
    }

    #[test]
    fn saves_under_a_safe_free_name() {
        assert_eq!(local_name("a/b:c?.xlsx"), "a_b_c_.xlsx");
        assert_eq!(local_name("report. "), "report");
        assert_eq!(local_name("CON.txt"), "file CON.txt");
        assert_eq!(local_name(""), "file");
        let dir = std::env::temp_dir().join(format!("duck-drive-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_path(&dir, "x.xlsx"), dir.join("x.xlsx"));
        std::fs::write(dir.join("x.xlsx"), b"1").unwrap();
        std::fs::write(dir.join("x (2).xlsx"), b"1").unwrap();
        assert_eq!(free_path(&dir, "x.xlsx"), dir.join("x (3).xlsx"));
        std::fs::write(dir.join("noext"), b"1").unwrap();
        assert_eq!(free_path(&dir, "noext"), dir.join("noext (2)"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn checks_an_upload() {
        assert!(upload_source("relative.xlsx").is_err());
        let dir = std::env::temp_dir().join(format!("duck-upload-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("Invoice.XLSX");
        std::fs::write(&f, b"PK").unwrap();
        assert_eq!(upload_source(f.to_str().unwrap()).unwrap().1, 2);
        assert!(upload_source(dir.to_str().unwrap()).unwrap_err().contains("isn't a file"));
        assert_eq!(mime_of(&f), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        assert_eq!(mime_of(Path::new("a.bin")), "application/octet-stream");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
