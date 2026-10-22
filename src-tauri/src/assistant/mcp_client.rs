//! Duck's MCP client (step X1): JSON-RPC to an MCP server over Streamable HTTP, for
//! the `mcp_*` tools (`src/assistant/tools/mcp.ts`). It lives here, not in the
//! webview, because a local MCP server sends no CORS headers and because a bearer
//! token, when a server needs one, is read from an environment variable here and
//! never reaches JavaScript.
//!
//! One session per URL: `initialize` and `notifications/initialized` run on first
//! use, the `mcp-session-id` the server hands out is kept and sent on every request,
//! and a request the server answers 404 (its session is gone: the app restarted) is
//! retried once on a fresh session. A response is plain JSON or an SSE stream; both
//! are read whole. Only `http`/`https` URLs are accepted.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::State;

use super::Assistant;

const PROTOCOL_VERSION: &str = "2025-06-18";
const ACCEPT: &str = "application/json, text/event-stream";

#[derive(Clone)]
struct Session {
    id: Option<String>,
    version: String,
}

/// Tauri-managed: the open session for each server URL.
#[derive(Default)]
pub struct McpSessions {
    by_url: Mutex<HashMap<String, Session>>,
    next_id: AtomicU64,
}

enum Fail {
    /// The server forgot our session (HTTP 404): start a new one and retry.
    SessionGone,
    Other(String),
}

impl From<String> for Fail {
    fn from(s: String) -> Self {
        Fail::Other(s)
    }
}

/// One JSON-RPC request (`tools/list`, `tools/call`) to the MCP server at `url`;
/// the `result` on success, the error message otherwise. `token_env` names an
/// environment variable holding a bearer token; its value is never returned.
#[tauri::command]
pub async fn assistant_mcp_request(
    ctx: State<'_, Arc<Assistant>>,
    sessions: State<'_, McpSessions>,
    url: String,
    token_env: Option<String>,
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("not an http(s) URL: {url}"));
    }
    let token = match token_env.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(name) => Some(
            std::env::var(name)
                .ok()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| format!("the environment variable {name} (the server's token) isn't set"))?,
        ),
    };
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1_000, 120_000));
    let http = Http { client: &ctx.client, url: &url, token: token.as_deref(), timeout };
    let params = params.unwrap_or_else(|| json!({}));

    for attempt in 0..2 {
        let session = match cached(&sessions, &url) {
            Some(s) => s,
            None => {
                let s = http.initialize(sessions.next()).await.map_err(fail_text)?;
                sessions.by_url.lock().unwrap().insert(url.clone(), s.clone());
                s
            }
        };
        let id = sessions.next();
        let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        match http.post(&body, Some(&session)).await {
            Ok((_, msg)) => return rpc_result(msg, id),
            Err(Fail::SessionGone) if attempt == 0 => {
                sessions.by_url.lock().unwrap().remove(&url);
            }
            Err(e) => {
                // A connection error may mean the server restarted: start afresh next time.
                sessions.by_url.lock().unwrap().remove(&url);
                return Err(fail_text(e));
            }
        }
    }
    Err("the server keeps dropping the session".into())
}

impl McpSessions {
    fn next(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }
}

fn cached(sessions: &McpSessions, url: &str) -> Option<Session> {
    sessions.by_url.lock().unwrap().get(url).cloned()
}

fn fail_text(f: Fail) -> String {
    match f {
        Fail::SessionGone => "the server dropped the session".into(),
        Fail::Other(s) => s,
    }
}

fn rpc_result(msg: Option<Value>, id: u64) -> Result<Value, String> {
    let msg = msg.ok_or("the server sent no reply")?;
    if msg.get("id").and_then(Value::as_u64) != Some(id) {
        return Err("the server's reply doesn't match the request".into());
    }
    if let Some(err) = msg.get("error") {
        let text = err.get("message").and_then(Value::as_str).unwrap_or("unknown error");
        return Err(format!("the server refused: {text}"));
    }
    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

struct Http<'a> {
    client: &'a reqwest::Client,
    url: &'a str,
    token: Option<&'a str>,
    timeout: Duration,
}

impl Http<'_> {
    async fn initialize(&self, id: u64) -> Result<Session, Fail> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "duck", "version": env!("CARGO_PKG_VERSION")},
            },
        });
        let (session_id, msg) = self.post(&body, None).await?;
        let result = rpc_result(msg, id)?;
        let version = result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(PROTOCOL_VERSION)
            .to_string();
        let session = Session { id: session_id, version };
        let note = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        self.post(&note, Some(&session)).await?;
        Ok(session)
    }

    /// POST one message; the session id the server sent back (if any) and the
    /// JSON-RPC message that answers it (none for a notification's 202).
    async fn post(&self, body: &Value, session: Option<&Session>) -> Result<(Option<String>, Option<Value>), Fail> {
        let mut req = self
            .client
            .post(self.url)
            .timeout(self.timeout)
            .header("Content-Type", "application/json")
            .header("Accept", ACCEPT)
            .body(body.to_string());
        if let Some(t) = self.token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        if let Some(s) = session {
            req = req.header("MCP-Protocol-Version", &s.version);
            if let Some(id) = &s.id {
                req = req.header("mcp-session-id", id);
            }
        }
        let resp = req.send().await.map_err(|e| {
            Fail::Other(if e.is_connect() {
                format!("couldn't reach {} (is the app that serves it running?)", self.url)
            } else if e.is_timeout() {
                format!("{} didn't answer in time", self.url)
            } else {
                format!("calling {} failed: {e}", self.url)
            })
        })?;
        let status = resp.status();
        if status.as_u16() == 404 && session.and_then(|s| s.id.as_ref()).is_some() {
            return Err(Fail::SessionGone);
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(Fail::Other(format!("{} refused the request ({status}): check its token", self.url)));
        }
        if !status.is_success() {
            return Err(Fail::Other(format!("{} answered {status}", self.url)));
        }
        let session_id = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let sse = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.starts_with("text/event-stream"));
        let text = resp
            .text()
            .await
            .map_err(|e| Fail::Other(format!("reading the reply from {} failed: {e}", self.url)))?;
        if text.trim().is_empty() {
            return Ok((session_id, None));
        }
        let want = body.get("id").cloned();
        let msg = if sse { from_sse(&text, want.as_ref()) } else { serde_json::from_str(&text).ok() };
        match msg {
            Some(m) => Ok((session_id, Some(m))),
            None => Err(Fail::Other(format!("{} sent a reply that isn't JSON-RPC", self.url))),
        }
    }
}

/// The message in an SSE body that answers request `want`: each event's `data:`
/// lines joined, parsed, and the one with that id kept (the first, without an id).
fn from_sse(text: &str, want: Option<&Value>) -> Option<Value> {
    let mut found = None;
    for event in text.replace("\r\n", "\n").split("\n\n") {
        let data: Vec<&str> = event
            .lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(|d| d.strip_prefix(' ').unwrap_or(d))
            .collect();
        if data.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&data.join("\n")) else { continue };
        match want {
            Some(id) if msg.get("id") == Some(id) => return Some(msg),
            None if found.is_none() => found = Some(msg),
            _ => {}
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_picks_the_reply_to_the_request() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n\
                    event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\r\ndata: \"result\":{\"ok\":true}}\r\n\r\n";
        let msg = from_sse(body, Some(&json!(7))).unwrap();
        assert_eq!(msg["result"]["ok"], json!(true));
        assert!(from_sse(body, Some(&json!(8))).is_none());
    }

    #[test]
    fn rpc_errors_and_mismatched_ids_fail() {
        let err = json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32601, "message": "no such tool"}});
        assert_eq!(rpc_result(Some(err), 1).unwrap_err(), "the server refused: no such tool");
        let ok = json!({"jsonrpc": "2.0", "id": 2, "result": {"tools": []}});
        assert!(rpc_result(Some(ok.clone()), 3).is_err());
        assert_eq!(rpc_result(Some(ok), 2).unwrap(), json!({"tools": []}));
        assert!(rpc_result(None, 1).is_err());
    }
}
