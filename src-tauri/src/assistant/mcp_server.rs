//! Duck's MCP server (step M3): the tools of the subscription brain
//! ([`super::subscription_brain`]), over Streamable HTTP at `/duck/mcp` on the
//! local server. Only a brain's process has a token for it, and the token says
//! which thread the call is for.
//!
//! The tools are the registry's own definitions, which the webview hands over when
//! it starts the brain (the ones the API path sends, so the two never drift). Each
//! call goes to the webview as a `brain-tool-call` event and is answered there,
//! through the trust policy, confirmations and each tool's time budget, as on the
//! API path.
//!
//! Plain JSON-RPC, written out rather than through an SDK: `initialize`, `ping`,
//! `tools/list` and `tools/call`, each answered with one JSON response. No
//! server-sent stream (a GET is refused, which the protocol allows) and no
//! sessions: the token is all the state there is.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::subscription_brain::{tool_error, BrainManager};

pub const MCP_PATH: &str = "/duck/mcp";

/// The protocol versions we answer as; another is answered with the first.
const VERSIONS: [&str; 3] = ["2025-06-18", "2025-11-25", "2025-03-26"];

pub fn router(app: AppHandle) -> Router {
    Router::new().route(MCP_PATH, any(handle)).with_state(app)
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

async fn handle(State(app): State<AppHandle>, method: Method, headers: HeaderMap, body: Bytes) -> Response {
    let Some(mgr) = app.try_state::<BrainManager>() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Some((thread_id, tools)) = bearer(&headers).and_then(|t| mgr.by_token(t)) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
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
    let answer = match msg.get("method").and_then(Value::as_str).unwrap_or("") {
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let input = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let tool_use_id = params
                .pointer("/_meta/claudecode~1toolUseId")
                .and_then(Value::as_str)
                .map(str::to_string);
            if tools.iter().any(|t| t["name"] == name.as_str()) {
                Ok(mgr.call(&app, thread_id, name, input, tool_use_id).await)
            } else {
                Ok(tool_error(&format!("There is no tool named {name}.")))
            }
        }
        m => answer(m, &params, &tools),
    };
    let reply = match answer {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    };
    ([(header::CONTENT_TYPE, "application/json")], reply.to_string()).into_response()
}

/// The answer to every method but `tools/call`: its result, or a JSON-RPC error.
fn answer(method: &str, params: &Value, tools: &[Value]) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = VERSIONS.iter().find(|v| **v == asked).unwrap_or(&VERSIONS[0]);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "duck", "version": env!("CARGO_PKG_VERSION") },
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools })),
        m => Err((-32601, format!("method not found: {m}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_handshake_and_lists_the_tools() {
        let tools = vec![json!({ "name": "get_time", "inputSchema": { "type": "object" } })];
        let init = answer("initialize", &json!({ "protocolVersion": "2025-11-25" }), &tools).unwrap();
        assert_eq!(init["protocolVersion"], "2025-11-25");
        assert_eq!(init["serverInfo"]["name"], "duck");
        let other = answer("initialize", &json!({ "protocolVersion": "2099-01-01" }), &tools).unwrap();
        assert_eq!(other["protocolVersion"], VERSIONS[0]);
        assert_eq!(answer("tools/list", &Value::Null, &tools).unwrap()["tools"][0]["name"], "get_time");
        // Claude Code probes with `server/discover` first, then falls back.
        assert_eq!(answer("server/discover", &Value::Null, &tools).unwrap_err().0, -32601);
    }

    #[test]
    fn a_token_is_read_from_the_bearer_header() {
        let mut h = HeaderMap::new();
        assert_eq!(bearer(&h), None);
        h.insert(header::AUTHORIZATION, "Bearer abc".parse().unwrap());
        assert_eq!(bearer(&h), Some("abc"));
        h.insert(header::AUTHORIZATION, "Basic abc".parse().unwrap());
        assert_eq!(bearer(&h), None);
    }
}
