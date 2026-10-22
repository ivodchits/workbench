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
//! - **A phone's echo** (step V7): the phone plays the desktop voice's audio, and
//!   says where in its microphone's stream each sentence started (`conv.said`).
//!   That audio, placed there, is the reference ([`Feed`]), in the stream's own
//!   clock. The echo comes some time after (the phone's buffers, its framer, the
//!   room), so the feed measures how long ([`Feed::heard`]: the playback's and the
//!   microphone's loudness, correlated) and plays the reference just ahead of it.
//!   On X0's speaker recording, placed so: the same as the desktop's own chain (no
//!   false barge-ins, 8 of 10 caught).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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

/// The output handed nothing over for this long: it's closed, and the reference
/// is silence.
const CLOSED: Duration = Duration::from_millis(100);
/// The playback's energy kept, by 10 ms chunk: 1 s.
const PLAYED_KEEP: usize = 100;
/// The delay assumed until AEC3 has estimated one (X0: ~165 ms).
const DELAY_MS: i32 = 160;

// ── a phone's reference ─────────────────────────────────────────────────────

/// Loudness kept per 10 ms chunk, for the lag: 6 s.
const ENV_KEEP: usize = 600;
/// The longest lag looked for: 0.8 s.
const LAG_MAX: usize = 80;
/// The reference plays this far ahead of its echo (6 chunks, 60 ms): inside AEC3's
/// window, whatever the lag.
const LEAD: usize = 6;
/// The lag is measured every 2 s of playback...
const LAG_EVERY: usize = 200;
/// ...when the echo clearly follows the playback (normalised correlation).
const LAG_SURE: f32 = 0.5;

/// Duck's sentences on a phone, placed where in its stream each started, as the
/// canceller's reference.
#[derive(Default)]
pub struct Feed(Mutex<FeedInner>);

#[derive(Default)]
struct FeedInner {
    /// Sentences by their first sample in the stream, in order.
    parts: VecDeque<(usize, Vec<f32>)>,
    /// The latest sentence said had no audio here (the phone's own voice).
    unheard: bool,
    /// The reference is played this many samples after it was placed.
    delay: usize,
    /// The reference's and the microphone's loudness per chunk (log), newest last.
    played: VecDeque<f32>,
    mic: VecDeque<f32>,
    since: usize,
}

impl Feed {
    /// A sentence the phone started at sample `at` of its stream: its audio at
    /// 16 kHz, or None for one said in the phone's own voice.
    pub fn place(&self, at: usize, samples: Option<Vec<f32>>) {
        let Ok(mut f) = self.0.lock() else { return };
        f.unheard = samples.is_none();
        if let Some(s) = samples {
            f.parts.push_back((at, s));
        }
    }

    /// Duck's voice stopped at sample `at` (cut, or hushed): the rest isn't played.
    pub fn stop(&self, at: usize) {
        let Ok(mut f) = self.0.lock() else { return };
        f.parts.retain_mut(|(start, s)| {
            s.truncate(at.saturating_sub(*start));
            !s.is_empty()
        });
    }

    /// The latest sentence has no reference: its echo can't be cancelled.
    pub fn unheard(&self) -> bool {
        self.0.lock().map(|f| f.unheard).unwrap_or(false)
    }

    /// The reference for stream samples `[from, from + n)`, and what's done with is
    /// let go.
    fn take(&self, from: usize, n: usize) -> Vec<f32> {
        let mut out = vec![0f32; n];
        let Ok(mut f) = self.0.lock() else { return out };
        let from = from.saturating_sub(f.delay);
        for (start, s) in &f.parts {
            for (i, o) in out.iter_mut().enumerate() {
                if let Some(x) = (from + i).checked_sub(*start).and_then(|j| s.get(j)) {
                    *o += x;
                }
            }
        }
        // Sentences that ended a second before what's taken now.
        while f.parts.front().is_some_and(|(start, s)| start + s.len() + RATE as usize <= from) {
            f.parts.pop_front();
        }
        out
    }

    /// The placed reference's and the microphone's energy for a chunk, both as
    /// placed (no delay): every 2 s of playback, the lag is measured again.
    fn heard(&self, placed: f32, mic: f32) {
        let Ok(mut f) = self.0.lock() else { return };
        let log = |e: f32| 10.0 * e.max(1e-10).log10();
        f.played.push_back(log(placed));
        f.mic.push_back(log(mic));
        if f.played.len() > ENV_KEEP {
            f.played.pop_front();
            f.mic.pop_front();
        }
        if placed > 1e-7 {
            f.since += 1;
        }
        if f.since >= LAG_EVERY && f.played.len() >= ENV_KEEP / 2 {
            f.since = 0;
            if let Some(lag) = lag(&f.played, &f.mic) {
                let delay = lag.saturating_sub(LEAD) * CHUNK;
                // Small changes aren't worth AEC3 re-adapting.
                if delay.abs_diff(f.delay) > 3 * CHUNK {
                    f.delay = delay;
                }
            }
        }
    }

    /// The reference's delay now, ms.
    pub fn delay_ms(&self) -> u32 {
        self.0.lock().map(|f| (f.delay * 1000 / RATE as usize) as u32).unwrap_or(0)
    }
}

/// How many chunks the microphone's loudness follows the playback's by, if it
/// clearly does.
fn lag(played: &VecDeque<f32>, mic: &VecDeque<f32>) -> Option<usize> {
    let n = played.len().min(mic.len());
    let (p, m): (Vec<f32>, Vec<f32>) = (played.iter().copied().take(n).collect(), mic.iter().copied().take(n).collect());
    let norm = |x: &[f32]| {
        let mean = x.iter().sum::<f32>() / x.len().max(1) as f32;
        x.iter().map(|v| v - mean).collect::<Vec<_>>()
    };
    let mut best = (0usize, 0f32);
    for k in 0..=LAG_MAX.min(n / 2) {
        let (a, b) = (norm(&p[..n - k]), norm(&m[k..]));
        let dot: f32 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
        let (ea, eb): (f32, f32) = (a.iter().map(|x| x * x).sum(), b.iter().map(|x| x * x).sum());
        let r = dot / (ea * eb).sqrt().max(1e-9);
        if r > best.1 {
            best = (k, r);
        }
    }
    (best.1 >= LAG_SURE).then_some(best.0)
}

// ── the canceller ───────────────────────────────────────────────────────────

/// Where the reference comes from: the speakers' output callback, or a phone's
/// sentences.
enum Reference {
    Tap,
    /// The feed, and the stream's sample the next chunk of microphone is.
    Feed(Arc<Feed>, usize),
}

pub struct Canceller {
    apm: AudioProcessing,
    reference: Reference,
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
        if let Ok(mut t) = TAP.lock() {
            t.samples.clear();
        }
        TAPPING.store(true, Ordering::Relaxed);
        Self::with(Reference::Tap)
    }

    /// A canceller for a phone's stream, `at` samples into it, its reference
    /// `feed`.
    pub fn for_feed(feed: Arc<Feed>, at: usize) -> Self {
        Self::with(Reference::Feed(feed, at))
    }

    fn with(reference: Reference) -> Self {
        let config = Config {
            echo_canceller: Some(EchoCanceller::default()),
            high_pass_filter: Some(HighPassFilter::default()),
            ..Default::default()
        };
        let stream = StreamConfig::new(RATE, 1);
        let apm = AudioProcessing::builder().config(config).capture_config(stream).render_config(stream).build();
        Self {
            apm,
            reference,
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
            let input = &self.mic[at..at + CHUNK];
            let closed = match &mut self.reference {
                Reference::Tap => self.pull(),
                Reference::Feed(feed, pos) => {
                    let e = |x: &[f32]| x.iter().map(|v| v * v).sum::<f32>() / CHUNK as f32;
                    let delay = feed.0.lock().map(|f| f.delay).unwrap_or(0);
                    // As placed, for the lag; then as played, for AEC3.
                    let placed = if delay == 0 { None } else { Some(feed.take(*pos + delay, CHUNK)) };
                    let chunk = feed.take(*pos, CHUNK);
                    feed.heard(e(placed.as_deref().unwrap_or(&chunk)), e(input));
                    *pos += CHUNK;
                    self.render.extend(chunk);
                    false
                }
            };
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
        if !matches!(self.reference, Reference::Tap) {
            return;
        }
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

    /// A phone: the sentence placed where the phone said it started; the
    /// microphone hears it 350 ms later (its buffers and the room), quieter and
    /// smeared. The feed finds the lag and the canceller removes the echo.
    #[test]
    fn cancels_a_phone_s_echo_from_where_it_said_it_started() {
        let at = 16_000;
        let said = voice(16_000 * 10, RATE, 11);
        let lag = 16 * 350;
        let mut mic = vec![0f32; at + said.len() + lag + 2];
        for (i, x) in said.iter().enumerate() {
            mic[at + lag + i] += 0.3 * x;
            mic[at + lag + i + 2] += 0.1 * x;
        }
        let feed = Arc::new(Feed::default());
        let mut c = Canceller::for_feed(Arc::clone(&feed), 0);
        let mut out = Vec::new();
        for (k, block) in mic.chunks(512).enumerate() {
            if k * 512 <= at && at < (k + 1) * 512 {
                feed.place(at, Some(said.clone()));
            }
            out.extend(c.process(block));
        }
        let d = feed.delay_ms();
        assert!((250..=300).contains(&d), "the reference plays ~60 ms ahead of the echo: delayed {d} ms");
        let (a, b) = (at + lag + 16_000 * 5, out.len());
        let erle = 10.0 * (energy(&mic[a..b]) / energy(&out[a..b]).max(1e-12)).log10();
        assert!(erle > 20.0, "{erle:.1} dB removed");
    }

    #[test]
    fn a_feed_mixes_its_sentences_lets_cut_ones_go_and_knows_an_unheard_one() {
        let f = Feed::default();
        f.place(100, Some(vec![1.0; 50]));
        f.place(120, Some(vec![0.5; 10]));
        let r = f.take(95, 40);
        assert_eq!(r[..5], [0.0; 5]);
        assert_eq!(r[5], 1.0);
        assert_eq!(r[25], 1.5);
        assert_eq!(r[35], 1.0);
        f.stop(110);
        assert_eq!(f.take(105, 10), [1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert!(!f.unheard());
        f.place(300, None);
        assert!(f.unheard(), "said in the phone's own voice");
        f.take(100_000, 1);
        assert!(f.0.lock().unwrap().parts.is_empty(), "done with");
    }

    #[test]
    fn the_lag_is_where_the_mic_follows_the_playback() {
        let mut x = 7u32;
        let mut rnd = move || {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (x >> 8) as f32 / (1u32 << 24) as f32
        };
        let p: VecDeque<f32> = (0..400).map(|_| -60.0 + 40.0 * rnd()).collect();
        let m: VecDeque<f32> = (0..400).map(|i| if i >= 23 { p[i - 23] - 12.0 + 2.0 * rnd() } else { -70.0 }).collect();
        assert_eq!(lag(&p, &m), Some(23));
        let noise: VecDeque<f32> = (0..400).map(|_| -60.0 + 40.0 * rnd()).collect();
        assert_eq!(lag(&p, &noise), None, "an echo that isn't there");
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
