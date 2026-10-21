//! The turn detector (step V4): is this pause the end of what you're saying?
//!
//! Smart Turn v3.2 (Pipecat, BSD-2-Clause) reads the audio of the turn so far, its
//! last 8 s, and returns P(turn complete) from the intonation and the trailing-off.
//! It runs on the CPU, one thread, only when a pause has gone on long enough for the
//! mode's policy to ask.
//!
//! **fp32, not int8.** Pipecat ships an int8 model for the CPU (8 MB, what X0
//! measured) and an fp32 one meant for the GPU (32 MB). The int8 model's output moves
//! with ONNX Runtime's version and graph optimizations: one pause read 0.27 on our
//! 1.24.2, 0.68 on X0's 1.31, and 0.57 with optimizations off. fp32 agrees with
//! itself to 1e-5 everywhere, so the app runs it, on the CPU.
//!
//! Its input is what `transformers`' `WhisperFeatureExtractor(chunk_length=8)`
//! makes, as X0's `score_turns.py` fed it:
//! - the audio left-padded with zeros to 8 s (or its last 8 s), then normalized to
//!   zero mean and unit variance;
//! - a 400-point STFT (periodic Hann, hop 160, centred with reflect padding), its
//!   power through 80 Slaney mel filters (0–8 kHz), `log10`, floored at 8 below
//!   the maximum, `(x + 4) / 4`;
//! - 800 frames (the STFT's last frame is dropped), as `(1, 80, 800)`.

use std::path::Path;
use std::sync::Arc;

use ndarray::Array3;
use ort::inputs;
use ort::session::Session;
use ort::value::TensorRef;
use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

pub const MODEL: &str = "smart-turn-v3.2-gpu.onnx";

const RATE: usize = 16_000;
/// What the model hears: the last 8 s.
pub const WINDOW: usize = 8 * RATE;
const N_FFT: usize = 400;
const HOP: usize = 160;
const BINS: usize = N_FFT / 2 + 1;
const MELS: usize = 80;
const FRAMES: usize = WINDOW / HOP;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub struct SmartTurn {
    session: Session,
    features: Features,
}

impl SmartTurn {
    pub fn load(path: &Path, session: &dyn Fn(&Path) -> Result<Session, String>) -> Result<Self, String> {
        Ok(Self { session: session(path)?, features: Features::new() })
    }

    /// P(the turn is complete), given the turn's audio up to now (16 kHz mono).
    pub fn complete(&mut self, audio: &[f32]) -> Result<f32, String> {
        let mel = self.features.log_mel(audio);
        let input = Array3::from_shape_vec((1, MELS, FRAMES), mel).map_err(err)?;
        let r = self
            .session
            .run(inputs!["input_features" => TensorRef::from_array_view(input.view()).map_err(err)?])
            .map_err(err)?;
        let (_, p) = r[0].try_extract_tensor::<f32>().map_err(err)?;
        Ok(p.first().copied().unwrap_or(0.0))
    }
}

/// The Whisper log-mel front end, with its tables made once.
pub struct Features {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    /// `MELS × BINS`, row-major.
    filters: Vec<f32>,
}

impl Default for Features {
    fn default() -> Self {
        Self::new()
    }
}

impl Features {
    pub fn new() -> Self {
        let window = (0..N_FFT)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / N_FFT as f64).cos())
            .map(|w| w as f32)
            .collect();
        Self { fft: FftPlanner::new().plan_fft_forward(N_FFT), window, filters: mel_filters() }
    }

    /// `MELS × FRAMES`, row-major (the model's `(80, 800)`).
    pub fn log_mel(&self, audio: &[f32]) -> Vec<f32> {
        // The last 8 s, zeros in front when shorter.
        let tail = &audio[audio.len().saturating_sub(WINDOW)..];
        let mut x = vec![0f32; WINDOW - tail.len()];
        x.extend_from_slice(tail);
        // Zero mean, unit variance, over the whole window (padding included).
        let mean = x.iter().map(|&s| s as f64).sum::<f64>() / WINDOW as f64;
        let var = x.iter().map(|&s| (s as f64 - mean).powi(2)).sum::<f64>() / WINDOW as f64;
        let scale = 1.0 / (var + 1e-7).sqrt();
        x.iter_mut().for_each(|s| *s = ((*s as f64 - mean) * scale) as f32);
        // Centred frames: reflect-pad by half a frame each side.
        let half = N_FFT / 2;
        let mut padded = Vec::with_capacity(WINDOW + N_FFT);
        padded.extend((1..=half).rev().map(|i| x[i]));
        padded.extend_from_slice(&x);
        padded.extend((WINDOW - half - 1..WINDOW - 1).rev().map(|i| x[i]));

        let mut power = vec![0f32; BINS];
        let mut buf = vec![Complex32::new(0.0, 0.0); N_FFT];
        let mut scratch = vec![Complex32::new(0.0, 0.0); self.fft.get_inplace_scratch_len()];
        let mut out = vec![0f32; MELS * FRAMES];
        for f in 0..FRAMES {
            let frame = &padded[f * HOP..f * HOP + N_FFT];
            for (b, (&s, &w)) in buf.iter_mut().zip(frame.iter().zip(&self.window)) {
                *b = Complex32::new(s * w, 0.0);
            }
            self.fft.process_with_scratch(&mut buf, &mut scratch);
            for (p, c) in power.iter_mut().zip(&buf) {
                *p = c.norm_sqr();
            }
            for m in 0..MELS {
                let row = &self.filters[m * BINS..(m + 1) * BINS];
                let e: f32 = row.iter().zip(&power).map(|(a, b)| a * b).sum();
                out[m * FRAMES + f] = e.max(1e-10).log10();
            }
        }
        let max = out.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        out.iter_mut().for_each(|v| *v = ((*v).max(max - 8.0) + 4.0) / 4.0);
        out
    }
}

/// Slaney's mel scale: linear below 1 kHz, logarithmic above.
fn hz_to_mel(f: f64) -> f64 {
    let step = 6.4f64.ln() / 27.0;
    if f < 1000.0 {
        3.0 * f / 200.0
    } else {
        15.0 + (f / 1000.0).ln() / step
    }
}

fn mel_to_hz(m: f64) -> f64 {
    let step = 6.4f64.ln() / 27.0;
    if m < 15.0 {
        200.0 * m / 3.0
    } else {
        1000.0 * (step * (m - 15.0)).exp()
    }
}

/// 80 triangular filters over 0–8 kHz, Slaney-normalized (each has unit area).
fn mel_filters() -> Vec<f32> {
    let (lo, hi) = (hz_to_mel(0.0), hz_to_mel(RATE as f64 / 2.0));
    let points: Vec<f64> = (0..MELS + 2).map(|i| mel_to_hz(lo + (hi - lo) * i as f64 / (MELS + 1) as f64)).collect();
    let freqs: Vec<f64> = (0..BINS).map(|i| i as f64 * (RATE as f64 / 2.0) / (BINS - 1) as f64).collect();
    let mut out = vec![0f32; MELS * BINS];
    for m in 0..MELS {
        let (a, b, c) = (points[m], points[m + 1], points[m + 2]);
        let norm = 2.0 / (c - a);
        for (k, &f) in freqs.iter().enumerate() {
            let w = ((f - a) / (b - a)).min((c - f) / (c - b)).max(0.0);
            out[m * BINS + k] = (w * norm) as f32;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_filters_cover_the_band_once() {
        let f = mel_filters();
        // Every filter has some weight, and its peak sits where the mel scale says.
        for m in 0..MELS {
            assert!(f[m * BINS..(m + 1) * BINS].iter().any(|&w| w > 0.0), "filter {m} is empty");
        }
        assert!((mel_to_hz(hz_to_mel(440.0)) - 440.0).abs() < 1e-6);
        assert!((mel_to_hz(hz_to_mel(4000.0)) - 4000.0).abs() < 1e-6);
    }

    #[test]
    fn a_tone_lands_in_its_band() {
        let tone: Vec<f32> = (0..RATE * 2).map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / RATE as f32).sin()).collect();
        let mel = Features::new().log_mel(&tone);
        assert_eq!(mel.len(), MELS * FRAMES);
        // In the last frame (the tone, not the padding), the loudest band is near 1 kHz.
        let f = FRAMES - 5;
        let loudest = (0..MELS).max_by(|&a, &b| mel[a * FRAMES + f].total_cmp(&mel[b * FRAMES + f])).unwrap();
        let centre = mel_to_hz(hz_to_mel(0.0) + (hz_to_mel(8000.0) - hz_to_mel(0.0)) * (loudest + 1) as f64 / (MELS + 1) as f64);
        assert!((centre - 1000.0).abs() < 120.0, "band {loudest} at {centre} Hz");
        assert!(mel.iter().all(|v| v.is_finite()));
    }

    /// The model on a recording, against the probabilities X0's Python pipeline
    /// gives at the same points (`cargo test --release smart_turn_matches_python --
    /// --ignored --nocapture`). `WB_MODELS` has the runtime and the model;
    /// `WB_TURN_WAV` is the recording, `WB_TURN_REF` the reference JSON
    /// (`[{end, p}]`).
    #[test]
    #[ignore]
    fn smart_turn_matches_python() {
        let models = std::path::PathBuf::from(std::env::var("WB_MODELS").expect("WB_MODELS"));
        super::super::engine::init_runtime(&models).unwrap();
        let audio = super::super::read_wav(Path::new(&std::env::var("WB_TURN_WAV").unwrap())).unwrap();
        let reference: serde_json::Value =
            serde_json::from_slice(&std::fs::read(std::env::var("WB_TURN_REF").unwrap()).unwrap()).unwrap();
        let mut st = SmartTurn::load(&models.join(MODEL), &super::super::engine::tiny_session).unwrap();
        for r in reference.as_array().unwrap() {
            let end = r["end"].as_u64().unwrap() as usize;
            let want = r["p"].as_f64().unwrap() as f32;
            let t = std::time::Instant::now();
            let got = st.complete(&audio[..end]).unwrap();
            println!("{:>6.1} s: {got:.4} (python {want:.4}) in {} ms", end as f32 / 16_000.0, t.elapsed().as_millis());
            assert!((got - want).abs() < 0.02, "at {end}: {got} against {want}");
        }
    }
}
