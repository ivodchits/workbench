//! Duck on the phone (step R1): the remote server's assistant routes.
//!
//! - `GET /api/assistant` — WebSocket carrying the Duck Protocol
//!   (`src/assistant/protocol.ts`, the phone's frames in `src/remote/protocol.ts`).
//!   Auth as `/api/ws` ([`ws_authed`]).
//! - `POST /api/assistant/audio` — a 16 kHz mono WAV of at most 60 s, transcribed
//!   with V1's model; answers `{text}`. Auth: bearer. The body limit is raised to
//!   4 MB on this route only.
//! - `GET /api/assistant/tts/{id}` — one sentence of a spoken reply the desktop
//!   made for the phone (`audio/wav`, kept a few minutes). Auth: bearer.
//!
//! Like the dashboard, Duck runs in the webview, so this is a bridge (the
//! `remote-action` and snapshot patterns):
//! - Up: each socket is numbered; its opening, its frames and its closing go to the
//!   webview as `assistant-remote-input` (`src/assistant/remoteBridge.ts`), which
//!   checks what the phone may do and hands it to Duck.
//! - Down: the webview sends Duck's events back with [`assistant_remote_emit`],
//!   either to every socket or to the one that asked.

use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::sync::broadcast;

use super::server::{authed, bearer, client_addr, ws_authed, SUBPROTOCOL};
use super::{device_valid, RemoteState};
use crate::voice::tts::TtsState;
use crate::voice::VoiceState;

const INPUT_EVENT: &str = "assistant-remote-input";
/// Longest phone clip, in samples at 16 kHz.
const AUDIO_MAX_SAMPLES: usize = 60 * 16_000;
/// The audio route's body limit.
pub(super) const AUDIO_BODY_MAX: usize = 4 * 1024 * 1024;
/// The largest frame a phone may send (a long message is still far below it).
const FRAME_MAX: usize = 256 * 1024;

/// One frame for the phones: to every socket, or to one.
#[derive(Clone)]
pub(super) struct DuckFrame {
    pub to: Option<u64>,
    pub json: Arc<str>,
}

impl DuckFrame {
    fn for_conn(&self, conn: u64) -> bool {
        self.to.is_none_or(|c| c == conn)
    }
}

#[derive(Clone, Serialize)]
struct Input<'a> {
    conn: u64,
    device: &'a str,
    /// `open`, `message` or `close`.
    kind: &'static str,
    msg: Option<Value>,
}

fn input(app: &AppHandle, conn: u64, device: &str, kind: &'static str, msg: Option<Value>) {
    let _ = app.emit(INPUT_EVENT, Input { conn, device, kind, msg });
}

/// Upgrade to Duck's socket.
pub(super) async fn api_assistant(
    ws: WebSocketUpgrade,
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let device = match ws_authed(&state, &headers, peer) {
        Ok(id) => id,
        Err(refusal) => return refusal,
    };
    ws.protocols([SUBPROTOCOL])
        .max_message_size(FRAME_MAX)
        .on_upgrade(move |socket| handle(socket, state, device))
}

/// Per-connection loop: relay Duck's frames meant for this socket down, and the
/// phone's frames up to the webview. Ends when either side closes, the server
/// stops, or the device loses access.
async fn handle(mut socket: WebSocket, state: Arc<RemoteState>, device: String) {
    let mut kick = state.kick.subscribe();
    let Some(mut rx) = state.inner.lock().unwrap().duck.as_ref().map(|tx| tx.subscribe()) else {
        return;
    };
    let conn = state.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
    input(&state.app, conn, &device, "open", None);
    loop {
        tokio::select! {
            frame = rx.recv() => match frame {
                Ok(f) => {
                    if f.for_conn(conn) && socket.send(Message::Text(f.json.as_ref().into())).await.is_err() {
                        break;
                    }
                }
                // Streamed text was lost; the phone asks for the thread again.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if socket.send(Message::Text(r#"{"type":"lagged"}"#.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = kick.changed() => {
                if !device_valid(&state, &device) {
                    break;
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(t))) => match serde_json::from_str::<Value>(t.as_str()) {
                    Ok(msg) => input(&state.app, conn, &device, "message", Some(msg)),
                    Err(_) => {
                        let _ = socket
                            .send(Message::Text(r#"{"type":"error","message":"not JSON"}"#.into()))
                            .await;
                    }
                },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
    input(&state.app, conn, &device, "close", None);
}

/// A phone clip as 16 kHz mono samples, or why not.
fn clip(body: &[u8]) -> Result<Vec<f32>, String> {
    let samples = crate::voice::parse_wav(body)?;
    if samples.len() > AUDIO_MAX_SAMPLES {
        return Err("the clip is longer than 60 s".into());
    }
    Ok(samples)
}

/// Transcribe the phone's clip.
pub(super) async fn audio(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(refusal) = authed(&state, bearer(&headers).as_deref(), &client_addr(peer, &headers)) {
        return refusal;
    }
    let samples = match clip(&body) {
        Ok(s) => s,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    };
    // The reply will likely be spoken: start the voice while this is transcribed,
    // as the desktop's push-to-talk press does.
    state.app.state::<TtsState>().warm_if_wanted();
    let app = state.app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || app.state::<VoiceState>().transcribe(&samples)).await;
    match result {
        Ok(Ok(t)) => Json(json!({ "text": t.text, "ms": t.ms })).into_response(),
        Ok(Err(e)) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": e }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

/// A sentence of a spoken reply, made for the phone.
pub(super) async fn tts(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(refusal) = authed(&state, bearer(&headers).as_deref(), &client_addr(peer, &headers)) {
        return refusal;
    }
    match state.app.state::<TtsState>().rendered(&id) {
        Some(wav) => (
            [(header::CONTENT_TYPE, "audio/wav"), (header::CACHE_CONTROL, "private, max-age=600")],
            wav.as_ref().clone(),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Send one of Duck's frames to the phones: to socket `conn`, or to all of them.
/// A no-op while the server is off.
#[tauri::command]
pub fn assistant_remote_emit(state: TauriState<'_, Arc<RemoteState>>, json: String, conn: Option<u64>) {
    if let Some(tx) = &state.inner().inner.lock().unwrap().duck {
        let _ = tx.send(DuckFrame { to: conn, json: json.into() });
    }
}

/// Push "Duck is waiting for you" to the phones (a confirmation, and no surface
/// open). Tapping it opens Duck on that thread.
#[tauri::command]
pub fn assistant_remote_push(app: AppHandle, thread_id: String, title: String, body: String) {
    super::push::send_all(
        &app,
        json!({ "title": title, "body": body, "threadId": thread_id, "tag": format!("duck-{thread_id}") }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_goes_to_its_socket_or_to_all() {
        let all = DuckFrame { to: None, json: "{}".into() };
        let one = DuckFrame { to: Some(2), json: "{}".into() };
        assert!(all.for_conn(1) && all.for_conn(2));
        assert!(one.for_conn(2) && !one.for_conn(1));
    }

    fn wav16k(seconds: usize) -> Vec<u8> {
        crate::voice::encode_wav(&vec![0.0; seconds * 16_000], 16_000)
    }

    #[test]
    fn takes_a_minute_of_16k_mono_and_no_more() {
        assert_eq!(clip(&wav16k(60)).unwrap().len(), 60 * 16_000);
        assert!(clip(&wav16k(61)).unwrap_err().contains("60 s"));
        assert!(clip(&crate::voice::encode_wav(&[0.0; 100], 24_000)).unwrap_err().contains("16 kHz"));
        assert!(clip(b"not a wav").is_err());
    }
}
