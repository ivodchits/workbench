//! Voice (track V). Step V1, voice input:
//! - the speech-to-text engine: Parakeet TDT 0.6B v3 over ONNX Runtime ([`engine`],
//!   [`parakeet`]), with Silero VAD trimming a clip to its speech ([`vad`]);
//! - the downloads they need on first use ([`assets`]);
//! - **push-to-talk** ([`capture`] and the global key here).
//!
//! See `documentation/assistant-plan.md`, step V1.
//!
//! Push-to-talk:
//! - The webview hands its settings over with [`voice_configure`]: the key, the
//!   microphone and the GPU preference.
//! - The key is registered globally (`tauri-plugin-global-shortcut`), so it works
//!   with Workbench in the background or hidden.
//! - **Press:** recording starts, and the model loads in parallel.
//! - **Release:** the recording stops and is transcribed.
//! - The webview hears `voice-state` (listening / transcribing / idle / error) and
//!   `voice-transcript`, and sends the text to Duck.
//! - The drawer's mic button drives the same path ([`voice_ptt`]).
//!
//! Transcribing a WAV is a command of its own (the settings check), and the phone
//! uploads 16 kHz WAV to the remote server, which calls [`VoiceState::transcribe`]
//! (step R1).
//!
//! Step V2, spoken replies: [`tts`] (the sentence queue and its engines),
//! [`sidecar`] (Kokoro + Silero in Python) and [`playback`]. The push-to-talk key
//! cuts a reply that's speaking (barge-in) and starts the sidecar while you talk.
//!
//! Step V3: [`screen`], Duck's screenshots.

pub mod assets;
pub mod capture;
pub mod engine;
pub mod parakeet;
pub mod playback;
pub mod screen;
pub mod sidecar;
pub mod tts;
pub mod vad;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use engine::{Engine, GpuPref, Provider, Transcript};

/// How long the model stays loaded with nothing to do (design: 3 minutes).
const IDLE_UNLOAD: Duration = Duration::from_secs(180);

const DOWNLOAD_EVENT: &str = "voice-download";
const STATE_EVENT: &str = "voice-state";
const TRANSCRIPT_EVENT: &str = "voice-transcript";
/// A press shorter than this was a slip, not a command.
const MIN_HOLD: Duration = Duration::from_millis(300);

/// What push-to-talk needs from the settings.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConfig {
    pub gpu: GpuPref,
    /// The microphone's name; None for the default input.
    pub device: Option<String>,
    /// The push-to-talk key ("Ctrl+Alt+Space", "F13"); None for none.
    pub hotkey: Option<String>,
}

/// Tauri-managed.
pub struct VoiceState {
    engine: Arc<Engine>,
    downloading: AtomicBool,
    config: Mutex<VoiceConfig>,
    /// The key registered now.
    hotkey: Mutex<Option<String>>,
    /// A recording in progress, and when it began.
    recording: Mutex<Option<(capture::Recorder, Instant)>>,
}

impl VoiceState {
    pub fn new(root: PathBuf) -> Self {
        let engine = Arc::new(Engine::new(root));
        engine.reap_when_idle(IDLE_UNLOAD);
        Self {
            engine,
            downloading: AtomicBool::new(false),
            config: Mutex::new(VoiceConfig::default()),
            hotkey: Mutex::new(None),
            recording: Mutex::new(None),
        }
    }

    /// Transcribe 16 kHz mono samples with the configured GPU preference (the
    /// phone's clips, step R1). Blocking: the model may load first.
    pub fn transcribe(&self, samples: &[f32]) -> Result<Transcript, String> {
        let gpu = self.config.lock().map(|c| c.gpu).unwrap_or_default();
        if self.engine.choose(gpu).is_none() {
            return Err("the voice model isn't downloaded on the desktop".into());
        }
        self.engine.transcribe(samples, gpu)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceEvent {
    /// `listening`, `transcribing`, `idle` or `error`.
    state: &'static str,
    message: Option<String>,
}

fn say(app: &AppHandle, state: &'static str, message: Option<String>) {
    let _ = app.emit(STATE_EVENT, VoiceEvent { state, message });
}

/// Start recording (the key went down). A second press while recording is ignored.
fn press(app: &AppHandle) {
    let Some(s) = app.try_state::<VoiceState>() else { return };
    let Ok(mut rec) = s.recording.lock() else { return };
    if rec.is_some() {
        return;
    }
    if let Some(t) = app.try_state::<tts::TtsState>() {
        t.stop(app);
        t.warm_if_wanted();
    }
    let config = s.config.lock().map(|c| c.clone()).unwrap_or_default();
    if s.engine.choose(config.gpu).is_none() {
        say(app, "error", Some("The voice model isn't downloaded yet: download it in Duck's settings.".into()));
        return;
    }
    match capture::start(config.device.clone()) {
        Ok(r) => *rec = Some((r, Instant::now())),
        Err(e) => {
            say(app, "error", Some(format!("The microphone didn't open: {e}")));
            return;
        }
    }
    say(app, "listening", None);
    // Loading takes ~2 s; the recording covers it.
    let engine = Arc::clone(&s.engine);
    std::thread::spawn(move || {
        let _ = engine.preload(config.gpu);
    });
}

/// Stop and transcribe (the key came up).
fn release(app: &AppHandle) {
    let Some(s) = app.try_state::<VoiceState>() else { return };
    let Some((rec, began)) = s.recording.lock().ok().and_then(|mut r| r.take()) else { return };
    let engine = Arc::clone(&s.engine);
    let gpu = s.config.lock().map(|c| c.gpu).unwrap_or_default();
    let app = app.clone();
    std::thread::spawn(move || {
        let samples = match rec.stop() {
            Ok(x) => x,
            Err(e) => return say(&app, "error", Some(format!("The recording failed: {e}"))),
        };
        if began.elapsed() < MIN_HOLD {
            return say(&app, "idle", None);
        }
        say(&app, "transcribing", None);
        match engine.transcribe(&samples, gpu) {
            Ok(t) => {
                say(&app, "idle", None);
                let _ = app.emit(TRANSCRIPT_EVENT, &t);
            }
            Err(e) => say(&app, "error", Some(format!("Transcription failed: {e}"))),
        }
    });
}

/// Take the settings: the GPU preference, the microphone, and the push-to-talk
/// key (registered globally; the previous one is released).
#[tauri::command]
pub fn voice_configure(app: AppHandle, state: State<'_, VoiceState>, config: VoiceConfig) -> Result<(), String> {
    let key = config.hotkey.clone().filter(|k| !k.trim().is_empty());
    *state.config.lock().map_err(|e| e.to_string())? = config;
    let mut current = state.hotkey.lock().map_err(|e| e.to_string())?;
    if *current == key {
        return Ok(());
    }
    let shortcuts = app.global_shortcut();
    if let Some(old) = current.take() {
        let _ = shortcuts.unregister(old.as_str());
    }
    if let Some(k) = key {
        shortcuts
            .on_shortcut(k.as_str(), |app, _, event| match event.state {
                ShortcutState::Pressed => press(app),
                ShortcutState::Released => release(app),
            })
            .map_err(|e| format!("{k} can't be used as the push-to-talk key: {e}"))?;
        *current = Some(k);
    }
    Ok(())
}

/// The drawer's mic button: `true` while it's held, `false` when let go.
#[tauri::command]
pub fn voice_ptt(app: AppHandle, down: bool) {
    if down {
        press(&app)
    } else {
        release(&app)
    }
}

/// The microphones, for the settings.
#[tauri::command]
pub fn voice_devices() -> Vec<String> {
    capture::input_devices()
}

/// `<app local data>/models` (`models.dev` in a debug build, so the two builds
/// never share half-written files).
pub fn models_root(app: &AppHandle) -> PathBuf {
    let base = app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir());
    base.join(if cfg!(debug_assertions) { "models.dev" } else { "models" })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// Where the model would run now; None when nothing usable is downloaded.
    provider: Option<Provider>,
    provider_label: Option<&'static str>,
    /// Loaded right now (and on which provider).
    loaded: Option<Provider>,
    /// Bytes to download before the preferred provider is ready.
    missing_bytes: u64,
    downloading: bool,
    on_ac: bool,
    /// Why the GPU wasn't used the last time it was asked for.
    gpu_problem: Option<String>,
    models_dir: String,
}

/// What the preference needs: the GPU's files and the CPU's, unless the GPU is
/// never used (the CPU is the fallback either way).
fn needed(pref: GpuPref) -> Vec<&'static [assets::Asset]> {
    let mut sets = vec![assets::COMMON, assets::INT8];
    if pref != GpuPref::Never {
        sets.push(assets::FP32);
    }
    sets
}

#[tauri::command]
pub fn voice_status(state: State<'_, VoiceState>, pref: GpuPref) -> VoiceStatus {
    let e = &state.engine;
    let provider = e.choose(pref);
    VoiceStatus {
        provider,
        provider_label: provider.map(Provider::label),
        loaded: e.loaded_provider(),
        missing_bytes: assets::missing_bytes(e.root(), &needed(pref), true),
        downloading: state.downloading.load(Ordering::Relaxed),
        on_ac: engine::on_ac_power(),
        gpu_problem: e.gpu_problem(),
        models_dir: e.root().display().to_string(),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    done: u64,
    total: u64,
    file: &'static str,
    /// Set on the last event: finished (`error` None) or failed.
    finished: bool,
    error: Option<String>,
}

/// Download what the preference needs, in the background; progress comes as
/// `voice-download` events. A second call while one runs does nothing.
#[tauri::command]
pub fn voice_prepare(app: AppHandle, state: State<'_, VoiceState>, pref: GpuPref) -> Result<(), String> {
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let root = state.engine.root().to_path_buf();
    std::thread::Builder::new()
        .name("voice-download".into())
        .spawn(move || {
            let sets = needed(pref);
            let total = assets::missing_bytes(&root, &sets, true);
            let mut done = 0u64;
            let mut last = Instant::now();
            let mut file = "";
            let mut tick = |n: u64, file: &'static str| {
                done += n;
                if last.elapsed() >= Duration::from_millis(250) {
                    last = Instant::now();
                    let _ = app.emit(DOWNLOAD_EVENT, DownloadProgress { done, total, file, finished: false, error: None });
                }
            };
            let result = (|| -> Result<(), String> {
                file = "the voice runtime";
                assets::fetch_runtime(&root, &mut |n| tick(n, "the voice runtime"))?;
                for asset in sets.iter().flat_map(|s| s.iter()) {
                    file = asset.path;
                    assets::fetch(&root, asset, &mut |n| tick(n, asset.path))?;
                }
                Ok(())
            })();
            let _ = app.emit(
                DOWNLOAD_EVENT,
                DownloadProgress { done: total, total, file, finished: true, error: result.err() },
            );
            if let Some(s) = app.try_state::<VoiceState>() {
                s.downloading.store(false, Ordering::SeqCst);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Load the model now, so a transcription about to come doesn't wait for it.
#[tauri::command]
pub async fn voice_preload(state: State<'_, VoiceState>, pref: GpuPref) -> Result<Provider, String> {
    let engine = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking(move || engine.preload(pref)).await.map_err(|e| e.to_string())?
}

/// Transcribe a WAV file (16 kHz; mono or stereo; 16-bit PCM or 32-bit float).
#[tauri::command]
pub async fn voice_transcribe_wav(state: State<'_, VoiceState>, path: String, pref: GpuPref) -> Result<Transcript, String> {
    let engine = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking(move || {
        let samples = read_wav(Path::new(&path))?;
        engine.transcribe(&samples, pref)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Keep the model loaded (the drawer is open, conversation mode is on), or let it
/// go after the idle timeout.
#[tauri::command]
pub fn voice_keep_warm(state: State<'_, VoiceState>, on: bool) {
    state.engine.set_warm(on);
}

#[tauri::command]
pub fn voice_unload(state: State<'_, VoiceState>) {
    state.engine.unload();
}

/// A 16 kHz WAV as mono f32 samples.
pub fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    parse_wav(&bytes)
}

pub fn parse_wav(b: &[u8]) -> Result<Vec<f32>, String> {
    let (samples, rate) = parse_wav_at(b)?;
    if rate != 16_000 {
        return Err(format!("the WAV is {rate} Hz; 16 kHz is needed"));
    }
    Ok(samples)
}

/// A WAV at whatever rate it is: mono f32 samples, and the rate.
pub fn parse_wav_at(b: &[u8]) -> Result<(Vec<f32>, u32), String> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let u16_at = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    let (mut format, mut channels, mut rate, mut bits) = (0u16, 0u16, 0u32, 0u16);
    let mut i = 12;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let size = u32_at(i + 4) as usize;
        let body = i + 8;
        let end = (body + size).min(b.len());
        if id == b"fmt " && size >= 16 {
            format = u16_at(body);
            channels = u16_at(body + 2);
            rate = u32_at(body + 4);
            bits = u16_at(body + 14);
            // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format's first word.
            if format == 0xFFFE && size >= 26 {
                format = u16_at(body + 24);
            }
        } else if id == b"data" {
            let ch = channels.max(1) as usize;
            let data = &b[body..end];
            let samples: Vec<f32> = match (format, bits) {
                (1, 16) => data.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0).collect(),
                (3, 32) => data.chunks_exact(4).map(|s| f32::from_le_bytes([s[0], s[1], s[2], s[3]])).collect(),
                _ => return Err(format!("unsupported WAV format {format} at {bits} bits")),
            };
            return Ok((samples.chunks_exact(ch).map(|f| f.iter().sum::<f32>() / ch as f32).collect(), rate));
        }
        i = body + size + (size & 1);
    }
    Err("the WAV has no data".into())
}

/// Mono samples as a 16-bit PCM WAV (the phone's copy of a spoken reply, step R1).
pub fn encode_wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = samples.len() as u32 * 2;
    let mut b = Vec::with_capacity(44 + data_len as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(channels: u16, samples: &[i16]) -> Vec<u8> {
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&16_000u32.to_le_bytes());
        b.extend_from_slice(&(16_000 * 2 * channels as u32).to_le_bytes());
        b.extend_from_slice(&(2 * channels).to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(data.len() as u32).to_le_bytes());
        b.extend_from_slice(&data);
        b
    }

    #[test]
    fn reads_pcm16_and_mixes_down() {
        assert_eq!(parse_wav(&wav(1, &[16384, -16384])).unwrap(), vec![0.5, -0.5]);
        assert_eq!(parse_wav(&wav(2, &[16384, 0, -16384, -16384])).unwrap(), vec![0.25, -0.5]);
        assert!(parse_wav(b"nope").is_err());
    }

    #[test]
    fn encodes_what_it_reads() {
        let (back, rate) = parse_wav_at(&encode_wav(&[0.5, -0.5, 0.0], 24_000)).unwrap();
        assert_eq!(rate, 24_000);
        assert_eq!(back.len(), 3);
        assert!((back[0] - 0.5).abs() < 1e-3 && (back[1] + 0.5).abs() < 1e-3 && back[2] == 0.0);
    }

    /// X0's recordings through the engine (`cargo test --release voice_bench --
    /// --ignored --nocapture`). `WB_MODELS` is a models folder with everything
    /// downloaded; `VOICE_EVAL_DATA` is the voice-eval data (default
    /// `~/repos/Duck/voice-eval`); `WB_VOICE_PREF` is always / ac_only / never.
    #[test]
    #[ignore]
    fn voice_bench() {
        let models = PathBuf::from(std::env::var("WB_MODELS").expect("WB_MODELS"));
        let data = std::env::var("VOICE_EVAL_DATA").map(PathBuf::from).unwrap_or_else(|_| {
            PathBuf::from(std::env::var("USERPROFILE").unwrap()).join("repos/Duck/voice-eval")
        });
        let pref: GpuPref = serde_json::from_value(serde_json::Value::String(
            std::env::var("WB_VOICE_PREF").unwrap_or_else(|_| "always".into()),
        ))
        .unwrap();
        let stt = data.join("recordings/stt");
        let prompts: serde_json::Value = serde_json::from_slice(&std::fs::read(stt.join("prompts.json")).unwrap()).unwrap();
        // The runtime through the real downloader, the first time.
        let mut got = 0u64;
        assets::fetch_runtime(&models, &mut |n| got += n).unwrap();
        if got > 0 {
            println!("downloaded the runtime: {got} bytes");
        }
        let engine = Engine::new(models);
        let t = Instant::now();
        let provider = engine.preload(pref).unwrap();
        println!("load on {:?}: {} ms (gpu problem: {:?})", provider, t.elapsed().as_millis(), engine.gpu_problem());
        for p in prompts.as_array().unwrap() {
            let id = p["id"].as_str().unwrap();
            let samples = read_wav(&stt.join(format!("{id}.wav"))).unwrap();
            let r = engine.transcribe(&samples, pref).unwrap();
            println!(
                "{id} {:>5} ms for {:>5} ms ({} ms speech){} | {}\n         ref | {}",
                r.ms,
                r.audio_ms,
                r.speech_ms,
                if r.retried { " retried" } else { "" },
                r.text,
                p["text"].as_str().unwrap()
            );
        }
    }
}
