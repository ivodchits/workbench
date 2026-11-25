//! The `wbmedia` URI scheme (S2): a registered file, by id, as it is now. Nothing
//! else is served. `Range` is honoured, so a video seeks without being read whole;
//! an open-ended range gets at most [`CHUNK`] bytes, and the player asks for more.
//! The remote server's `/api/media/<id>` (S3) answers the same way ([`registered`]),
//! and `/m/<machine>/<id>` is another machine's file ([`super::fleet`]).

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

/// An answer to a request for a file, as either server sends it.
pub struct Answer {
    pub status: StatusCode,
    pub headers: Vec<(header::HeaderName, String)>,
    pub body: Vec<u8>,
}

impl Answer {
    fn bare(status: StatusCode) -> Self {
        Self { status, headers: Vec::new(), body: Vec::new() }
    }

    /// As the webview's scheme answers.
    pub fn into_tauri(self) -> Response<Vec<u8>> {
        let mut r = Response::builder().status(self.status);
        for (k, v) in self.headers {
            r = r.header(k, v);
        }
        r.body(self.body).unwrap()
    }
}

/// The file at `path` (of type `mime`), whole or the range asked for, as it is now.
pub fn file(path: &str, mime: &str, asked_range: Option<&str>) -> Answer {
    let Ok(mut file) = std::fs::File::open(path) else {
        // Gone since it was shown.
        return Answer::bare(StatusCode::GONE);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut headers = vec![
        (header::CONTENT_TYPE, mime.to_string()),
        (header::ACCEPT_RANGES, "bytes".to_string()),
        // Served as it is now: a file that changed shows its new self.
        (header::CACHE_CONTROL, "no-store".to_string()),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
    ];
    match range(asked_range, len) {
        Err(()) => Answer {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            headers: vec![(header::CONTENT_RANGE, format!("bytes */{len}"))],
            body: Vec::new(),
        },
        Ok(None) => {
            let mut body = Vec::with_capacity(len as usize);
            if file.read_to_end(&mut body).is_err() {
                return Answer::bare(StatusCode::INTERNAL_SERVER_ERROR);
            }
            headers.push((header::CONTENT_LENGTH, body.len().to_string()));
            Answer { status: StatusCode::OK, headers, body }
        }
        Ok(Some((start, end))) => {
            let n = end - start + 1;
            let mut body = vec![0u8; n as usize];
            if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err() {
                return Answer::bare(StatusCode::INTERNAL_SERVER_ERROR);
            }
            headers.push((header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}")));
            headers.push((header::CONTENT_LENGTH, n.to_string()));
            Answer { status: StatusCode::PARTIAL_CONTENT, headers, body }
        }
    }
}

/// A registered file of this machine's, by id.
pub fn registered(app: &AppHandle, id: &str, asked_range: Option<&str>) -> Answer {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Answer::bare(StatusCode::NOT_FOUND);
    }
    let info = {
        let db = app.state::<Db>();
        let Ok(conn) = db.conn.lock() else {
            return Answer::bare(StatusCode::SERVICE_UNAVAILABLE);
        };
        super::lookup(&conn, id)
    };
    match info {
        Some(info) => file(&info.path, &info.mime, asked_range),
        None => Answer::bare(StatusCode::NOT_FOUND),
    }
}

/// `%XX` decoded (a machine id in `/m/<machine>/<id>` is encoded by the page).
pub fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let digit = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (digit(b[i + 1]), digit(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Answer one of the webview's requests: `/<id>` for this machine's file, or
/// `/m/<machine>/<id>` for another's ([`super::fleet`]).
pub async fn serve(app: AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = decode(request.uri().path().trim_matches('/'));
    let asked = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    if let Some(rest) = path.strip_prefix("m/") {
        let big = request.uri().query().is_some_and(|q| q.split('&').any(|p| p == "big=1"));
        return super::fleet::serve(&app, rest, asked.as_deref(), big).await.into_tauri();
    }
    tauri::async_runtime::spawn_blocking(move || registered(&app, &path, asked.as_deref()))
        .await
        .unwrap_or_else(|_| Answer::bare(StatusCode::INTERNAL_SERVER_ERROR))
        .into_tauri()
}
