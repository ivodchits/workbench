//! The speech sidecar (step V2): Kokoro (English) and Silero (Russian) in one Python
//! process on the CPU, managed by `uv`.
//!
//! - **Install** ([`Sidecar::install`]): a pinned project (`pyproject.toml` +
//!   `uv.lock`, compiled into the app from `resources/voice-runtime/`) is written to
//!   `<app local data>/voice-runtime/` (`voice-runtime.dev/` in debug) and
//!   `uv sync --frozen` builds its `.venv` there. A marker holds the hash of the two
//!   files, so a new pin reinstalls. The models are [`TTS_ASSETS`], under
//!   `<models>/tts/`.
//! - **Run:** the venv's own `python.exe` runs `tts_sidecar.py` (not `uv run`, whose
//!   child would outlive a kill), with no window, spawned on first use. While
//!   replies are spoken it stays loaded ([`Sidecar::set_keep`], so the first reply
//!   is never cold); otherwise it's killed after [`IDLE_KILL`] with nothing to say.
//!   Silero loads only when a Russian sentence comes.
//! - **Protocol:** a JSON line per request on stdin; a JSON header line back, then
//!   `samples` int16 samples (see the script's docstring).

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::assets::Asset;

/// When it isn't kept loaded, nothing stays resident longer than this after the
/// last sentence (design: 5 min).
pub const IDLE_KILL: Duration = Duration::from_secs(300);
/// The rate both engines are asked for.
pub const RATE: u32 = 24_000;

pub const TTS_DIR: &str = "tts";

const PYPROJECT: &str = include_str!("../../resources/voice-runtime/pyproject.toml");
const LOCK: &str = include_str!("../../resources/voice-runtime/uv.lock");
const SCRIPT: &str = include_str!("../../resources/voice-runtime/tts_sidecar.py");
const MARKER: &str = ".installed";

/// The models, pinned like V1's. Silero's host is slow (~150 KB/s measured) and
/// replaces files in place, so a changed `v5_6_ru.pt` fails its checksum rather
/// than loading something unheard.
pub const TTS_ASSETS: &[Asset] = &[
    Asset {
        path: "tts/kokoro-v1.0.int8.onnx",
        url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx",
        size: 92_361_271,
        sha256: "6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb",
    },
    Asset {
        path: "tts/voices-v1.0.bin",
        url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
        size: 28_214_398,
        sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    },
    Asset {
        path: "tts/v5_6_ru.pt",
        url: "https://models.silero.ai/models/tts/ru/v5_6_ru.pt",
        size: 147_664_410,
        sha256: "04cc9b1d08ce38bcaa9d02c488d80d3e6806d17f7eaa7c95982f36a3cbf50b2e",
    },
];

/// Which engine a sentence goes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Kokoro,
    Silero,
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Deserialize)]
struct Header {
    #[serde(default)]
    samples: Option<usize>,
    #[serde(default)]
    rate: Option<u32>,
    #[serde(default)]
    error: Option<String>,
}

/// Tauri-managed through [`super::tts::TtsState`].
pub struct Sidecar {
    dir: PathBuf,
    models: PathBuf,
    proc: Mutex<Option<Proc>>,
    last_used: Mutex<Instant>,
    /// Stay loaded however long it's idle.
    keep: AtomicBool,
}

impl Sidecar {
    pub fn new(dir: PathBuf, models: PathBuf) -> Self {
        Self {
            dir,
            models,
            proc: Mutex::new(None),
            last_used: Mutex::new(Instant::now()),
            keep: AtomicBool::new(false),
        }
    }

    /// Stay loaded (replies are spoken), or go after the idle timeout.
    pub fn set_keep(&self, keep: bool) {
        self.keep.store(keep, Ordering::Relaxed);
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn models(&self) -> &Path {
        &self.models
    }

    fn python(&self) -> PathBuf {
        self.dir.join(".venv").join("Scripts").join("python.exe")
    }

    fn pin_hash() -> String {
        let mut h = Sha256::new();
        h.update(PYPROJECT.as_bytes());
        h.update(LOCK.as_bytes());
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The venv is built from the pins this app carries.
    pub fn installed(&self) -> bool {
        self.python().is_file()
            && std::fs::read_to_string(self.dir.join(MARKER)).is_ok_and(|m| m.trim() == Self::pin_hash())
    }

    /// Bytes of models still to download.
    pub fn missing_bytes(&self) -> u64 {
        super::assets::missing_bytes(&self.models, &[TTS_ASSETS], false)
    }

    /// Everything is in place to speak.
    pub fn ready(&self) -> bool {
        self.installed() && self.missing_bytes() == 0
    }

    /// Write the project and `uv sync` it (downloads Python 3.12 and the packages,
    /// ~1 GB, the first time). Blocking.
    pub fn install(&self) -> Result<(), String> {
        let uv = find_uv().ok_or("uv isn't installed: get it from https://docs.astral.sh/uv/ and try again")?;
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("creating {}: {e}", self.dir.display()))?;
        for (name, body) in [("pyproject.toml", PYPROJECT), ("uv.lock", LOCK), ("tts_sidecar.py", SCRIPT)] {
            std::fs::write(self.dir.join(name), body).map_err(|e| format!("writing {name}: {e}"))?;
        }
        let mut cmd = Command::new(uv);
        cmd.args(["sync", "--frozen", "--no-progress", "--python", "3.12"])
            .current_dir(&self.dir)
            .env_remove("VIRTUAL_ENV")
            .stdin(Stdio::null());
        no_window(&mut cmd);
        let out = cmd.output().map_err(|e| format!("running uv: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let tail: Vec<&str> = err.lines().rev().take(6).collect();
            return Err(format!("uv sync failed: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" | ")));
        }
        std::fs::write(self.dir.join(MARKER), Self::pin_hash()).map_err(|e| e.to_string())
    }

    fn spawn(&self) -> Result<Proc, String> {
        if !self.ready() {
            return Err("spoken replies aren't set up: download them in Duck's voice settings".into());
        }
        // The script is rewritten each start, so a new app version's script runs
        // without a reinstall.
        std::fs::write(self.dir.join("tts_sidecar.py"), SCRIPT).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(self.python());
        cmd.arg("tts_sidecar.py")
            .current_dir(&self.dir)
            .env("WB_TTS_MODELS", self.models.join(TTS_DIR))
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        no_window(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("starting the speech sidecar: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        lower_priority(&child);
        Ok(Proc { child, stdin, stdout, next_id: 1 })
    }

    /// One request and its reply on the live process (started if needed). A broken
    /// pipe drops the process, so the next call starts a fresh one.
    fn call(&self, req: serde_json::Value) -> Result<(Header, Vec<u8>), String> {
        *self.last_used.lock().map_err(|e| e.to_string())? = Instant::now();
        let mut guard = self.proc.lock().map_err(|e| e.to_string())?;
        if guard.as_mut().is_some_and(|p| p.child.try_wait().ok().flatten().is_some()) {
            *guard = None;
        }
        if guard.is_none() {
            *guard = Some(self.spawn()?);
        }
        let p = guard.as_mut().expect("just set");
        let result = (|| -> Result<(Header, Vec<u8>), String> {
            let mut req = req;
            req["id"] = p.next_id.into();
            p.next_id += 1;
            writeln!(p.stdin, "{req}").and_then(|_| p.stdin.flush()).map_err(|e| format!("the speech sidecar: {e}"))?;
            let mut line = String::new();
            if p.stdout.read_line(&mut line).map_err(|e| format!("the speech sidecar: {e}"))? == 0 {
                return Err("the speech sidecar quit".into());
            }
            let h: Header = serde_json::from_str(&line).map_err(|e| format!("the speech sidecar said {line:?}: {e}"))?;
            let mut pcm = vec![0u8; h.samples.unwrap_or(0) * 2];
            p.stdout.read_exact(&mut pcm).map_err(|e| format!("the speech sidecar: {e}"))?;
            Ok((h, pcm))
        })();
        if result.is_err() {
            *guard = None;
        }
        *self.last_used.lock().map_err(|e| e.to_string())? = Instant::now();
        result
    }

    /// Start the process and load Kokoro (and Silero, with `ru`), so the first
    /// sentence doesn't wait.
    pub fn warm(&self, ru: bool) -> Result<(), String> {
        self.call(serde_json::json!({"op": "warm", "ru": ru})).map(|_| ())
    }

    /// Synthesize one sentence: mono f32 at [`RATE`].
    pub fn synth(&self, engine: Engine, text: &str, voice: &str, speed: f32) -> Result<Vec<f32>, String> {
        let (h, pcm) = self.call(serde_json::json!({
            "engine": engine,
            "text": text,
            "voice": voice,
            "speed": speed,
        }))?;
        if let Some(e) = h.error {
            return Err(e);
        }
        if h.rate != Some(RATE) {
            return Err(format!("the sidecar sent {:?} Hz", h.rate));
        }
        Ok(pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect())
    }

    pub fn running(&self) -> bool {
        self.proc.lock().is_ok_and(|p| p.is_some())
    }

    #[cfg(test)]
    pub fn kill(&self) {
        if let Ok(mut p) = self.proc.lock() {
            *p = None;
        }
    }

    /// Kill the process once it's been idle for `idle`.
    pub fn reap_when_idle(self: &Arc<Self>, idle: Duration) {
        let me = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("tts-reaper".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_secs(15));
                let Some(s) = me.upgrade() else { return };
                if s.keep.load(Ordering::Relaxed) {
                    continue;
                }
                let quiet = s.last_used.lock().map(|t| t.elapsed() >= idle).unwrap_or(false);
                // try_lock: a call in progress isn't idle.
                if quiet {
                    if let Ok(mut p) = s.proc.try_lock() {
                        *p = None;
                    }
                }
            })
            .expect("spawning the tts reaper");
    }
}

/// `uv` on PATH, or where its installer puts it.
fn find_uv() -> Option<PathBuf> {
    which::which("uv").ok().or_else(|| {
        let home = std::env::var_os("USERPROFILE")?;
        let p = PathBuf::from(home).join(".local").join("bin").join("uv.exe");
        p.is_file().then_some(p)
    })
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Below-normal priority, so speech never slows the sessions it reports on.
fn lower_priority(child: &Child) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
        };
        // SAFETY: a handle we open for our own child and close at once.
        unsafe {
            if let Ok(h) = OpenProcess(PROCESS_SET_INFORMATION, false, child.id()) {
                let _ = SetPriorityClass(h, BELOW_NORMAL_PRIORITY_CLASS);
                let _ = CloseHandle(h);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = child;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pins_are_consistent() {
        for a in TTS_ASSETS {
            assert_eq!(a.sha256.len(), 64, "{}", a.path);
            assert!(a.path.starts_with("tts/") && a.url.ends_with(a.path.trim_start_matches("tts/")), "{}", a.path);
        }
        // The script reads the files the pins name.
        for a in TTS_ASSETS {
            assert!(SCRIPT.contains(a.path.trim_start_matches("tts/")), "{}", a.path);
        }
        assert!(LOCK.contains("kokoro-onnx") && LOCK.contains("torch"));
    }

    /// Speaks two sentences through a real install (`cargo test tts_sidecar --
    /// --ignored --nocapture`). `WB_TTS_RUNTIME` is a runtime folder (installed
    /// here if needed) and `WB_MODELS` a models folder with the TTS files.
    #[test]
    #[ignore]
    fn tts_sidecar_speaks() {
        let dir = PathBuf::from(std::env::var("WB_TTS_RUNTIME").expect("WB_TTS_RUNTIME"));
        let models = PathBuf::from(std::env::var("WB_MODELS").expect("WB_MODELS"));
        let s = Sidecar::new(dir, models);
        if !s.installed() {
            let t = Instant::now();
            s.install().unwrap();
            println!("installed in {} s", t.elapsed().as_secs());
        }
        let t = Instant::now();
        s.warm(false).unwrap();
        println!("warm: {} ms", t.elapsed().as_millis());
        for (engine, text) in [(Engine::Kokoro, "The backend session finished."), (Engine::Silero, "Бэкенд готов.")] {
            let t = Instant::now();
            let pcm = s.synth(engine, text, if engine == Engine::Kokoro { "af_heart" } else { "kseniya" }, 1.0).unwrap();
            println!("{engine:?}: {} ms for {} ms of audio", t.elapsed().as_millis(), pcm.len() as u64 * 1000 / RATE as u64);
            assert!(pcm.len() > RATE as usize / 2);
        }
        assert!(s.synth(Engine::Silero, "abc 123", "kseniya", 1.0).is_err(), "Silero refuses text it can't say");
        s.kill();
        assert!(!s.running());
    }
}
