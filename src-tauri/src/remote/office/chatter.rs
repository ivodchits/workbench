//! Chatter (office plan O4.1): short scenes for idle workers who meet, written by
//! Haiku. The page asks here (`POST /office/api/chatter`); this side decides whether
//! a call may be made — chatter on, under the hour's calls and the day's tokens, no
//! other one out — and hands it to the webview as an `office-chatter` event. The
//! webview owns the API client (`src/state/officeChatter.ts`) and answers with
//! `office_chatter_reply`. Off or over budget, nothing reaches the webview and no call
//! is made: the page plays its canned lines.
//!
//! The settings (`office.chatter`) and the ledger (`office.chatter.usage`) live in the
//! app DB's `meta` table. The day is the page's local date; a new one starts the tally
//! again. A call's tokens are known only once it's back, so a day can end one call
//! over its budget.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

use super::super::server::bearer;
use super::super::RemoteState;

const SETTINGS_KEY: &str = "office.chatter";
const USAGE_KEY: &str = "office.chatter.usage";
/// The largest scene request the page may send.
const REQUEST_MAX: usize = 16 * 1024;
/// How long the webview has to answer.
const REPLY_SECS: u64 = 30;
const HOUR_SECS: u64 = 3600;
const PER_HOUR_MAX: u64 = 120;
const TOKENS_MIN: u64 = 1_000;
const TOKENS_MAX: u64 = 2_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Model {
    Haiku,
    Sonnet,
}

/// What the user set; anything missing or out of range is the default.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Settings {
    on: bool,
    model: Model,
    /// Calls in any hour.
    per_hour: u32,
    /// Tokens (in and out) in a day.
    tokens_per_day: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { on: true, model: Model::Haiku, per_hour: 20, tokens_per_day: 50_000 }
    }
}

impl Settings {
    fn from_value(v: &Value) -> Settings {
        let d = Settings::default();
        let num = |k: &str, min: u64, max: u64, def: u32| {
            v.get(k).and_then(Value::as_u64).map_or(def, |n| n.clamp(min, max) as u32)
        };
        Settings {
            on: v.get("on").and_then(Value::as_bool).unwrap_or(d.on),
            model: match v.get("model").and_then(Value::as_str) {
                Some("sonnet") => Model::Sonnet,
                Some("haiku") => Model::Haiku,
                _ => d.model,
            },
            per_hour: num("perHour", 1, PER_HOUR_MAX, d.per_hour),
            tokens_per_day: num("tokensPerDay", TOKENS_MIN, TOKENS_MAX, d.tokens_per_day),
        }
    }

    /// These settings with `patch`'s fields over them.
    fn patched(&self, patch: &Map<String, Value>) -> Settings {
        let mut v = serde_json::to_value(self).unwrap_or_default();
        if let Value::Object(o) = &mut v {
            o.extend(patch.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
        Settings::from_value(&v)
    }
}

/// What has been spent: the day's tokens and the last hour's calls (epoch seconds).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Ledger {
    day: String,
    tokens: u64,
    calls: Vec<u64>,
}

#[derive(Debug, PartialEq)]
enum Verdict {
    Go,
    Off,
    /// The hour's calls are spent.
    Hour,
    /// The day's tokens are spent.
    Day,
    /// Another call is out.
    Busy,
}

impl Verdict {
    fn status(&self) -> &'static str {
        match self {
            Verdict::Go => "ok",
            Verdict::Off => "off",
            Verdict::Hour => "hour",
            Verdict::Day => "day",
            Verdict::Busy => "busy",
        }
    }
}

impl Ledger {
    /// Forget calls older than an hour, and the tokens of another day (`day` None:
    /// keep the day, as a status read does).
    fn roll(&mut self, day: Option<&str>, now: u64) {
        if let Some(day) = day.filter(|d| *d != self.day) {
            self.day = day.to_string();
            self.tokens = 0;
        }
        self.calls.retain(|t| *t <= now && now - t < HOUR_SECS);
    }

    fn verdict(&self, s: &Settings, busy: bool) -> Verdict {
        if !s.on {
            Verdict::Off
        } else if self.calls.len() >= s.per_hour as usize {
            Verdict::Hour
        } else if self.tokens >= u64::from(s.tokens_per_day) {
            Verdict::Day
        } else if busy {
            Verdict::Busy
        } else {
            Verdict::Go
        }
    }

    fn usage(&self, s: &Settings) -> Value {
        json!({
            "callsThisHour": self.calls.len(),
            "perHour": s.per_hour,
            "tokensToday": self.tokens,
            "tokensPerDay": s.tokens_per_day,
        })
    }
}

#[derive(Default)]
pub(super) struct Chatter {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Read from the DB on first use.
    ledger: Option<Ledger>,
    /// The call out to the webview, by id, and the next id.
    pending: HashMap<u64, oneshot::Sender<Value>>,
    next: u64,
}

impl Chatter {
    /// Hand the webview's answer to the request waiting for it.
    pub(super) fn reply(&self, id: u64, reply: Value) {
        if let Some(tx) = self.inner.lock().unwrap().pending.remove(&id) {
            let _ = tx.send(reply); // Err: it gave up waiting
        }
    }
}

fn db(state: &RemoteState) -> tauri::State<'_, crate::db::Db> {
    state.app.state::<crate::db::Db>()
}

fn load_settings(state: &RemoteState) -> Settings {
    db(state)
        .meta_get(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| Settings::from_value(&v))
        .unwrap_or_default()
}

/// The ledger, read from the DB the first time.
fn ledger<'a>(inner: &'a mut Inner, state: &RemoteState) -> &'a mut Ledger {
    inner.ledger.get_or_insert_with(|| {
        db(state)
            .meta_get(USAGE_KEY)
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    })
}

fn save_ledger(state: &RemoteState, ledger: &Ledger) {
    if let Ok(s) = serde_json::to_string(ledger) {
        if let Err(e) = db(state).meta_set(USAGE_KEY, &s) {
            eprintln!("[office] chatter usage not saved: {e}");
        }
    }
}

fn no_store(body: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

/// The settings and what's been spent, for the page's sidebar.
fn status(state: &RemoteState, settings: &Settings) -> Value {
    let mut inner = state.office.chatter.inner.lock().unwrap();
    let ledger = ledger(&mut inner, state);
    ledger.roll(None, super::super::now());
    json!({ "settings": settings, "usage": ledger.usage(settings) })
}

/// `GET /office/api/chatter`: the settings and usage.
pub(super) async fn get(State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    no_store(status(&state, &load_settings(&state)))
}

/// `PUT /office/api/chatter`: change some settings (a JSON object of them).
pub(super) async fn put(State(state): State<Arc<RemoteState>>, headers: HeaderMap, body: Bytes) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(Value::Object(patch)) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let settings = load_settings(&state).patched(&patch);
    let saved = serde_json::to_string(&settings).map_err(|e| e.to_string()).and_then(|s| {
        db(&state).meta_set(SETTINGS_KEY, &s).map_err(|e| e.to_string())
    });
    if saved.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    no_store(status(&state, &settings))
}

/// `POST /office/api/chatter`: a scene for the request's speakers, or why not. The
/// request needs `day` (the page's local date); the rest goes to the webview as it is.
pub(super) async fn ask(State(state): State<Arc<RemoteState>>, headers: HeaderMap, body: Bytes) -> Response {
    if !state.office.valid(bearer(&headers).as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if body.len() > REQUEST_MAX {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let Ok(request @ Value::Object(_)) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(day) = request.get("day").and_then(Value::as_str).filter(|d| !d.is_empty() && d.len() <= 16) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let day = day.to_string();
    let settings = load_settings(&state);
    let now = super::super::now();
    let chatter = &state.office.chatter;
    let (id, rx) = {
        let mut inner = chatter.inner.lock().unwrap();
        let busy = !inner.pending.is_empty();
        let l = ledger(&mut inner, &state);
        l.roll(Some(&day), now);
        let verdict = l.verdict(&settings, busy);
        if verdict != Verdict::Go {
            return no_store(json!({ "status": verdict.status(), "usage": l.usage(&settings) }));
        }
        l.calls.push(now);
        save_ledger(&state, l);
        inner.next += 1;
        let id = inner.next;
        let (tx, rx) = oneshot::channel();
        inner.pending.insert(id, tx);
        (id, rx)
    };
    let _ = state.app.emit("office-chatter", json!({ "id": id, "model": settings.model, "request": request }));
    let reply = tokio::time::timeout(Duration::from_secs(REPLY_SECS), rx).await;
    let mut inner = chatter.inner.lock().unwrap();
    inner.pending.remove(&id);
    let l = ledger(&mut inner, &state);
    let mut out = match reply {
        Ok(Ok(reply)) => {
            let tokens = reply.get("tokens").and_then(Value::as_u64).unwrap_or(0);
            if tokens > 0 && l.day == day {
                l.tokens += tokens;
                save_ledger(&state, l);
            }
            match reply.get("scene") {
                Some(scene) if !scene.is_null() => json!({ "status": "ok", "scene": scene }),
                _ => json!({
                    "status": "error",
                    "message": reply.get("error").and_then(Value::as_str).unwrap_or("no scene came back"),
                }),
            }
        }
        Ok(Err(_)) => json!({ "status": "error", "message": "Workbench dropped the request" }),
        Err(_) => json!({ "status": "error", "message": "Workbench didn't answer in time" }),
    };
    out["usage"] = l.usage(&settings);
    no_store(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_take_valid_fields_and_default_the_rest() {
        assert_eq!(Settings::from_value(&json!({})), Settings::default());
        let s = Settings::from_value(&json!({ "on": false, "model": "sonnet", "perHour": 5, "tokensPerDay": 9000 }));
        assert_eq!(s, Settings { on: false, model: Model::Sonnet, per_hour: 5, tokens_per_day: 9000 });
        let s = Settings::from_value(&json!({ "on": "yes", "model": "opus", "perHour": 9999, "tokensPerDay": 3 }));
        assert_eq!(s, Settings { per_hour: PER_HOUR_MAX as u32, tokens_per_day: TOKENS_MIN as u32, ..Settings::default() });
        let off = Settings::default().patched(json!({ "on": false }).as_object().unwrap());
        assert_eq!(off, Settings { on: false, ..Settings::default() });
    }

    #[test]
    fn the_budget_holds() {
        let s = Settings { per_hour: 2, tokens_per_day: 1000, ..Settings::default() };
        let mut l = Ledger::default();
        l.roll(Some("2026-10-28"), 10_000);
        assert_eq!(l.verdict(&s, false), Verdict::Go);
        assert_eq!(l.verdict(&s, true), Verdict::Busy);
        assert_eq!(l.verdict(&Settings { on: false, ..s.clone() }, false), Verdict::Off);
        l.calls.extend([10_000, 10_100]);
        assert_eq!(l.verdict(&s, false), Verdict::Hour);
        // An hour after the first call, one is free again.
        l.roll(Some("2026-10-28"), 10_000 + HOUR_SECS);
        assert_eq!(l.calls, vec![10_100]);
        l.tokens = 1000;
        assert_eq!(l.verdict(&s, false), Verdict::Day);
        // A status read keeps the day; a new day starts the tokens again.
        l.roll(None, 10_000 + HOUR_SECS);
        assert_eq!(l.tokens, 1000);
        l.roll(Some("2026-10-29"), 10_000 + HOUR_SECS);
        assert_eq!((l.day.as_str(), l.tokens), ("2026-10-29", 0));
        assert_eq!(l.verdict(&s, false), Verdict::Go);
    }

    #[test]
    fn off_is_checked_before_anything_else() {
        let s = Settings { on: false, per_hour: 1, ..Settings::default() };
        let l = Ledger { day: "d".into(), tokens: u64::MAX, calls: vec![1, 2, 3] };
        assert_eq!(l.verdict(&s, true), Verdict::Off);
    }
}
