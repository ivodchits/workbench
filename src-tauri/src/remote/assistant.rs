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
//! - `GET /api/assistant/image/{id}/{name}` — a stored image attachment (step G3: a
//!   drawing's PNG for the phone's viewer). PNG, JPEG, GIF and WebP only, never an
//!   SVG, which would be a page on this origin. Auth: bearer.
//!
//! Conversation mode on the phone (step V4 part 3) is this server's, not the
//! webview's: `conv.start` / `conv.stop` / `conv.playing` frames and the binary
//! audio frames (`AUDIO_PCM`, `AUDIO_GAP` in `src/remote/protocol.ts`) feed V4's
//! pipeline (`voice/conversation.rs`) here, and its `conv.*` frames go back to
//! that socket. The phone then sends the turns to Duck as any message.
//!
//! Its echo (step V7): the phone tells what it starts saying (`conv.said`), so the
//! pipeline knows Duck's own words when it hears them ([`Phone::said_lately`]),
//! and the desktop voice's audio for it, placed where it started in the phone's
//! stream, is the echo canceller's reference ([`Feed`]).
//! With the voice setting "save the phone's conversation audio" on, a run is
//! recorded for measuring that echo ([`crate::voice::phone_record`]).
//!
//! Like the dashboard, Duck runs in the webview, so this is a bridge (the
//! `remote-action` and snapshot patterns):
//! - Up: each socket is numbered; its opening, its frames and its closing go to the
//!   webview as `assistant-remote-input` (`src/assistant/remoteBridge.ts`), which
//!   checks what the phone may do and hands it to Duck.
//! - Down: the webview sends Duck's events back with [`assistant_remote_emit`],
//!   either to every socket or to the one that asked.
//!
//! The office's Duck chat (office plan O3.1) rides the same bridge ([`relay`]) as
//! the device `office`, on the office's own listener and channel.

use std::net::SocketAddr;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::sync::{broadcast, mpsc as tmpsc};

use super::server::{authed, bearer, client_addr, ws_authed, SUBPROTOCOL};
use super::{device_valid, RemoteState};
use crate::voice::aec::Feed;
use crate::voice::conversation::{self, Patience, StateEvent, Surface, TurnEvent};
use crate::voice::endpoint::Output;
use crate::voice::phone_record::{self, Recording};
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
        .on_upgrade(move |socket| async move {
            let Some(rx) = state.inner.lock().unwrap().duck.as_ref().map(|tx| tx.subscribe()) else {
                return;
            };
            let (st, id) = (state.clone(), device.clone());
            relay(socket, state, device, rx, move || device_valid(&st, &id), true).await
        })
}

// ── conversation mode on the phone (step V4 part 3) ──

const AUDIO_PCM: u8 = 0;
const AUDIO_GAP: u8 = 1;
/// The longest gap a frame may stand for (more is a broken page).
const GAP_MAX: usize = 10 * 16_000;

/// A binary frame as 16 kHz samples: speech as it came, or a gap of silence.
fn audio_block(b: &[u8]) -> Option<Vec<f32>> {
    match b.split_first()? {
        (&AUDIO_PCM, pcm) => Some(pcm.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0).collect()),
        (&AUDIO_GAP, n) if n.len() == 4 => {
            let n = u32::from_le_bytes([n[0], n[1], n[2], n[3]]) as usize;
            (n <= GAP_MAX).then(|| vec![0.0; n])
        }
        _ => None,
    }
}

/// What a phone said lately, sentence by sentence, kept this long.
const SAID_KEEP: Duration = Duration::from_secs(60);

/// The sentences a phone started saying, with when.
#[derive(Default)]
struct Said(VecDeque<(Instant, String)>);

impl Said {
    fn push(&mut self, at: Instant, text: &str) {
        self.0.retain(|(t, _)| at.duration_since(*t) < SAID_KEEP);
        self.0.push_back((at, text.to_string()));
    }

    /// The sentences started within `within` of `now`, and the one playing then.
    fn lately(&self, now: Instant, within: Duration) -> String {
        let last = self.0.len().saturating_sub(1);
        let texts: Vec<&str> = self
            .0
            .iter()
            .enumerate()
            .filter(|(i, (t, _))| *i == last || now.saturating_duration_since(*t) <= within)
            .map(|(_, (_, s))| s.as_str())
            .collect();
        texts.join(" ")
    }
}

/// A run's recording, while the setting is on.
type Rec = Arc<Mutex<Option<Recording>>>;

fn record(rec: &Rec, kind: &str, detail: Value) {
    if let Some(r) = rec.lock().unwrap().as_mut() {
        r.event(kind, detail);
    }
}

/// A phone as conversation mode's surface: its socket, what it says it's
/// playing and saying, and the recording. Its browser cancels its own echo, as
/// far as it can.
struct Phone {
    app: AppHandle,
    out: tmpsc::UnboundedSender<String>,
    playing: Arc<AtomicBool>,
    said: Arc<Mutex<Said>>,
    rec: Rec,
    feed: Arc<Feed>,
    /// The stream's samples so far.
    received: Arc<AtomicUsize>,
}

impl Phone {
    fn send(&self, v: Value) {
        let _ = self.out.send(v.to_string());
    }
}

impl Surface for Phone {
    fn state(&self, ev: &StateEvent) {
        self.send(json!({ "type": "conv.state", "run": ev.run, "state": ev.state, "held": ev.held, "message": ev.message }));
    }

    fn turn(&self, ev: &TurnEvent) {
        record(&self.rec, "turn", json!({ "text": ev.text, "phase": ev.phase }));
        self.send(json!({ "type": "conv.turn", "run": ev.run, "id": ev.id, "text": ev.text, "phase": ev.phase }));
    }

    fn level(&self, _: f32) {}

    fn sign(&self, _: bool) {}

    fn warm(&self) {
        self.app.state::<TtsState>().warm_if_wanted();
    }

    fn speaking(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }

    fn cut(&self) {
        record(&self.rec, "cut", Value::Null);
        self.feed.stop(self.received.load(Ordering::Relaxed));
        self.playing.store(false, Ordering::Relaxed);
        self.send(json!({ "type": "conv.cut" }));
    }

    fn cue(&self) {
        self.send(json!({ "type": "conv.cue" }));
    }

    fn said_lately(&self, within: Duration) -> String {
        self.said.lock().unwrap().lately(Instant::now(), within)
    }

    fn output(&self) -> Option<(Output, Option<String>)> {
        None
    }

    fn hold_output(&self, _: bool) {}

    fn finish(&self) {}

    fn note(&self, kind: &str, detail: Value) {
        record(&self.rec, kind, detail);
    }

    fn reference(&self) -> Option<Arc<Feed>> {
        Some(Arc::clone(&self.feed))
    }
}


/// A socket's conversation run.
struct PhoneRun {
    cmds: mpsc::Sender<conversation::Cmd>,
    audio: mpsc::Sender<Vec<f32>>,
    playing: Arc<AtomicBool>,
    said: Arc<Mutex<Said>>,
    rec: Rec,
    feed: Arc<Feed>,
    received: Arc<AtomicUsize>,
}

impl PhoneRun {
    /// Audio from the phone, for the run (and the recording).
    fn heard(&self, block: Vec<f32>) {
        self.received.fetch_add(block.len(), Ordering::Relaxed);
        if let Some(r) = self.rec.lock().unwrap().as_mut() {
            r.audio(&block);
        }
        let _ = self.audio.send(block);
    }
}

impl Drop for PhoneRun {
    fn drop(&mut self) {
        let _ = self.cmds.send(conversation::Cmd::Stop);
        if let Some(mut r) = self.rec.lock().unwrap().take() {
            r.event("feed", json!({ "delay_ms": self.feed.delay_ms() }));
            std::thread::spawn(move || match r.finish() {
                Ok(Some(dir)) => eprintln!("[voice] the phone's conversation was saved to {}", dir.display()),
                Ok(None) => {}
                Err(e) => eprintln!("[voice] the phone's conversation wasn't saved: {e}"),
            });
        }
    }
}

/// A `conv.*` frame from the phone: start, stop, or what it's playing.
fn conv_message(app: &AppHandle, run: &mut Option<PhoneRun>, out: &tmpsc::UnboundedSender<String>, msg: &Value) {
    match msg["type"].as_str() {
        Some("conv.start") => {
            *run = None;
            let patience = serde_json::from_value::<Patience>(msg["patience"].clone()).ok();
            let (audio, heard) = mpsc::channel();
            let playing = Arc::new(AtomicBool::new(false));
            let said = Arc::new(Mutex::new(Said::default()));
            let rec: Rec = Arc::new(Mutex::new(
                crate::voice::recording_phone(app)
                    .then(phone_record::data_dir)
                    .flatten()
                    .map(|root| Recording::new(root, json!({ "path": msg["path"], "voice": msg["voice"], "patience": msg["patience"] }))),
            ));
            let (feed, received) = (Arc::new(Feed::default()), Arc::new(AtomicUsize::new(0)));
            let io = Phone {
                app: app.clone(),
                out: out.clone(),
                playing: Arc::clone(&playing),
                said: Arc::clone(&said),
                rec: Arc::clone(&rec),
                feed: Arc::clone(&feed),
                received: Arc::clone(&received),
            };
            match crate::voice::start_phone_conversation(app, Box::new(io), heard, patience) {
                Some(cmds) => *run = Some(PhoneRun { cmds, audio, playing, said, rec, feed, received }),
                None => {
                    let _ = out.send(
                        json!({ "type": "conv.state", "run": 0, "state": "error", "held": false, "message": "Voice isn't available on the desktop." })
                            .to_string(),
                    );
                }
            }
        }
        Some("conv.stop") => *run = None,
        Some("conv.playing") => {
            if let Some(r) = run {
                let on = msg["on"].as_bool().unwrap_or(false);
                r.playing.store(on, Ordering::Relaxed);
                if !on {
                    r.feed.stop(r.received.load(Ordering::Relaxed));
                }
                record(&r.rec, "playing", json!({ "on": on }));
            }
        }
        Some("conv.said") => {
            if let Some(r) = run {
                let text = msg["text"].as_str().unwrap_or_default();
                r.said.lock().unwrap().push(Instant::now(), text);
                let wav = msg["id"].as_str().and_then(|id| app.state::<TtsState>().rendered(id));
                r.feed.place(r.received.load(Ordering::Relaxed), wav.as_deref().and_then(|w| crate::voice::wav_at_16k(w)));
                if let Some(rec) = r.rec.lock().unwrap().as_mut() {
                    rec.said(text, msg["voice"].as_str().unwrap_or("desktop"), wav);
                }
            }
        }
        _ => {}
    }
}

/// Per-connection loop: relay Duck's frames meant for this socket down, and the
/// phone's frames up to the webview (conversation mode's to its run here). Ends
/// when either side closes, the server stops, or the device loses access.
/// One Duck socket: its frames up to the webview as `device`, Duck's frames for it
/// down from `rx`, until it closes or `valid` says it no longer may (checked on each
/// kick). `conv`: it may run conversation mode (the phone; not the office).
pub(super) async fn relay(
    mut socket: WebSocket,
    state: Arc<RemoteState>,
    device: String,
    mut rx: broadcast::Receiver<DuckFrame>,
    valid: impl Fn() -> bool,
    conv_ok: bool,
) {
    let mut kick = state.kick.subscribe();
    let conn = state.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
    state.duck_conns.lock().unwrap().push((conn, device.clone()));
    input(&state.app, conn, &device, "open", None);
    let (conv_out, mut conv_frames) = tmpsc::unbounded_channel::<String>();
    let mut conv: Option<PhoneRun> = None;
    loop {
        tokio::select! {
            Some(json) = conv_frames.recv() => {
                if socket.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            },
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
                if !valid() {
                    break;
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Binary(b))) => {
                    if let (Some(r), Some(block)) = (&conv, audio_block(&b)) {
                        r.heard(block);
                    }
                }
                Some(Ok(Message::Text(t))) => match serde_json::from_str::<Value>(t.as_str()) {
                    Ok(msg) if conv_ok && msg["type"].as_str().is_some_and(|t| t.starts_with("conv.")) => {
                        conv_message(&state.app, &mut conv, &conv_out, &msg);
                    }
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
    drop(conv);
    state.duck_conns.lock().unwrap().retain(|(c, _)| *c != conn);
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

/// The image types the image route serves.
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// A stored image attachment, for the phone (a drawing's PNG, step G3).
pub(super) async fn image(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path((id, name)): Path<(String, String)>,
) -> Response {
    if let Err(refusal) = authed(&state, bearer(&headers).as_deref(), &client_addr(peer, &headers)) {
        return refusal;
    }
    let Ok(data) = state.app.path().app_data_dir() else { return StatusCode::NOT_FOUND.into_response() };
    let root = crate::assistant::attachments::root(&data);
    let Ok(path) = crate::assistant::attachments::file_of(&root, &id, &name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(&path).await else { return StatusCode::NOT_FOUND.into_response() };
    let mime = crate::assistant::attachments::mime_of(&name, &bytes[..bytes.len().min(64)]);
    if !IMAGE_TYPES.contains(&mime.as_str()) {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "private, max-age=86400".to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        ],
        bytes,
    )
        .into_response()
}

/// Send one of Duck's frames to the phones: to socket `conn`, or to all of them.
/// A no-op while the server is off.
#[tauri::command]
pub fn assistant_remote_emit(state: TauriState<'_, Arc<RemoteState>>, json: String, conn: Option<u64>) {
    let frame = DuckFrame { to: conn, json: json.into() };
    if let Some(tx) = &state.inner().inner.lock().unwrap().duck {
        let _ = tx.send(frame.clone());
    }
    state.inner().office.duck(frame);
}

/// The Duck sockets open now, as `{conn, device}`: a bridge that starts (the webview
/// reloaded) takes them as opened, or Duck's news would never reach them.
#[tauri::command]
pub fn assistant_remote_conns(state: TauriState<'_, Arc<RemoteState>>) -> Vec<Value> {
    state.duck_conns.lock().unwrap().iter().map(|(conn, device)| json!({ "conn": conn, "device": device })).collect()
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
    fn audio_frames_are_speech_or_gaps() {
        let mut pcm = vec![AUDIO_PCM];
        for s in [0i16, 16384, -32768] {
            pcm.extend(s.to_le_bytes());
        }
        assert_eq!(audio_block(&pcm).unwrap(), [0.0, 0.5, -1.0]);
        let mut gap = vec![AUDIO_GAP];
        gap.extend(512u32.to_le_bytes());
        assert_eq!(audio_block(&gap).unwrap(), vec![0.0; 512]);
        gap.truncate(1);
        gap.extend((GAP_MAX as u32 + 1).to_le_bytes());
        assert!(audio_block(&gap).is_none(), "too long a gap");
        assert!(audio_block(&[7, 1, 2]).is_none());
        assert!(audio_block(&[]).is_none());
    }

    #[test]
    fn what_the_phone_said_lately_is_its_recent_sentences_and_the_one_playing() {
        let t0 = Instant::now();
        let mut s = Said::default();
        assert_eq!(s.lately(t0, Duration::from_secs(10)), "");
        s.push(t0, "First one.");
        s.push(t0 + Duration::from_secs(5), "Second one.");
        s.push(t0 + Duration::from_secs(12), "Third one.");
        assert_eq!(s.lately(t0 + Duration::from_secs(14), Duration::from_secs(10)), "Second one. Third one.");
        // A long sentence still playing is what's being said, however long ago it began.
        assert_eq!(s.lately(t0 + Duration::from_secs(40), Duration::from_secs(10)), "Third one.");
        s.push(t0 + Duration::from_secs(100), "Later.");
        assert_eq!(s.0.len(), 1, "a minute's worth is kept");
    }

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
