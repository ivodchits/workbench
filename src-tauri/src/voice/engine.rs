//! The speech-to-text engine (step V1): Parakeet on the CPU in int8, or on the GPU
//! through DirectML, with the clip trimmed to its speech first.
//!
//! - **Runtime.** `onnxruntime.dll` is loaded from the models folder the first time
//!   it's needed (`ort`'s `load-dynamic`), with our `DirectML.dll` loaded by full
//!   path just before it. Windows has an older `DirectML.dll` in System32 that would
//!   otherwise be picked up.
//! - **CPU** (the default). int8, 3 intra-op threads, so a busy PC keeps its
//!   cores; ~0.8 GB of RAM while loaded. An empty result is retried once in fp32
//!   when those files are there: X0 saw int8 return nothing on some clips that
//!   fp32 read fine.
//! - **GPU** (opt-in, [`GpuPref`]). DirectML asked for the high-performance
//!   adapter, which is the RTX rather than the Radeon iGPU (X0: the default adapter
//!   was the iGPU, and slower). It needs no CUDA or cuDNN install. fp32 weights for
//!   the encoder; the decoder stays on the CPU. If the GPU can't be used, the CPU
//!   takes over and the reason is kept for the settings.
//! - **Lifetime.** Nothing loads at start. `preload` loads in the background (the
//!   hotkey's press, in parallel with recording), and the model is dropped after
//!   it has been idle a while, unless something keeps it warm. Dropping it frees
//!   the VRAM, so the dGPU can sleep.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use ort::ep::directml::PerformancePreference;
use ort::ep::DirectML;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use serde::{Deserialize, Serialize};

use super::assets::{self, PARAKEET_DIR, RUNTIME_DIR};
use super::parakeet::Parakeet;
use super::vad::{self, Vad};

/// When the GPU may be used for voice. Never by default: measured in V1, the CPU
/// path is faster (0.1–0.4 s per command against 0.2–0.5 s, and 0.1–0.6 s against
/// 0.6–1.1 s with the CPU fully loaded) and costs no VRAM, where the GPU path takes
/// 2.5 GB of it and a 2.5 GB download.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum GpuPref {
    Always,
    /// On battery the CPU path runs, so the dGPU stays asleep.
    AcOnly,
    #[default]
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Gpu,
    Cpu,
}

impl Provider {
    pub fn label(self) -> &'static str {
        match self {
            Provider::Gpu => "GPU (DirectML)",
            Provider::Cpu => "CPU (int8)",
        }
    }
}

/// One transcription.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    pub provider: Provider,
    /// The clip's length, and the speech kept after trimming, ms.
    pub audio_ms: u64,
    pub speech_ms: u64,
    /// Time spent loading the model for this call (0 when it was loaded), and
    /// transcribing, ms.
    pub load_ms: u64,
    pub ms: u64,
    /// The int8 result was empty and fp32 was asked.
    pub retried: bool,
}

const CPU_THREADS: usize = 3;
const SAMPLE_RATE: usize = 16_000;

struct Loaded {
    provider: Provider,
    model: Parakeet,
    vad: Vad,
    /// fp32 on the CPU, loaded for a retry and kept with the rest.
    retry: Option<Parakeet>,
}

pub struct Engine {
    root: PathBuf,
    loaded: Mutex<Option<Loaded>>,
    last_used: Mutex<Instant>,
    /// Why the GPU wasn't used last time it was asked for; None when it was.
    gpu_problem: Mutex<Option<String>>,
    /// Kept loaded regardless of idleness (the drawer open, conversation mode).
    warm: AtomicBool,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Load ONNX Runtime from the models folder, once per process.
pub(crate) fn init_runtime(root: &Path) -> Result<(), String> {
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    INIT.get_or_init(|| {
        let dir = root.join(RUNTIME_DIR);
        if !assets::runtime_present(root) {
            return Err("the voice runtime isn't downloaded".into());
        }
        preload_library(&dir.join("DirectML.dll"))?;
        let builder = ort::init_from(dir.join("onnxruntime.dll")).map_err(err)?;
        let _ = builder.with_name("workbench-voice").commit();
        Ok(())
    })
    .clone()
}

#[cfg(windows)]
fn preload_library(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::System::LibraryLoader::LoadLibraryW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // Stays loaded for the process: ONNX Runtime binds to it by name.
    unsafe { LoadLibraryW(PCWSTR(wide.as_ptr())) }
        .map(|_| ())
        .map_err(|e| format!("loading {}: {e}", path.display()))
}

#[cfg(not(windows))]
fn preload_library(_: &Path) -> Result<(), String> {
    Ok(())
}

/// Is the PC on AC power? (Unknown counts as yes.)
#[cfg(windows)]
pub fn on_ac_power() -> bool {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut s) }.is_err() {
        return true;
    }
    s.ACLineStatus != 0
}

#[cfg(not(windows))]
pub fn on_ac_power() -> bool {
    true
}

/// The provider the preference asks for now.
pub fn wanted(pref: GpuPref, on_ac: bool) -> Provider {
    match pref {
        GpuPref::Always => Provider::Gpu,
        GpuPref::AcOnly if on_ac => Provider::Gpu,
        _ => Provider::Cpu,
    }
}

fn session(provider: Provider, path: &Path) -> Result<Session, String> {
    let named = |e: String| format!("{}: {e}", path.file_name().and_then(|n| n.to_str()).unwrap_or("model"));
    let b = Session::builder()
        .map_err(err)?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(err)?;
    let b = match provider {
        // DirectML runs one op at a time and can't use memory patterns.
        Provider::Gpu => b
            .with_parallel_execution(false)
            .map_err(err)?
            .with_memory_pattern(false)
            .map_err(err)?
            .with_execution_providers([DirectML::default()
                .with_performance_preference(PerformancePreference::HighPerformance)
                .build()
                .error_on_failure()])
            .map_err(err)?,
        Provider::Cpu => b
            .with_intra_threads(CPU_THREADS)
            .map_err(err)?
            .with_inter_threads(1)
            .map_err(err)?,
    };
    let mut b = b;
    b.commit_from_file(path).map_err(|e| named(e.to_string()))
}

/// The VAD (and V4's turn detector) always run on the CPU, one thread: they're tiny.
pub(crate) fn tiny_session(path: &Path) -> Result<Session, String> {
    Session::builder()
        .map_err(err)?
        .with_intra_threads(1)
        .map_err(err)?
        .with_inter_threads(1)
        .map_err(err)?
        .commit_from_file(path)
        .map_err(err)
}

impl Engine {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            loaded: Mutex::new(None),
            last_used: Mutex::new(Instant::now()),
            gpu_problem: Mutex::new(None),
            warm: AtomicBool::new(false),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The files a provider needs.
    pub fn needs(provider: Provider) -> [&'static [assets::Asset]; 2] {
        match provider {
            Provider::Gpu => [assets::COMMON, assets::FP32],
            Provider::Cpu => [assets::COMMON, assets::INT8],
        }
    }

    pub fn ready_for(&self, provider: Provider) -> bool {
        assets::runtime_present(&self.root) && Self::needs(provider).iter().all(|s| s.iter().all(|a| assets::present(&self.root, a)))
    }

    /// The provider it would use now: the preferred one if its files are there,
    /// else the other one that is ready; None when neither is.
    pub fn choose(&self, pref: GpuPref) -> Option<Provider> {
        let first = wanted(pref, on_ac_power());
        let other = if first == Provider::Gpu { Provider::Cpu } else { Provider::Gpu };
        if self.ready_for(first) {
            Some(first)
        } else if pref != GpuPref::Never && self.ready_for(other) {
            Some(other)
        } else if self.ready_for(Provider::Cpu) {
            Some(Provider::Cpu)
        } else {
            None
        }
    }

    pub fn loaded_provider(&self) -> Option<Provider> {
        self.loaded.lock().ok()?.as_ref().map(|l| l.provider)
    }

    pub fn gpu_problem(&self) -> Option<String> {
        self.gpu_problem.lock().ok()?.clone()
    }

    pub fn set_warm(&self, on: bool) {
        self.warm.store(on, Ordering::Relaxed);
        self.touch();
    }

    fn touch(&self) {
        if let Ok(mut t) = self.last_used.lock() {
            *t = Instant::now();
        }
    }

    fn load(&self, provider: Provider) -> Result<Loaded, String> {
        init_runtime(&self.root)?;
        let dir = self.root.join(PARAKEET_DIR);
        let vad = Vad::load(&self.root.join(vad::MODEL), &tiny_session)?;
        // The decoder runs once per output step: on DirectML each call pays a
        // dispatch, and its first ones a long warm-up, so it stays on the CPU.
        let model = Parakeet::load(&dir, provider == Provider::Cpu, &|p| session(provider, p), &|p| session(Provider::Cpu, p))?;
        Ok(Loaded { provider, model, vad, retry: None })
    }

    /// Make sure the model is loaded on the provider the preference picks now
    /// (reloading when that changed). Returns how long loading took, ms.
    fn ensure<'a>(
        &self,
        slot: &'a mut Option<Loaded>,
        pref: GpuPref,
    ) -> Result<(&'a mut Loaded, u64), String> {
        let provider = self.choose(pref).ok_or("the voice model isn't downloaded")?;
        let t = Instant::now();
        if slot.as_ref().map(|l| l.provider) != Some(provider) {
            *slot = None;
            *slot = Some(match self.load(provider) {
                Ok(l) => {
                    if provider == Provider::Gpu {
                        *self.gpu_problem.lock().map_err(err)? = None;
                    }
                    l
                }
                Err(e) if provider == Provider::Gpu && self.ready_for(Provider::Cpu) => {
                    *self.gpu_problem.lock().map_err(err)? = Some(e);
                    self.load(Provider::Cpu)?
                }
                Err(e) => return Err(e),
            });
        }
        Ok((slot.as_mut().expect("just loaded"), t.elapsed().as_millis() as u64))
    }

    /// Load now (in the background of a recording), so the transcription doesn't wait.
    pub fn preload(&self, pref: GpuPref) -> Result<Provider, String> {
        let mut slot = self.loaded.lock().map_err(err)?;
        self.touch();
        Ok(self.ensure(&mut slot, pref)?.0.provider)
    }

    /// Transcribe 16 kHz mono samples.
    pub fn transcribe(&self, samples: &[f32], pref: GpuPref) -> Result<Transcript, String> {
        let mut slot = self.loaded.lock().map_err(err)?;
        self.touch();
        let (l, load_ms) = self.ensure(&mut slot, pref)?;
        let t = Instant::now();
        let audio_ms = (samples.len() * 1000 / SAMPLE_RATE) as u64;
        let probs = l.vad.probabilities(samples)?;
        let Some((from, to)) = vad::speech_bounds(&probs, samples.len()) else {
            return Ok(Transcript { text: String::new(), provider: l.provider, audio_ms, speech_ms: 0, load_ms, ms: t.elapsed().as_millis() as u64, retried: false });
        };
        let clip = &samples[from..to];
        let mut text = l.model.transcribe(clip)?;
        let mut retried = false;
        if text.is_empty() && l.provider == Provider::Cpu && assets::FP32.iter().all(|a| assets::present(&self.root, a)) {
            retried = true;
            if l.retry.is_none() {
                let cpu = |p: &Path| session(Provider::Cpu, p);
                l.retry = Some(Parakeet::load(&self.root.join(PARAKEET_DIR), false, &cpu, &cpu)?);
            }
            text = l.retry.as_mut().expect("just loaded").transcribe(clip)?;
        }
        self.touch();
        Ok(Transcript {
            text,
            provider: l.provider,
            audio_ms,
            speech_ms: ((to - from) * 1000 / SAMPLE_RATE) as u64,
            load_ms,
            ms: t.elapsed().as_millis() as u64,
            retried,
        })
    }

    pub fn unload(&self) {
        if let Ok(mut slot) = self.loaded.lock() {
            *slot = None;
        }
    }

    /// Drop the model once it has been idle `idle` (and nothing keeps it warm).
    /// Checked every few seconds on a thread of its own, for the process's life.
    pub fn reap_when_idle(self: &std::sync::Arc<Self>, idle: Duration) {
        let engine = std::sync::Arc::clone(self);
        std::thread::Builder::new()
            .name("voice-reaper".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_secs(10));
                if engine.warm.load(Ordering::Relaxed) {
                    continue;
                }
                let idle_for = engine.last_used.lock().map(|t| t.elapsed()).unwrap_or_default();
                // try_lock: a transcription in progress isn't idle.
                if idle_for >= idle {
                    if let Ok(mut slot) = engine.loaded.try_lock() {
                        *slot = None;
                    }
                }
            })
            .expect("spawning the voice reaper");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_preference_and_the_power_pick_the_provider() {
        assert_eq!(wanted(GpuPref::Always, false), Provider::Gpu);
        assert_eq!(wanted(GpuPref::AcOnly, true), Provider::Gpu);
        assert_eq!(wanted(GpuPref::AcOnly, false), Provider::Cpu);
        assert_eq!(wanted(GpuPref::Never, true), Provider::Cpu);
    }

    #[test]
    fn nothing_downloaded_means_no_provider() {
        let e = Engine::new(std::env::temp_dir().join(format!("wb-voice-none-{}", uuid::Uuid::new_v4())));
        assert_eq!(e.choose(GpuPref::Always), None);
        assert!(e.transcribe(&[0.0; 16_000], GpuPref::Always).is_err());
    }
}
