//! The loopback Anthropic proxy (step A1): `/anthropic/{*path}` on the hook server.
//!
//! The webview's SDK calls `http://127.0.0.1:<hook port>/anthropic` with the
//! per-launch token as its "API key". The proxy
//!
//! - accepts only that token (no other local process can spend the credits) and only
//!   the endpoints in [`allowed`], so nothing can reach an unmetered endpoint such as
//!   batches or files;
//! - answers the CORS preflight for the app's own origins only;
//! - checks the budget, swaps the real key in and forwards to `api.anthropic.com`,
//!   keeping `anthropic-version` / `anthropic-beta` and dropping `x-wb-purpose`;
//! - streams the response back chunk by chunk while a [`Meter`] reads its `usage`,
//!   and records the call in `assistant_usage` when the stream ends, including when
//!   the caller cancels it part way (the tokens so far are billed all the same).

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, RawQuery, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use futures_util::StreamExt;
use serde_json::Value;
use tauri::Emitter;

use super::usage::{self, Meter, Record};
use super::{budget, key, now_ms, Assistant};

const UPSTREAM: &str = "https://api.anthropic.com";
/// The event carrying each new ledger row, for the spend readout.
const USAGE_EVENT: &str = "assistant-usage";
/// Screenshots and long transcripts make big requests; axum's default is 2 MB.
const MAX_REQUEST: usize = 32 << 20;

const ALLOWED_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1430", // the vite dev server
];

/// Request headers that never go upstream: the token, browser and hop-by-hop
/// headers, and our own `x-wb-purpose`. `accept-encoding` goes too, so the response
/// comes back uncompressed for the meter to read.
const DROP_REQUEST: &[&str] = &[
    "host",
    "origin",
    "referer",
    "cookie",
    "x-api-key",
    "authorization",
    "accept-encoding",
    "connection",
    "content-length",
    "anthropic-dangerous-direct-browser-access",
    PURPOSE_HEADER,
];
const PURPOSE_HEADER: &str = "x-wb-purpose";

pub fn router(ctx: Arc<Assistant>) -> Router {
    Router::new()
        .route("/anthropic/{*path}", any(handle))
        .layer(DefaultBodyLimit::max(MAX_REQUEST))
        .with_state(ctx)
}

/// The endpoints the proxy forwards: messages (metered), token counting and the
/// model list (free).
fn allowed(method: &Method, path: &str) -> bool {
    match path {
        "v1/messages" | "v1/messages/count_tokens" => method == Method::POST,
        "v1/models" => method == Method::GET,
        p => {
            method == Method::GET
                && p.strip_prefix("v1/models/")
                    .is_some_and(|id| !id.contains('/'))
        }
    }
}

fn cors(headers: &mut HeaderMap, origin: Option<&str>) {
    if let Some(o) = origin.and_then(|o| HeaderValue::from_str(o).ok()) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("*"),
        );
    }
}

/// An error in the API's own shape, so the SDK surfaces it like any other.
fn error(status: StatusCode, kind: &str, message: &str, origin: Option<&str>) -> Response {
    let body = serde_json::json!({"type": "error", "error": {"type": kind, "message": message}});
    let mut r = (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response();
    cors(r.headers_mut(), origin);
    r
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `x-wb-purpose`, reduced to a short `[a-z0-9_-]` label; `other` when absent.
fn purpose(headers: &HeaderMap) -> String {
    let p: String = headers
        .get(PURPOSE_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        .take(40)
        .collect();
    if p.is_empty() {
        "other".into()
    } else {
        p
    }
}

async fn handle(
    State(ctx): State<Arc<Assistant>>,
    method: Method,
    Path(path): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let origin = origin.as_deref();
    // A browser page from anywhere else gets no CORS headers, so it can't read the
    // answer. Callers without an origin (not a browser) still need the token.
    if origin.is_some_and(|o| !ALLOWED_ORIGINS.contains(&o)) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }

    if method == Method::OPTIONS {
        let mut r = StatusCode::NO_CONTENT.into_response();
        let h = r.headers_mut();
        cors(h, origin);
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        if let Some(asked) = headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
            h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, asked.clone());
        }
        h.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        return r;
    }

    let presented = headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_eq(presented.as_bytes(), ctx.token.as_bytes()) {
        return error(
            StatusCode::UNAUTHORIZED,
            "authentication_error",
            "invalid launch token",
            origin,
        );
    }
    if !allowed(&method, &path) {
        return error(
            StatusCode::NOT_FOUND,
            "not_found_error",
            "this endpoint isn't proxied",
            origin,
        );
    }

    // Only message calls cost anything, so only they are metered and budgeted.
    let metered = path == "v1/messages";
    let purpose = purpose(&headers);
    let model = if metered {
        let parsed: Option<Value> = serde_json::from_slice(&body).ok();
        parsed
            .as_ref()
            .and_then(|v| v.get("model"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };
    if metered {
        let spent = {
            let conn = ctx.db.conn.lock().expect("duck db lock poisoned");
            budget::month_to_date(&conn).unwrap_or(0.0)
        };
        if let Err(msg) = budget::admit(&budget::limits(&ctx.db), spent, &model, &purpose) {
            return error(
                StatusCode::PAYMENT_REQUIRED,
                budget::CAP_ERROR,
                &msg,
                origin,
            );
        }
    }

    let Some(api_key) = key::get() else {
        return error(
            StatusCode::UNAUTHORIZED,
            "authentication_error",
            &format!(
                "no API key stored: run `cmdkey /generic:{} /user:duck /pass:<key>`",
                key::TARGET
            ),
            origin,
        );
    };
    let mut url = format!("{UPSTREAM}/{path}");
    if let Some(q) = query {
        url.push('?');
        url.push_str(&q);
    }
    let mut forward = reqwest::header::HeaderMap::new();
    for (name, value) in headers.iter() {
        let n = name.as_str();
        if DROP_REQUEST.contains(&n) || n.starts_with("sec-") {
            continue;
        }
        if let Ok(name) = HeaderName::from_bytes(n.as_bytes()) {
            forward.insert(name, value.clone());
        }
    }
    match HeaderValue::from_str(&api_key) {
        Ok(v) => forward.insert("x-api-key", v),
        Err(_) => {
            return error(
                StatusCode::UNAUTHORIZED,
                "authentication_error",
                "the stored API key isn't valid text",
                origin,
            )
        }
    };

    let upstream = match ctx
        .client
        .request(method, &url)
        .headers(forward)
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "api_error",
                &format!("couldn't reach the API: {e}"),
                origin,
            )
        }
    };
    let status = upstream.status();
    let mut out = HeaderMap::new();
    for (name, value) in upstream.headers() {
        if !matches!(
            name.as_str(),
            "transfer-encoding" | "connection" | "content-length" | "keep-alive"
        ) {
            out.insert(name.clone(), value.clone());
        }
    }
    cors(&mut out, origin);

    let stream = upstream.bytes_stream();
    let body = if metered && status.is_success() {
        let sse = out
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.starts_with("text/event-stream"));
        let mut tap = Tap {
            meter: Some(Meter::new(model, sse)),
            purpose,
            ctx: ctx.clone(),
        };
        Body::from_stream(stream.map(move |chunk| {
            if let Ok(bytes) = &chunk {
                tap.feed(bytes);
            }
            chunk
        }))
    } else {
        Body::from_stream(stream)
    };
    let mut r = Response::new(body);
    *r.status_mut() = status;
    *r.headers_mut() = out;
    r
}

/// Owns the meter for one response and records it when dropped, i.e. when the
/// response body ends or the caller abandons it.
struct Tap {
    meter: Option<Meter>,
    purpose: String,
    ctx: Arc<Assistant>,
}

impl Tap {
    fn feed(&mut self, bytes: &[u8]) {
        if let Some(m) = self.meter.as_mut() {
            m.feed(bytes);
        }
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        let Some(meter) = self.meter.take() else {
            return;
        };
        let (model, usage) = meter.finish();
        if usage.is_empty() {
            return;
        }
        let record = Record {
            ts: now_ms(),
            cost_usd: usage::cost_usd(&model, &usage),
            model,
            purpose: std::mem::take(&mut self.purpose),
            usage,
        };
        let saved = {
            let conn = self.ctx.db.conn.lock().expect("duck db lock poisoned");
            usage::insert(&conn, &record)
        };
        match saved {
            Ok(()) => {
                let _ = self.ctx.app.emit(USAGE_EVENT, &record);
            }
            Err(e) => eprintln!("[assistant] couldn't record usage: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwards_only_the_metered_and_free_endpoints() {
        assert!(allowed(&Method::POST, "v1/messages"));
        assert!(allowed(&Method::POST, "v1/messages/count_tokens"));
        assert!(allowed(&Method::GET, "v1/models"));
        assert!(allowed(&Method::GET, "v1/models/claude-haiku-5-5"));
        assert!(!allowed(&Method::GET, "v1/messages"));
        assert!(!allowed(&Method::POST, "v1/messages/batches"));
        assert!(!allowed(&Method::POST, "v1/files"));
        assert!(!allowed(&Method::GET, "v1/models/x/../../files"));
    }

    #[test]
    fn purpose_is_a_short_safe_label() {
        let with = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert(PURPOSE_HEADER, v.parse().unwrap());
            h
        };
        assert_eq!(purpose(&HeaderMap::new()), "other");
        assert_eq!(purpose(&with(" Summary ")), "summary");
        assert_eq!(purpose(&with("a\"b;drop")), "abdrop");
    }

    #[test]
    fn token_comparison() {
        assert!(constant_eq(b"abc", b"abc"));
        assert!(!constant_eq(b"abc", b"abd"));
        assert!(!constant_eq(b"abc", b"ab"));
    }
}
