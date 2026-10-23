//! Microphone capture for push-to-talk (step V1): the input device's samples,
//! mixed to mono and resampled to 16 kHz when the recording stops.
//!
//! The stream lives on a thread of its own (cpal streams can't move between
//! threads on Windows), and only between `start` and `stop`, so Windows shows the
//! microphone as in use only while the key is held.
//!
//! Conversation mode (step V4) [`listen`]s instead: the same mix-down, resampled a
//! block at a time ([`StreamResampler`]) and handed over as it comes. The wake word
//! (step V6) listens all the time, so the kernel's weights are worked out once per
//! phase of the rate change (one phase for 48 kHz, 160 for 44.1 kHz), not per tap.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};

pub const RATE: u32 = 16_000;
/// A recording longer than this is cut (the key stuck, or forgotten).
pub const MAX: Duration = Duration::from_secs(120);

pub struct Recorder {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<Result<Vec<f32>, String>>,
}

/// The input devices' names, for the settings.
pub fn input_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|ds| ds.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

fn device(name: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(name) = name.filter(|n| !n.is_empty()) {
        let found = host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().is_ok_and(|n| n == name));
        if let Some(d) = found {
            return Ok(d);
        }
    }
    host.default_input_device().ok_or_else(|| "there is no microphone".to_string())
}

/// Start recording from `device_name` (the default input when None or not found).
/// Returns once the stream is running.
pub fn start(device_name: Option<String>) -> Result<Recorder, String> {
    let (stop, stopped) = mpsc::channel::<()>();
    let (ready_tx, ready) = mpsc::channel::<Result<(), String>>();
    let thread = std::thread::Builder::new()
        .name("voice-capture".into())
        .spawn(move || -> Result<Vec<f32>, String> {
            let opened = (|| {
                let dev = device(device_name.as_deref())?;
                let supported = dev.default_input_config().map_err(|e| e.to_string())?;
                let config: StreamConfig = supported.config();
                let channels = config.channels.max(1) as usize;
                let rate = config.sample_rate.0;
                let buf = Arc::new(Mutex::new(Vec::<f32>::with_capacity(rate as usize * 10)));
                let cap = rate as usize * MAX.as_secs() as usize;
                let sink = Arc::clone(&buf);
                let push = move |frames: &mut dyn Iterator<Item = f32>| {
                    if let Ok(mut b) = sink.lock() {
                        if b.len() < cap {
                            b.extend(frames);
                        }
                    }
                };
                let on_err = |e: cpal::StreamError| eprintln!("[voice] capture: {e}");
                let stream = match supported.sample_format() {
                    SampleFormat::F32 => dev.build_input_stream(
                        &config,
                        move |d: &[f32], _: &_| push(&mut d.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32)),
                        on_err,
                        None,
                    ),
                    SampleFormat::I16 => dev.build_input_stream(
                        &config,
                        move |d: &[i16], _: &_| {
                            push(&mut d.chunks(channels).map(|f| f.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / channels as f32))
                        },
                        on_err,
                        None,
                    ),
                    f => return Err(format!("the microphone's sample format {f:?} isn't supported")),
                }
                .map_err(|e| e.to_string())?;
                stream.play().map_err(|e| e.to_string())?;
                Ok((stream, buf, rate))
            })();
            let (stream, buf, rate) = match opened {
                Ok(x) => {
                    let _ = ready_tx.send(Ok(()));
                    x
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e.clone()));
                    return Err(e);
                }
            };
            // Until stopped, or the cap.
            let _ = stopped.recv_timeout(MAX);
            drop(stream);
            let samples = std::mem::take(&mut *buf.lock().map_err(|e| e.to_string())?);
            Ok(resample(&samples, rate, RATE))
        })
        .map_err(|e| e.to_string())?;
    match ready.recv() {
        Ok(Ok(())) => Ok(Recorder { stop, thread }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(thread.join().map_err(|_| "the capture thread panicked".to_string())?.err().unwrap_or_default()),
    }
}

impl Recorder {
    /// Stop and return the recording, 16 kHz mono.
    pub fn stop(self) -> Result<Vec<f32>, String> {
        let _ = self.stop.send(());
        self.thread.join().map_err(|_| "the capture thread panicked".to_string())?
    }
}

/// Half the windowed-sinc kernel, in input samples (at the output's cutoff).
const TAPS: i64 = 16;

/// The resampler's kernel for one rate change.
#[derive(Clone)]
struct Kernel {
    ratio: f64,
    cutoff: f64,
    half: i64,
    table: Option<Arc<Table>>,
}

/// The kernel's weights, normalized, for each phase: output `i` sits `(i q mod p)
/// / p` past input `⌊i q / p⌋`, where `q / p` is `from / to` in lowest terms.
struct Table {
    q: u64,
    p: u64,
    taps: usize,
    w: Vec<f32>,
}

/// More phases than this aren't tabled (an odd rate pair): each sample is worked
/// out as it comes.
const MAX_PHASES: u64 = 4096;

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

impl Kernel {
    fn new(from: u32, to: u32) -> Self {
        let cutoff = (to as f64 / from as f64).min(1.0);
        let half = (TAPS as f64 / cutoff).ceil() as i64;
        let g = gcd(from as u64, to as u64).max(1);
        let (q, p) = (from as u64 / g, to as u64 / g);
        let table = (p <= MAX_PHASES && from != to).then(|| {
            let taps = 2 * half as usize;
            let mut w = Vec::with_capacity(p as usize * taps);
            for phase in 0..p {
                let frac = phase as f64 / p as f64;
                let row: Vec<f64> = (0..taps).map(|j| Self::weight(frac + (half - 1 - j as i64) as f64, half, cutoff)).collect();
                let norm: f64 = row.iter().sum();
                w.extend(row.iter().map(|h| (h / norm) as f32));
            }
            Arc::new(Table { q, p, taps, w })
        });
        Self { ratio: from as f64 / to as f64, cutoff, half, table }
    }

    /// The windowed sinc `d` input samples from the output's position.
    fn weight(d: f64, half: i64, cutoff: f64) -> f64 {
        let arg = std::f64::consts::PI * d * cutoff;
        let sinc = if d.abs() < 1e-9 { 1.0 } else { arg.sin() / arg };
        let w = d / half as f64; // −1..1 across the kernel
        let win = 0.42 + 0.5 * (std::f64::consts::PI * w).cos() + 0.08 * (2.0 * std::f64::consts::PI * w).cos();
        sinc * win
    }

    /// Output sample `i`, from input `x` that starts at absolute index `offset`.
    fn sample(&self, i: usize, x: &[f32], offset: usize) -> f32 {
        if let Some(t) = &self.table {
            let iq = i as u64 * t.q;
            let first = (iq / t.p) as i64 - self.half + 1 - offset as i64;
            // The whole kernel within `x` (all but the stream's very start).
            if first >= 0 && first as usize + t.taps <= x.len() {
                let phase = (iq % t.p) as usize;
                let w = &t.w[phase * t.taps..(phase + 1) * t.taps];
                return w.iter().zip(&x[first as usize..]).map(|(a, b)| a * b).sum();
            }
        }
        let t = i as f64 * self.ratio;
        let center = t.floor() as i64;
        let (mut acc, mut norm) = (0f64, 0f64);
        for k in (center - self.half + 1)..=(center + self.half) {
            let j = k - offset as i64;
            if j < 0 || j as usize >= x.len() {
                continue;
            }
            let h = Self::weight(t - k as f64, self.half, self.cutoff);
            acc += x[j as usize] as f64 * h;
            norm += h;
        }
        if norm.abs() > 1e-9 {
            (acc / norm) as f32
        } else {
            0.0
        }
    }
}

/// Windowed-sinc resampling (Blackman window), low-passed at the lower Nyquist.
pub fn resample(x: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || x.is_empty() {
        return x.to_vec();
    }
    let k = Kernel::new(from, to);
    let n_out = (x.len() as f64 / k.ratio).floor() as usize;
    (0..n_out).map(|i| k.sample(i, x, 0)).collect()
}

/// [`resample`] a block at a time, for a stream (step V4). Each output sample is
/// made once the input its kernel reaches has arrived, so the stream comes out as
/// resampling it whole would give (bar the very end, still waiting for input).
pub struct StreamResampler {
    kernel: Kernel,
    passthrough: bool,
    /// Input from absolute index `offset` on.
    buf: Vec<f32>,
    offset: usize,
    next: usize,
}

impl StreamResampler {
    pub fn new(from: u32, to: u32) -> Self {
        Self { kernel: Kernel::new(from, to), passthrough: from == to, buf: Vec::new(), offset: 0, next: 0 }
    }

    /// Take a block of input; return the output it completes.
    pub fn push(&mut self, x: &[f32]) -> Vec<f32> {
        if self.passthrough {
            return x.to_vec();
        }
        self.buf.extend_from_slice(x);
        let k = &self.kernel;
        let have = (self.offset + self.buf.len()) as i64;
        let mut out = Vec::new();
        while (self.next as f64 * k.ratio).floor() as i64 + k.half < have {
            out.push(k.sample(self.next, &self.buf, self.offset));
            self.next += 1;
        }
        // Keep only what the next sample's kernel still reaches.
        let keep_from = ((self.next as f64 * k.ratio).floor() as i64 - k.half + 1).max(0) as usize;
        if keep_from > self.offset {
            self.buf.drain(..keep_from - self.offset);
            self.offset = keep_from;
        }
        out
    }
}

/// Conversation mode's open microphone (step V4): 16 kHz mono blocks as they come,
/// until it's dropped. Windows shows the microphone in use while it lives.
pub struct Listener {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    pub blocks: mpsc::Receiver<Vec<f32>>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Open `device_name` (the default input when None or not found) and stream it.
pub fn listen(device_name: Option<String>) -> Result<Listener, String> {
    let (stop, stopped) = mpsc::channel::<()>();
    let (blocks_tx, blocks) = mpsc::channel::<Vec<f32>>();
    let (ready_tx, ready) = mpsc::channel::<Result<(), String>>();
    let thread = std::thread::Builder::new()
        .name("voice-listen".into())
        .spawn(move || {
            let opened = (|| {
                let dev = device(device_name.as_deref())?;
                let supported = dev.default_input_config().map_err(|e| e.to_string())?;
                let config: StreamConfig = supported.config();
                let channels = config.channels.max(1) as usize;
                let mut rs = StreamResampler::new(config.sample_rate.0, RATE);
                let mut mono = Vec::new();
                let mut send = move |frames: &mut dyn Iterator<Item = f32>| {
                    mono.clear();
                    mono.extend(frames);
                    let out = rs.push(&mono);
                    if !out.is_empty() {
                        let _ = blocks_tx.send(out);
                    }
                };
                let on_err = |e: cpal::StreamError| eprintln!("[voice] listen: {e}");
                let stream = match supported.sample_format() {
                    SampleFormat::F32 => dev.build_input_stream(
                        &config,
                        move |d: &[f32], _: &_| send(&mut d.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32)),
                        on_err,
                        None,
                    ),
                    SampleFormat::I16 => dev.build_input_stream(
                        &config,
                        move |d: &[i16], _: &_| {
                            send(&mut d.chunks(channels).map(|f| f.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / channels as f32))
                        },
                        on_err,
                        None,
                    ),
                    f => return Err(format!("the microphone's sample format {f:?} isn't supported")),
                }
                .map_err(|e| e.to_string())?;
                stream.play().map_err(|e| e.to_string())?;
                Ok(stream)
            })();
            match opened {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    // Until the listener is dropped (its sender with it).
                    let _ = stopped.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    match ready.recv() {
        Ok(Ok(())) => Ok(Listener { stop: Some(stop), thread: Some(thread), blocks }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err("the microphone thread ended".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: u32, secs: f64) -> Vec<f32> {
        (0..(rate as f64 * secs) as usize).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() as f32).collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn keeps_speech_frequencies_and_drops_what_wont_fit() {
        // 1 kHz passes 48k → 16k at its level; 12 kHz (above 8 kHz) is filtered out.
        let low = resample(&sine(1000.0, 48_000, 1.0), 48_000, 16_000);
        assert_eq!(low.len(), 16_000);
        let level = rms(&low[1000..15_000]);
        assert!((level - std::f64::consts::FRAC_1_SQRT_2).abs() < 0.02, "{level}");
        let high = resample(&sine(12_000.0, 48_000, 1.0), 48_000, 16_000);
        assert!(rms(&high[1000..15_000]) < 0.05);
        // 44.1 kHz too.
        assert_eq!(resample(&sine(500.0, 44_100, 1.0), 44_100, 16_000).len(), 16_000);
        assert_eq!(resample(&[0.5, 0.25], 16_000, 16_000), vec![0.5, 0.25]);
    }

    /// The default microphone, streamed for a second (`cargo test listens -- --ignored
    /// --nocapture`): blocks come at 16 kHz, and it closes when dropped.
    #[test]
    #[ignore]
    fn listens_to_the_microphone() {
        let mic = listen(None).unwrap();
        let t = std::time::Instant::now();
        let mut got = 0usize;
        while t.elapsed() < Duration::from_secs(1) {
            if let Ok(b) = mic.blocks.recv_timeout(Duration::from_millis(200)) {
                got += b.len();
            }
        }
        drop(mic);
        println!("{got} samples in a second");
        assert!((14_000..18_000).contains(&got), "{got}");
    }

    #[test]
    fn the_tabled_kernel_gives_what_working_it_out_gives() {
        // 44.1 kHz has 160 phases; every tabled sample against the slow path's.
        let x = sine(1234.0, 44_100, 0.2);
        let tabled = Kernel::new(44_100, 16_000);
        assert_eq!(tabled.table.as_ref().map(|t| t.p), Some(160));
        let slow = Kernel { table: None, ..tabled.clone() };
        for i in (100..3000).step_by(7) {
            assert!((tabled.sample(i, &x, 0) - slow.sample(i, &x, 0)).abs() < 1e-4, "{i}");
        }
        assert!(Kernel::new(16_000, 16_000).table.is_none());
    }

    /// What resampling the microphone costs (`cargo test --release
    /// resampling_costs -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn resampling_costs() {
        for rate in [48_000, 44_100] {
            let x = sine(440.0, rate, 10.0);
            let mut rs = StreamResampler::new(rate, 16_000);
            let t = std::time::Instant::now();
            let n: usize = x.chunks(480).map(|b| rs.push(b).len()).sum();
            println!("{rate} Hz: {n} samples, {:.2}% of a core", 100.0 * t.elapsed().as_secs_f64() / 10.0);
        }
    }

    #[test]
    fn streaming_gives_what_resampling_at_once_gives() {
        let x = sine(700.0, 48_000, 0.5);
        let whole = resample(&x, 48_000, 16_000);
        let mut rs = StreamResampler::new(48_000, 16_000);
        // Blocks of odd sizes, as a sound card hands them over.
        let out: Vec<f32> = x.chunks(441).flat_map(|b| rs.push(b)).collect();
        // All but the last kernel's worth, which waits for input that never came.
        assert!(whole.len() - out.len() <= 20, "{} of {}", out.len(), whole.len());
        for (a, b) in out.iter().zip(&whole) {
            assert!((a - b).abs() < 1e-5);
        }
    }
}
