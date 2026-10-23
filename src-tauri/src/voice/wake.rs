//! The wake word on the PC (step V6, an experiment): say "Hey Duck" / «Эй, Дак» and
//! talk. The key and the drawer's mic stay the main way in; this is off by default.
//!
//! - **Listening:** while it's on, the microphone stays open ([`capture::listen`]).
//!   Every 32 ms frame goes through Silero VAD; only speech wakes the keyword
//!   spotter ([`kws`], one CPU thread at below-normal priority, never the GPU),
//!   fed from half a second before the speech began. A second of silence puts it
//!   back to sleep.
//! - **Confirmed by the transcript** ([`confirm`]): a hit records quietly, from
//!   just before the phrase to the end of speech, and V1's engine transcribes it.
//!   - The phrase near the start (fuzzy, either language): it's cut off and the rest
//!     goes to Duck like push-to-talk.
//!   - The phrase alone: a chime, then listening as the key would: conversation mode,
//!     or one dictation that ends at a pause ([`Ear::follow`]).
//!   - No phrase: dropped and logged as a false trigger. Nothing reaches Duck.
//! - **Deaf** ([`Hold`]): while Duck speaks, and with the microphone let go while
//!   conversation mode or a dictation has it, another app is using it (a call),
//!   a full-screen app is in front, or the PC is on battery (the last two are
//!   settings, on by default).
//! - **The trigger log:** `<voice-eval data>/wake/triggers.jsonl`, one line per hit
//!   (when, the score, what it turned out to be; never the words). With "keep
//!   false-trigger clips" on, a false trigger's audio goes beside it.
//!
//! The webview hears `wake-state` (on, listening, why it's deaf), for the ear on
//! the Duck button and the tray's check item.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use super::engine::{self, Engine, GpuPref, Transcript};
use super::kws::{self, Hit, Spotter};
use super::vad::{self, Vad};
use super::{assets, capture, phone_record, tts, Press};

const RATE: usize = 16_000;
const FRAME: usize = vad::FRAME;
/// Speech this long (~100 ms) wakes the spotter...
const WAKE_FRAMES: usize = 3;
/// ...fed from this long before the speech began.
const PREROLL: usize = RATE / 2;
/// Silence this long puts the spotter back to sleep.
const SLEEP_AFTER: usize = RATE;
/// A hit's clip starts this long before the phrase...
const BEFORE: usize = RATE * 3 / 10;
/// ...and ends at this much silence, or this long after it began.
const CLIP_END: usize = RATE * 8 / 10;
const CLIP_MAX: usize = 15 * RATE;
/// After the phrase alone: speech must start within this, and ends at this much
/// silence or the cap.
const FOLLOW_WAIT: usize = 8 * RATE;
const FOLLOW_END: usize = RATE * 6 / 5;
const FOLLOW_MAX: usize = 30 * RATE;
/// The audio kept for cutting a clip out of.
const KEEP: usize = 40 * RATE;
/// How often the reasons to stay deaf are looked at.
const HOLD_EVERY: Duration = Duration::from_secs(1);
/// After Duck's voice stops, its echo dies down.
const ECHO_TAIL: Duration = Duration::from_millis(400);

pub const STATE_EVENT: &str = "wake-state";

// ── the ear: frames in, clips out ───────────────────────────────────────────

/// What the spotter does for [`Ear`] (the model, or a test's fake).
pub trait Spot {
    fn reset(&mut self);
    fn accept(&mut self, x: &[f32]) -> Option<Hit>;
}

impl Spot for Spotter {
    fn reset(&mut self) {
        if let Err(e) = Spotter::reset(self) {
            eprintln!("[wake] spotter reset: {e}");
        }
    }

    fn accept(&mut self, x: &[f32]) -> Option<Hit> {
        Spotter::accept(self, x).unwrap_or_else(|e| {
            eprintln!("[wake] spotter: {e}");
            None
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Phase {
    /// Nothing but silence (or speech too short to look at).
    Idle,
    /// The spotter hears the stream from `start` on.
    Spotting { start: usize },
    /// A hit: recording from `from` to the end of speech.
    Capturing { from: usize, hit: Hit },
    /// After the phrase alone: waiting for speech from `since`, then recording it
    /// from `from`.
    Following { since: usize, from: Option<usize> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Heard {
    /// Samples `[from, to)` hold a hit to confirm.
    Clip { from: usize, to: usize, hit: Hit },
    /// What was said after the phrase alone.
    Followed { from: usize, to: usize },
    /// Nothing was said after the phrase alone.
    NothingFollowed,
}

/// The stream's recent samples, by their index in the stream.
struct Audio {
    buf: VecDeque<f32>,
    start: usize,
}

impl Audio {
    fn end(&self) -> usize {
        self.start + self.buf.len()
    }

    fn push(&mut self, x: &[f32]) {
        self.buf.extend(x);
        if self.buf.len() > KEEP {
            let n = self.buf.len() - KEEP;
            self.buf.drain(..n);
            self.start += n;
        }
    }

    fn slice(&self, from: usize, to: usize) -> Vec<f32> {
        let a = from.saturating_sub(self.start).min(self.buf.len());
        let b = to.saturating_sub(self.start).min(self.buf.len());
        self.buf.range(a..b.max(a)).copied().collect()
    }
}

/// The wake word, frame by frame: the VAD's verdicts in, the stretches to
/// transcribe out. It knows nothing of the microphone or the model.
pub struct Ear {
    phase: Phase,
    audio: Audio,
    on: bool,
    run: usize,
    last_speech: usize,
}

impl Default for Ear {
    fn default() -> Self {
        Self::new()
    }
}

impl Ear {
    pub fn new() -> Self {
        Self { phase: Phase::Idle, audio: Audio { buf: VecDeque::with_capacity(KEEP), start: 0 }, on: false, run: 0, last_speech: 0 }
    }

    /// The stream so far, in samples.
    pub fn now(&self) -> usize {
        self.audio.end()
    }

    pub fn slice(&self, from: usize, to: usize) -> Vec<f32> {
        self.audio.slice(from, to)
    }

    /// The spotter is awake (speech is being looked at).
    #[cfg(test)]
    pub fn spotting(&self) -> bool {
        matches!(self.phase, Phase::Spotting { .. } | Phase::Capturing { .. })
    }

    /// A hit is being recorded.
    pub fn capturing(&self) -> bool {
        matches!(self.phase, Phase::Capturing { .. })
    }

    pub fn following(&self) -> bool {
        matches!(self.phase, Phase::Following { .. })
    }

    /// Back to sleep (Duck spoke, or a stretch was handled).
    pub fn sleep(&mut self, spot: &mut dyn Spot) {
        if self.phase != Phase::Idle {
            spot.reset();
        }
        self.phase = Phase::Idle;
        self.run = 0;
    }

    /// The phrase alone was said: listen for what comes next.
    pub fn follow(&mut self) {
        self.phase = Phase::Following { since: self.now(), from: None };
    }

    /// One [`FRAME`] of audio and its speech probability.
    pub fn frame(&mut self, frame: &[f32], p: f32, spot: &mut dyn Spot) -> Option<Heard> {
        self.audio.push(frame);
        let end = self.now();
        self.on = if self.on { p >= vad::OFF } else { p >= vad::ON };
        if self.on {
            self.run += 1;
            self.last_speech = end;
        } else {
            self.run = 0;
        }
        let silence = end - self.last_speech;
        match self.phase.clone() {
            Phase::Idle => {
                if self.run >= WAKE_FRAMES {
                    let start = (end - self.run * FRAME).saturating_sub(PREROLL).max(self.audio.start);
                    spot.reset();
                    self.phase = Phase::Spotting { start };
                    let hit = spot.accept(&self.audio.slice(start, end));
                    return self.hit(start, hit);
                }
                None
            }
            Phase::Spotting { start } => {
                let hit = spot.accept(frame);
                if hit.is_some() {
                    return self.hit(start, hit);
                }
                if silence >= SLEEP_AFTER {
                    self.sleep(spot);
                }
                None
            }
            Phase::Capturing { from, hit } => {
                if silence >= CLIP_END || end - from >= CLIP_MAX {
                    self.sleep(spot);
                    return Some(Heard::Clip { from, to: end, hit });
                }
                None
            }
            Phase::Following { since, from } => match from {
                None if self.run >= WAKE_FRAMES => {
                    let from = (end - self.run * FRAME).saturating_sub(BEFORE);
                    self.phase = Phase::Following { since, from: Some(from) };
                    None
                }
                None if end - since >= FOLLOW_WAIT => {
                    self.phase = Phase::Idle;
                    Some(Heard::NothingFollowed)
                }
                None => None,
                Some(from) if silence >= FOLLOW_END || end - from >= FOLLOW_MAX => {
                    self.phase = Phase::Idle;
                    self.run = 0;
                    Some(Heard::Followed { from, to: end })
                }
                Some(_) => None,
            },
        }
    }

    fn hit(&mut self, start: usize, hit: Option<Hit>) -> Option<Heard> {
        if let Some(hit) = hit {
            let at = |s: f32| start + (s * RATE as f32) as usize;
            let from = at(hit.start).saturating_sub(BEFORE).max(start);
            self.phase = Phase::Capturing { from, hit };
        }
        None
    }
}

// ── the transcript's verdict ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// The phrase, and nothing after it.
    Alone,
    /// The phrase, then this.
    Command(String),
    /// No phrase: a false trigger.
    None,
}

/// The greeting's spellings, English and Russian, as the speech model writes them.
const HEY: &[&str] = &["hey", "hay", "hei", "hi", "эй", "ей", "хей", "хэй", "хай"];
/// The name's, with what Parakeet hears it as (on X0's voices "Hey Duck" came out
/// "Hey Doc" more often than not, and «Эй, Дак» as «Эй, Даг»). Exact: one letter
/// off "дак" is "так" and "как".
const DUCK: &[&str] = &["duck", "dak", "duk", "dack", "dock", "doc", "dog", "dag", "дак", "дэк", "дук", "даг", "док", "дог"];
/// The phrase may start this many words in (the clip can open on the end of what
/// came before).
const LEAD_WORDS: usize = 3;

fn near(word: &str, forms: &[&str]) -> bool {
    forms.contains(&word)
}

/// The words of `text`, lowercased, each with the byte offset just past it.
fn words(text: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, c) in text.char_indices() {
        if c.is_alphanumeric() || c == '\'' {
            cur.extend(c.to_lowercase());
        } else if !cur.is_empty() {
            out.push((std::mem::take(&mut cur), i));
        }
    }
    if !cur.is_empty() {
        out.push((cur, text.len()));
    }
    out
}

/// Whether the transcript of a hit has the phrase, and what came after it.
pub fn confirm(text: &str) -> Verdict {
    let ws = words(text);
    for i in 0..ws.len().min(LEAD_WORDS) {
        let w = &ws[i].0;
        // "Hey Duck" as two words, or run together ("heyduck").
        let end = if near(w, HEY) && ws.get(i + 1).is_some_and(|(n, _)| near(n, DUCK)) {
            ws[i + 1].1
        } else if HEY.iter().any(|h| w.strip_prefix(h).is_some_and(|rest| !rest.is_empty() && near(rest, DUCK))) {
            ws[i].1
        } else {
            continue;
        };
        let rest = text[end..].trim_start_matches(|c: char| !c.is_alphanumeric()).trim_end();
        return if rest.is_empty() { Verdict::Alone } else { Verdict::Command(rest.to_string()) };
    }
    Verdict::None
}

// ── staying deaf ────────────────────────────────────────────────────────────

/// Why the microphone is let go for now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Hold {
    /// Conversation mode or a dictation has the microphone.
    Busy,
    /// Another app is using the microphone (a call or a meeting).
    Call,
    FullScreen,
    Battery,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub gpu: GpuPref,
    pub device: Option<String>,
    pub sensitivity: f32,
    pub full_screen: bool,
    pub battery: bool,
    pub keep_clips: bool,
    pub press: Press,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StateEvent {
    on: bool,
    /// The microphone is open and the phrase would be heard.
    listening: bool,
    hold: Option<Hold>,
    error: Option<String>,
}

static LAST: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

fn emit(app: &AppHandle, on: bool, listening: bool, hold: Option<Hold>, error: Option<String>) {
    let ev = StateEvent { on, listening, hold, error };
    if let Ok(mut last) = LAST.lock() {
        *last = serde_json::to_value(&ev).ok();
    }
    let _ = app.emit(STATE_EVENT, ev);
}

/// What was last said in `wake-state` (off before anything was).
pub fn last_state() -> serde_json::Value {
    LAST.lock().ok().and_then(|l| l.clone()).unwrap_or_else(|| json!({ "on": false, "listening": false, "hold": null, "error": null }))
}

/// Is another app using a microphone? Windows' privacy store keeps, per app, when
/// it last started and stopped (a stop of 0 means it still has it). This app's own
/// entry is skipped.
#[cfg(windows)]
pub fn another_app_on_mic() -> bool {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };
    const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    let own = std::env::current_exe().ok().map(|p| p.display().to_string().replace('\\', "#").to_lowercase());

    fn open(parent: HKEY, path: &str) -> Option<HKEY> {
        let mut key = HKEY::default();
        // SAFETY: valid key and path; `key` is written on success.
        unsafe { RegOpenKeyExW(parent, &HSTRING::from(path), None, KEY_READ, &mut key) }.ok().ok()?;
        Some(key)
    }
    fn qword(key: HKEY, name: &str) -> Option<u64> {
        let mut v = 0u64;
        let mut size = 8u32;
        // SAFETY: the buffer is 8 bytes and `size` says so.
        unsafe { RegQueryValueExW(key, &HSTRING::from(name), None, None, Some((&mut v as *mut u64).cast()), Some(&mut size)) }
            .ok()
            .ok()?;
        Some(v)
    }
    fn subkeys(key: HKEY) -> Vec<String> {
        let mut out = Vec::new();
        let mut buf = [0u16; 512];
        for i in 0.. {
            let mut len = buf.len() as u32;
            // SAFETY: `buf` holds `len` u16s.
            let r = unsafe { RegEnumKeyExW(key, i, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None) };
            if r.is_err() {
                break;
            }
            out.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        out
    }
    let in_use = |parent: HKEY, name: &str| -> bool {
        let Some(k) = open(parent, name) else { return false };
        let busy = qword(k, "LastUsedTimeStart").is_some_and(|s| s > 0) && qword(k, "LastUsedTimeStop") == Some(0);
        // SAFETY: `k` was opened above.
        let _ = unsafe { RegCloseKey(k) };
        busy
    };
    let Some(root) = open(HKEY_CURRENT_USER, STORE) else { return false };
    let mut found = false;
    for name in subkeys(root) {
        if name == "NonPackaged" {
            if let Some(np) = open(root, "NonPackaged") {
                for app in subkeys(np) {
                    if own.as_deref() != Some(app.to_lowercase().as_str()) && in_use(np, &app) {
                        found = true;
                    }
                }
                // SAFETY: opened above.
                let _ = unsafe { RegCloseKey(np) };
            }
        } else if in_use(root, &name) {
            found = true;
        }
    }
    // SAFETY: opened above.
    let _ = unsafe { RegCloseKey(root) };
    found
}

#[cfg(not(windows))]
pub fn another_app_on_mic() -> bool {
    false
}

/// What keeps the microphone let go now, if anything. `busy`: conversation mode
/// or a dictation has it.
fn hold(s: &Settings, busy: bool) -> Option<Hold> {
    if busy {
        return Some(Hold::Busy);
    }
    if s.battery && !engine::on_ac_power() {
        return Some(Hold::Battery);
    }
    if s.full_screen && super::presence::now().full_screen {
        return Some(Hold::FullScreen);
    }
    if another_app_on_mic() {
        return Some(Hold::Call);
    }
    None
}

// ── the trigger log ─────────────────────────────────────────────────────────

fn wake_dir() -> Option<PathBuf> {
    let root = phone_record::data_dir()?;
    std::fs::create_dir_all(&root).ok()?;
    let ignore = root.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "*\n").ok()?;
    }
    let dir = root.join("wake");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// One hit in the log; a false trigger's clip beside it when asked to keep them.
fn log_trigger(hit: &Hit, outcome: &str, ms: u64, clip: Option<&[f32]>) {
    let Some(dir) = wake_dir() else { return };
    let at = unix_ms();
    let file = clip.and_then(|x| {
        let name = format!("false-{at}.wav");
        std::fs::write(dir.join(&name), super::encode_wav(x, RATE as u32)).ok().map(|_| name)
    });
    let line = json!({
        "at": at,
        "keyword": kws::KEYWORDS.get(hit.keyword),
        "score": (hit.score * 1000.0).round() / 1000.0,
        "outcome": outcome,
        "transcribeMs": ms,
        "clip": file,
    });
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("triggers.jsonl")) {
        let _ = writeln!(f, "{line}");
    }
}

// ── the run ─────────────────────────────────────────────────────────────────

pub enum Cmd {
    Stop,
}

/// A running wake word: its commands.
pub struct Handle {
    pub cmds: Sender<Cmd>,
}

/// What the run needs from the rest of voice, so it can be driven by hand.
pub trait Host: Send {
    /// Conversation mode or a dictation has the microphone.
    fn busy(&self) -> bool;
    /// Duck's voice is playing.
    fn speaking(&self) -> bool;
    fn chime(&self);
    /// Start listening as the key would (conversation mode).
    fn converse(&self);
    /// The listening sign and the webview's voice state for a dictation.
    fn dictating(&self, state: &'static str);
    /// Send text to Duck as push-to-talk does.
    fn send(&self, t: Transcript);
    fn state(&self, listening: bool, hold: Option<Hold>, error: Option<String>);
}

struct Desktop(AppHandle);

impl Host for Desktop {
    fn busy(&self) -> bool {
        super::conversing(&self.0) || super::recording(&self.0)
    }

    fn speaking(&self) -> bool {
        self.0.try_state::<tts::TtsState>().is_some_and(|t| t.voice_active())
    }

    fn chime(&self) {
        if let Some(t) = self.0.try_state::<tts::TtsState>() {
            t.cue();
        }
    }

    fn converse(&self) {
        super::set_conversation(&self.0, true);
    }

    fn dictating(&self, state: &'static str) {
        super::say(&self.0, state, None);
    }

    fn send(&self, t: Transcript) {
        let _ = self.0.emit(super::TRANSCRIPT_EVENT, &t);
    }

    fn state(&self, listening: bool, hold: Option<Hold>, error: Option<String>) {
        emit(&self.0, true, listening, hold, error);
    }
}

/// Start listening for the phrase on a thread of its own.
pub fn start(app: AppHandle, engine: Arc<Engine>, settings: Settings) -> Handle {
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new().name("voice-wake".into()).spawn(move || {
        lower_priority();
        let host = Desktop(app.clone());
        if let Err(e) = run(&host, &engine, &settings, &rx) {
            host.state(false, None, Some(e));
        }
        emit(&app, false, false, None, None);
    });
    if let Err(e) = spawned {
        eprintln!("[voice] the wake word didn't start: {e}");
    }
    Handle { cmds: tx }
}

#[cfg(windows)]
fn lower_priority() {
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
    // SAFETY: the current thread's pseudo-handle.
    let _ = unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL) };
}

#[cfg(not(windows))]
fn lower_priority() {}

/// The models, then the microphone and the ear, until stopped.
fn run(host: &dyn Host, engine: &Arc<Engine>, s: &Settings, cmds: &Receiver<Cmd>) -> Result<(), String> {
    let root = engine.root().to_path_buf();
    if engine.choose(s.gpu).is_none() {
        return Err("The voice model isn't downloaded yet: download it in Duck's settings.".into());
    }
    assets::fetch_kws(&root, &mut |_| {}).map_err(|e| format!("The wake word's model didn't download: {e}"))?;
    engine::init_runtime(&root)?;
    let mut vad = Vad::load(&root.join(vad::MODEL), &engine::tiny_session)?;
    let mut spotter = Spotter::load(&root.join(kws::DIR), kws::KEYWORDS, s.sensitivity, &engine::tiny_session)?;
    let mut ear = Ear::new();
    let mut mic: Option<capture::Listener> = None;
    let mut held: Option<Hold> = None;
    let mut checked = Instant::now() - HOLD_EVERY;
    let mut voice_until: Option<Instant> = None;
    let mut pending: Vec<f32> = Vec::new();
    let mut shown: Option<(bool, Option<Hold>)> = None;
    let show = |shown: &mut Option<(bool, Option<Hold>)>, listening: bool, hold: Option<Hold>| {
        if *shown != Some((listening, hold)) {
            *shown = Some((listening, hold));
            host.state(listening, hold, None);
        }
    };
    let mut preloaded: Option<Instant> = None;

    loop {
        match cmds.try_recv() {
            Ok(Cmd::Stop) | Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        // Conversation mode or a dictation takes the microphone at once; the rest is
        // looked at every second.
        let busy = host.busy();
        if busy || checked.elapsed() >= HOLD_EVERY {
            checked = Instant::now();
            held = hold(s, busy);
        }
        if held.is_some() {
            if mic.take().is_some() {
                // A dictation after the phrase alone gives way too (the key was
                // pressed): its listening sign goes.
                if ear.following() {
                    host.dictating("idle");
                }
                ear.sleep(&mut spotter);
                pending.clear();
            }
            show(&mut shown, false, held);
            std::thread::sleep(Duration::from_millis(250));
            continue;
        }
        let blocks = match &mic {
            Some(m) => &m.blocks,
            None => match capture::listen(s.device.clone()) {
                Ok(m) => {
                    vad.reset();
                    &mic.insert(m).blocks
                }
                Err(e) => {
                    host.state(false, None, Some(format!("The microphone didn't open: {e}")));
                    shown = None;
                    std::thread::sleep(Duration::from_secs(5));
                    continue;
                }
            },
        };
        show(&mut shown, true, None);
        match blocks.recv_timeout(Duration::from_millis(100)) {
            Ok(b) => pending.extend(b),
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                mic = None;
                continue;
            }
        }
        let mut consumed = 0;
        while pending.len() - consumed >= FRAME {
            let frame = &pending[consumed..consumed + FRAME];
            consumed += FRAME;
            if host.speaking() {
                voice_until = Some(Instant::now() + ECHO_TAIL);
            }
            // Deaf while Duck speaks: what's heard then is Duck.
            if voice_until.is_some_and(|t| Instant::now() < t) && !ear.following() {
                ear.sleep(&mut spotter);
                continue;
            }
            let p = vad.step(frame)?;
            let heard = ear.frame(frame, p, &mut spotter);
            // A hit is being recorded: load the speech model meanwhile.
            if ear.capturing() && preloaded.is_none_or(|t| t.elapsed() > Duration::from_secs(60)) {
                preloaded = Some(Instant::now());
                let (engine, gpu) = (Arc::clone(engine), s.gpu);
                std::thread::spawn(move || {
                    let _ = engine.preload(gpu);
                });
            }
            if let Some(heard) = heard {
                handle(host, engine, s, &mut ear, heard, &mut mic);
                if mic.is_none() {
                    break;
                }
            }
        }
        if mic.is_none() {
            pending.clear();
        } else {
            pending.drain(..consumed.min(pending.len()));
        }
    }
}

/// What a stretch the ear gave turns out to be, and what's done about it.
fn handle(host: &dyn Host, engine: &Arc<Engine>, s: &Settings, ear: &mut Ear, heard: Heard, mic: &mut Option<capture::Listener>) {
    match heard {
        Heard::Clip { from, to, hit } => {
            let clip = ear.slice(from, to);
            let t = Instant::now();
            let text = match engine.transcribe(&clip, s.gpu) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[wake] transcription failed: {e}");
                    return;
                }
            };
            let ms = t.elapsed().as_millis() as u64;
            match confirm(&text.text) {
                Verdict::None => log_trigger(&hit, "none", ms, s.keep_clips.then_some(&clip[..])),
                Verdict::Command(rest) => {
                    log_trigger(&hit, "command", ms, None);
                    host.send(Transcript { text: rest, ..text });
                }
                Verdict::Alone => {
                    log_trigger(&hit, "alone", ms, None);
                    host.chime();
                    if s.press == Press::Conversation {
                        // Conversation mode opens the microphone itself.
                        *mic = None;
                        host.converse();
                    } else {
                        host.dictating("listening");
                        ear.follow();
                    }
                }
            }
        }
        Heard::Followed { from, to } => {
            host.dictating("transcribing");
            match engine.transcribe(&ear.slice(from, to), s.gpu) {
                Ok(t) if !t.text.trim().is_empty() => {
                    host.dictating("idle");
                    host.send(t);
                }
                Ok(_) => host.dictating("idle"),
                Err(e) => {
                    eprintln!("[wake] transcription failed: {e}");
                    host.dictating("idle");
                }
            }
        }
        Heard::NothingFollowed => host.dictating("idle"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hits after `after` samples fed since a reset, at the stream's second
    /// `start`..`at` of the hit.
    struct Fake {
        fed: usize,
        after: Option<usize>,
        resets: usize,
        hit_start: f32,
    }

    impl Spot for Fake {
        fn reset(&mut self) {
            self.fed = 0;
            self.resets += 1;
        }

        fn accept(&mut self, x: &[f32]) -> Option<Hit> {
            self.fed += x.len();
            match self.after {
                Some(n) if self.fed >= n => {
                    self.after = None;
                    Some(Hit { keyword: 0, score: 0.5, start: self.hit_start, at: self.fed as f32 / RATE as f32 })
                }
                _ => None,
            }
        }
    }

    /// Feed `(seconds, speech?)` stretches; what the ear gave, with the sample it
    /// gave it at.
    fn feed(ear: &mut Ear, spot: &mut dyn Spot, plan: &[(f32, bool)]) -> Vec<(usize, Heard)> {
        let mut out = Vec::new();
        let frame = [0f32; FRAME];
        for &(secs, speech) in plan {
            for _ in 0..(secs * RATE as f32 / FRAME as f32).round() as usize {
                if let Some(h) = ear.frame(&frame, if speech { 0.9 } else { 0.05 }, spot) {
                    out.push((ear.now(), h));
                }
            }
        }
        out
    }

    #[test]
    fn speech_wakes_the_spotter_from_before_it_began_and_silence_puts_it_back() {
        let mut ear = Ear::new();
        let mut spot = Fake { fed: 0, after: None, resets: 0, hit_start: 0.0 };
        assert!(feed(&mut ear, &mut spot, &[(1.0, false)]).is_empty());
        assert!(!ear.spotting());
        feed(&mut ear, &mut spot, &[(0.1, true)]);
        assert!(ear.spotting());
        // Woken with the pre-roll: half a second plus the speech so far.
        assert_eq!(spot.fed, PREROLL + WAKE_FRAMES * FRAME);
        feed(&mut ear, &mut spot, &[(0.9, false)]);
        assert!(ear.spotting(), "a pause shorter than a second keeps it awake");
        feed(&mut ear, &mut spot, &[(0.2, false)]);
        assert!(!ear.spotting());
        assert_eq!(spot.resets, 2);
    }

    #[test]
    fn a_hit_records_from_just_before_the_phrase_to_the_end_of_speech() {
        let mut ear = Ear::new();
        // The hit comes 1.2 s into the spotter's stream, the phrase having begun at 0.6 s.
        let mut spot = Fake { fed: 0, after: Some(RATE * 6 / 5), resets: 0, hit_start: 0.6 };
        let got = feed(&mut ear, &mut spot, &[(2.0, false), (2.5, true), (1.0, false)]);
        let [(at, Heard::Clip { from, to, hit })] = &got[..] else { panic!("{got:?}") };
        // The spotter's stream starts half a second before the speech (at 2 s).
        let stream = 2 * RATE - PREROLL + (FRAME - (2 * RATE) % FRAME) % FRAME;
        assert!((*from as i64 - (stream as i64 + (0.6 * RATE as f32) as i64 - BEFORE as i64)).abs() <= FRAME as i64, "{from} {stream}");
        // It ends 0.8 s into the silence.
        let speech_end = ((4.5 * RATE as f32) / FRAME as f32).round() as usize * FRAME;
        assert!((*to as i64 - (speech_end + CLIP_END) as i64).abs() <= FRAME as i64, "{to}");
        assert_eq!(at, to);
        assert_eq!(hit.score, 0.5);
        assert!(!ear.spotting());
    }

    #[test]
    fn after_the_phrase_alone_it_takes_what_follows_or_gives_up() {
        let mut ear = Ear::new();
        let mut spot = Fake { fed: 0, after: None, resets: 0, hit_start: 0.0 };
        feed(&mut ear, &mut spot, &[(0.5, false)]);
        ear.follow();
        let got = feed(&mut ear, &mut spot, &[(1.0, false), (2.0, true), (1.5, false)]);
        let [(_, Heard::Followed { from, to })] = &got[..] else { panic!("{got:?}") };
        assert!(to - from > 2 * RATE && to - from < 4 * RATE, "{from}..{to}");
        assert!(!ear.following());
        // Nothing said: it gives up after 8 s.
        ear.follow();
        let got = feed(&mut ear, &mut spot, &[(9.0, false)]);
        assert_eq!(got.iter().map(|g| g.1.clone()).collect::<Vec<_>>(), vec![Heard::NothingFollowed]);
    }

    #[test]
    fn the_transcript_confirms_the_phrase_in_either_language() {
        assert_eq!(confirm("Hey Duck."), Verdict::Alone);
        assert_eq!(confirm("Hey, Duck, what's the weather like?"), Verdict::Command("what's the weather like?".into()));
        assert_eq!(confirm("Эй, Дак, какая сегодня погода?"), Verdict::Command("какая сегодня погода?".into()));
        assert_eq!(confirm("Эй, Дак."), Verdict::Alone);
        assert_eq!(confirm("Hey Dak, open my notifications"), Verdict::Command("open my notifications".into()));
        assert_eq!(confirm("Heyduck, stop"), Verdict::Command("stop".into()));
        assert_eq!(confirm("Hi, Dock."), Verdict::Alone);
        // The end of what came before, then the phrase.
        assert_eq!(confirm("so. Hey Duck, play music"), Verdict::Command("play music".into()));
        // Not the phrase: nothing goes to Duck.
        assert_eq!(confirm("Hey Doug, how are you?"), Verdict::None);
        assert_eq!(confirm("Hey, look at that duck."), Verdict::None);
        assert_eq!(confirm("A duck crossed the road."), Verdict::None);
        assert_eq!(confirm("Эй, так нельзя."), Verdict::None);
        assert_eq!(confirm("Эй, как дела?"), Verdict::None);
        assert_eq!(confirm(""), Verdict::None);
        assert_eq!(confirm("one two three hey duck"), Verdict::None, "too far in");
    }

    /// The whole ear on recordings (`cargo test --release wake_bench -- --ignored
    /// --nocapture`): the real VAD and spotter, and Parakeet (CPU) for the verdict.
    /// `WB_MODELS` has everything downloaded; `WB_WAKE_CLIPS` is a folder of 16 kHz
    /// clips with a `meta.json` (`file`, `lang`, `wake`); `WB_WAKE_LONG`, WAVs with
    /// no wake word in them, `;`-separated (folders or files). Prints what each
    /// turned into, the false triggers per hour, and the time the ear took per
    /// second of audio (the transcriptions apart).
    #[test]
    #[ignore]
    fn wake_bench() {
        use std::path::{Path, PathBuf};
        let models = PathBuf::from(std::env::var("WB_MODELS").expect("WB_MODELS"));
        engine::init_runtime(&models).unwrap();
        assets::fetch_kws(&models, &mut |_| {}).unwrap();
        let sensitivity = std::env::var("WB_WAKE_SENS").ok().and_then(|s| s.parse().ok()).unwrap_or(0.5);
        let mut vad = Vad::load(&models.join(vad::MODEL), &engine::tiny_session).unwrap();
        let mut spotter = Spotter::load(&models.join(kws::DIR), kws::KEYWORDS, sensitivity, &engine::tiny_session).unwrap();
        let stt = Engine::new(models.clone());
        let mut ear_time = Duration::ZERO;
        // Each stretch the ear gives, with its verdict.
        let mut listen = |x: &[f32], stt_time: &mut Duration| -> Vec<(Verdict, String, f32)> {
            let mut ear = Ear::new();
            vad.reset();
            Spot::reset(&mut spotter);
            let mut out = Vec::new();
            let t = Instant::now();
            let mut spent = Duration::ZERO;
            for f in x.chunks_exact(FRAME) {
                let p = vad.step(f).unwrap();
                if let Some(Heard::Clip { from, to, hit }) = ear.frame(f, p, &mut spotter) {
                    let t2 = Instant::now();
                    let text = stt.transcribe(&ear.slice(from, to), GpuPref::Never).unwrap().text;
                    spent += t2.elapsed();
                    out.push((confirm(&text), text, hit.score));
                }
            }
            ear_time += t.elapsed() - spent;
            *stt_time += spent;
            out
        };
        let mut stt_time = Duration::ZERO;
        let mut audio = 0f32;
        if let Ok(dir) = std::env::var("WB_WAKE_CLIPS") {
            let dir = PathBuf::from(dir);
            let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("meta.json")).unwrap()).unwrap();
            // (lang, wake) → [clips, spotted, confirmed]
            let mut tally: std::collections::BTreeMap<(String, bool), [usize; 3]> = Default::default();
            for m in meta.as_array().unwrap() {
                let file = m["file"].as_str().unwrap();
                let x = super::super::read_wav(&dir.join(file)).unwrap();
                audio += x.len() as f32 / RATE as f32;
                let got = listen(&x, &mut stt_time);
                let wake = m["wake"].as_bool().unwrap();
                let t = tally.entry((m["lang"].as_str().unwrap().to_string(), wake)).or_default();
                t[0] += 1;
                t[1] += usize::from(!got.is_empty());
                let ok = got.iter().any(|g| g.0 != Verdict::None);
                t[2] += usize::from(ok);
                if ok != wake || std::env::var("WB_WAKE_VERBOSE").is_ok() {
                    println!("  {file}: {:?}", got.iter().map(|g| (&g.0, g.1.as_str(), g.2)).collect::<Vec<_>>());
                }
            }
            for ((lang, wake), [n, spotted, confirmed]) in tally {
                println!("{lang} {}: {n} clips, {spotted} spotted, {confirmed} confirmed", if wake { "with the phrase" } else { "without" });
            }
        }
        if let Ok(list) = std::env::var("WB_WAKE_LONG") {
            let mut files: Vec<PathBuf> = Vec::new();
            for p in list.split(';').filter(|p| !p.is_empty()) {
                let p = Path::new(p);
                if p.is_dir() {
                    let mut fs: Vec<PathBuf> = std::fs::read_dir(p).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "wav")).collect();
                    fs.sort();
                    files.extend(fs);
                } else {
                    files.push(p.to_path_buf());
                }
            }
            let (mut secs, mut hits, mut confirmed) = (0f32, 0usize, 0usize);
            for f in files {
                let (x, rate) = super::super::parse_wav_at(&std::fs::read(&f).unwrap()).unwrap();
                let x = if rate == 16_000 { x } else { capture::resample(&x, rate, 16_000) };
                secs += x.len() as f32 / RATE as f32;
                audio += x.len() as f32 / RATE as f32;
                for (v, text, score) in listen(&x, &mut stt_time) {
                    hits += 1;
                    if v != Verdict::None {
                        confirmed += 1;
                    }
                    println!("  {}: {v:?} {score:.2} {text:?}", f.file_name().unwrap().to_string_lossy());
                }
            }
            let h = secs / 3600.0;
            println!("no wake word, {h:.2} h: {hits} spotted ({:.2}/h), {confirmed} confirmed ({:.2}/h)", hits as f32 / h, confirmed as f32 / h);
        }
        println!(
            "the ear: {:.1} s for {:.0} s of audio ({:.2}% of a core); transcribing hits: {:.1} s",
            ear_time.as_secs_f32(),
            audio,
            100.0 * ear_time.as_secs_f32() / audio,
            stt_time.as_secs_f32()
        );
    }
}
