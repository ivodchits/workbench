//! Microphone capture for push-to-talk (step V1): the input device's samples,
//! mixed to mono and resampled to 16 kHz when the recording stops.
//!
//! The stream lives on a thread of its own (cpal streams can't move between
//! threads on Windows), and only between `start` and `stop`, so Windows shows the
//! microphone as in use only while the key is held.

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

/// Windowed-sinc resampling (Blackman window), low-passed at the lower Nyquist.
pub fn resample(x: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || x.is_empty() {
        return x.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let cutoff = (to as f64 / from as f64).min(1.0);
    let n_out = (x.len() as f64 / ratio).floor() as usize;
    let half = (TAPS as f64 / cutoff).ceil() as i64;
    let mut out = Vec::with_capacity(n_out);
    for i in 0..n_out {
        let t = i as f64 * ratio;
        let center = t.floor() as i64;
        let (mut acc, mut norm) = (0f64, 0f64);
        for k in (center - half + 1)..=(center + half) {
            if k < 0 || k as usize >= x.len() {
                continue;
            }
            let d = t - k as f64;
            let arg = std::f64::consts::PI * d * cutoff;
            let sinc = if d.abs() < 1e-9 { 1.0 } else { arg.sin() / arg };
            let w = d / half as f64; // −1..1 across the kernel
            let win = 0.42 + 0.5 * (std::f64::consts::PI * w).cos() + 0.08 * (2.0 * std::f64::consts::PI * w).cos();
            let h = sinc * win;
            acc += x[k as usize] as f64 * h;
            norm += h;
        }
        out.push(if norm.abs() > 1e-9 { (acc / norm) as f32 } else { 0.0 });
    }
    out
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
}
