//! Conversation mode (step V4): you just talk. Duck works out when you've finished,
//! not merely paused, answers, and listens again, with nothing to press.
//!
//! - **The microphone** stays open while the mode is on ([`capture::listen`]), and
//!   every 32 ms frame goes through Silero VAD ([`Vad::step`]).
//! - **The turn** ([`Machine`]): speech starts one; in each pause the mode's
//!   policy ([`Patience`], X0's measured ones) asks the turn detector
//!   ([`SmartTurn`]) at set lengths of silence, and ends the turn when it says
//!   "complete" or the silence reaches the ceiling.
//! - **Incremental STT:** each stretch of speech is transcribed when a 0.6 s pause
//!   closes it, so the end of a long monologue only waits for its last stretch. The
//!   model stays loaded while the mode is on.
//! - **Grace and merge:** at the end of a turn its text goes out at once as
//!   `provisional` (`voice-turn`), so Duck starts on it. Speech again within 2 s
//!   `withdraw`s it (the engine aborts the request, and nothing is kept), and the
//!   next end sends the merged text. 2 s of quiet makes it `final`.
//! - **Verbal controls** in what was heard ([`control`]): "wait" holds the turn
//!   open with no ceiling until "go on"; "that's it" ends it now; "stop" cuts
//!   Duck's voice; "that's all for now" sends what's left and turns the mode off.
//! - **Duck's voice:** you can talk over it, and ~0.3 s of your speech stops it.
//!   With headphones ([`endpoint`]) the microphone doesn't hear it. On speakers
//!   (or an output of unknown kind) the microphone goes through the echo canceller
//!   ([`aec`], V4 part 2) fed what's playing. While Duck speaks there, speech must
//!   also pass the barge-in gate ([`aec::Gate`]), and words heard that are mostly
//!   Duck's own are dropped ([`aec::self_voice`]). The "never" setting keeps part
//!   1's half-duplex: Duck doesn't listen while it speaks, nor for a moment after.
//! - **The listening sign** ([`overlay`]) shows exactly while the microphone is
//!   being listened to.
//! - **Off** by the key or the drawer, by "that's all for now", or after minutes
//!   of quiet (`autoOffMin`); the microphone is released at once.
//!
//! The **reply window** (V5's, built here) is the same pipeline for a few seconds
//! after Duck announces something: a reply goes to that thread, and the window
//! closes when it's sent or when nothing was said.
//!
//! **The phone** (V4 part 3) runs the same pipeline here, on the desktop: its page
//! streams its microphone over Duck's socket, and a [`Surface`] stands for where a
//! run hears and speaks ([`Desktop`], or the phone's socket in
//! `remote/assistant.rs`).

use std::collections::VecDeque;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::aec::{self, Canceller, Gate};
use super::endpoint::{self, Output};
use super::engine::{self, Engine, GpuPref};
use super::turn::{self, SmartTurn};
use super::vad::{self, Vad};
use super::{assets, capture, overlay, tts};

const RATE: usize = 16_000;
const FRAME: usize = vad::FRAME;

fn secs(frames: usize) -> f32 {
    (frames * FRAME) as f32 / RATE as f32
}

// ── the turn ────────────────────────────────────────────────────────────────

/// When a pause is the end of a turn: the turn detector is asked at each of
/// `checks` (seconds of silence) and ends it at `threshold`; at `ceiling` it ends
/// regardless.
#[derive(Debug, Clone, Copy)]
pub struct Policy {
    pub checks: &'static [f32],
    pub threshold: f32,
    pub ceiling: f32,
}

/// How patient Duck is with pauses (X0, on your thinking-aloud monologues):
/// - **quick** (commands): from 0.25 s, 0.5, ceiling 1.5 s. Mid-thought pauses
///   often end the turn, and the grace window takes most of them back.
/// - **patient** (chat): from 1.5 s, 0.7, ceiling 8 s. 17 false ends in 11
///   minutes, every one taken back by the grace window; replies 1.5 s after you
///   stop.
/// - **thinking** (rubber duck): only from 3 s, 0.8, ceiling 8 s. 1 false end in
///   11 minutes; replies ~3 s after you stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Patience {
    #[default]
    Quick,
    Patient,
    Thinking,
}

impl Patience {
    pub fn policy(self) -> Policy {
        match self {
            Patience::Quick => Policy { checks: &[0.25], threshold: 0.5, ceiling: 1.5 },
            Patience::Patient => Policy { checks: &[1.5, 3.0, 5.0], threshold: 0.7, ceiling: 8.0 },
            Patience::Thinking => Policy { checks: &[3.0, 5.0], threshold: 0.8, ceiling: 8.0 },
        }
    }
}

/// Speech shorter than this is a blip (~100 ms, as X0 scored it).
const CONFIRM_FRAMES: usize = 3;
/// Speech in the grace window takes the turn back once it lasts ~250 ms (a
/// cough doesn't).
const RESUME_FRAMES: usize = 8;
/// After a turn ends, speech this soon takes it back.
pub const GRACE_S: f32 = 2.0;
/// A pause this long closes a stretch of speech, which is then transcribed.
const SEGMENT_GAP_S: f32 = 0.6;
/// A stretch longer than this closes at a shorter pause, and one this long closes
/// wherever it is, so no single transcription is long.
const SEGMENT_LONG_S: f32 = 20.0;
const SEGMENT_LONG_GAP_S: f32 = 0.25;
const SEGMENT_MAX_S: f32 = 30.0;
/// Kept around a stretch, each side (the engine trims it to its speech again).
const PAD: usize = RATE / 5;

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// Speech started a turn.
    Started,
    /// Samples `[from, to)` of the stream are a stretch of speech to transcribe.
    Segment { from: usize, to: usize },
    /// The turn is over (provisionally: the grace window is open).
    EndOfTurn,
    /// Speech in the grace window: the turn goes on.
    Resumed,
    /// The grace window passed: the turn stands.
    Committed,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    Turn,
    /// Since this frame.
    Grace(usize),
}

/// The turn, frame by frame. It knows nothing of audio: it takes each frame's
/// speech probability, and asks `ask(from, to)` for the turn detector's verdict
/// on samples `[from, to)`.
pub struct Machine {
    policy: Policy,
    phase: Phase,
    /// Frames seen.
    frame: usize,
    /// The VAD's hysteresis: in speech (above `ON` to start, `OFF` to stay).
    on: bool,
    /// Consecutive speech frames.
    run: usize,
    /// Frames since the last speech, in a turn.
    sil: usize,
    /// Checks asked in this pause.
    asked: usize,
    /// Where the turn detector's audio starts: the turn's first speech, or where
    /// it resumed after a grace window (as X0 scored it). It hears the last 8 s.
    heard_from: usize,
    /// The open stretch's first speech frame.
    segment: Option<usize>,
    last_speech: usize,
    held: bool,
}

impl Machine {
    pub fn new(policy: Policy) -> Self {
        Self {
            policy,
            phase: Phase::Idle,
            frame: 0,
            on: false,
            run: 0,
            sil: 0,
            asked: 0,
            heard_from: 0,
            segment: None,
            last_speech: 0,
            held: false,
        }
    }

    pub fn in_turn(&self) -> bool {
        self.phase == Phase::Turn
    }

    pub fn in_grace(&self) -> bool {
        matches!(self.phase, Phase::Grace(_))
    }

    /// Speech has gone on this many frames.
    pub fn speech_frames(&self) -> usize {
        self.run
    }

    pub fn held(&self) -> bool {
        self.held
    }

    /// One frame: its speech probability, and whether it's to be ignored (Duck
    /// speaking on speakers).
    pub fn frame(&mut self, p: f32, deaf: bool, ask: &mut dyn FnMut(usize, usize) -> f32) -> Vec<Event> {
        let i = self.frame;
        self.frame += 1;
        self.on = !deaf && if self.on { p >= vad::OFF } else { p >= vad::ON };
        self.run = if self.on { self.run + 1 } else { 0 };
        let start = i + 1 - self.run.min(i + 1);
        let mut events = Vec::new();
        match self.phase {
            Phase::Idle => {
                if self.run >= CONFIRM_FRAMES {
                    self.begin(start, i);
                    events.push(Event::Started);
                }
            }
            Phase::Grace(since) => {
                if self.run >= RESUME_FRAMES {
                    self.begin(start, i);
                    events.push(Event::Resumed);
                } else if secs(i + 1 - since) >= GRACE_S {
                    self.phase = Phase::Idle;
                    events.push(Event::Committed);
                }
            }
            Phase::Turn if self.run >= CONFIRM_FRAMES => {
                self.sil = 0;
                self.asked = 0;
                self.last_speech = i;
                let from = *self.segment.get_or_insert(start);
                if secs(i + 1 - from) >= SEGMENT_MAX_S {
                    events.push(self.close_segment());
                    self.segment = Some(i + 1);
                }
            }
            Phase::Turn => {
                self.sil += 1;
                let silence = secs(self.sil);
                if let Some(from) = self.segment {
                    let long = secs(self.last_speech + 1 - from) >= SEGMENT_LONG_S;
                    if silence >= SEGMENT_GAP_S || (long && silence >= SEGMENT_LONG_GAP_S) {
                        events.push(self.close_segment());
                    }
                }
                if !self.held {
                    let mut complete = false;
                    while self.asked < self.policy.checks.len() && silence >= self.policy.checks[self.asked] {
                        self.asked += 1;
                        if ask(self.heard_from, (i + 1) * FRAME) >= self.policy.threshold {
                            complete = true;
                            break;
                        }
                    }
                    if complete || silence >= self.policy.ceiling {
                        events.extend(self.end_turn());
                    }
                }
            }
        }
        events
    }

    fn begin(&mut self, start: usize, i: usize) {
        self.phase = Phase::Turn;
        self.heard_from = start * FRAME;
        self.segment = Some(start);
        self.sil = 0;
        self.asked = 0;
        self.last_speech = i;
    }

    fn close_segment(&mut self) -> Event {
        let from = self.segment.take().unwrap_or(self.last_speech);
        let now = self.frame * FRAME;
        Event::Segment { from: (from * FRAME).saturating_sub(PAD), to: ((self.last_speech + 1) * FRAME + PAD).min(now) }
    }

    fn end_turn(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        if self.segment.is_some() {
            events.push(self.close_segment());
        }
        self.phase = Phase::Grace(self.frame);
        events.push(Event::EndOfTurn);
        events
    }

    /// End the turn now ("that's it"). Nothing when not in one.
    pub fn end_now(&mut self) -> Vec<Event> {
        if self.phase == Phase::Turn {
            self.end_turn()
        } else {
            Vec::new()
        }
    }

    /// A turn that ended before what was heard was read ("wait" in its last
    /// stretch) goes on, with no checks until speech comes again.
    pub fn reopen(&mut self) {
        if self.in_grace() {
            self.phase = Phase::Turn;
            self.asked = self.policy.checks.len();
        }
    }

    /// Drop the turn (nothing in it was worth sending).
    pub fn cancel(&mut self) {
        self.phase = Phase::Idle;
        self.segment = None;
    }

    /// "Wait": no checks and no ceiling until released. Released, the pause is
    /// timed from then.
    pub fn hold(&mut self, on: bool) {
        if self.held && !on {
            self.sil = 0;
            self.asked = 0;
        }
        self.held = on;
    }
}

// ── verbal controls ─────────────────────────────────────────────────────────

pub mod control {
    //! What a stretch of speech says to do, besides being words to send. A control
    //! counts only as the last phrase of a stretch (after its last `.`, `!`, `?`
    //! or `,`), so "the game is over" isn't "over". `rest` is what came before it.

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Control {
        /// Just words.
        None,
        /// "wait / hold on / подожди": keep the turn open.
        Hold(String),
        /// "go on / давай": let it end again.
        Release(String),
        /// "that's it / over / всё": end the turn now.
        End(String),
        /// "stop / хватит": cut Duck's voice.
        Stop(String),
        /// "that's all for now / на этом всё": send what's left, then the mode
        /// turns off.
        Bye(String),
    }

    const BYE: &[&str] = &["that's all for now", "that is all for now", "that's all", "на этом всё", "на этом все", "пока всё", "пока все"];
    const END: &[&str] = &["that's it", "that is it", "over", "всё", "все", "это всё", "это все"];
    const STOP: &[&str] = &["stop", "please stop", "stop please", "хватит", "стоп"];
    const HOLD: &[&str] = &["wait", "hold on", "wait a moment", "wait a second", "подожди", "подождите", "погоди", "секунду"];
    const RELEASE: &[&str] = &["go on", "go ahead", "continue", "давай", "продолжай"];

    fn norm(s: &str) -> String {
        let s = s.to_lowercase().replace('ё', "е").replace('’', "'");
        s.chars()
            .map(|c| if c.is_alphanumeric() || c == '\'' { c } else { ' ' })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn is(phrase: &str, list: &[&str]) -> bool {
        list.iter().any(|p| norm(p) == phrase)
    }

    pub fn classify(text: &str) -> Control {
        let t = text.trim().trim_end_matches(|c: char| c.is_ascii_punctuation() || c == '…' || c.is_whitespace());
        let cut = t.rfind(['.', '!', '?', ',', '…', ';']).map(|i| i + t[i..].chars().next().map_or(1, char::len_utf8));
        let (rest, last) = match cut {
            Some(i) => (t[..i].trim().trim_end_matches([',', ';']).trim(), &t[i..]),
            None => ("", t),
        };
        let last = norm(last);
        let rest = rest.to_string();
        if is(&last, BYE) {
            Control::Bye(rest)
        } else if is(&last, END) {
            Control::End(rest)
        } else if is(&last, STOP) {
            Control::Stop(rest)
        } else if is(&last, HOLD) {
            Control::Hold(rest)
        } else if is(&last, RELEASE) {
            Control::Release(rest)
        } else {
            Control::None
        }
    }
}

// ── the running mode ────────────────────────────────────────────────────────

/// How Duck's own voice is kept out of what it hears.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EchoPref {
    /// By the output ([`endpoint`]): headphones as they are, anything else
    /// through the echo canceller.
    #[default]
    Auto,
    /// The echo canceller whatever the output.
    Full,
    /// Never listen while Duck speaks (half-duplex).
    Half,
}

impl EchoPref {
    /// For this output: whether you can talk over Duck, and whether the echo
    /// canceller runs.
    fn chain(self, o: Output) -> (bool, bool) {
        match self {
            EchoPref::Full => (true, true),
            EchoPref::Half => (false, false),
            EchoPref::Auto => (true, o != Output::Headphones),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub gpu: GpuPref,
    pub device: Option<String>,
    pub patience: Patience,
    pub echo: EchoPref,
    pub auto_off: Duration,
    pub cue: bool,
}

/// What's running: the mode, or a reply window of so many seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Mode,
    Window(Duration),
}

pub const STATE_EVENT: &str = "conversation-state";
pub const TURN_EVENT: &str = "voice-turn";
pub const LEVEL_EVENT: &str = "conversation-level";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    /// Which run this is (a newer one replaces it).
    pub run: u64,
    /// `preparing`, `listening`, `hearing` (you're talking), `grace` (a turn just
    /// went out), `deaf` (Duck speaking on speakers), `off` or `error`.
    pub state: &'static str,
    /// A reply window, not the mode.
    pub window: bool,
    /// "wait" is holding the turn open.
    pub held: bool,
    /// You can talk over Duck now.
    pub duplex: bool,
    pub message: Option<String>,
    /// The echo canceller is running.
    pub cancelling: bool,
    /// The echo it has removed while Duck talked, dB, and the output that was on.
    pub suppression: Option<f32>,
    pub output: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEvent {
    pub run: u64,
    pub id: u64,
    pub text: String,
    /// `provisional` (start on it), `withdrawn` (you went on: drop it) or `final`.
    pub phase: &'static str,
    pub window: bool,
}

pub enum Cmd {
    Stop,
}

/// A running mode or window: its commands, and which run it is.
pub struct Handle {
    pub cmds: Sender<Cmd>,
    pub kind: Kind,
    pub run: u64,
}

/// After Duck's voice stops, the room's echo takes this long to die (X0: the
/// playback reached the mic ~165 ms late).
const ECHO_TAIL: Duration = Duration::from_millis(400);
/// Your speech over Duck's voice stops it after ~300 ms (X0's interruptions fired
/// at ~0.29 s).
const BARGE_FRAMES: usize = 9;
const LEVEL_EVERY: Duration = Duration::from_millis(100);
const OUTPUT_EVERY: Duration = Duration::from_secs(3);
/// What Duck said this recently is compared with what's heard over it.
const SAID_WITHIN: Duration = Duration::from_secs(30);

/// Where a run hears and speaks: the desktop, or a phone (V4 part 3).
pub trait Surface: Send {
    /// The run's state, its turns and the microphone's level, for the UI.
    fn state(&self, ev: &StateEvent);
    fn turn(&self, ev: &TurnEvent);
    fn level(&self, level: f32);
    /// The listening sign.
    fn sign(&self, on: bool);
    /// Start the voice replies will be spoken in.
    fn warm(&self);
    /// Duck's voice is playing there now.
    fn speaking(&self) -> bool;
    /// Cut Duck's voice (you talked over it, or said "stop").
    fn cut(&self);
    /// The soft "heard you" chime.
    fn cue(&self);
    /// What Duck said there lately (the self-voice check).
    fn said_lately(&self, within: Duration) -> String;
    /// The output Duck's voice comes out of, and its name; None where it isn't
    /// the run's to handle (a phone's browser cancels its own echo).
    fn output(&self) -> Option<(Output, Option<String>)>;
    /// Keep the output open for the echo canceller's reference.
    fn hold_output(&self, on: bool);
    /// The run is over and was still the current one.
    fn finish(&self);
}

/// The desktop: its microphone and speakers, the webview's events, the
/// listening sign and the tray.
pub struct Desktop(pub AppHandle);

impl Desktop {
    fn tts(&self) -> Option<tauri::State<'_, tts::TtsState>> {
        self.0.try_state::<tts::TtsState>()
    }
}

impl Surface for Desktop {
    fn state(&self, ev: &StateEvent) {
        if !matches!(ev.state, "off" | "error") {
            let tray = match ev.state {
                "preparing" => "Duck is getting ready to listen",
                "hearing" | "grace" => "Duck is hearing you",
                "deaf" => "Duck is speaking",
                _ => "Duck is listening",
            };
            crate::attention::set_voice(&self.0, Some(tray));
        }
        let _ = self.0.emit(STATE_EVENT, ev);
    }

    fn turn(&self, ev: &TurnEvent) {
        let _ = self.0.emit(TURN_EVENT, ev);
    }

    fn level(&self, level: f32) {
        let _ = self.0.emit(LEVEL_EVENT, level);
    }

    fn sign(&self, on: bool) {
        overlay::set(&self.0, on);
    }

    fn warm(&self) {
        if let Some(t) = self.tts() {
            t.warm_if_wanted();
        }
    }

    fn speaking(&self) -> bool {
        self.tts().is_some_and(|t| t.voice_active())
    }

    fn cut(&self) {
        if let Some(t) = self.tts() {
            t.stop(&self.0);
        }
    }

    fn cue(&self) {
        if let Some(t) = self.tts() {
            t.cue();
        }
    }

    fn said_lately(&self, within: Duration) -> String {
        self.tts().map(|t| t.said_lately(within)).unwrap_or_default()
    }

    fn output(&self) -> Option<(Output, Option<String>)> {
        Some((endpoint::default_output(), endpoint::default_output_name()))
    }

    fn hold_output(&self, on: bool) {
        if let Some(t) = self.tts() {
            t.hold_output(on);
        }
    }

    fn finish(&self) {
        overlay::set(&self.0, false);
        crate::attention::set_voice(&self.0, None);
    }
}

/// What a run hears: the desktop's microphone, or 16 kHz blocks from elsewhere
/// (a phone).
pub enum Source {
    Mic,
    Stream(Receiver<Vec<f32>>),
}

/// The speakers' stream held open for the echo canceller, let go however the run
/// ends.
struct HeldOutput<'a> {
    io: &'a dyn Surface,
    on: bool,
}

impl HeldOutput<'_> {
    fn set(&mut self, on: bool) {
        if on != self.on {
            self.on = on;
            self.io.hold_output(on);
        }
    }
}

/// The speech model kept loaded while a run lasts.
struct Warm<'a>(&'a Engine);

impl Drop for Warm<'_> {
    fn drop(&mut self) {
        self.0.set_warm(false);
    }
}

impl Drop for HeldOutput<'_> {
    fn drop(&mut self) {
        self.set(false);
    }
}
/// The audio kept, so a stretch (30 s at most) can be cut out of it.
const KEEP: usize = 40 * RATE;

/// The stream's recent samples, by their index in the stream.
struct Audio {
    buf: VecDeque<f32>,
    start: usize,
}

impl Audio {
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

/// Start a mode or a window on the desktop on a thread of its own, as run `id`.
/// `done` runs when it ends, however it ends, and says whether it was still the
/// one running (not replaced, nor stopped by a dictation, which has the listening
/// sign now).
pub fn start(
    app: AppHandle,
    engine: Arc<Engine>,
    settings: Settings,
    kind: Kind,
    id: u64,
    done: impl FnOnce() -> bool + Send + 'static,
) -> Sender<Cmd> {
    start_on(Box::new(Desktop(app)), engine, settings, kind, id, Source::Mic, done)
}

/// Start a run on any surface, hearing `source` (see [`start`]).
pub fn start_on(
    io: Box<dyn Surface>,
    engine: Arc<Engine>,
    settings: Settings,
    kind: Kind,
    id: u64,
    source: Source,
    done: impl FnOnce() -> bool + Send + 'static,
) -> Sender<Cmd> {
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new().name("voice-conversation".into()).spawn(move || {
        let window = matches!(kind, Kind::Window(_));
        let result = run(io.as_ref(), &engine, &settings, kind, id, &rx, source);
        let (state, message) = match result {
            Ok(m) => ("off", m),
            Err(e) => ("error", Some(e)),
        };
        if done() {
            io.finish();
        }
        io.state(&StateEvent {
            run: id,
            state,
            window,
            held: false,
            duplex: false,
            message,
            cancelling: false,
            suppression: None,
            output: None,
        });
    });
    if let Err(e) = spawned {
        eprintln!("[voice] conversation didn't start: {e}");
    }
    tx
}

/// The loaded models, the microphone and the turn, until stopped. Ok carries why
/// it ended by itself, if it did.
fn run(
    io: &dyn Surface,
    engine: &Arc<Engine>,
    s: &Settings,
    kind: Kind,
    id: u64,
    cmds: &Receiver<Cmd>,
    source: Source,
) -> Result<Option<String>, String> {
    let window = matches!(kind, Kind::Window(_));
    let run = id;
    let emit = |state: &'static str, held: bool, duplex: bool, cancelling: bool, suppression: Option<f32>, output: &Option<String>| {
        io.state(&StateEvent { run, state, window, held, duplex, message: None, cancelling, suppression, output: output.clone() });
    };
    emit("preparing", false, false, false, None, &None);
    let root = engine.root().to_path_buf();
    if engine.choose(s.gpu).is_none() {
        return Err("The voice model isn't downloaded yet: download it in Duck's settings.".into());
    }
    for a in assets::TURN {
        assets::fetch(&root, a, &mut |_| {}).map_err(|e| format!("The turn detector didn't download: {e}"))?;
    }
    engine::init_runtime(&root)?;
    let mut vad = Vad::load(&root.join(vad::MODEL), &engine::tiny_session)?;
    let mut detector = SmartTurn::load(&root.join(turn::MODEL), &engine::tiny_session)?;
    engine.set_warm(true);
    let _warm = Warm(engine);
    {
        let (engine, gpu) = (Arc::clone(engine), s.gpu);
        std::thread::spawn(move || {
            let _ = engine.preload(gpu);
        });
    }
    io.warm();
    let (listener, stream);
    let (blocks, lost) = match source {
        Source::Mic => {
            listener = capture::listen(s.device.clone()).map_err(|e| format!("The microphone didn't open: {e}"))?;
            (&listener.blocks, "The microphone stopped (unplugged?).")
        }
        Source::Stream(rx) => {
            stream = rx;
            (&stream, "The phone stopped sending its microphone.")
        }
    };

    let mut machine = Machine::new(match kind {
        Kind::Mode => s.patience.policy(),
        // A reply to an announcement is short.
        Kind::Window(_) => Patience::Quick.policy(),
    });
    let mut audio = Audio { buf: VecDeque::with_capacity(KEEP), start: 0 };
    // What's heard (through the echo canceller when it runs), and the microphone as
    // it came, sample for sample from the front.
    let mut pending: Vec<f32> = Vec::new();
    let mut pending_raw: Vec<f32> = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    let mut turn_id = 0u64;
    let mut sent: Option<String> = None;
    let mut bye = false;

    let began = Instant::now();
    let mut active = Instant::now();
    let mut heard_any = false;
    let mut output = io.output();
    let mut output_at = Instant::now();
    let mut voice_until: Option<Instant> = None;
    // The stream index Duck's voice was last playing at.
    let mut voice_at: Option<usize> = None;
    let mut level = 0f32;
    let mut level_at = Instant::now();
    let mut shown: Option<(&'static str, bool, bool, bool, Option<i32>)> = None;

    // The echo canceller, for the output it was started on; the speakers kept open
    // while it runs, for its reference.
    let mut canceller: Option<(Canceller, Option<String>)> = None;
    let mut gate = Gate::default();
    let mut held_output = HeldOutput { io, on: false };

    loop {
        match cmds.try_recv() {
            Ok(Cmd::Stop) | Err(mpsc::TryRecvError::Disconnected) => return Ok(None),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        match blocks.recv_timeout(Duration::from_millis(100)) {
            Ok(b) => {
                match &mut canceller {
                    Some((c, _)) => pending.extend(c.process(&b)),
                    None => pending.extend_from_slice(&b),
                }
                pending_raw.extend(b);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err(lost.into()),
        }
        if output_at.elapsed() >= OUTPUT_EVERY {
            output = io.output();
            output_at = Instant::now();
        }
        let output_name = output.as_ref().and_then(|o| o.1.clone());
        // Where the output isn't ours (a phone), you can always talk over Duck.
        let (duplex, cancel) = output.as_ref().map_or((true, false), |o| s.echo.chain(o.0));
        // Started, stopped, or another output (another room's echo): a fresh one.
        if cancel != canceller.is_some() || canceller.as_ref().is_some_and(|(_, on)| *on != output_name) {
            canceller = cancel.then(|| (Canceller::new(), output_name.clone()));
            gate = Gate::default();
            held_output.set(cancel);
            pending_raw = pending.clone();
        }
        let mut consumed = 0;
        while pending.len() - consumed >= FRAME {
            let frame = &pending[consumed..consumed + FRAME];
            let raw = pending_raw.get(consumed..consumed + FRAME).unwrap_or(frame);
            consumed += FRAME;
            audio.push(frame);
            let energy = |x: &[f32]| x.iter().map(|v| v * v).sum::<f32>() / FRAME as f32;
            let (e_raw, e_clean) = (energy(raw), energy(frame));
            level = level.max(((10.0 * e_clean.max(1e-12).log10() + 60.0) / 60.0).clamp(0.0, 1.0));

            let speaking = io.speaking();
            if speaking {
                voice_until = Some(Instant::now() + ECHO_TAIL);
                voice_at = Some(audio.start + audio.buf.len());
                active = Instant::now();
            }
            let deaf = !duplex && voice_until.is_some_and(|t| Instant::now() < t);
            let mut p = vad.step(frame)?;
            // Over Duck's voice, speech no louder than its leftover echo isn't you.
            if let Some((c, _)) = &canceller {
                if !gate.frame(e_raw, e_clean, c.played(), p) {
                    p = 0.0;
                }
            }
            let events = machine.frame(p, deaf, &mut |from, to| detector.complete(&audio.slice(from, to)).unwrap_or(0.0));
            // Talking over Duck: your speech stops its voice.
            if duplex && speaking && machine.speech_frames() >= BARGE_FRAMES {
                io.cut();
            }
            let mut queue: VecDeque<Event> = events.into();
            while let Some(ev) = queue.pop_front() {
                match ev {
                    Event::Started => {
                        heard_any = true;
                        active = Instant::now();
                    }
                    Event::Segment { from, to } => {
                        let t = engine.transcribe(&audio.slice(from, to), s.gpu)?;
                        let text = t.text.trim().to_string();
                        if text.is_empty() {
                            continue;
                        }
                        // Heard while Duck spoke on speakers, and mostly its own words:
                        // its echo got through.
                        if canceller.is_some()
                            && voice_at.is_some_and(|at| at >= from)
                            && aec::self_voice(&text, &io.said_lately(SAID_WITHIN))
                        {
                            continue;
                        }
                        use control::Control;
                        let mut keep = |rest: String| {
                            if !rest.is_empty() {
                                parts.push(rest);
                            }
                        };
                        match control::classify(&text) {
                            Control::None => parts.push(text),
                            Control::Hold(rest) => {
                                keep(rest);
                                machine.hold(true);
                                machine.reopen();
                            }
                            Control::Release(rest) if machine.held() => {
                                keep(rest);
                                machine.hold(false);
                            }
                            Control::Release(_) => parts.push(text),
                            Control::End(rest) => {
                                keep(rest);
                                machine.hold(false);
                                queue.extend(machine.end_now());
                            }
                            Control::Stop(rest) => {
                                io.cut();
                                keep(rest);
                                if parts.is_empty() {
                                    machine.cancel();
                                }
                            }
                            Control::Bye(rest) => {
                                keep(rest);
                                bye = true;
                                machine.hold(false);
                                queue.extend(machine.end_now());
                                if parts.is_empty() {
                                    return Ok(Some("Conversation mode is off (you said so).".into()));
                                }
                            }
                        }
                    }
                    Event::EndOfTurn => {
                        if machine.held() {
                            // "wait" was in its last stretch.
                            machine.reopen();
                            continue;
                        }
                        let text = parts.join(" ").trim().to_string();
                        if text.is_empty() {
                            machine.cancel();
                            continue;
                        }
                        turn_id += 1;
                        if bye {
                            io.turn(&TurnEvent { run, id: turn_id, text, phase: "final", window });
                            return Ok(Some("Conversation mode is off (you said so).".into()));
                        }
                        if s.cue {
                            io.cue();
                        }
                        io.turn(&TurnEvent { run, id: turn_id, text: text.clone(), phase: "provisional", window });
                        sent = Some(text);
                    }
                    Event::Resumed => {
                        if sent.take().is_some() {
                            io.turn(&TurnEvent { run, id: turn_id, text: String::new(), phase: "withdrawn", window });
                        }
                        active = Instant::now();
                    }
                    Event::Committed => {
                        if let Some(text) = sent.take() {
                            io.turn(&TurnEvent { run, id: turn_id, text, phase: "final", window });
                        }
                        parts.clear();
                        active = Instant::now();
                        if window {
                            return Ok(None);
                        }
                    }
                }
            }
            let state = if deaf {
                "deaf"
            } else if machine.in_grace() {
                "grace"
            } else if machine.in_turn() {
                "hearing"
            } else {
                "listening"
            };
            let suppression = canceller.as_ref().and(gate.suppression_db());
            let now = (state, machine.held(), duplex, canceller.is_some(), suppression.map(|d| d.round() as i32));
            if shown != Some(now) {
                if shown.map(|s| s.0 == "deaf") != Some(state == "deaf") {
                    io.sign(state != "deaf");
                }
                shown = Some(now);
                emit(state, now.1, duplex, now.3, suppression, &output_name);
            }
        }
        pending_raw.drain(..consumed.min(pending_raw.len()));
        pending.drain(..consumed);

        if level_at.elapsed() >= LEVEL_EVERY {
            io.level(level);
            level = 0.0;
            level_at = Instant::now();
        }
        let idle = !machine.in_turn() && !machine.in_grace();
        match kind {
            Kind::Mode if idle && active.elapsed() >= s.auto_off => {
                let min = s.auto_off.as_secs().div_ceil(60);
                return Ok(Some(format!("Conversation mode turned off after {min} minute{} of quiet.", if min == 1 { "" } else { "s" })));
            }
            Kind::Window(d) if idle && !heard_any && began.elapsed() >= d => return Ok(None),
            Kind::Window(d) if idle && began.elapsed() >= d + Duration::from_secs(30) => return Ok(None),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::control::{classify, Control};
    use super::*;

    /// Feed the machine `(seconds, speech?)` stretches; the events with the second
    /// they happened at. The turn detector answers `p`.
    fn feed(m: &mut Machine, plan: &[(f32, bool)], p: f32) -> Vec<(f32, Event)> {
        let mut out = Vec::new();
        for &(dur, speech) in plan {
            for _ in 0..(dur / secs(1)).round() as usize {
                let at = secs(m.frame + 1);
                for e in m.frame(if speech { 0.9 } else { 0.05 }, false, &mut |_, _| p) {
                    out.push((at, e));
                }
            }
        }
        out
    }

    fn kinds(evs: &[(f32, Event)]) -> Vec<&'static str> {
        evs.iter()
            .map(|(_, e)| match e {
                Event::Started => "started",
                Event::Segment { .. } => "segment",
                Event::EndOfTurn => "end",
                Event::Resumed => "resumed",
                Event::Committed => "committed",
            })
            .collect()
    }

    #[test]
    fn a_quick_command_ends_at_the_first_check_and_commits_after_grace() {
        let mut m = Machine::new(Patience::Quick.policy());
        let evs = feed(&mut m, &[(0.5, false), (1.2, true), (3.0, false)], 0.9);
        assert_eq!(kinds(&evs), ["started", "segment", "end", "committed"]);
        // The end ~0.25 s after the speech stopped (at 1.73 s, in whole frames),
        // the commit 2 s after that.
        let end = evs[2].0;
        assert!((end - 1.98).abs() < 0.05, "{end}");
        assert!((evs[3].0 - end - GRACE_S).abs() < 0.05);
        // The stretch covers the speech, padded.
        let Event::Segment { from, to } = evs[1].1 else { panic!() };
        assert!(from <= 8000 - PAD + FRAME && (27_200..=27_200 + PAD + FRAME).contains(&to));
    }

    #[test]
    fn not_complete_waits_for_the_ceiling() {
        let mut m = Machine::new(Patience::Patient.policy());
        let evs = feed(&mut m, &[(1.0, true), (9.0, false)], 0.2);
        assert_eq!(kinds(&evs), ["started", "segment", "end"]);
        assert!((evs[2].0 - 9.0).abs() < 0.1, "{}", evs[2].0);
    }

    #[test]
    fn speech_in_the_grace_window_resumes_the_turn() {
        let mut m = Machine::new(Patience::Quick.policy());
        let evs = feed(&mut m, &[(1.0, true), (1.0, false), (1.0, true), (3.0, false)], 0.9);
        assert_eq!(kinds(&evs), ["started", "segment", "end", "resumed", "segment", "end", "committed"]);
    }

    #[test]
    fn blips_and_coughs_dont_count() {
        let mut m = Machine::new(Patience::Quick.policy());
        // 64 ms is a blip: no turn.
        assert!(feed(&mut m, &[(0.064, true), (1.0, false)], 0.9).is_empty());
        // A 160 ms cough in the grace window doesn't take the turn back.
        let evs = feed(&mut m, &[(1.0, true), (0.5, false), (0.16, true), (3.0, false)], 0.9);
        assert_eq!(kinds(&evs), ["started", "segment", "end", "committed"]);
    }

    #[test]
    fn thinking_waits_through_long_pauses() {
        let mut m = Machine::new(Patience::Thinking.policy());
        // Pauses of 2.5 s are never asked about; stretches close at each.
        let evs = feed(&mut m, &[(2.0, true), (2.5, false), (2.0, true), (2.5, false), (2.0, true), (4.0, false)], 0.95);
        assert_eq!(kinds(&evs), ["started", "segment", "segment", "segment", "end"]);
        assert!((evs[4].0 - 14.0).abs() < 0.1, "{}", evs[4].0);
    }

    #[test]
    fn held_turns_have_no_ceiling_until_released() {
        let mut m = Machine::new(Patience::Quick.policy());
        feed(&mut m, &[(1.0, true)], 0.9);
        m.hold(true);
        let evs = feed(&mut m, &[(20.0, false)], 0.9);
        assert_eq!(kinds(&evs), ["segment"]);
        m.hold(false);
        let evs = feed(&mut m, &[(0.5, true), (1.0, false)], 0.9);
        assert_eq!(kinds(&evs), ["segment", "end"]);
    }

    #[test]
    fn deaf_frames_are_silence() {
        let mut m = Machine::new(Patience::Quick.policy());
        for _ in 0..100 {
            assert!(m.frame(0.95, true, &mut |_, _| 1.0).is_empty());
        }
        assert!(!m.in_turn());
    }

    #[test]
    fn a_long_monologue_is_cut_into_stretches() {
        let mut m = Machine::new(Patience::Thinking.policy());
        let evs = feed(&mut m, &[(35.0, true), (0.3, false), (5.0, true)], 0.1);
        let segs: Vec<_> = evs.iter().filter(|(_, e)| matches!(e, Event::Segment { .. })).collect();
        // Cut at 30 s wherever it was. The 5 s after it aren't long, so a 0.3 s
        // pause doesn't close them.
        assert_eq!(segs.len(), 1);
        assert!((segs[0].0 - 30.0).abs() < 0.1);
    }

    /// The whole pipeline (VAD, the machine, the turn detector, transcription of
    /// each stretch) over X0's thinking-aloud monologues, per policy: the false ends
    /// (a turn ending before the last word), those taken back in the grace window,
    /// and the text (`cargo test --release conversation_on_monologues -- --ignored
    /// --nocapture`). `WB_MODELS` as for `voice_bench`; `VOICE_EVAL_DATA` the
    /// recordings (default `~/repos/Duck/voice-eval`).
    #[test]
    #[ignore]
    fn conversation_on_monologues() {
        let models = std::path::PathBuf::from(std::env::var("WB_MODELS").expect("WB_MODELS"));
        let data = std::env::var("VOICE_EVAL_DATA").map(std::path::PathBuf::from).unwrap_or_else(|_| {
            std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap()).join("repos/Duck/voice-eval")
        });
        let engine = Engine::new(models.clone());
        engine.preload(GpuPref::Never).unwrap();
        let mut vad = Vad::load(&models.join(vad::MODEL), &engine::tiny_session).unwrap();
        let mut detector = SmartTurn::load(&models.join(turn::MODEL), &engine::tiny_session).unwrap();
        let mut files: Vec<_> = std::fs::read_dir(data.join("recordings/monologues"))
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "wav"))
            .collect();
        files.sort();
        for patience in [Patience::Quick, Patience::Patient, Patience::Thinking] {
            let (mut false_ends, mut taken_back, mut st_ms, mut st_calls) = (0, 0, 0u128, 0);
            for f in &files {
                let audio = super::super::read_wav(f).unwrap();
                vad.reset();
                let mut m = Machine::new(patience.policy());
                let mut events = Vec::new();
                for frame in audio.chunks_exact(FRAME) {
                    let p = vad.step(frame).unwrap();
                    let at = secs(m.frame + 1);
                    for e in m.frame(p, false, &mut |from, to| {
                        let t = Instant::now();
                        let p = detector.complete(&audio[from..to.min(audio.len())]).unwrap();
                        st_ms += t.elapsed().as_millis();
                        st_calls += 1;
                        p
                    }) {
                        events.push((at, e));
                    }
                }
                // The last word: the last stretch's end, less its padding.
                let last = events
                    .iter()
                    .filter_map(|(_, e)| if let Event::Segment { to, .. } = e { Some(*to) } else { None })
                    .max()
                    .map_or(0.0, |to| (to.saturating_sub(PAD)) as f32 / RATE as f32);
                let ends: Vec<f32> = events.iter().filter(|(_, e)| *e == Event::EndOfTurn).map(|(t, _)| *t).collect();
                let resumed = events.iter().filter(|(_, e)| *e == Event::Resumed).count();
                let early = ends.iter().filter(|&&t| t < last).count();
                false_ends += early;
                taken_back += resumed;
                if patience == Patience::Thinking {
                    let mut text = Vec::new();
                    for (_, e) in &events {
                        if let Event::Segment { from, to } = e {
                            text.push(engine.transcribe(&audio[*from..(*to).min(audio.len())], GpuPref::Never).unwrap().text);
                        }
                    }
                    println!("{}: {early} early ends, {resumed} taken back | {}", f.display(), text.join(" "));
                }
            }
            println!(
                "{patience:?}: {false_ends} false ends, {taken_back} taken back in the grace window; turn detector {} calls, {} ms each",
                st_calls,
                st_ms / st_calls.max(1) as u128
            );
        }
    }

    #[test]
    fn controls_are_the_last_phrase_only() {
        assert_eq!(classify("That's it."), Control::End(String::new()));
        assert_eq!(classify("Restart the backend. That's it!"), Control::End("Restart the backend.".into()));
        assert_eq!(classify("The game is over."), Control::None);
        assert_eq!(classify("Over."), Control::End(String::new()));
        assert_eq!(classify("Всё."), Control::End(String::new()));
        assert_eq!(classify("Hmm, wait."), Control::Hold("Hmm".into()));
        assert_eq!(classify("Подожди..."), Control::Hold(String::new()));
        assert_eq!(classify("Go on."), Control::Release(String::new()));
        assert_eq!(classify("Stop."), Control::Stop(String::new()));
        assert_eq!(classify("Хватит!"), Control::Stop(String::new()));
        assert_eq!(classify("Thanks, that's all for now."), Control::Bye("Thanks".into()));
        assert_eq!(classify("На этом всё."), Control::Bye(String::new()));
        assert_eq!(classify("Don't stop the build"), Control::None);
        assert_eq!(classify("Wait for the tests to pass"), Control::None);
    }

    /// A surface that keeps what it's told (the phone's path, without a socket).
    #[derive(Default)]
    struct Kept {
        turns: std::sync::Mutex<Vec<(String, &'static str)>>,
        states: std::sync::Mutex<Vec<&'static str>>,
    }

    impl Surface for Arc<Kept> {
        fn state(&self, ev: &StateEvent) {
            self.states.lock().unwrap().push(ev.state);
        }
        fn turn(&self, ev: &TurnEvent) {
            self.turns.lock().unwrap().push((ev.text.clone(), ev.phase));
        }
        fn level(&self, _: f32) {}
        fn sign(&self, _: bool) {}
        fn warm(&self) {}
        fn speaking(&self) -> bool {
            false
        }
        fn cut(&self) {}
        fn cue(&self) {}
        fn said_lately(&self, _: Duration) -> String {
            String::new()
        }
        fn output(&self) -> Option<(Output, Option<String>)> {
            None
        }
        fn hold_output(&self, _: bool) {}
        fn finish(&self) {}
    }

    /// The phone's path: a recording streamed in 32 ms blocks as its page sends
    /// them, then quiet as one gap, through a run on a [`Source::Stream`]. It
    /// comes out as a provisional turn, then final, and the run ends when the
    /// stream does (`cargo test --release a_streamed_turn -- --ignored
    /// --nocapture`; `WB_MODELS`, `WB_TURN_WAV` a short spoken question).
    #[test]
    #[ignore]
    fn a_streamed_turn_comes_out_whole() {
        let models = std::path::PathBuf::from(std::env::var("WB_MODELS").expect("WB_MODELS"));
        let audio = super::super::read_wav(std::path::Path::new(&std::env::var("WB_TURN_WAV").unwrap())).unwrap();
        let engine = Arc::new(Engine::new(models));
        let kept = Arc::new(Kept::default());
        let (tx, rx) = mpsc::channel();
        let settings = Settings {
            gpu: GpuPref::Never,
            device: None,
            patience: Patience::Quick,
            echo: EchoPref::Auto,
            auto_off: Duration::from_secs(300),
            cue: false,
        };
        let (done_tx, done_rx) = mpsc::channel();
        let _cmds = start_on(Box::new(Arc::clone(&kept)), engine, settings, Kind::Mode, 1, Source::Stream(rx), move || {
            let _ = done_tx.send(());
            true
        });
        for block in audio.chunks(FRAME) {
            tx.send(block.to_vec()).unwrap();
        }
        // The quiet after it, as the page sends it: one gap.
        tx.send(vec![0.0; 4 * RATE]).unwrap();
        std::thread::sleep(Duration::from_secs(3));
        drop(tx);
        done_rx.recv_timeout(Duration::from_secs(30)).unwrap();
        let turns = kept.turns.lock().unwrap().clone();
        println!("{turns:?}\n{:?}", kept.states.lock().unwrap());
        assert_eq!(turns.iter().map(|t| t.1).collect::<Vec<_>>(), ["provisional", "final"]);
        assert!(!turns[1].0.trim().is_empty());
        assert_eq!(kept.states.lock().unwrap().last(), Some(&"error"), "the stream ended");
    }

    /// X0's speaker recording through this chain: the canceller (the reference
    /// handed over as the output callback would), the barge-in gate, the VAD and
    /// the barge-in rule. Phase 1 is Duck talking with you silent (any barge-in is
    /// false), phase 2 has your interruptions at `cues` (`cargo test --release
    /// barge_in_on_x0_speakers -- --ignored --nocapture`). `WB_MODELS`;
    /// `WB_ECHO_MIC` / `WB_ECHO_REF`, the mic and the playback at 16 kHz with the
    /// playback ahead; `WB_ECHO_META` the recording's `meta.json`.
    #[test]
    #[ignore]
    fn barge_in_on_x0_speakers() {
        let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k}"));
        let models = std::path::PathBuf::from(env("WB_MODELS"));
        engine::init_runtime(&models).unwrap();
        let mut vad = Vad::load(&models.join(vad::MODEL), &engine::tiny_session).unwrap();
        let mic = super::super::read_wav(std::path::Path::new(&env("WB_ECHO_MIC"))).unwrap();
        let played = super::super::read_wav(std::path::Path::new(&env("WB_ECHO_REF"))).unwrap();
        let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(env("WB_ECHO_META")).unwrap()).unwrap();
        let at48 = |v: &serde_json::Value| v.as_f64().unwrap() as f32 / 48_000.0;
        let half = at48(&meta["half"]);
        let cues: Vec<f32> = meta["cues"].as_array().unwrap().iter().map(at48).collect();

        let (mut c, mut gate) = (Canceller::new(), Gate::default());
        let (mut clean, mut raw) = (Vec::new(), Vec::new());
        let (mut on, mut run, mut frames) = (false, 0usize, 0usize);
        let (mut last_play, mut last_barge) = (f32::MIN, f32::MIN);
        let mut barges = Vec::new();
        let energy = |x: &[f32]| x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32;
        let n = mic.len().min(played.len()) / 160;
        for k in 0..n {
            let r = &played[k * 160..(k + 1) * 160];
            if energy(r) > 1e-5 {
                last_play = k as f32 / 100.0;
            }
            aec::tap(RATE as u32, r);
            let b = &mic[k * 160..(k + 1) * 160];
            clean.extend(c.process(b));
            raw.extend_from_slice(b);
            while clean.len() >= FRAME {
                frames += 1;
                let t = secs(frames);
                let mut p = vad.step(&clean[..FRAME]).unwrap();
                if !gate.frame(energy(&raw[..FRAME]), energy(&clean[..FRAME]), c.played(), p) {
                    p = 0.0;
                }
                on = if on { p >= vad::OFF } else { p >= vad::ON };
                run = if on { run + 1 } else { 0 };
                // Duck "speaking": its voice playing, the gaps between words included.
                if t - last_play < 0.3 && run >= BARGE_FRAMES && t - last_barge > 1.5 {
                    barges.push(t);
                    last_barge = t;
                }
                clean.drain(..FRAME);
                raw.drain(..FRAME);
            }
        }
        let false1: Vec<f32> = barges.iter().copied().filter(|&t| t < half).collect();
        let caught = cues.iter().filter(|&&q| barges.iter().any(|&t| t >= q && t <= q + 5.0)).count();
        let false2 = barges.iter().filter(|&&t| t >= half && !cues.iter().any(|&q| t >= q && t <= q + 8.0)).count();
        println!(
            "echo removed {:?} dB, delay {:?} ms; false barge-ins {} in {:.1} min {false1:?}, {false2} in phase 2; caught {caught}/{}",
            gate.suppression_db(),
            c.delay_ms(),
            false1.len(),
            half / 60.0,
            cues.len()
        );
        assert!(false1.is_empty());
        assert!(caught >= 8);
    }
}
