//! Silero VAD (v5/v6 interface, step V1): the speech bounds of a clip, so it is
//! trimmed before transcription. X0 found the int8 model returns nothing on clips
//! with about a second of leading silence; trimmed clips were fine.
//!
//! The model reads 512-sample frames at 16 kHz with the previous frame's last 64
//! samples in front, and carries a `(2, 1, 128)` state between frames.

use std::path::Path;

use ndarray::{Array1, Array2, Array3};
use ort::inputs;
use ort::session::Session;
use ort::value::TensorRef;

pub const MODEL: &str = "silero_vad.onnx";
pub const FRAME: usize = 512;
const CONTEXT: usize = 64;

/// Speech starts above this, and continues above `OFF` (hysteresis).
pub const ON: f32 = 0.5;
pub const OFF: f32 = 0.35;
/// Speech shorter than this many frames is a blip, not speech.
const MIN_SPEECH_FRAMES: usize = 3;
/// Kept around the speech, each side.
pub const PAD_MS: usize = 200;

pub struct Vad {
    session: Session,
    /// Carried between frames: the model's state, and the last frame's tail.
    state: Array3<f32>,
    context: Vec<f32>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Vad {
    pub fn load(path: &Path, session: &dyn Fn(&Path) -> Result<Session, String>) -> Result<Self, String> {
        Ok(Self { session: session(path)?, state: Array3::zeros((2, 1, 128)), context: vec![0f32; CONTEXT] })
    }

    /// Forget the stream so far.
    pub fn reset(&mut self) {
        self.state.fill(0.0);
        self.context.fill(0.0);
    }

    /// The speech probability of the next frame of a stream ([`FRAME`] samples;
    /// conversation mode, step V4).
    pub fn step(&mut self, frame: &[f32]) -> Result<f32, String> {
        let mut x = Vec::with_capacity(CONTEXT + FRAME);
        x.extend_from_slice(&self.context);
        x.extend_from_slice(frame);
        self.context.copy_from_slice(&x[x.len() - CONTEXT..]);
        let input = Array2::from_shape_vec((1, CONTEXT + FRAME), x).map_err(err)?;
        let sr = Array1::from_vec(vec![16_000i64]);
        let r = self
            .session
            .run(inputs![
                "input" => TensorRef::from_array_view(input.view()).map_err(err)?,
                "state" => TensorRef::from_array_view(self.state.view()).map_err(err)?,
                "sr" => TensorRef::from_array_view(sr.view().into_shape_with_order(()).map_err(err)?).map_err(err)?,
            ])
            .map_err(err)?;
        let (_, p) = r["output"].try_extract_tensor::<f32>().map_err(err)?;
        let p = p.first().copied().unwrap_or(0.0);
        self.state = r["stateN"].try_extract_array::<f32>().map_err(err)?.to_owned().into_dimensionality().map_err(err)?;
        Ok(p)
    }

    /// Speech probability per frame of a whole clip.
    pub fn probabilities(&mut self, samples: &[f32]) -> Result<Vec<f32>, String> {
        self.reset();
        samples.chunks_exact(FRAME).map(|f| self.step(f)).collect()
    }
}

/// The sample range to keep: from the first speech to the last, with `PAD_MS` each
/// side; None when there's no speech at all.
pub fn speech_bounds(probs: &[f32], samples: usize) -> Option<(usize, usize)> {
    let mut speech = vec![false; probs.len()];
    let mut on = false;
    for (i, &p) in probs.iter().enumerate() {
        on = if on { p >= OFF } else { p >= ON };
        speech[i] = on;
    }
    // Drop blips.
    let mut i = 0;
    while i < speech.len() {
        if !speech[i] {
            i += 1;
            continue;
        }
        let start = i;
        while i < speech.len() && speech[i] {
            i += 1;
        }
        if i - start < MIN_SPEECH_FRAMES {
            speech[start..i].iter_mut().for_each(|s| *s = false);
        }
    }
    let first = speech.iter().position(|&s| s)?;
    let last = speech.iter().rposition(|&s| s)?;
    let pad = PAD_MS * 16;
    Some(((first * FRAME).saturating_sub(pad), ((last + 1) * FRAME + pad).min(samples)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_to_the_speech_with_padding() {
        // 10 frames of silence, 5 of speech, 10 of silence.
        let mut p = vec![0.0; 25];
        p[10..15].iter_mut().for_each(|x| *x = 0.9);
        let n = 25 * FRAME;
        assert_eq!(speech_bounds(&p, n), Some((10 * FRAME - 3200, 15 * FRAME + 3200)));
    }

    #[test]
    fn ignores_blips_and_keeps_through_soft_frames() {
        let mut p = vec![0.0; 30];
        p[2] = 0.9; // a blip
        p[10..13].iter_mut().for_each(|x| *x = 0.9);
        p[13..16].iter_mut().for_each(|x| *x = 0.4); // above OFF: still speech
        let (start, end) = speech_bounds(&p, 30 * FRAME).unwrap();
        assert_eq!(start, 10 * FRAME - 3200);
        assert_eq!(end, 16 * FRAME + 3200);
        assert_eq!(speech_bounds(&[0.9, 0.0, 0.0], 3 * FRAME), None);
    }
}
