//! Google Sheets for Duck (the morning routine's invoice, or any sheet the user points
//! it at). Reads: [`assistant_sheet_search`] finds sheets by name,
//! [`assistant_sheet_read`] reads a tab (shown values and formulas, capped) for Duck
//! to work out what a draft should change, and [`assistant_sheet_cells`] reads given
//! cells. [`assistant_sheet_export`] keeps a local copy of the original in the
//! workspace's `data/invoices/` (the tab as CSV, the file as xlsx, a JSON sidecar):
//! the record of what a draft started from.
//!
//! Only Google Sheets files are read (an uploaded .xlsx isn't one).
//!
//! The draft: [`assistant_sheet_draft`] copies the original into Duck's drafts folder
//! and sets the cells Duck chose in the copy, after the card the user confirmed. It
//! refuses a second draft of the same sheet for the same month while the first is
//! still in Drive, a sheet whose cells changed since the card, and a target cell
//! holding a formula. The copy is Drive's `files.copy`; when Google refuses that
//! under `drive.file`, the xlsx export is uploaded as a new Sheet instead. Every file
//! Duck makes is recorded in `assistant_google_files` (the folder too), the only
//! files its scopes let it change. [`assistant_sheet_drafts`] lists a month's drafts
//! still in Drive, for the briefing.

use std::sync::Arc;

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use super::google::{self, pct, GoogleAuth};
use super::{now_ms, workspace, Assistant};

const SHEETS: &str = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE: &str = "https://www.googleapis.com/drive/v3/files";
const SHEET_MIME: &str = "application/vnd.google-apps.spreadsheet";
const XLSX_MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/// The most cells one call reads or a draft sets.
pub const MAX_CELLS: usize = 20;
/// What [`assistant_sheet_read`] returns at most of a tab.
const READ_ROWS: usize = 150;
const READ_COLS: usize = 26;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    address: String,
    /// As the sheet shows it.
    value: String,
    /// The formula, when the cell holds one (a draft never overwrites it).
    #[serde(skip_serializing_if = "Option::is_none")]
    formula: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetCells {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<String>,
    cells: Vec<Cell>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetExport {
    #[serde(flatten)]
    sheet: SheetCells,
    csv: String,
    xlsx: String,
    sidecar: String,
}

/// The configured cells, shown and as formulas.
#[tauri::command]
pub async fn assistant_sheet_cells(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    sheet_id: String,
    tab: String,
    addresses: Vec<String>,
) -> Result<SheetCells, String> {
    let g = Google { client: &ctx.client, auth: &auth, client_id: client_id.trim() };
    read_cells(&g, &sheet_id, &tab, &addresses).await
}

/// The cells, and a local copy of the sheet in `<workspace>/data/invoices/`, its
/// files named `<date>-<sheet name>`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn assistant_sheet_export(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    workspace: String,
    date: String,
    sheet_id: String,
    tab: String,
    addresses: Vec<String>,
) -> Result<SheetExport, String> {
    if !is_date(&date) {
        return Err(format!("not a date: {date}"));
    }
    let g = Google { client: &ctx.client, auth: &auth, client_id: client_id.trim() };
    let sheet = read_cells(&g, &sheet_id, &tab, &addresses).await?;
    let xlsx = g.get(&format!("{DRIVE}/{sheet_id}/export?mimeType={}", pct(XLSX_MIME))).await?;
    let rows = g
        .json(&format!("{SHEETS}/{sheet_id}/values/{}?valueRenderOption=FORMATTED_VALUE", pct(&quote_tab(&tab))))
        .await?;
    let rows = rows.get("values").and_then(Value::as_array).cloned().unwrap_or_default();

    let ws = workspace::resolve(Some(&workspace))?;
    workspace::prepare(&ws)?;
    let dir = ws.join(workspace::DATA).join("invoices");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let base = format!("{date}-{}", workspace::slug(&sheet.name));
    let write = |ext: &str, bytes: &[u8]| {
        let p = dir.join(format!("{base}.{ext}"));
        std::fs::write(&p, bytes).map_err(|e| format!("cannot write {}: {e}", p.display()))?;
        Ok::<_, String>(p.to_string_lossy().into_owned())
    };
    let csv = write("csv", to_csv(&rows).as_bytes())?;
    let xlsx = write("xlsx", &xlsx)?;
    let side = json!({
        "sheetId": sheet_id,
        "name": sheet.name,
        "tab": tab,
        "modified": sheet.modified,
        "fetchedAt": now_ms(),
        "cells": sheet.cells,
    });
    let sidecar = write("json", serde_json::to_string_pretty(&side).unwrap_or_default().as_bytes())?;
    Ok(SheetExport { sheet, csv, xlsx, sidecar })
}

struct Google<'a> {
    client: &'a reqwest::Client,
    auth: &'a GoogleAuth,
    client_id: &'a str,
}

impl Google<'_> {
    async fn get(&self, url: &str) -> Result<Vec<u8>, String> {
        self.send(reqwest::Method::GET, url, None).await
    }

    async fn send(&self, method: reqwest::Method, url: &str, body: Option<&google::Body>) -> Result<Vec<u8>, String> {
        if self.client_id.is_empty() {
            return Err("set the Google OAuth client id first (Duck's settings, morning)".into());
        }
        google::send(self.client, self.auth, self.client_id, method, url, body).await
    }

    async fn json(&self, url: &str) -> Result<Value, String> {
        parse_json(&self.get(url).await?)
    }

    /// POST `body` as JSON; the reply as JSON.
    async fn post(&self, url: &str, body: &Value) -> Result<Value, String> {
        let body = ("application/json".to_string(), body.to_string().into_bytes());
        parse_json(&self.send(reqwest::Method::POST, url, Some(&body)).await?)
    }

    /// Whether Duck's file `id` is still in Drive (not trashed, not deleted).
    async fn alive(&self, id: &str) -> Result<bool, String> {
        match self.json(&format!("{DRIVE}/{id}?fields=trashed&supportsAllDrives=true")).await {
            Ok(v) => Ok(!v.get("trashed").and_then(Value::as_bool).unwrap_or(false)),
            Err(e) if e == google::NOT_FOUND => Ok(false),
            Err(e) => Err(e),
        }
    }
}

fn parse_json(bytes: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(bytes).map_err(|_| "Google's reply wasn't JSON".to_string())
}

// ── the draft (phase 3) ──

/// A cell's value, as planned or as the card showed it.
#[derive(Deserialize, Clone)]
pub struct CellValue {
    address: String,
    value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    id: String,
    name: String,
    url: String,
    month: String,
    /// `copy` (Drive's copy) or `upload` (the xlsx export, converted).
    how: String,
    created: i64,
    /// The configured cells as the copy has them now.
    cells: Vec<Cell>,
}

const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";

/// Copy the original as `title` into the drafts folder `folder` and set `updates`
/// in the copy. `expect` is the original's cells as the card showed them; any that
/// changed since fails the draft before anything is made.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn assistant_sheet_draft(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    sheet_id: String,
    tab: String,
    folder: String,
    title: String,
    month: String,
    expect: Vec<CellValue>,
    updates: Vec<CellValue>,
) -> Result<Draft, String> {
    let addresses = draft_check(&sheet_id, &tab, &folder, &title, &month, &expect, &updates)?;
    let g = Google { client: &ctx.client, auth: &auth, client_id: client_id.trim() };

    // One draft a month: refused while the last one is still in Drive.
    let last = last_draft(&ctx.db.conn.lock().expect("duck db lock poisoned"), &sheet_id, &month)
        .map_err(|e| e.to_string())?;
    if let Some(d) = last {
        if g.alive(&d.file_id).await? {
            return Err(format!(
                "this month's draft already exists: {} ({}). Trash it in Drive first to make a new one",
                d.name,
                d.url.unwrap_or_default()
            ));
        }
    }

    // The original as it is now must be what the card showed.
    let now = read_cells(&g, &sheet_id, &tab, &addresses).await?;
    stale_or_formula(&now.cells, &expect, &updates)?;

    let folder_id = drafts_folder(&g, &ctx, &folder).await?;
    let made = match g
        .post(
            &format!("{DRIVE}/{sheet_id}/copy?fields=id,name,webViewLink&supportsAllDrives=true"),
            &json!({ "name": title, "parents": [folder_id] }),
        )
        .await
    {
        Ok(v) => ("copy", v),
        Err(e) if e.starts_with("google_expired:") => return Err(e),
        Err(copy_err) => {
            let xlsx = g.get(&format!("{DRIVE}/{sheet_id}/export?mimeType={}", pct(XLSX_MIME))).await?;
            let body = multipart(&json!({ "name": title, "parents": [folder_id], "mimeType": SHEET_MIME }), XLSX_MIME, &xlsx);
            let v = g
                .send(reqwest::Method::POST, &format!("{UPLOAD}?uploadType=multipart&fields=id,name,webViewLink"), Some(&body))
                .await
                .and_then(|b| parse_json(&b))
                .map_err(|e| format!("Drive's copy was refused ({copy_err}), and uploading the sheet failed too ({e})"))?;
            ("upload", v)
        }
    };
    let (how, v) = made;
    let id = v.get("id").and_then(Value::as_str).ok_or("Google's reply had no file id")?.to_string();
    let url = v
        .get("webViewLink")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://docs.google.com/spreadsheets/d/{id}/edit"));
    let created = now_ms();
    record(
        &ctx.db.conn.lock().expect("duck db lock poisoned"),
        &FileRecord { file_id: id.clone(), kind: "draft", name: title.clone(), source: Some(sheet_id.clone()), month: Some(month.clone()), url: Some(url.clone()), how: Some(how.into()), created },
    )
    .map_err(|e| e.to_string())?;

    // The copy's own cells: a formula there (an upload converts differently) stays.
    let copy = read_cells(&g, &id, &tab, &addresses).await?;
    stale_or_formula(&copy.cells, &[], &updates).map_err(|e| format!("{e}; the copy is at {url}, unchanged"))?;
    g.post(&format!("{SHEETS}/{id}/values:batchUpdate"), &update_body(&tab, &updates)).await?;
    let after = read_cells(&g, &id, &tab, &addresses).await?;
    Ok(Draft { id, name: title, url, month, how: how.into(), created, cells: after.cells })
}

/// A draft Duck made, as recorded.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRef {
    id: String,
    name: String,
    url: String,
    /// The sheet it's a copy of.
    source: String,
    month: String,
    how: String,
    created: i64,
}

/// The drafts Duck made for `month` that are still in Drive, newest first.
#[tauri::command]
pub async fn assistant_sheet_drafts(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    month: String,
) -> Result<Vec<DraftRef>, String> {
    if !is_month(&month) {
        return Err(format!("not a month: {month}"));
    }
    let made = drafts_in(&ctx.db.conn.lock().expect("duck db lock poisoned"), &month).map_err(|e| e.to_string())?;
    let g = Google { client: &ctx.client, auth: &auth, client_id: client_id.trim() };
    let mut out = Vec::new();
    for d in made {
        if g.alive(&d.file_id).await? {
            out.push(DraftRef {
                url: d.url.unwrap_or_else(|| format!("https://docs.google.com/spreadsheets/d/{}/edit", d.file_id)),
                id: d.file_id,
                name: d.name,
                source: d.source.unwrap_or_default(),
                month: month.clone(),
                how: d.how.unwrap_or_default(),
                created: d.created,
            });
        }
    }
    Ok(out)
}

/// A sheet found by name.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFound {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<String>,
}

/// Google Sheets whose name contains `query` (the latest changed, without one), at
/// most 10.
#[tauri::command]
pub async fn assistant_sheet_search(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    query: String,
) -> Result<Vec<SheetFound>, String> {
    let g = Google { client: &ctx.client, auth: &auth, client_id: client_id.trim() };
    let v = g.json(&search_url(&query)).await?;
    let files = v.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(files
        .iter()
        .filter_map(|f| {
            Some(SheetFound {
                id: f.get("id")?.as_str()?.to_string(),
                name: f.get("name")?.as_str()?.to_string(),
                modified: f.get("modifiedTime").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect())
}

/// Drive's `files.list` for sheets named like `query`.
fn search_url(query: &str) -> String {
    let mut q = format!("mimeType='{SHEET_MIME}' and trashed=false");
    let name: String = query.trim().chars().take(100).collect();
    if !name.is_empty() {
        let quoted = name.replace('\\', r"\\").replace('\'', r"\'");
        q.push_str(&format!(" and name contains '{quoted}'"));
    }
    format!(
        "{DRIVE}?q={}&orderBy=modifiedTime%20desc&pageSize=10&fields=files(id,name,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true",
        pct(&q)
    )
}

/// One tab of a sheet, for Duck to read.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetRead {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<String>,
    /// Every tab's name.
    tabs: Vec<String>,
    tab: String,
    /// The non-empty cells, row by row, with their formulas.
    cells: Vec<Cell>,
    /// Whether the tab goes on past what was read.
    cut: bool,
}

/// A tab's shown values and formulas (the first tab when `tab` is empty), up to
/// [`READ_ROWS`] rows and [`READ_COLS`] columns.
#[tauri::command]
pub async fn assistant_sheet_read(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
    sheet_id: String,
    tab: String,
) -> Result<SheetRead, String> {
    check_id(&sheet_id)?;
    let g = Google { client: &ctx.client, auth: &auth, client_id: client_id.trim() };
    let (name, modified) = sheet_meta(&g, &sheet_id).await?;
    let info = g.json(&format!("{SHEETS}/{sheet_id}?fields=sheets.properties.title")).await?;
    let tabs: Vec<String> = info
        .get("sheets")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|t| t.pointer("/properties/title")?.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let tab = if tab.trim().is_empty() {
        tabs.first().cloned().ok_or("the sheet has no tabs")?
    } else if tabs.contains(&tab) {
        tab
    } else {
        return Err(format!("there's no tab \"{tab}\": its tabs are {}", tabs.join(", ")));
    };
    let range = pct(&format!("{}!A1:{}{}", quote_tab(&tab), col_name(READ_COLS), READ_ROWS + 1));
    let url = |render: &str| format!("{SHEETS}/{sheet_id}/values/{range}?valueRenderOption={render}");
    let (shown_url, formula_url) = (url("FORMATTED_VALUE"), url("FORMULA"));
    let (shown, formulas) = futures_util::try_join!(g.json(&shown_url), g.json(&formula_url))?;
    let (cells, cut) = grid_cells(&shown, &formulas);
    Ok(SheetRead { name, modified, tabs, tab, cells, cut })
}

/// The non-empty cells of a `values.get` pair (shown, formulas), and whether the
/// read reached past [`READ_ROWS`] rows.
fn grid_cells(shown: &Value, formulas: &Value) -> (Vec<Cell>, bool) {
    let rows = |v: &Value| v.get("values").and_then(Value::as_array).cloned().unwrap_or_default();
    let (shown, formulas) = (rows(shown), rows(formulas));
    let text = |v: Option<&Value>| match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let mut out = Vec::new();
    for (r, row) in shown.iter().take(READ_ROWS).enumerate() {
        let frow = formulas.get(r).and_then(Value::as_array);
        for (c, v) in row.as_array().into_iter().flatten().enumerate() {
            let value = text(Some(v));
            let formula = text(frow.and_then(|f| f.get(c)));
            let formula = formula.starts_with('=').then_some(formula);
            if value.is_empty() && formula.is_none() {
                continue;
            }
            out.push(Cell { address: format!("{}{}", col_name(c + 1), r + 1), value, formula });
        }
    }
    (out, shown.len() > READ_ROWS)
}

/// The letters of the 1-based column `n`: 1 → A, 27 → AA.
fn col_name(mut n: usize) -> String {
    let mut s = Vec::new();
    while n > 0 {
        n -= 1;
        s.push(b'A' + (n % 26) as u8);
        n /= 26;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

/// The drafts folder's id: the one Duck made with this name, else a new one.
async fn drafts_folder(g: &Google<'_>, ctx: &Assistant, name: &str) -> Result<String, String> {
    let known = last_folder(&ctx.db.conn.lock().expect("duck db lock poisoned"), name).map_err(|e| e.to_string())?;
    if let Some(id) = known {
        if g.alive(&id).await? {
            return Ok(id);
        }
    }
    let v = g
        .post(&format!("{DRIVE}?fields=id"), &json!({ "name": name, "mimeType": FOLDER_MIME }))
        .await?;
    let id = v.get("id").and_then(Value::as_str).ok_or("Google's reply had no folder id")?.to_string();
    record(
        &ctx.db.conn.lock().expect("duck db lock poisoned"),
        &FileRecord { file_id: id.clone(), kind: "folder", name: name.into(), source: None, month: None, url: None, how: None, created: now_ms() },
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// The cells read and written, after checking every argument.
fn draft_check(
    sheet_id: &str,
    tab: &str,
    folder: &str,
    title: &str,
    month: &str,
    expect: &[CellValue],
    updates: &[CellValue],
) -> Result<Vec<String>, String> {
    if !is_month(month) {
        return Err(format!("not a month: {month}"));
    }
    for (what, s, max) in [("the drafts folder's name", folder, 100), ("the draft's name", title, 200)] {
        if s.trim().is_empty() || s.chars().count() > max {
            return Err(format!("{what} is empty or too long"));
        }
    }
    if updates.is_empty() {
        return Err("nothing to change: the draft would be the same as the sheet".into());
    }
    if let Some(u) = updates.iter().find(|u| u.value.chars().count() > 100 || u.value.trim_start().starts_with('=')) {
        return Err(format!("{} can't be set to that: a draft writes plain values only", u.address));
    }
    let mut addresses: Vec<String> = Vec::new();
    for a in expect.iter().chain(updates).map(|c| &c.address) {
        if !addresses.contains(a) {
            addresses.push(a.clone());
        }
    }
    check(sheet_id, tab, &addresses)?;
    Ok(addresses)
}

/// Fails when a cell no longer holds what the card showed, or a cell to set holds
/// a formula.
fn stale_or_formula(now: &[Cell], expect: &[CellValue], updates: &[CellValue]) -> Result<(), String> {
    let at = |a: &str| now.iter().find(|c| c.address == a);
    for e in expect {
        let v = at(&e.address).map(|c| c.value.as_str()).unwrap_or("");
        if v != e.value {
            return Err(format!(
                "the sheet changed since the card: {} is now \"{v}\", not \"{}\". Plan the draft again",
                e.address, e.value
            ));
        }
    }
    if let Some(c) = updates.iter().filter_map(|u| at(&u.address)).find(|c| c.formula.is_some()) {
        return Err(format!(
            "{} holds a formula ({}): a draft never overwrites one",
            c.address,
            c.formula.as_deref().unwrap_or("")
        ));
    }
    Ok(())
}

/// `values:batchUpdate`'s body: each cell typed in as the user would.
fn update_body(tab: &str, updates: &[CellValue]) -> Value {
    json!({
        "valueInputOption": "USER_ENTERED",
        "data": updates
            .iter()
            .map(|u| json!({ "range": format!("{}!{}", quote_tab(tab), u.address), "values": [[u.value]] }))
            .collect::<Vec<_>>(),
    })
}

/// A `multipart/related` upload: the metadata, then the file.
fn multipart(meta: &Value, mime: &str, bytes: &[u8]) -> google::Body {
    let boundary = "duck-draft-7f3a9c";
    let mut body = format!(
        "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/related; boundary={boundary}"), body)
}

fn is_month(s: &str) -> bool {
    s.len() == 7 && s.bytes().enumerate().all(|(i, b)| if i == 4 { b == b'-' } else { b.is_ascii_digit() })
}

// ── the files Duck made (duck.db) ──

struct FileRecord {
    file_id: String,
    kind: &'static str,
    name: String,
    source: Option<String>,
    month: Option<String>,
    url: Option<String>,
    how: Option<String>,
    created: i64,
}

fn record(conn: &Connection, r: &FileRecord) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO assistant_google_files (file_id, kind, name, source, month, url, how, created)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![r.file_id, r.kind, r.name, r.source, r.month, r.url, r.how, r.created],
    )?;
    Ok(())
}

/// The latest draft of `source` for `month`.
fn last_draft(conn: &Connection, source: &str, month: &str) -> rusqlite::Result<Option<FileRecord>> {
    conn.query_row(
        "SELECT file_id, name, url, how, created FROM assistant_google_files
         WHERE kind = 'draft' AND source = ?1 AND month = ?2 ORDER BY created DESC LIMIT 1",
        params![source, month],
        |r| {
            Ok(FileRecord {
                file_id: r.get(0)?,
                kind: "draft",
                name: r.get(1)?,
                source: Some(source.into()),
                month: Some(month.into()),
                url: r.get(2)?,
                how: r.get(3)?,
                created: r.get(4)?,
            })
        },
    )
    .optional()
}

/// The drafts made for `month`, newest first.
fn drafts_in(conn: &Connection, month: &str) -> rusqlite::Result<Vec<FileRecord>> {
    let mut st = conn.prepare(
        "SELECT file_id, name, url, how, created, source FROM assistant_google_files
         WHERE kind = 'draft' AND month = ?1 ORDER BY created DESC",
    )?;
    let rows = st.query_map([month], |r| {
        Ok(FileRecord {
            file_id: r.get(0)?,
            kind: "draft",
            name: r.get(1)?,
            source: r.get(5)?,
            month: Some(month.into()),
            url: r.get(2)?,
            how: r.get(3)?,
            created: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// The latest drafts folder Duck made with this name.
fn last_folder(conn: &Connection, name: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT file_id FROM assistant_google_files WHERE kind = 'folder' AND name = ?1 ORDER BY created DESC LIMIT 1",
        [name],
        |r| r.get(0),
    )
    .optional()
}

async fn read_cells(g: &Google<'_>, sheet_id: &str, tab: &str, addresses: &[String]) -> Result<SheetCells, String> {
    check(sheet_id, tab, addresses)?;
    let (name, modified) = sheet_meta(g, sheet_id).await?;
    if addresses.is_empty() {
        return Ok(SheetCells { name, modified, cells: Vec::new() });
    }
    let ranges: String = addresses
        .iter()
        .map(|a| format!("&ranges={}", pct(&format!("{}!{a}", quote_tab(tab)))))
        .collect();
    let url = |render: &str| format!("{SHEETS}/{sheet_id}/values:batchGet?valueRenderOption={render}{ranges}");
    let (shown_url, formula_url) = (url("FORMATTED_VALUE"), url("FORMULA"));
    let (shown, formulas) = futures_util::try_join!(g.json(&shown_url), g.json(&formula_url))?;
    let cells = addresses
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let formula = first_value(&formulas, i).filter(|f| f.starts_with('='));
            Cell { address: a.clone(), value: first_value(&shown, i).unwrap_or_default(), formula }
        })
        .collect();
    Ok(SheetCells { name, modified, cells })
}

/// The `i`th range's top-left value from a `batchGet` reply.
fn first_value(reply: &Value, i: usize) -> Option<String> {
    let v = reply.pointer(&format!("/valueRanges/{i}/values/0/0"))?;
    Some(match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    })
}

/// A Google Sheet's name and last change; an error for any other kind of file.
async fn sheet_meta(g: &Google<'_>, sheet_id: &str) -> Result<(String, Option<String>), String> {
    let meta = g
        .json(&format!("{DRIVE}/{sheet_id}?fields=name,mimeType,modifiedTime&supportsAllDrives=true"))
        .await?;
    let mime = meta.get("mimeType").and_then(Value::as_str).unwrap_or("");
    if mime != SHEET_MIME {
        return Err(format!("that file isn't a Google Sheet ({mime}): open it in Sheets and save it as one"));
    }
    let name = meta.get("name").and_then(Value::as_str).unwrap_or("sheet").to_string();
    Ok((name, meta.get("modifiedTime").and_then(Value::as_str).map(str::to_string)))
}

fn check_id(sheet_id: &str) -> Result<(), String> {
    let id_ok = (20..=128).contains(&sheet_id.len())
        && sheet_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if id_ok {
        Ok(())
    } else {
        Err(format!("not a sheet id: {sheet_id}"))
    }
}

fn check(sheet_id: &str, tab: &str, addresses: &[String]) -> Result<(), String> {
    check_id(sheet_id)?;
    if tab.trim().is_empty() || tab.len() > 100 {
        return Err("the tab's name is missing".into());
    }
    if addresses.len() > MAX_CELLS {
        return Err(format!("at most {MAX_CELLS} cells"));
    }
    let cell = Regex::new(r"^[A-Z]{1,3}[1-9][0-9]{0,6}$").expect("cell pattern");
    match addresses.iter().find(|a| !cell.is_match(a)) {
        Some(a) => Err(format!("not a cell address: {a}")),
        None => Ok(()),
    }
}

/// A tab name as an A1 range's sheet part: `'Tab name'`, quotes doubled.
fn quote_tab(tab: &str) -> String {
    format!("'{}'", tab.replace('\'', "''"))
}

fn is_date(s: &str) -> bool {
    s.len() == 10 && s.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() })
}

/// Rows of shown values as CSV (RFC 4180, CRLF).
fn to_csv(rows: &[Value]) -> String {
    let field = |v: &Value| {
        let s = match v {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        if s.contains([',', '"', '\n', '\r']) {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s
        }
    };
    rows.iter()
        .map(|r| r.as_array().map(|c| c.iter().map(field).collect::<Vec<_>>().join(",")).unwrap_or_default())
        .map(|line| line + "\r\n")
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "1AbC_defGhIjKlMnOpQrStUvWxYz0123456789";

    #[test]
    fn checks_ids_tabs_and_cells() {
        assert!(check(ID, "Invoices", &["B2".into(), "F10".into()]).is_ok());
        assert!(check("short", "Invoices", &[]).is_err());
        assert!(check(ID, " ", &[]).is_err());
        assert!(check(ID, "T", &["B2:C3".into()]).is_err());
        assert!(check(ID, "T", &["b2".into()]).is_err());
        assert!(check(ID, "T", &vec!["A1".to_string(); MAX_CELLS + 1]).is_err());
    }

    #[test]
    fn quotes_tabs_and_writes_csv() {
        assert_eq!(quote_tab("Bob's 2026"), "'Bob''s 2026'");
        let rows = vec![json!(["Date", "Amount"]), json!(["2026-10-01", "1,200.00"]), json!(["say \"hi\""])];
        assert_eq!(to_csv(&rows), "Date,Amount\r\n2026-10-01,\"1,200.00\"\r\n\"say \"\"hi\"\"\"\r\n");
    }

    fn cv(address: &str, value: &str) -> CellValue {
        CellValue { address: address.into(), value: value.into() }
    }

    fn cell(address: &str, value: &str, formula: Option<&str>) -> Cell {
        Cell { address: address.into(), value: value.into(), formula: formula.map(str::to_string) }
    }

    #[test]
    fn checks_a_drafts_arguments() {
        let ok = draft_check(ID, "T", "Duck drafts", "S draft 2026-10 (Duck)", "2026-10", &[cv("B2", "x"), cv("F10", "1")], &[cv("B2", "2026-10-22")]);
        assert_eq!(ok.unwrap(), vec!["B2".to_string(), "F10".to_string()]);
        let bad = |month: &str, updates: &[CellValue]| draft_check(ID, "T", "F", "N", month, &[], updates).is_err();
        assert!(bad("2026-1", &[cv("B2", "1")]));
        assert!(bad("2026-10", &[]));
        assert!(bad("2026-10", &[cv("B2", "=A1*2")]));
        assert!(bad("2026-10", &[cv("B2:B3", "1")]));
        assert!(draft_check(ID, "T", " ", "N", "2026-10", &[], &[cv("B2", "1")]).is_err());
    }

    #[test]
    fn refuses_a_changed_sheet_and_formula_cells() {
        let now = [cell("B2", "2026-09-01", None), cell("F10", "$1,200.00", Some("=C5*C6"))];
        assert!(stale_or_formula(&now, &[cv("B2", "2026-09-01")], &[cv("B2", "2026-10-01")]).is_ok());
        let stale = stale_or_formula(&now, &[cv("B2", "2026-08-01")], &[cv("B2", "x")]).unwrap_err();
        assert!(stale.contains("changed since the card"), "{stale}");
        let formula = stale_or_formula(&now, &[], &[cv("F10", "1300")]).unwrap_err();
        assert!(formula.contains("never overwrites"), "{formula}");
    }

    #[test]
    fn builds_the_update_and_the_upload() {
        let b = update_body("Bob's", &[cv("B2", "2026-10-01")]);
        assert_eq!(b["valueInputOption"], "USER_ENTERED");
        assert_eq!(b["data"][0]["range"], "'Bob''s'!B2");
        assert_eq!(b["data"][0]["values"][0][0], "2026-10-01");
        let (kind, body) = multipart(&json!({"name": "n"}), XLSX_MIME, b"PK");
        assert_eq!(kind, "multipart/related; boundary=duck-draft-7f3a9c");
        let text = String::from_utf8(body).unwrap();
        assert!(text.starts_with("--duck-draft-7f3a9c\r\nContent-Type: application/json"));
        assert!(text.contains("{\"name\":\"n\"}\r\n--duck-draft-7f3a9c\r\nContent-Type: application/vnd.openxml"));
        assert!(text.ends_with("PK\r\n--duck-draft-7f3a9c--\r\n"));
    }

    #[test]
    fn records_drafts_and_folders() {
        let db = super::super::db::DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let rec = |id: &str, kind: &'static str, month: Option<&str>, created: i64| FileRecord {
            file_id: id.into(),
            kind,
            name: if kind == "folder" { "Duck drafts".into() } else { format!("d {id}") },
            source: month.map(|_| ID.to_string()),
            month: month.map(str::to_string),
            url: None,
            how: Some("copy".into()),
            created,
        };
        assert!(last_draft(&conn, ID, "2026-10").unwrap().is_none());
        record(&conn, &rec("f1", "folder", None, 1)).unwrap();
        record(&conn, &rec("d1", "draft", Some("2026-10"), 2)).unwrap();
        record(&conn, &rec("d2", "draft", Some("2026-10"), 3)).unwrap();
        record(&conn, &rec("d3", "draft", Some("2026-09"), 4)).unwrap();
        assert_eq!(last_draft(&conn, ID, "2026-10").unwrap().unwrap().file_id, "d2");
        let october: Vec<String> = drafts_in(&conn, "2026-10").unwrap().into_iter().map(|d| d.file_id).collect();
        assert_eq!(october, vec!["d2", "d1"]);
        assert_eq!(last_folder(&conn, "Duck drafts").unwrap().as_deref(), Some("f1"));
        assert_eq!(last_folder(&conn, "Other").unwrap(), None);
        assert!(conn
            .execute("INSERT INTO assistant_google_files (file_id, kind, name, created) VALUES ('x', 'sheet', 'n', 0)", [])
            .is_err());
    }

    #[test]
    fn reads_a_tab_as_cells() {
        assert_eq!((col_name(1), col_name(26), col_name(27), col_name(52)), ("A".into(), "Z".into(), "AA".into(), "AZ".into()));
        let shown = json!({"values": [["Invoice", "", "No. 41"], [], ["Total", 1200]]});
        let formulas = json!({"values": [["Invoice", "", "No. 41"], [], ["Total", "=B5*B6"]]});
        let (cells, cut) = grid_cells(&shown, &formulas);
        let got: Vec<(String, String, Option<String>)> =
            cells.into_iter().map(|c| (c.address, c.value, c.formula)).collect();
        assert_eq!(
            got,
            vec![
                ("A1".into(), "Invoice".into(), None),
                ("C1".into(), "No. 41".into(), None),
                ("A3".into(), "Total".into(), None),
                ("B3".into(), "1200".into(), Some("=B5*B6".into())),
            ]
        );
        assert!(!cut);
    }

    #[test]
    fn searches_sheets_by_name() {
        let url = search_url("Bob's invoice");
        assert!(url.contains(&pct("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and name contains 'Bob\\'s invoice'")), "{url}");
        assert!(!search_url("  ").contains("name%20contains"));
    }

    #[test]
    fn picks_each_ranges_value() {
        let reply = json!({"valueRanges": [{"values": [["=C5*C6"]]}, {}, {"values": [[12.5]]}]});
        assert_eq!(first_value(&reply, 0).as_deref(), Some("=C5*C6"));
        assert_eq!(first_value(&reply, 1), None);
        assert_eq!(first_value(&reply, 2).as_deref(), Some("12.5"));
    }
}
