//! The morning standup (office plan O5.5): idle workers gather at the table in Duck's
//! office and say what their projects got done the day before. The page asks here
//! (`POST /office/api/standup`) with its date; one call is out at a time, and it goes
//! to the webview as an `office-standup` event. The webview reads the transcripts and
//! has Haiku summarise them (`src/state/officeStandup.ts`), answering with
//! `office_standup_reply`.
//!
//! The day reported on is over, so its summaries won't change: the answer is kept
//! (`office.standup` in the DB's `meta`) for the page's date, and a second standup
//! that day costs nothing unless the page asks `fresh`. It's asked for by a click, so
//! there's no budget beyond Duck's own: a few Haiku calls, one per project.

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

const KEPT_KEY: &str = "office.standup";
const REQUEST_MAX: usize = 1024;
/// How long the webview has: reading the transcripts and a call per project.
const REPLY_SECS: u64 = 120;

#[derive(Default)]
pub(super) struct Standup {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// The call out to the webview, by id, and the next id.
    pending: HashMap<u64, oneshot::Sender<Value>>,
    next: u64,
}

impl Standup {
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

/// The request's date, when it looks like one (`YYYY-MM-DD`).
fn today(request: &Value) -> Option<&str> {
    let d = request.get("today")?.as_str()?;
    let ok = d.len() == 10 && d.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    ok.then_some(d)
}

/// The result kept for `today`, from what's stored.
fn kept_for(stored: &Value, today: &str) -> Option<Value> {
    (stored.get("today")?.as_str()? == today).then(|| stored.get("result").cloned()).flatten().filter(|r| r.is_object())
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

fn kept(state: &RemoteState, today: &str) -> Option<Value> {
    let stored = db(state).meta_get(KEPT_KEY).ok().flatten()?;
    kept_for(&serde_json::from_str(&stored).ok()?, today)
}

fn keep(state: &RemoteState, today: &str, result: &Value) {
    let saved = json!({ "today": today, "result": result }).to_string();
    if let Err(e) = db(state).meta_set(KEPT_KEY, &saved) {
        eprintln!("[office] standup not kept: {e}");
    }
}

/// `POST /office/api/standup`: what each project got done on the last day with
/// sessions before the page's date.
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
    let fresh = request.get("fresh").and_then(Value::as_bool).unwrap_or(false);
    if !fresh {
        if let Some(result) = kept(&state, &day) {
            return no_store(json!({ "status": "ok", "result": result }));
        }
    }
    let standup = &state.office.standup;
    let Some((id, rx)) = standup.begin() else {
        return no_store(json!({ "status": "busy" }));
    };
    let _ = state.app.emit("office-standup", json!({ "id": id, "request": { "today": day } }));
    let reply = tokio::time::timeout(Duration::from_secs(REPLY_SECS), rx).await;
    standup.end(id);
    no_store(match reply {
        Ok(Ok(reply)) => {
            let out = answer(&reply);
            if out["status"] == "ok" {
                keep(&state, &day, &out["result"]);
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
        assert_eq!(today(&json!({ "today": "2026-10-28" })), Some("2026-10-28"));
        assert_eq!(today(&json!({ "today": "2026-10-28", "fresh": true })), Some("2026-10-28"));
        assert_eq!(today(&json!({ "today": "28/10/2026" })), None);
        assert_eq!(today(&json!({ "today": "2026-10-2" })), None);
        assert_eq!(today(&json!({ "today": 20261028 })), None);
        assert_eq!(today(&json!({})), None);
    }

    #[test]
    fn an_answer_is_kept_for_its_day_only() {
        let stored = json!({ "today": "2026-10-28", "result": { "day": "2026-10-27", "reports": [] } });
        assert_eq!(kept_for(&stored, "2026-10-28").unwrap()["day"], "2026-10-27");
        assert!(kept_for(&stored, "2026-10-29").is_none());
        assert!(kept_for(&json!({ "today": "2026-10-28", "result": null }), "2026-10-28").is_none());
        assert!(kept_for(&json!([]), "2026-10-28").is_none());
    }

    #[test]
    fn a_reply_without_a_result_is_an_error() {
        assert_eq!(answer(&json!({ "result": { "day": null, "reports": [] } }))["status"], "ok");
        let e = answer(&json!({ "result": null, "error": "no API key" }));
        assert_eq!((e["status"].as_str(), e["message"].as_str()), (Some("error"), Some("no API key")));
        assert_eq!(answer(&json!({}))["message"], "nothing came back");
    }

    #[test]
    fn one_call_is_out_at_a_time() {
        let s = Standup::default();
        let (id, rx) = s.begin().unwrap();
        assert!(s.begin().is_none());
        s.reply(id, json!({ "result": {} }));
        assert!(rx.blocking_recv().unwrap()["result"].is_object());
        s.end(id);
        assert!(s.begin().is_some());
    }
}
