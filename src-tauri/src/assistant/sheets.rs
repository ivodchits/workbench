//! The morning routine's invoice sheet (phase 2: reads only). [`assistant_sheet_cells`]
//! reads the configured cells, shown and as formulas, for the settings' "Test sheet"
//! and the briefing. [`assistant_sheet_export`] also keeps a local copy of the
//! original in the workspace's `data/invoices/`: the tab as CSV, the whole file as
//! xlsx, and a JSON sidecar with the sheet's id, name, the time it was fetched and
//! the cells. That is the audit record of what a draft started from.
//!
//! Only Google Sheets files are read (an uploaded .xlsx isn't one); every request is
//! a GET, through [`super::google::get`].

use std::sync::Arc;

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use super::google::{self, pct, GoogleAuth};
use super::{now_ms, workspace, Assistant};

const SHEETS: &str = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE: &str = "https://www.googleapis.com/drive/v3/files";
const SHEET_MIME: &str = "application/vnd.google-apps.spreadsheet";
const XLSX_MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
pub const MAX_CELLS: usize = 6;

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
        if self.client_id.is_empty() {
            return Err("set the Google OAuth client id first (Duck's settings, morning)".into());
        }
        google::get(self.client, self.auth, self.client_id, url).await
    }

    async fn json(&self, url: &str) -> Result<Value, String> {
        serde_json::from_slice(&self.get(url).await?).map_err(|_| "Google's reply wasn't JSON".to_string())
    }
}

async fn read_cells(g: &Google<'_>, sheet_id: &str, tab: &str, addresses: &[String]) -> Result<SheetCells, String> {
    check(sheet_id, tab, addresses)?;
    let meta = g
        .json(&format!("{DRIVE}/{sheet_id}?fields=name,mimeType,modifiedTime&supportsAllDrives=true"))
        .await?;
    let mime = meta.get("mimeType").and_then(Value::as_str).unwrap_or("");
    if mime != SHEET_MIME {
        return Err(format!("that file isn't a Google Sheet ({mime}): open it in Sheets and save it as one"));
    }
    let name = meta.get("name").and_then(Value::as_str).unwrap_or("sheet").to_string();
    let modified = meta.get("modifiedTime").and_then(Value::as_str).map(str::to_string);
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

fn check(sheet_id: &str, tab: &str, addresses: &[String]) -> Result<(), String> {
    let id_ok = (20..=128).contains(&sheet_id.len())
        && sheet_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !id_ok {
        return Err(format!("not a sheet id: {sheet_id}"));
    }
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

    #[test]
    fn picks_each_ranges_value() {
        let reply = json!({"valueRanges": [{"values": [["=C5*C6"]]}, {}, {"values": [[12.5]]}]});
        assert_eq!(first_value(&reply, 0).as_deref(), Some("=C5*C6"));
        assert_eq!(first_value(&reply, 1), None);
        assert_eq!(first_value(&reply, 2).as_deref(), Some("12.5"));
    }
}
