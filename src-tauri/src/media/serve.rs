//! The `wbmedia` URI scheme (S2): a registered file, by id, as it is now. Nothing
//! else is served. `Range` is honoured, so a video seeks without being read whole;
//! an open-ended range gets at most [`CHUNK`] bytes, and the player asks for more.

use std::io::{Read, Seek, SeekFrom};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

use crate::db::Db;

pub const SCHEME: &str = "wbmedia";
/// The most one open-ended range answer carries.
const CHUNK: u64 = 4 * 1024 * 1024;

/// A `Range: bytes=…` header against a file of `len` bytes: the first and last byte,
/// or `Err(())` when it can't be satisfied. `Ok(None)` when there's none to honour.
pub fn range(value: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = value.and_then(|v| v.trim().strip_prefix("bytes=")) else {
        return Ok(None);
    };
    // Several ranges: just the first.
    let spec = spec.split(',').next().unwrap_or("").trim();
    let (a, b) = spec.split_once('-').ok_or(())?;
    if len == 0 {
        return Err(());
    }
    let (start, end) = if a.is_empty() {
        // The last `b` bytes.
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = a.parse().map_err(|_| ())?;
        let end = if b.is_empty() {
            (start + CHUNK - 1).min(len - 1)
        } else {
            b.parse::<u64>().map_err(|_| ())?.min(len - 1)
        };
        (start, end)
    };
    if start >= len || end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap()
}

/// Answer one request: `/<id>`.
pub fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let id = request.uri().path().trim_start_matches('/').trim_end_matches('/');
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return status(StatusCode::NOT_FOUND);
    }
    let info = {
        let db = app.state::<Db>();
        let Ok(conn) = db.conn.lock() else {
            return status(StatusCode::SERVICE_UNAVAILABLE);
        };
        super::lookup(&conn, id)
    };
    let Some(info) = info else {
        return status(StatusCode::NOT_FOUND);
    };
    let Ok(mut file) = std::fs::File::open(&info.path) else {
        // Gone since it was shown.
        return status(StatusCode::GONE);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let asked = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    let base = Response::builder()
        .header(header::CONTENT_TYPE, info.mime.as_str())
        .header(header::ACCEPT_RANGES, "bytes")
        // Served as it is now: a file that changed shows its new self.
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff");
    match range(asked, len) {
        Err(()) => Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Vec::new())
            .unwrap(),
        Ok(None) => {
            let mut body = Vec::with_capacity(len as usize);
            if file.read_to_end(&mut body).is_err() {
                return status(StatusCode::INTERNAL_SERVER_ERROR);
            }
            base.status(StatusCode::OK).header(header::CONTENT_LENGTH, body.len()).body(body).unwrap()
        }
        Ok(Some((start, end))) => {
            let n = end - start + 1;
            let mut body = vec![0u8; n as usize];
            if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err() {
                return status(StatusCode::INTERNAL_SERVER_ERROR);
            }
            base.status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, n)
                .body(body)
                .unwrap()
        }
    }
}
