//! The phone's transcript socket (step R4): `GET /api/transcript?instance=…`.
//!
//! One instance's conversation, fed by the same follow the desktop's transcript view
//! uses (step T1). The socket keeps a **cursor of its own** — the follow's notes only
//! say *that* lines were appended or the transcript moved — so a phone that falls
//! behind or reconnects reads exactly what it has not seen, never a line twice.
//!
//! Frames, all JSON text:
//!
//! - down `start { sessionId, offset }` — on connect: the live stream continues from
//!   `offset`; what is before it is history, asked for with `back`.
//! - down `resume { sessionId, offset }` — on a reconnect that named the transcript
//!   and offset it had got to (`?session=…&offset=…`): lines continue from there.
//! - down `lines { sessionId, lines, offset, nextOffset }` — appended lines.
//! - down `rotated { sessionId, offset, reason }` — another transcript (`/clear`, a
//!   resumed session) or a truncated file: start over, history before `offset`.
//! - up `back { id, before }` → down `page { id, sessionId, lines, offset,
//!   nextOffset, end }` — the page of history ending at `before`.
//!
//! **Only the conversation travels.** Most of a transcript is bookkeeping the
//! renderer never shows — one trivial prompt appends ~270 KB, nearly all of it
//! `attachment` lines. Lines are cut down to what `transcript/model.ts` keeps (main-
//! thread `user` / `assistant` / `system` entries) before they leave, and an Edit
//! result loses the copy of the whole file it carries. Offsets still describe the
//! file, so the cursor stays exact.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::broadcast;

use super::server::{ws_authed, SUBPROTOCOL};
use super::{device_valid, RemoteState};
use crate::transcript::stream::{self, Lines, Note};

#[derive(Deserialize)]
pub(super) struct TranscriptQuery {
    #[serde(default)]
    instance: String,
    /// The transcript a reconnecting phone was reading…
    session: Option<String>,
    /// …and the offset it had got to.
    offset: Option<u64>,
}

/// Upgrade to the transcript socket (auth as `/api/ws`).
pub(super) async fn api_transcript(
    ws: WebSocketUpgrade,
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TranscriptQuery>,
) -> Response {
    let device = match ws_authed(&state, &headers, peer) {
        Ok(id) => id,
        Err(refusal) => return refusal,
    };
    ws.protocols([SUBPROTOCOL]).on_upgrade(move |socket| {
        let allowed = {
            let state = state.clone();
            move || device_valid(&state, &device)
        };
        follow(socket, state, q, allowed)
    })
}

/// Serve the transcript `q` asks for on `socket`, until it closes or, checked whenever
/// access changes anywhere, `allowed()` says no. The office's socket uses this too.
pub(super) async fn follow(
    socket: WebSocket,
    state: Arc<RemoteState>,
    q: TranscriptQuery,
    allowed: impl Fn() -> bool + Send + 'static,
) {
    let resume = q.session.zip(q.offset);
    handle(socket, state, q.instance, resume, allowed).await
}

/// Gives the follow back however the socket ends.
struct Hold {
    app: AppHandle,
    instance_id: String,
}

impl Drop for Hold {
    fn drop(&mut self) {
        stream::release(&self.app, &self.instance_id);
    }
}

/// Where this socket is in the instance's transcript.
struct Cursor {
    session_id: Option<String>,
    path: Option<PathBuf>,
    /// Everything before this has been sent (or is history).
    offset: u64,
}

async fn handle(
    mut socket: WebSocket,
    state: Arc<RemoteState>,
    instance_id: String,
    resume: Option<(String, u64)>,
    allowed: impl Fn() -> bool,
) {
    let app = state.app.clone();
    let mut kick = state.kick.subscribe();
    // Notes first, then the follow, so nothing is appended unseen between the two.
    let mut notes = stream::subscribe(&app);
    let Ok(at) = stream::acquire(&app, &instance_id) else {
        return;
    };
    let _hold = Hold { app: app.clone(), instance_id: instance_id.clone() };

    let mut cur = Cursor { session_id: at.session_id, path: at.path, offset: at.offset };
    let resumed = match (&resume, &cur.session_id, &cur.path) {
        (Some((session, offset)), Some(now), Some(path)) if session == now => {
            // Only an offset inside the file is a place to continue from.
            stream::read_forward(path, *offset, 1)
                .is_ok_and(|l| *offset <= l.end)
                .then_some(*offset)
        }
        _ => None,
    };
    let hello = match resumed {
        Some(offset) => {
            cur.offset = offset;
            json!({ "type": "resume", "sessionId": cur.session_id, "offset": offset })
        }
        None => json!({ "type": "start", "sessionId": cur.session_id, "offset": cur.offset }),
    };
    if !send(&mut socket, &hello).await || !pump(&mut socket, &app, &instance_id, &mut cur).await {
        return;
    }

    loop {
        tokio::select! {
            note = notes.recv() => {
                let ok = match note {
                    Ok(Note::Appended { instance_id: id }) if id == instance_id => {
                        pump(&mut socket, &app, &instance_id, &mut cur).await
                    }
                    Ok(Note::Rotated { instance_id: id, session_id, path, offset, reason })
                        if id == instance_id =>
                    {
                        // The last lines of the transcript being left, then the new one.
                        let to = stream::Position { session_id, path, offset };
                        pump(&mut socket, &app, &instance_id, &mut cur).await
                            && rotate(&mut socket, &app, &instance_id, &mut cur, to, reason).await
                    }
                    Ok(_) => true,
                    // Missed some notes: a rotation may be among them, so ask the
                    // follow where it is now.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        match stream::position(&app, &instance_id) {
                            Some(p) if p.session_id != cur.session_id => {
                                rotate(&mut socket, &app, &instance_id, &mut cur, p, "session").await
                            }
                            _ => pump(&mut socket, &app, &instance_id, &mut cur).await,
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => false,
                };
                if !ok {
                    break;
                }
            },
            _ = kick.changed() => {
                if !allowed() {
                    break;
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    if let Some(reply) = request(&cur, t.as_str()) {
                        if !send(&mut socket, &reply).await {
                            break;
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
}

async fn send(socket: &mut WebSocket, frame: &Value) -> bool {
    socket.send(Message::Text(frame.to_string().into())).await.is_ok()
}

/// Send what was appended since the cursor, and move it on.
async fn pump(socket: &mut WebSocket, app: &AppHandle, instance_id: &str, cur: &mut Cursor) -> bool {
    if cur.path.is_none() && cur.session_id.is_some() {
        // A new session's file only appears with its first line, and the follow
        // takes it up without a rotation (nothing to start over): ask it.
        if let Some(p) = stream::position(app, instance_id) {
            if p.session_id == cur.session_id {
                cur.path = p.path;
            }
        }
    }
    let Some(path) = cur.path.clone() else { return true };
    loop {
        let Ok(chunk) = stream::read_forward(&path, cur.offset, stream::CHUNK_BYTES) else {
            return true; // not written yet, or briefly unreadable — the next note
        };
        if chunk.next_offset <= cur.offset {
            return true;
        }
        cur.offset = chunk.next_offset;
        // Sent even when nothing in it is conversation, so the phone's offset (what a
        // reconnect resumes from) keeps up.
        let frame = json!({
            "type": "lines",
            "sessionId": cur.session_id,
            "lines": conversation(chunk.lines),
            "offset": chunk.offset,
            "nextOffset": chunk.next_offset,
        });
        if !send(socket, &frame).await {
            return false;
        }
    }
}

async fn rotate(
    socket: &mut WebSocket,
    app: &AppHandle,
    instance_id: &str,
    cur: &mut Cursor,
    to: stream::Position,
    reason: &str,
) -> bool {
    *cur = Cursor { session_id: to.session_id, path: to.path, offset: to.offset };
    let frame = json!({
        "type": "rotated",
        "sessionId": cur.session_id,
        "offset": cur.offset,
        "reason": reason,
    });
    send(socket, &frame).await && pump(socket, app, instance_id, cur).await
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Request {
    Back { id: u64, before: Option<u64> },
}

/// Answer a request frame; anything unrecognised is ignored.
fn request(cur: &Cursor, text: &str) -> Option<Value> {
    let Ok(Request::Back { id, before }) = serde_json::from_str(text) else {
        return None;
    };
    let page = cur.path.as_ref().map_or_else(Lines::default, |p| history(p, before));
    Some(json!({
        "type": "page",
        "id": id,
        "sessionId": cur.session_id,
        "lines": page.lines,
        "offset": page.offset,
        "nextOffset": page.next_offset,
        "end": page.end,
    }))
}

/// The page of conversation ending at `before`. Pages with nothing to show (a run of
/// bookkeeping) are skipped, so an empty page always means the top of the file —
/// which is how the feed knows history is exhausted.
fn history(path: &std::path::Path, before: Option<u64>) -> Lines {
    let mut before = before;
    let mut next_offset = None;
    loop {
        let Ok(page) = stream::read_back(path, before, stream::CHUNK_BYTES) else {
            return Lines::default();
        };
        let next = *next_offset.get_or_insert(page.next_offset);
        let lines = conversation(page.lines);
        if !lines.is_empty() || page.offset == 0 || page.offset >= before.unwrap_or(u64::MAX) {
            return Lines { lines, offset: page.offset, next_offset: next, end: page.end };
        }
        before = Some(page.offset);
    }
}

/// The lines the transcript model shows, each cut to what it reads (see the module
/// note). A line that isn't JSON is dropped; the model would skip it too.
fn conversation(lines: Vec<String>) -> Vec<String> {
    lines
        .into_iter()
        .filter_map(|raw| {
            let mut v: Value = serde_json::from_str(&raw).ok()?;
            let kind = v.get("type")?.as_str()?;
            if !matches!(kind, "user" | "assistant" | "system")
                || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
            {
                return None;
            }
            let carries_file = v
                .get_mut("toolUseResult")
                .and_then(Value::as_object_mut)
                .and_then(|r| r.remove("originalFile"))
                .is_some();
            Some(if carries_file { v.to_string() } else { raw })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/transcript/fixtures")
    }

    /// Bookkeeping and the other thread's lines stay home; conversation goes through,
    /// untouched unless it carried a whole file.
    #[test]
    fn only_conversation_travels() {
        let lines = vec![
            r#"{"type":"attachment","uuid":"a","attachment":{"x":1}}"#.to_string(),
            r#"{"type":"user","uuid":"u","message":{"content":"hi"}}"#.to_string(),
            r#"{"type":"assistant","uuid":"s","isSidechain":true}"#.to_string(),
            r#"{"type":"user","uuid":"r","toolUseResult":{"filePath":"a.rs","originalFile":"…"}}"#
                .to_string(),
            "not json".to_string(),
            r#"{"type":"system","uuid":"y"}"#.to_string(),
        ];
        let out = conversation(lines.clone());
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], lines[1]);
        let edited: Value = serde_json::from_str(&out[1]).unwrap();
        assert_eq!(edited["toolUseResult"], json!({ "filePath": "a.rs" }));
        assert_eq!(out[2], lines[5]);
    }

    /// The real session, paged back the way the phone does: every page has something
    /// to show until the top, pages tile the file, and together they hold exactly the
    /// session's conversation lines — far fewer bytes than the file.
    #[test]
    fn history_skips_pages_with_nothing_to_show() {
        let mut names: Vec<_> = std::fs::read_dir(fixtures())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".jsonl") && !n.contains("sidechain") && !n.starts_with("16"))
            .collect();
        names.sort();
        let bytes: Vec<u8> =
            names.iter().flat_map(|n| std::fs::read(fixtures().join(n)).unwrap()).collect();
        // Bookkeeping lines padded out the way a real prompt's attachments are, so a
        // page can hold nothing else.
        let pad = format!("{{\"type\":\"attachment\",\"pad\":\"{}\"}}\n", "x".repeat(300_000));
        let mut file = pad.repeat(2).into_bytes();
        file.extend_from_slice(&bytes);
        file.extend_from_slice(pad.repeat(3).as_bytes());

        let dir = std::env::temp_dir().join(format!(
            "wb-remote-tx-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        std::fs::write(&path, &file).unwrap();

        let mut pages = Vec::new();
        let mut before = None;
        let mut sent = 0;
        loop {
            let page = history(&path, before);
            assert_eq!(page.next_offset, before.unwrap_or(file.len() as u64));
            sent += page.lines.iter().map(String::len).sum::<usize>();
            if page.lines.is_empty() {
                assert_eq!(page.offset, 0);
                break;
            }
            before = Some(page.offset);
            pages.push(page.lines);
            if page.offset == 0 {
                break;
            }
        }
        let got: Vec<String> = pages.into_iter().rev().flatten().collect();
        let want = conversation(
            String::from_utf8_lossy(&bytes)
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect(),
        );
        assert_eq!(got, want);
        assert!(sent < file.len() / 4);
        std::fs::remove_dir_all(&dir).ok();
    }
}
