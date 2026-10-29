//! Whiteboard Pictionary (office plan O5.4): Duck guesses what you draw, or draws a
//! word for you to guess. The page asks here (`POST /office/api/pictionary`); one call
//! is out at a time, and it goes to the webview as an `office-pictionary` event. The
//! webview owns the API client (`src/state/officePictionary.ts`) and answers with
//! `office_pictionary_reply`. It's a game you open and play, so there's no budget
//! beyond Duck's own: each call is a few thousand tokens at most.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::sync::oneshot;

use super::super::server::bearer;
use super::super::RemoteState;

/// The largest request: a guess carries a picture of the board.
pub(super) const REQUEST_MAX: usize = 1024 * 1024;
/// How long the webview has to answer: a drawing is a long reply.
const REPLY_SECS: u64 = 90;

#[derive(Default)]
pub(super) struct Pictionary {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// The call out to the webview, by id, and the next id.
    pending: HashMap<u64, oneshot::Sender<Value>>,
    next: u64,
}

impl Pictionary {
    /// Hand the webview's answer to the request waiting for it.
    pub(super) fn reply(&self, id: u64, reply: Value) {
        if let Some(tx) = self.inner.lock().unwrap().pending.remove(&id) {
            let _ = tx.send(reply); // Err: it gave up waiting
        }
    }

    /// A slot for a call, or None while another is out.
    fn begin(&self) -> Option<(u64, oneshot::Receiver<Value>)> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.pending.is_empty() {
            return None;
        }
        inner.next += 1;
        let id = inner.next;
        let (tx, rx) = oneshot::channel();
        inner.pending.insert(id, tx);
        Some((id, rx))
    }

    fn end(&self, id: u64) {
        self.inner.lock().unwrap().pending.remove(&id);
    }
}

/// Whether `request` is one the webview can take: a guess with its picture, or a draw.
fn valid(request: &Value) -> bool {
    match request.get("kind").and_then(Value::as_str) {
        Some("guess") => request.get("png").and_then(Value::as_str).is_some_and(|p| !p.is_empty()),
        Some("draw") => true,
        _ => false,
    }
}

/// The page's answer for the webview's reply.
fn answer(reply: Value) -> Value {
    match reply.get("result") {
        Some(result) if !result.is_null() => json!({ "status": "ok", "result": result }),
        _ => json!({
            "status": "error",
            "message": reply.get("error").and_then(Value::as_str).unwrap_or("nothing came back"),
        }),
    }
}

/// `POST /office/api/pictionary`: Duck's guess at a picture, or a word drawn.
pub(super) async fn ask(State(state): State<Arc<RemoteState>>, headers: HeaderMap, body: Bytes) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if body.len() > REQUEST_MAX {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let Ok(request) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !valid(&request) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let game = &state.office.pictionary;
    let Some((id, rx)) = game.begin() else {
        return no_store(json!({ "status": "busy" }));
    };
    let _ = state.app.emit("office-pictionary", json!({ "id": id, "request": request }));
    let reply = tokio::time::timeout(Duration::from_secs(REPLY_SECS), rx).await;
    game.end(id);
    no_store(match reply {
        Ok(Ok(reply)) => answer(reply),
        Ok(Err(_)) => json!({ "status": "error", "message": "Workbench dropped the request" }),
        Err(_) => json!({ "status": "error", "message": "Workbench didn't answer in time" }),
    })
}

fn no_store(body: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_a_guess_with_a_picture_or_a_draw() {
        assert!(valid(&json!({ "kind": "guess", "png": "iVBOR", "guessed": [] })));
        assert!(valid(&json!({ "kind": "draw", "avoid": ["cat"] })));
        assert!(!valid(&json!({ "kind": "guess", "png": "" })));
        assert!(!valid(&json!({ "kind": "guess" })));
        assert!(!valid(&json!({ "kind": "paint" })));
        assert!(!valid(&json!([])));
    }

    #[test]
    fn one_call_is_out_at_a_time() {
        let p = Pictionary::default();
        let (id, rx) = p.begin().unwrap();
        assert!(p.begin().is_none());
        p.reply(id, json!({ "result": { "kind": "guess" } }));
        assert_eq!(rx.blocking_recv().unwrap()["result"]["kind"], "guess");
        p.end(id);
        assert!(p.begin().is_some());
    }

    #[test]
    fn a_reply_without_a_result_is_an_error() {
        assert_eq!(answer(json!({ "result": { "kind": "draw" } }))["status"], "ok");
        let e = answer(json!({ "result": null, "error": "the model declined" }));
        assert_eq!((e["status"].as_str(), e["message"].as_str()), (Some("error"), Some("the model declined")));
        assert_eq!(answer(json!({}))["message"], "nothing came back");
    }
}
