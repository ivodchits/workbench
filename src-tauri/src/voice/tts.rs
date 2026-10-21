//! Spoken replies (step V2): a [`Speaker`] per engine, a queue of sentences, and
//! the commands the webview drives it with.
//!
//! The webview does the words: it splits a reply into sentences as it streams,
//! strips markdown, makes them speakable and decides each one's language (see
//! `src/assistant/speakable.ts`). Here each sentence is synthesized in order and
//! played as soon as it's ready, so sentence 1 plays while sentence 2 is made.
//!
//! - **Engines:** local ([`LocalSpeaker`]: Kokoro for English, Silero for Russian,
//!   in the [`super::sidecar`]) by default; Google Chirp 3 HD ([`ChirpSpeaker`]) when
//!   chosen, or as the fallback when the local one fails and the fallback is on.
//!   Chirp's characters go into Duck's ledger, and a call that would pass the free
//!   1M a month is refused rather than billed.
//! - **Utterances:** the webview numbers each reply it speaks. `tts_say` queues a
//!   sentence of it, `tts_end` says no more are coming. The webview hears
//!   `tts-state` (`speaking`, then `done` / `stopped` / `error`) and `tts-level`.
//! - **Barge-in:** `tts_stop` (Esc, the stop button) and the push-to-talk key empty
//!   the queue and cut what's playing; sentences of the stopped reply still on
//!   their way are dropped by epoch.
//! - **The phone** (step R1): [`tts_render`] makes one sentence of a reply into a
//!   WAV without playing it, kept a few minutes for the remote server's
//!   `GET /api/assistant/tts/{id}` ([`TtsState::rendered`]). The webview renders a
//!   reply's sentences in order as they stream, so the phone plays sentence 1
//!   while sentence 2 is made.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::playback::Player;
use super::sidecar::{self, Engine, Sidecar};

const STATE_EVENT: &str = "tts-state";
const LEVEL_EVENT: &str = "tts-level";
const DOWNLOAD_EVENT: &str = "tts-download";
/// Chirp's free tier; never passed silently.
const CHIRP_FREE_CHARS: u64 = 1_000_000;
/// How long the phone's copy of a sentence is kept, and how many are (a few
/// replies' worth).
const RENDERED_TTL: Duration = Duration::from_secs(600);
const RENDERED_MAX: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    En,
    Ru,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EnginePref {
    #[default]
    Local,
    Chirp,
}

/// What the settings say about speech.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsConfig {
    pub engine: EnginePref,
    /// Chirp speaks when the local engine fails.
    pub chirp_fallback: bool,
    pub voice_en: String,
    pub voice_ru: String,
    /// 1.0 is normal.
    pub rate: f32,
    /// Start the sidecar when the push-to-talk key goes down (replies will be spoken).
    pub warm_on_talk: bool,
}

impl Default for TtsConfig {
    fn default() -> Self {
        Self {
            engine: EnginePref::Local,
            chirp_fallback: false,
            voice_en: "af_heart".into(),
            voice_ru: "kseniya".into(),
            rate: 1.0,
            warm_on_talk: false,
        }
    }
}

/// One engine. A sentence in, its audio out (mono f32, and its rate).
pub trait Speaker: Send + Sync {
    fn speak(&self, text: &str, lang: Lang, config: &TtsConfig) -> Result<(Vec<f32>, u32), String>;
}

pub struct LocalSpeaker(pub Arc<Sidecar>);

impl Speaker for LocalSpeaker {
    fn speak(&self, text: &str, lang: Lang, c: &TtsConfig) -> Result<(Vec<f32>, u32), String> {
        let (engine, voice) = match lang {
            Lang::En => (Engine::Kokoro, c.voice_en.as_str()),
            Lang::Ru => (Engine::Silero, c.voice_ru.as_str()),
        };
        Ok((self.0.synth(engine, text, voice, c.rate.clamp(0.5, 2.0))?, sidecar::RATE))
    }
}

pub struct ChirpSpeaker(pub AppHandle);

impl Speaker for ChirpSpeaker {
    fn speak(&self, text: &str, lang: Lang, c: &TtsConfig) -> Result<(Vec<f32>, u32), String> {
        let key = crate::assistant::google_tts_key().ok_or("no Google key (duck/google-tts-key) is stored")?;
        let chars = text.chars().count() as u64;
        let used = crate::assistant::chirp_chars_this_month(&self.0);
        if used + chars > CHIRP_FREE_CHARS {
            return Err(format!("Chirp's free {CHIRP_FREE_CHARS} characters this month are used up ({used})"));
        }
        let (code, name) = match lang {
            Lang::En => ("en-US", "en-US-Chirp3-HD-Aoede"),
            Lang::Ru => ("ru-RU", "ru-RU-Chirp3-HD-Aoede"),
        };
        let body = serde_json::json!({
            "input": {"text": text},
            "voice": {"languageCode": code, "name": name},
            "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 24000, "speakingRate": c.rate.clamp(0.5, 2.0)},
        });
        let bytes = ureq::post("https://texttospeech.googleapis.com/v1/text:synthesize")
            .header("x-goog-api-key", &key)
            .header("content-type", "application/json")
            .send(body.to_string().as_bytes())
            .map_err(|e| format!("Chirp: {e}"))?
            .into_body()
            .read_to_vec()
            .map_err(|e| format!("Chirp: {e}"))?;
        let resp: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| format!("Chirp: {e}"))?;
        crate::assistant::record_chirp(&self.0, chars);
        let audio = resp["audioContent"].as_str().ok_or("Chirp sent no audio")?;
        let wav = base64::engine::general_purpose::STANDARD.decode(audio).map_err(|e| format!("Chirp: {e}"))?;
        super::parse_wav_at(&wav)
    }
}

/// One sentence through the chosen engine, falling back to Chirp when that's on;
/// the audio and which engine made it.
fn speak_with(
    local: &LocalSpeaker,
    chirp: &ChirpSpeaker,
    text: &str,
    lang: Lang,
    c: &TtsConfig,
) -> Result<((Vec<f32>, u32), &'static str), String> {
    let first: (&dyn Speaker, &'static str) =
        if c.engine == EnginePref::Chirp { (chirp, "chirp") } else { (local, "local") };
    let result = first.0.speak(text, lang, c).map(|a| (a, first.1));
    match result {
        Err(e) if c.engine == EnginePref::Local && c.chirp_fallback => {
            eprintln!("tts: the local engine failed ({e}); trying Chirp");
            chirp.speak(text, lang, c).map(|a| (a, "chirp"))
        }
        r => r,
    }
}

enum Job {
    Say { epoch: u64, utterance: u64, text: String, lang: Lang },
    End { epoch: u64, utterance: u64 },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StateEvent {
    utterance: u64,
    /// `speaking`, `done`, `stopped` or `error`.
    state: &'static str,
    message: Option<String>,
    /// Which engine spoke (`local` / `chirp`), on `speaking`.
    engine: Option<&'static str>,
}

/// A sentence made for the phone: its id, the WAV, when it was made.
type Rendered = (String, Arc<Vec<u8>>, Instant);

/// Tauri-managed.
pub struct TtsState {
    sidecar: Arc<Sidecar>,
    player: Arc<Player>,
    config: Arc<Mutex<TtsConfig>>,
    /// Bumped by a stop: queued sentences of an older generation are dropped.
    epoch: Arc<AtomicU64>,
    jobs: Mutex<Sender<Job>>,
    preparing: AtomicBool,
    /// The utterance speaking now, if any (0 = none).
    current: Arc<AtomicU64>,
    /// Sentences made for the phone, newest last.
    rendered: Mutex<VecDeque<Rendered>>,
}

impl TtsState {
    pub fn new(app: &AppHandle, runtime_dir: std::path::PathBuf, models: std::path::PathBuf) -> Self {
        let sidecar = Arc::new(Sidecar::new(runtime_dir, models));
        sidecar.reap_when_idle(sidecar::IDLE_KILL);
        let level_app = app.clone();
        let player = Arc::new(Player::new(move |level| {
            let _ = level_app.emit(LEVEL_EVENT, level);
        }));
        let (tx, rx) = mpsc::channel();
        let me = Self {
            sidecar,
            player,
            config: Arc::new(Mutex::new(TtsConfig::default())),
            epoch: Arc::new(AtomicU64::new(0)),
            jobs: Mutex::new(tx),
            preparing: AtomicBool::new(false),
            current: Arc::new(AtomicU64::new(0)),
            rendered: Mutex::new(VecDeque::new()),
        };
        me.run(app.clone(), rx);
        me
    }

    fn run(&self, app: AppHandle, rx: Receiver<Job>) {
        let local = LocalSpeaker(Arc::clone(&self.sidecar));
        let chirp = ChirpSpeaker(app.clone());
        let player = Arc::clone(&self.player);
        let config = Arc::clone(&self.config);
        let epoch = Arc::clone(&self.epoch);
        let current = Arc::clone(&self.current);
        std::thread::Builder::new()
            .name("tts-queue".into())
            .spawn(move || {
                let emit = |utterance, state, message: Option<String>, engine| {
                    let _ = app.emit(STATE_EVENT, StateEvent { utterance, state, message, engine });
                };
                // Utterances that already said `speaking` (or failed), so each says it once.
                let mut announced = 0u64;
                let mut failed = 0u64;
                for job in rx {
                    match job {
                        Job::Say { epoch: g, utterance, text, lang } => {
                            if g != epoch.load(Ordering::SeqCst) || failed == utterance {
                                continue;
                            }
                            let c = config.lock().map(|c| c.clone()).unwrap_or_default();
                            let result = speak_with(&local, &chirp, &text, lang, &c);
                            // A stop may have come while this was synthesized.
                            if g != epoch.load(Ordering::SeqCst) {
                                continue;
                            }
                            match result.and_then(|((pcm, rate), engine)| player.push(&pcm, rate).map(|_| engine)) {
                                Ok(engine) => {
                                    if announced != utterance {
                                        announced = utterance;
                                        current.store(utterance, Ordering::SeqCst);
                                        emit(utterance, "speaking", None, Some(engine));
                                    }
                                }
                                Err(e) => {
                                    failed = utterance;
                                    emit(utterance, "error", Some(e), None);
                                }
                            }
                        }
                        Job::End { epoch: g, utterance } => {
                            while g == epoch.load(Ordering::SeqCst) && player.is_playing() {
                                std::thread::sleep(Duration::from_millis(40));
                            }
                            if g == epoch.load(Ordering::SeqCst) && failed != utterance {
                                emit(utterance, "done", None, None);
                            }
                            let _ = current.compare_exchange(utterance, 0, Ordering::SeqCst, Ordering::SeqCst);
                        }
                    }
                }
            })
            .expect("spawning the tts queue");
    }

    fn send(&self, job: Job) {
        if let Ok(tx) = self.jobs.lock() {
            let _ = tx.send(job);
        }
    }

    /// Cut everything: what's playing and what's queued.
    pub fn stop(&self, app: &AppHandle) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.player.stop();
        // Said even when nothing was playing yet: whoever queued sentences is
        // waiting for their end (a read, step V3), which now won't come.
        let was = self.current.swap(0, Ordering::SeqCst);
        let _ = app.emit(STATE_EVENT, StateEvent { utterance: was, state: "stopped", message: None, engine: None });
    }

    /// Make one sentence into a WAV for the phone and keep it as `id`; its length
    /// in seconds. Blocking. The same engines as the desktop's, but nothing plays.
    pub fn render(&self, app: &AppHandle, id: String, text: &str, lang: Lang) -> Result<f32, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("nothing to say".into());
        }
        let c = self.config.lock().map(|c| c.clone()).unwrap_or_default();
        let (local, chirp) = (LocalSpeaker(Arc::clone(&self.sidecar)), ChirpSpeaker(app.clone()));
        let ((pcm, rate), _) = speak_with(&local, &chirp, text, lang, &c)?;
        let mut all = if rate == sidecar::RATE { pcm } else { super::capture::resample(&pcm, rate, sidecar::RATE) };
        // A breath before the next sentence.
        all.extend(std::iter::repeat_n(0.0, sidecar::RATE as usize / 6));
        let secs = all.len() as f32 / sidecar::RATE as f32;
        let wav = Arc::new(super::encode_wav(&all, sidecar::RATE));
        let mut kept = self.rendered.lock().map_err(|e| e.to_string())?;
        kept.retain(|(k, _, at)| *k != id && at.elapsed() < RENDERED_TTL);
        kept.push_back((id, wav, Instant::now()));
        while kept.len() > RENDERED_MAX {
            kept.pop_front();
        }
        Ok(secs)
    }

    /// A sentence made for the phone, while it's kept.
    pub fn rendered(&self, id: &str) -> Option<Arc<Vec<u8>>> {
        let kept = self.rendered.lock().ok()?;
        kept.iter().find(|(k, _, at)| k == id && at.elapsed() < RENDERED_TTL).map(|(_, w, _)| Arc::clone(w))
    }

    /// Start the sidecar in the background if replies will be spoken.
    pub fn warm_if_wanted(&self) {
        let c = self.config.lock().map(|c| c.clone()).unwrap_or_default();
        if c.warm_on_talk && c.engine == EnginePref::Local && self.sidecar.ready() && !self.sidecar.running() {
            let s = Arc::clone(&self.sidecar);
            std::thread::spawn(move || {
                if let Err(e) = s.warm(false) {
                    eprintln!("tts: warming failed: {e}");
                }
            });
        }
    }
}

/// `<app local data>/voice-runtime` (`voice-runtime.dev` in debug).
pub fn runtime_dir(app: &AppHandle) -> std::path::PathBuf {
    let base = app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir());
    base.join(if cfg!(debug_assertions) { "voice-runtime.dev" } else { "voice-runtime" })
}

/// Take the settings. While replies are spoken with the local engine, the sidecar
/// is started now and stays loaded, so a reply is never cold.
#[tauri::command]
pub fn tts_configure(state: State<'_, TtsState>, config: TtsConfig) -> Result<(), String> {
    let keep = config.warm_on_talk && config.engine == EnginePref::Local;
    *state.config.lock().map_err(|e| e.to_string())? = config;
    state.sidecar.set_keep(keep);
    if keep {
        state.warm_if_wanted();
    }
    Ok(())
}

/// Queue a sentence of reply `utterance` (numbered by the webview).
#[tauri::command]
pub fn tts_say(state: State<'_, TtsState>, utterance: u64, text: String, lang: Lang) {
    let text = text.trim().to_string();
    if !text.is_empty() {
        state.send(Job::Say { epoch: state.epoch.load(Ordering::SeqCst), utterance, text, lang });
    }
}

/// No more sentences of `utterance` are coming: say `done` once they've played.
#[tauri::command]
pub fn tts_end(state: State<'_, TtsState>, utterance: u64) {
    state.send(Job::End { epoch: state.epoch.load(Ordering::SeqCst), utterance });
}

#[tauri::command]
pub fn tts_stop(app: AppHandle, state: State<'_, TtsState>) {
    state.stop(&app);
}

/// Start the sidecar now; with `ru`, load Silero too (a Russian message was heard,
/// and Silero takes 10-20 s cold).
#[tauri::command]
pub fn tts_warm(state: State<'_, TtsState>, ru: bool) {
    let s = Arc::clone(&state.sidecar);
    if s.ready() && (ru || !s.running()) {
        std::thread::spawn(move || {
            if let Err(e) = s.warm(ru) {
                eprintln!("tts: warming failed: {e}");
            }
        });
    }
}

/// Make one sentence of a reply (already speakable) into audio for the phone
/// (step R1), kept as `id` for `GET /api/assistant/tts/{id}`; its length in seconds.
#[tauri::command]
pub async fn tts_render(app: AppHandle, id: String, text: String, lang: Lang) -> Result<f32, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<TtsState>().render(&app, id, &text, lang))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    /// The Python runtime is installed (at the pins this app carries).
    installed: bool,
    /// Model bytes still to download.
    missing_bytes: u64,
    preparing: bool,
    /// The sidecar process is up.
    running: bool,
    /// A Google key is stored, so Chirp can speak.
    chirp_key: bool,
    chirp_chars_this_month: u64,
    runtime_dir: String,
}

#[tauri::command]
pub fn tts_status(app: AppHandle, state: State<'_, TtsState>) -> TtsStatus {
    let s = &state.sidecar;
    TtsStatus {
        installed: s.installed(),
        missing_bytes: s.missing_bytes(),
        preparing: state.preparing.load(Ordering::Relaxed),
        running: s.running(),
        chirp_key: crate::assistant::google_tts_key().is_some(),
        chirp_chars_this_month: crate::assistant::chirp_chars_this_month(&app),
        runtime_dir: s.dir().display().to_string(),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: u64,
    total: u64,
    file: &'static str,
    finished: bool,
    error: Option<String>,
}

/// Download the voices and install the runtime, in the background; progress comes
/// as `tts-download` events (the install is one step at the end, "the speech runtime").
#[tauri::command]
pub fn tts_prepare(app: AppHandle, state: State<'_, TtsState>) -> Result<(), String> {
    if state.preparing.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let sidecar = Arc::clone(&state.sidecar);
    std::thread::Builder::new()
        .name("tts-prepare".into())
        .spawn(move || {
            let total = sidecar.missing_bytes();
            let mut done = 0u64;
            let mut last = Instant::now();
            let mut file = "";
            let result = (|| -> Result<(), String> {
                for asset in sidecar::TTS_ASSETS {
                    file = asset.path;
                    super::assets::fetch(sidecar.models(), asset, &mut |n| {
                        done += n;
                        if last.elapsed() >= Duration::from_millis(250) {
                            last = Instant::now();
                            let _ = app.emit(DOWNLOAD_EVENT, Progress { done, total, file: asset.path, finished: false, error: None });
                        }
                    })?;
                }
                if !sidecar.installed() {
                    file = "the speech runtime";
                    let _ = app.emit(DOWNLOAD_EVENT, Progress { done, total, file, finished: false, error: None });
                    sidecar.install()?;
                }
                Ok(())
            })();
            let _ = app.emit(DOWNLOAD_EVENT, Progress { done: total, total, file, finished: true, error: result.err() });
            if let Some(s) = app.try_state::<TtsState>() {
                s.preparing.store(false, Ordering::SeqCst);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}
