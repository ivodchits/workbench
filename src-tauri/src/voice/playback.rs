//! Spoken replies out of the speakers (step V2), through cpal (already here for the
//! microphone; `rodio` would bring a second cpal).
//!
//! - Sentences are queued as mono f32 at the engine's rate, resampled to the output
//!   device's rate and copied to every channel.
//! - The output stream lives on its own thread only while there is something to
//!   play, plus a short tail, so no audio device stays open between replies.
//! - [`Player::stop`] empties the queue at once (barge-in).
//! - While audio plays, `level` (0..1, the loudness of what is coming out right now)
//!   is reported every ~33 ms for the duck's beak.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::capture::resample;

/// How long the stream stays open after the queue runs dry, so the next
/// sentence of the same reply doesn't reopen the device.
const TAIL: Duration = Duration::from_millis(1500);
const LEVEL_EVERY: Duration = Duration::from_millis(33);

type LevelFn = Box<dyn Fn(f32) + Send + Sync>;

struct Shared {
    /// Device-rate mono samples still to play.
    queue: Mutex<VecDeque<f32>>,
    /// The device's rate, once a stream has opened.
    rate: AtomicU32,
    /// Loudness of the last buffer played (f32 bits).
    level: AtomicU32,
    /// A stream thread is running.
    open: AtomicBool,
    on_level: LevelFn,
}

pub struct Player {
    shared: Arc<Shared>,
}

impl Player {
    pub fn new(on_level: impl Fn(f32) + Send + Sync + 'static) -> Self {
        Self {
            shared: Arc::new(Shared {
                queue: Mutex::new(VecDeque::new()),
                rate: AtomicU32::new(0),
                level: AtomicU32::new(0),
                open: AtomicBool::new(false),
                on_level: Box::new(on_level),
            }),
        }
    }

    /// Queue `samples` (mono, at `rate`) behind what's playing.
    pub fn push(&self, samples: &[f32], rate: u32) -> Result<(), String> {
        let device_rate = self.ensure_open()?;
        let resampled = if device_rate == rate { samples.to_vec() } else { resample(samples, rate, device_rate) };
        loop {
            {
                let mut q = self.shared.queue.lock().map_err(|e| e.to_string())?;
                // The stream may have closed after its tail meanwhile.
                if self.shared.open.load(Ordering::SeqCst) {
                    q.extend(resampled);
                    return Ok(());
                }
            }
            self.ensure_open()?;
        }
    }

    /// Drop everything queued; what's playing stops within one buffer.
    pub fn stop(&self) {
        if let Ok(mut q) = self.shared.queue.lock() {
            q.clear();
        }
    }

    /// Seconds of audio still queued.
    pub fn queued_secs(&self) -> f32 {
        let rate = self.shared.rate.load(Ordering::Relaxed).max(1);
        self.shared.queue.lock().map(|q| q.len() as f32 / rate as f32).unwrap_or(0.0)
    }

    pub fn is_playing(&self) -> bool {
        self.queued_secs() > 0.0
    }

    /// Open the default output on its own thread if it isn't open; its rate.
    fn ensure_open(&self) -> Result<u32, String> {
        if self.shared.open.load(Ordering::SeqCst) {
            let r = self.shared.rate.load(Ordering::SeqCst);
            if r > 0 {
                return Ok(r);
            }
        }
        let device = cpal::default_host().default_output_device().ok_or("no audio output device")?;
        let config = device.default_output_config().map_err(|e| format!("the audio output: {e}"))?;
        let rate = config.sample_rate().0;
        self.shared.rate.store(rate, Ordering::SeqCst);
        if self.shared.open.swap(true, Ordering::SeqCst) {
            return Ok(rate);
        }
        let shared = Arc::clone(&self.shared);
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        std::thread::Builder::new()
            .name("tts-playback".into())
            .spawn(move || {
                let stream = match open_stream(&device, &config, Arc::clone(&shared)) {
                    Ok(s) => s,
                    Err(e) => {
                        shared.open.store(false, Ordering::SeqCst);
                        let _ = tx.send(Err(e));
                        return;
                    }
                };
                let _ = tx.send(Ok(()));
                let mut idle_since: Option<Instant> = None;
                loop {
                    std::thread::sleep(LEVEL_EVERY);
                    let queued = shared.queue.lock().map(|q| q.len()).unwrap_or(0);
                    if queued > 0 {
                        idle_since = None;
                        (shared.on_level)(f32::from_bits(shared.level.load(Ordering::Relaxed)));
                    } else {
                        let since = *idle_since.get_or_insert_with(|| {
                            (shared.on_level)(0.0);
                            Instant::now()
                        });
                        if since.elapsed() >= TAIL {
                            break;
                        }
                    }
                }
                // Closing under the queue lock, so a push racing the close either
                // lands before (and is played by the next stream) or sees `open` false.
                let q = shared.queue.lock();
                shared.open.store(false, Ordering::SeqCst);
                drop(q);
                drop(stream);
            })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())??;
        Ok(rate)
    }
}

fn open_stream(device: &cpal::Device, config: &cpal::SupportedStreamConfig, shared: Arc<Shared>) -> Result<cpal::Stream, String> {
    let channels = config.channels() as usize;
    let format = config.sample_format();
    let cfg: cpal::StreamConfig = config.clone().into();
    let err = |e| eprintln!("tts playback: {e}");
    // Fill `out` (interleaved) from the queue, and note the loudness.
    fn fill<T: Copy>(out: &mut [T], channels: usize, shared: &Shared, conv: impl Fn(f32) -> T, silence: T) {
        let mut sum = 0f32;
        let mut n = 0usize;
        let mut q = shared.queue.lock().ok();
        for frame in out.chunks_mut(channels) {
            let s = q.as_mut().and_then(|q| q.pop_front());
            match s {
                Some(v) => {
                    sum += v * v;
                    n += 1;
                    frame.fill(conv(v));
                }
                None => frame.fill(silence),
            }
        }
        // RMS of speech sits around 0.05–0.2; scaled so a normal syllable opens the beak.
        let rms = if n > 0 { (sum / n as f32).sqrt() } else { 0.0 };
        shared.level.store((rms * 6.0).min(1.0).to_bits(), Ordering::Relaxed);
    }
    let stream = match format {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &cfg,
            move |out: &mut [f32], _| fill(out, channels, &shared, |v| v, 0.0),
            err,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_output_stream(
            &cfg,
            move |out: &mut [i16], _| fill(out, channels, &shared, |v| (v.clamp(-1.0, 1.0) * 32767.0) as i16, 0),
            err,
            None,
        ),
        other => return Err(format!("the audio output uses {other:?}, which isn't supported")),
    }
    .map_err(|e| format!("opening the audio output: {e}"))?;
    stream.play().map_err(|e| format!("starting the audio output: {e}"))?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plays half a second of a near-silent tone on the default output, and checks
    /// the level is reported, a stop cuts it, and the device closes after the tail
    /// (`cargo test tts_playback -- --ignored`).
    #[test]
    #[ignore]
    fn tts_playback_reports_level_and_closes() {
        let levels = Arc::new(Mutex::new(Vec::<f32>::new()));
        let seen = Arc::clone(&levels);
        let player = Player::new(move |l| seen.lock().unwrap().push(l));
        let tone: Vec<f32> = (0..12_000).map(|i| 0.02 * (i as f32 * 0.1).sin()).collect();
        player.push(&tone, 24_000).unwrap();
        assert!(player.is_playing());
        std::thread::sleep(Duration::from_millis(250));
        assert!(levels.lock().unwrap().iter().any(|&l| l > 0.01), "a level while playing");
        player.stop();
        assert!(!player.is_playing());
        std::thread::sleep(TAIL + Duration::from_millis(300));
        assert!(!player.shared.open.load(Ordering::SeqCst), "the device closes after the tail");
        // And opens again for the next reply.
        player.push(&tone[..2400], 24_000).unwrap();
        assert!(player.shared.open.load(Ordering::SeqCst));
    }
}
