//! The phone's conversation audio, saved for measuring its echo (step V7).
//!
//! With the voice setting "save the phone's conversation audio" on, each
//! conversation run on a phone is written to
//! `<voice-eval data>/recordings/phone/<when>/` for `tools/voice-eval/score_phone.py`:
//! - `mic.wav`: the stream as the desktop heard it, 16 kHz, gaps as silence;
//! - `said-<n>.wav`: each sentence of the desktop's voice the phone played;
//! - `events.json`: what happened, each at its sample in `mic.wav` (`at`): playing
//!   on and off, each sentence said (its words, its WAV), cuts, turns, and what the
//!   pipeline dropped as Duck's own voice;
//! - `meta.json`: how the phone played Duck's voice (its echo path and voice).
//!
//! The data folder is `tools/voice-eval`'s (`_paths.py`): `VOICE_EVAL_DATA`, else
//! `~/repos/Duck/voice-eval`. Recordings are your voice: the folder gets a
//! `.gitignore` of `*` if it has none, so they never enter Duck's data repo.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// The longest recording kept: 30 minutes.
const MAX_SAMPLES: usize = 30 * 60 * 16_000;

/// The voice-eval data folder (`tools/voice-eval/_paths.py`).
pub fn data_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("VOICE_EVAL_DATA").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join("repos").join("Duck").join("voice-eval"))
}

pub struct Recording {
    root: PathBuf,
    meta: Value,
    started: u64,
    mic: Vec<f32>,
    events: Vec<Value>,
    said: Vec<Arc<Vec<u8>>>,
}

impl Recording {
    /// A recording into `root` (the data folder), described by `meta`.
    pub fn new(root: PathBuf, meta: Value) -> Self {
        let started = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        Self { root, meta, started, mic: Vec::new(), events: Vec::new(), said: Vec::new() }
    }

    /// Samples heard, in order.
    pub fn audio(&mut self, x: &[f32]) {
        let room = MAX_SAMPLES.saturating_sub(self.mic.len());
        self.mic.extend_from_slice(&x[..x.len().min(room)]);
    }

    /// Something that happened now, at the stream's current sample.
    pub fn event(&mut self, kind: &str, mut detail: Value) {
        if !detail.is_object() {
            detail = json!({});
        }
        detail["kind"] = json!(kind);
        detail["at"] = json!(self.mic.len());
        self.events.push(detail);
    }

    /// A sentence the phone started playing: its words, and the desktop's audio
    /// for it when there was some.
    pub fn said(&mut self, text: &str, voice: &str, wav: Option<Arc<Vec<u8>>>) {
        let file = wav.map(|w| {
            self.said.push(w);
            format!("said-{}.wav", self.said.len())
        });
        self.event("said", json!({ "text": text, "voice": voice, "wav": file }));
    }

    /// Write it out; the folder it went to. Nothing for a run that heard nothing.
    pub fn finish(self) -> std::io::Result<Option<PathBuf>> {
        if self.mic.is_empty() {
            return Ok(None);
        }
        std::fs::create_dir_all(&self.root)?;
        let ignore = self.root.join(".gitignore");
        if !ignore.exists() {
            std::fs::write(&ignore, "*\n")?;
        }
        let dir = self.root.join("recordings").join("phone").join(stamp(self.started));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("mic.wav"), super::encode_wav(&self.mic, 16_000))?;
        for (i, w) in self.said.iter().enumerate() {
            std::fs::write(dir.join(format!("said-{}.wav", i + 1)), w.as_slice())?;
        }
        let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap_or_default();
        std::fs::write(dir.join("events.json"), pretty(&Value::Array(self.events)))?;
        let mut meta = self.meta;
        meta["seconds"] = json!(self.mic.len() as f64 / 16_000.0);
        std::fs::write(dir.join("meta.json"), pretty(&meta))?;
        Ok(Some(dir))
    }
}

/// `20261022-133045` (UTC) for the folder's name.
fn stamp(secs: u64) -> String {
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rest / 3600, rest / 60 % 60, rest % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_are_utc_dates() {
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_792_675_845), "20261022-133045");
    }

    #[test]
    fn writes_the_stream_its_events_and_the_sentences_and_keeps_out_of_git() {
        let root = std::env::temp_dir().join(format!("wb-phone-rec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mut r = Recording::new(root.clone(), json!({ "path": "shared", "voice": "desktop" }));
        r.audio(&[0.0; 1600]);
        r.event("playing", json!({ "on": true }));
        r.said("Hello there.", "desktop", Some(Arc::new(super::super::encode_wav(&[0.1; 160], 24_000))));
        r.audio(&[0.0; 800]);
        r.event("cut", Value::Null);
        let dir = r.finish().unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(root.join(".gitignore")).unwrap(), "*\n");
        let (mic, rate) = super::super::parse_wav_at(&std::fs::read(dir.join("mic.wav")).unwrap()).unwrap();
        assert_eq!((mic.len(), rate), (2400, 16_000));
        assert!(dir.join("said-1.wav").exists());
        let events: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(dir.join("events.json")).unwrap()).unwrap();
        assert_eq!(events[0]["kind"], "playing");
        assert_eq!(events[1]["at"], 1600);
        assert_eq!(events[1]["wav"], "said-1.wav");
        assert_eq!(events[2]["kind"], "cut");
        assert_eq!(events[2]["at"], 2400);
        let meta: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap();
        assert_eq!(meta["path"], "shared");
        assert_eq!(meta["seconds"], 0.15);
        let _ = std::fs::remove_dir_all(&root);
        assert!(Recording::new(root.clone(), json!({})).finish().unwrap().is_none(), "nothing heard, nothing written");
        assert!(!root.exists());
    }
}
