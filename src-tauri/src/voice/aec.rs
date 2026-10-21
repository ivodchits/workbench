//! Echo cancellation (step V4, part 2): on speakers the microphone hears Duck's own
//! voice, so in conversation mode it goes through WebRTC's AEC3 ([`sonora`], a Rust
//! port) given what the speakers are playing, and you can talk over Duck there too.
//!
//! - **The reference** is taken in the output callback ([`tap`]): the samples the
//!   device is about to play, silence included. It's exact, and always ahead of its
//!   echo. AEC3 finds the delay itself: on X0's speaker recording it coped with the
//!   echo arriving up to ~300 ms after the reference (and broke at 500), and from the
//!   callback the delay is the device buffers plus the room, ~165 ms in X0.
//! - **The canceller** ([`Canceller`]) runs at 16 kHz on 10 ms chunks: before each
//!   chunk of microphone it's given the reference that came in meanwhile. X0's
//!   recording: 29.3 dB of echo removed (livekit's native build: 29.6), no false
//!   barge-ins, 0.34% of one core.
//! - **The barge-in gate** ([`Gate`]): while Duck speaks, your speech must also be
//!   clearly louder (6 dB) than the echo left over, as expected from how loud the
//!   playback is. The ratio is learned as it goes. The gate also measures how much
//!   echo is removed, for the settings.
//! - **The self-voice check** ([`self_voice`]): words heard while Duck spoke that
//!   are mostly its own words are its echo, not you.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sonora::config::{Config, EchoCanceller, HighPassFilter};
use sonora::{AudioProcessing, StreamConfig};

use super::capture::{StreamResampler, RATE};
use super::vad;

/// 10 ms at 16 kHz: AEC3's chunk.
const CHUNK: usize = RATE as usize / 100;

// ── the reference ───────────────────────────────────────────────────────────

struct Tap {
    rate: u32,
    samples: VecDeque<f32>,
    /// When the output last handed some over.
    last: Option<Instant>,
}

static TAPPING: AtomicBool = AtomicBool::new(false);
static TAP: Mutex<Tap> = Mutex::new(Tap { rate: 0, samples: VecDeque::new(), last: None });

/// Whether a canceller wants the reference (the output callback asks first).
pub fn tapping() -> bool {
    TAPPING.load(Ordering::Relaxed)
}

/// The output callback hands over what it's about to play: mono, at `rate`.
pub fn tap(rate: u32, samples: &[f32]) {
    if !tapping() {
        return;
    }
    if let Ok(mut t) = TAP.lock() {
        if t.rate != rate {
            t.samples.clear();
            t.rate = rate;
        }
        t.samples.extend(samples);
        // Nobody reading for 2 s: keep only the newest.
        let max = rate as usize * 2;
        if t.samples.len() > max {
            let n = t.samples.len() - max;
            t.samples.drain(..n);
        }
        t.last = Some(Instant::now());
    }
}

// ── the canceller ───────────────────────────────────────────────────────────

/// The output handed nothing over for this long: it's closed, and the reference
/// is silence.
const CLOSED: Duration = Duration::from_millis(100);
/// The playback's energy kept, by 10 ms chunk: 1 s.
const PLAYED_KEEP: usize = 100;
/// The delay assumed until AEC3 has estimated one (X0: ~165 ms).
const DELAY_MS: i32 = 160;

pub struct Canceller {
    apm: AudioProcessing,
    resampler: Option<(u32, StreamResampler)>,
    /// The reference at 16 kHz, not yet given to AEC3.
    render: VecDeque<f32>,
    /// Microphone short of a whole chunk.
    mic: Vec<f32>,
    /// The playback's energy given with each chunk of microphone, newest last.
    played: VecDeque<f32>,
    scratch: Vec<f32>,
}

impl Canceller {
    /// Starts taking the reference; dropping it stops.
    pub fn new() -> Self {
        let config = Config {
            echo_canceller: Some(EchoCanceller::default()),
            high_pass_filter: Some(HighPassFilter::default()),
            ..Default::default()
        };
        let stream = StreamConfig::new(RATE, 1);
        let apm = AudioProcessing::builder().config(config).capture_config(stream).render_config(stream).build();
        if let Ok(mut t) = TAP.lock() {
            t.samples.clear();
        }
        TAPPING.store(true, Ordering::Relaxed);
        Self {
            apm,
            resampler: None,
            render: VecDeque::new(),
            mic: Vec::new(),
            played: VecDeque::with_capacity(PLAYED_KEEP + 1),
            scratch: vec![0.0; CHUNK],
        }
    }

    /// The reference that came in since the last chunk; whether the output is closed.
    fn pull(&mut self) -> bool {
        let (rate, samples, closed) = match TAP.lock() {
            Ok(mut t) => (t.rate, t.samples.drain(..).collect::<Vec<_>>(), t.last.is_none_or(|l| l.elapsed() > CLOSED)),
            Err(_) => return true,
        };
        if !samples.is_empty() {
            if self.resampler.as_ref().is_none_or(|(r, _)| *r != rate) {
                self.resampler = Some((rate, StreamResampler::new(rate, RATE)));
            }
            if let Some((_, r)) = &mut self.resampler {
                self.render.extend(r.push(&samples));
            }
        }
        closed
    }

    /// Clean a block of 16 kHz microphone audio. What comes back is as long as the
    /// whole chunks in it (the rest waits for the next block).
    pub fn process(&mut self, block: &[f32]) -> Vec<f32> {
        self.mic.extend_from_slice(block);
        let mut out = Vec::with_capacity(self.mic.len());
        let mut at = 0;
        while self.mic.len() - at >= CHUNK {
            let closed = self.pull();
            let (mut energy, mut fed) = (0f32, 0usize);
            while self.render.len() >= CHUNK {
                let chunk: Vec<f32> = self.render.drain(..CHUNK).collect();
                energy += chunk.iter().map(|x| x * x).sum::<f32>() / CHUNK as f32;
                fed += 1;
                let _ = self.apm.process_render_f32(&[&chunk], &mut [&mut self.scratch[..]]);
            }
            if fed == 0 && closed {
                let silence = [0f32; CHUNK];
                let _ = self.apm.process_render_f32(&[&silence], &mut [&mut self.scratch[..]]);
            }
            self.played.push_back(if fed > 0 { energy / fed as f32 } else { 0.0 });
            if self.played.len() > PLAYED_KEEP {
                self.played.pop_front();
            }
            let input = &self.mic[at..at + CHUNK];
            let mut cleaned = [0f32; CHUNK];
            if self.apm.process_capture_f32(&[input], &mut [&mut cleaned[..]]).is_err() {
                cleaned.copy_from_slice(input);
            }
            out.extend_from_slice(&cleaned);
            at += CHUNK;
        }
        self.mic.drain(..at);
        out
    }

    /// The playback → microphone delay AEC3 estimates, ms.
    pub fn delay_ms(&self) -> Option<i32> {
        self.apm.statistics().delay_ms
    }

    /// How loud the playback reaching the microphone now is: its mean energy around
    /// the estimated delay ago (±110 ms, so the gaps between words count as talking).
    pub fn played(&self) -> f32 {
        let delay = self.delay_ms().unwrap_or(DELAY_MS).max(0) as usize / 10;
        let n = self.played.len();
        let center = n.saturating_sub(1 + delay);
        let (a, b) = (center.saturating_sub(11), (center + 12).min(n));
        if a >= b {
            return 0.0;
        }
        self.played.range(a..b).sum::<f32>() / (b - a) as f32
    }
}

impl Drop for Canceller {
    fn drop(&mut self) {
        TAPPING.store(false, Ordering::Relaxed);
        if let Ok(mut t) = TAP.lock() {
            t.samples.clear();
            t.last = None;
        }
    }
}

// ── the barge-in gate ───────────────────────────────────────────────────────

/// Frames learned from: the last ~20 s of each kind.
const LEARN: usize = 600;
/// Frames needed before the ratio is used (until then, the VAD alone decides, as
/// it did on X0's recordings).
const LEARNED: usize = 30;
/// Playback energy (per frame, as it reaches the mic) that counts as Duck talking.
const TALKING: f32 = 1e-6;
/// Speech over Duck must be this much louder than the expected echo (6 dB).
const MARGIN: f32 = 4.0;

#[derive(Default)]
pub struct Gate {
    /// Echo left after cancelling, over the playback level, on frames of Duck alone.
    ratios: VecDeque<f32>,
    /// The playback levels seen, so only its louder half teaches the ratio.
    levels: VecDeque<f32>,
    /// The cleaned microphone in quiet with nothing playing.
    floors: VecDeque<f32>,
    echo_in: f64,
    echo_out: f64,
    echo_frames: usize,
}

fn keep(q: &mut VecDeque<f32>, x: f32) {
    q.push_back(x);
    if q.len() > LEARN {
        q.pop_front();
    }
}

fn percentile(q: &VecDeque<f32>, p: f32) -> f32 {
    let mut v: Vec<f32> = q.iter().copied().collect();
    v.sort_by(f32::total_cmp);
    v[((v.len() as f32 * p) as usize).min(v.len() - 1)]
}

impl Gate {
    /// One 32 ms frame: the microphone's energy before and after cancelling, the
    /// playback's ([`Canceller::played`]) and the VAD's probability. Whether speech
    /// in it can be you over Duck.
    pub fn frame(&mut self, raw: f32, clean: f32, played: f32, p: f32) -> bool {
        let talking = played > TALKING;
        if p < vad::OFF {
            if talking {
                self.echo_in += raw as f64;
                self.echo_out += clean as f64;
                self.echo_frames += 1;
                keep(&mut self.levels, played);
                if played >= percentile(&self.levels, 0.5) {
                    keep(&mut self.ratios, clean / played);
                }
            } else {
                keep(&mut self.floors, clean);
            }
        }
        if !talking || self.ratios.len() < LEARNED {
            return true;
        }
        let floor = if self.floors.len() >= LEARNED { percentile(&self.floors, 0.9) } else { 0.0 };
        clean > MARGIN * (percentile(&self.ratios, 0.9) * played).max(floor)
    }

    /// The echo removed while Duck talked, dB (after a second of it).
    pub fn suppression_db(&self) -> Option<f32> {
        (self.echo_frames >= LEARNED).then(|| (10.0 * (self.echo_in / self.echo_out.max(1e-12)).log10()) as f32)
    }
}

// ── the self-voice check ────────────────────────────────────────────────────

fn words(s: &str) -> Vec<String> {
    s.to_lowercase().replace('ё', "е").split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

/// What was heard is mostly what Duck was saying (X0's check: half its words or
/// more), so it's Duck's echo.
pub fn self_voice(heard: &str, said: &str) -> bool {
    let heard = words(heard);
    if heard.is_empty() {
        return false;
    }
    let said: std::collections::HashSet<String> = words(said).into_iter().collect();
    let common = heard.iter().filter(|w| said.contains(*w)).count();
    common * 2 >= heard.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Speech-like noise: "syllables" of coloured noise of random lengths and
    /// loudness, with short gaps. Nothing periodic, which would fool the delay
    /// estimator.
    fn voice(n: usize, rate: u32, seed: u32) -> Vec<f32> {
        let mut x = seed;
        let mut noise = move || {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (x >> 8) as f32 / (1u32 << 24) as f32
        };
        let mut out = Vec::with_capacity(n);
        let mut lp = 0f32;
        while out.len() < n {
            let len = ((0.08 + 0.22 * noise()) * rate as f32) as usize;
            let (amp, gap) = (0.1 + 0.3 * noise(), noise() < 0.25);
            for i in 0..len {
                let env = (std::f32::consts::PI * i as f32 / len as f32).sin();
                lp = 0.85 * lp + 0.15 * (noise() - 0.5);
                out.push(if gap { 0.0 } else { amp * env * 4.0 * lp });
            }
        }
        out.truncate(n);
        out
    }

    fn energy(x: &[f32]) -> f32 {
        x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32
    }

    /// The reference goes through the tap at 48 kHz, as the output callback hands
    /// it over; the microphone hears it 120 ms later, quieter and smeared.
    #[test]
    fn cancels_a_delayed_echo() {
        let secs = 8;
        let played = voice(48_000 * secs, 48_000, 7);
        let at16 = StreamResampler::new(48_000, RATE).push(&played);
        let lag = 16 * 120;
        let mut mic = vec![0f32; at16.len()];
        for i in lag + 2..mic.len() {
            mic[i] = 0.3 * at16[i - lag] + 0.15 * at16[i - lag - 2];
        }
        let mut c = Canceller::new();
        let mut out = Vec::new();
        for (k, block) in mic.chunks(CHUNK * 2).enumerate() {
            tap(48_000, &played[k * 960..((k + 1) * 960).min(played.len())]);
            out.extend(c.process(block));
        }
        drop(c);
        assert!(!tapping());
        // After 3 s to converge.
        let (a, b) = (16_000 * 3, out.len());
        let erle = 10.0 * (energy(&mic[a..b]) / energy(&out[a..b]).max(1e-12)).log10();
        assert!(erle > 30.0, "{erle:.1} dB removed");
    }

    #[test]
    fn the_gate_learns_the_echo_and_lets_louder_speech_through() {
        let mut g = Gate::default();
        // Duck alone: echo at 1/1000 of the playback after cancelling.
        for i in 0..200 {
            let played = 1e-3 * (1.0 + (i % 7) as f32 / 7.0);
            g.frame(played * 0.03, played * 1e-3, played, 0.1);
        }
        assert!(g.suppression_db().unwrap() > 14.0);
        // Echo-level "speech" over Duck doesn't count; you, 20 dB louder, do.
        assert!(!g.frame(3e-5, 2e-6, 1.5e-3, 0.9));
        assert!(g.frame(1e-3, 1e-4, 1.5e-3, 0.9));
        // Nothing playing: the VAD decides.
        assert!(g.frame(1e-6, 1e-7, 0.0, 0.9));
    }

    #[test]
    fn self_voice_is_mostly_duck_s_own_words() {
        let said = "The backend session finished the migration and all tests pass.";
        assert!(self_voice("the migration and all tests", said));
        assert!(!self_voice("stop, what about the frontend?", said));
        assert!(self_voice("Всё прошло", "всё прошло хорошо"));
        assert!(!self_voice("", said));
    }

    /// Live, on this PC's speakers and microphone: plays the WAVs in `WB_ECHO_WAVS`
    /// (`;`-separated) through the player while the canceller listens, and prints
    /// the echo removed, the delay, and the frames the gate would have let through
    /// (`cargo test live_echo -- --ignored --nocapture`). Stay quiet while it runs.
    #[test]
    #[ignore]
    fn live_echo() {
        use super::super::{capture, parse_wav_at, playback::Player};
        let player = Player::new(|_| {});
        let mut c = Canceller::new();
        player.hold_open(true).unwrap();
        let mic = capture::listen(None).unwrap();
        for p in std::env::var("WB_ECHO_WAVS").expect("WB_ECHO_WAVS").split(';') {
            let (pcm, rate) = parse_wav_at(&std::fs::read(p).unwrap()).unwrap();
            player.push(&pcm, rate).unwrap();
        }
        let (mut raw, mut clean) = (Vec::new(), Vec::new());
        let mut gate = Gate::default();
        let (mut talking, mut through) = (0, 0);
        let mut quiet_since: Option<Instant> = None;
        while quiet_since.is_none_or(|t| t.elapsed() < Duration::from_secs(1)) {
            let b = mic.blocks.recv_timeout(Duration::from_millis(200)).unwrap();
            clean.extend(c.process(&b));
            raw.extend(b);
            while clean.len() >= vad::FRAME {
                let e = |x: &[f32]| x.iter().map(|v| v * v).sum::<f32>() / vad::FRAME as f32;
                let (er, ec) = (e(&raw[..vad::FRAME]), e(&clean[..vad::FRAME]));
                let played = c.played();
                if played > TALKING {
                    talking += 1;
                    if gate.frame(er, ec, played, 0.0) && gate.ratios.len() >= LEARNED {
                        through += 1;
                    }
                } else {
                    gate.frame(er, ec, played, 0.0);
                }
                raw.drain(..vad::FRAME);
                clean.drain(..vad::FRAME);
            }
            if player.is_playing() {
                quiet_since = None;
            } else {
                quiet_since.get_or_insert_with(Instant::now);
            }
        }
        player.hold_open(false).unwrap();
        println!(
            "echo removed {:?} dB, delay {:?} ms, {talking} frames of Duck talking, {through} the gate would let through",
            gate.suppression_db(),
            c.delay_ms()
        );
        assert!(gate.suppression_db().unwrap() > 15.0);
    }
}
