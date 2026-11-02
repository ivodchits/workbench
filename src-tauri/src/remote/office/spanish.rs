//! Fernando's Spanish lessons: the office page asks here (`POST /office/api/spanish`)
//! for the Spanish lessons' project and, when it opens the lessons, the word of the
//! day. The request goes to the webview as an `office-spanish` event; the webview
//! finds the project, reads the learner's level from it and has Haiku pick a word
//! (`src/state/officeSpanish.ts`), answering with `office_spanish_reply`.
//!
//! The word is kept (`office.spanish` in the DB's `meta`) for the page's date, so it's
//! one Haiku call a day at most, and the same word all day; the latest days' words are
//! kept with it and sent along, so a word isn't picked again soon. Calls don't wait on
//! each other: the page asks once when it opens and again when the lessons do.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

use super::super::server::bearer;
use super::super::RemoteState;

const KEPT_KEY: &str = "office.spanish";
const REQUEST_MAX: usize = 1024;
/// How long the webview has: reading two files and one Haiku call.
const REPLY_SECS: u64 = 60;
/// The latest words of the day kept, not to be picked again.
const RECENT_MAX: usize = 60;

#[derive(Default)]
pub(super) struct Spanish {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// The calls out to the webview, by id, and the next id.
    pending: HashMap<u64, oneshot::Sender<Value>>,
    next: u64,
}

impl Spanish {
    /// Hand the webview's answer to the request waiting for it.
    pub(super) fn reply(&self, id: u64, reply: Value) {
        if let Some(tx) = self.inner.lock().unwrap().pending.remove(&id) {
            let _ = tx.send(reply); // Err: it gave up waiting
        }
    }

    fn begin(&self) -> (u64, oneshot::Receiver<Value>) {
        let mut inner = self.inner.lock().unwrap();
        inner.next += 1;
        let id = inner.next;
        let (tx, rx) = oneshot::channel();
        inner.pending.insert(id, tx);
        (id, rx)
    }

    fn end(&self, id: u64) {
        self.inner.lock().unwrap().pending.remove(&id);
    }
}

/// The request's date, when it looks like one (`YYYY-MM-DD`).
fn today(request: &Value) -> Option<&str> {
    let d = request.get("today")?.as_str()?;
    let ok = d.len() == 10 && d.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    ok.then_some(d)
}

/// The word kept for `today`, and the latest days' words, from what's stored.
fn kept_for(stored: &Value, today: &str) -> (Option<Value>, Vec<String>) {
    let recent = stored
        .get("recent")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(|w| w.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let word = (stored.get("today").and_then(Value::as_str) == Some(today))
        .then(|| stored.get("word").cloned())
        .flatten()
        .filter(Value::is_object);
    (word, recent)
}

/// What's stored once `word` is today's: it, with its text added to the recent words.
fn stored_with(today: &str, word: &Value, mut recent: Vec<String>) -> Value {
    if let Some(text) = word.get("word").and_then(Value::as_str) {
        recent.retain(|w| w != text);
        recent.push(text.to_string());
    }
    let from = recent.len().saturating_sub(RECENT_MAX);
    json!({ "today": today, "word": word, "recent": &recent[from..] })
}

/// The page's answer for the webview's reply.
fn answer(reply: &Value) -> Value {
    match reply.get("result") {
        Some(result) if result.is_object() => json!({ "status": "ok", "result": result }),
        _ => json!({
            "status": "error",
            "message": reply.get("error").and_then(Value::as_str).unwrap_or("nothing came back"),
        }),
    }
}

fn db(state: &RemoteState) -> tauri::State<'_, crate::db::Db> {
    state.app.state::<crate::db::Db>()
}

fn stored(state: &RemoteState) -> Value {
    db(state).meta_get(KEPT_KEY).ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

/// `POST /office/api/spanish`: the Spanish lessons' project, and the word of the day.
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
    let Some(day) = today(&request).map(str::to_string) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let wants_word = request.get("word").and_then(Value::as_bool).unwrap_or(false);
    let (kept, recent) = kept_for(&stored(&state), &day);
    let spanish = &state.office.spanish;
    let (id, rx) = spanish.begin();
    let ask = json!({ "today": day, "word": wants_word, "kept": kept, "recent": recent });
    let _ = state.app.emit("office-spanish", json!({ "id": id, "request": ask }));
    let reply = tokio::time::timeout(Duration::from_secs(REPLY_SECS), rx).await;
    spanish.end(id);
    no_store(match reply {
        Ok(Ok(reply)) => {
            let out = answer(&reply);
            let word = &out["result"]["word"];
            if wants_word && kept.is_none() && word.is_object() {
                let saved = stored_with(&day, word, recent).to_string();
                if let Err(e) = db(&state).meta_set(KEPT_KEY, &saved) {
                    eprintln!("[office] word of the day not kept: {e}");
                }
            }
            out
        }
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
    fn the_request_names_a_date() {
        assert_eq!(today(&json!({ "today": "2026-11-02", "word": true })), Some("2026-11-02"));
        assert_eq!(today(&json!({ "today": "2/11/2026" })), None);
        assert_eq!(today(&json!({})), None);
    }

    #[test]
    fn a_word_is_kept_for_its_day_and_the_recent_ones_always() {
        let stored = json!({ "today": "2026-11-02", "word": { "word": "la alcancía" }, "recent": ["el chile", "la alcancía"] });
        let (word, recent) = kept_for(&stored, "2026-11-02");
        assert_eq!(word.unwrap()["word"], "la alcancía");
        assert_eq!(recent, ["el chile", "la alcancía"]);
        let (word, recent) = kept_for(&stored, "2026-11-03");
        assert!(word.is_none());
        assert_eq!(recent.len(), 2);
        assert_eq!(kept_for(&Value::Null, "2026-11-02"), (None, vec![]));
    }

    #[test]
    fn a_new_word_joins_the_recent_ones_and_the_oldest_drop() {
        let recent: Vec<String> = (0..RECENT_MAX).map(|n| format!("w{n}")).collect();
        let s = stored_with("2026-11-03", &json!({ "word": "el elote" }), recent);
        let r = s["recent"].as_array().unwrap();
        assert_eq!(r.len(), RECENT_MAX);
        assert_eq!(r[0], "w1");
        assert_eq!(r[RECENT_MAX - 1], "el elote");
        assert_eq!(s["today"], "2026-11-03");
        // Again, it moves to the end rather than showing twice.
        let s = stored_with("2026-11-04", &json!({ "word": "w5" }), vec!["w5".into(), "w6".into()]);
        assert_eq!(s["recent"], json!(["w6", "w5"]));
    }

    #[test]
    fn a_reply_without_a_result_is_an_error() {
        assert_eq!(answer(&json!({ "result": { "projectId": null } }))["status"], "ok");
        let e = answer(&json!({ "result": null, "error": "no API key" }));
        assert_eq!(e["message"], "no API key");
        assert_eq!(answer(&json!({}))["message"], "nothing came back");
    }
}
