//! NVIDIA Parakeet TDT 0.6B v3 over ONNX Runtime (step V1): the preprocessor
//! (`nemo128.onnx`, waveform → log-mel features), the Conformer encoder, and the
//! token-and-duration transducer decoded greedily.
//!
//! Adapted from `transcribe-rs` 0.3.12 (MIT, cjpais), with two changes:
//! - **TDT durations.** The joint network's logits past the vocabulary are the
//!   duration head; its argmax is how many encoder frames the next step skips, as
//!   `onnx-asr` decodes it. `transcribe-rs` ignores them and steps one frame at a
//!   time, which is most of why X0 measured it 2.5–3× slower than Python.
//! - **Our sessions.** The caller builds the sessions ([`super::engine`]), so the
//!   execution provider, its device and the CPU threads are ours to choose.

use std::path::Path;

use ndarray::{Array1, Array2, Array3, ArrayD, Axis, IxDyn};
use ort::inputs;
use ort::session::Session;
use ort::value::TensorRef;

/// Most tokens one encoder frame may emit before the decoder moves on.
const MAX_TOKENS_PER_STEP: usize = 10;

/// The model's files in its folder (`istupakov/parakeet-tdt-0.6b-v3-onnx`).
pub const PREPROCESSOR: &str = "nemo128.onnx";
pub const VOCAB: &str = "vocab.txt";

/// The encoder and decoder file names for a precision.
pub fn model_files(int8: bool) -> (&'static str, &'static str) {
    if int8 {
        ("encoder-model.int8.onnx", "decoder_joint-model.int8.onnx")
    } else {
        ("encoder-model.onnx", "decoder_joint-model.onnx")
    }
}

pub struct Parakeet {
    preprocessor: Session,
    encoder: Session,
    decoder: Session,
    vocab: Vec<String>,
    blank: i32,
    /// Decoder state shapes: (layers, hidden) for each of the two LSTM states.
    state_dims: [(usize, usize); 2],
}

type State = (Array3<f32>, Array3<f32>);

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Parakeet {
    /// Load from `dir`: the preprocessor and encoder with sessions from `heavy`, the
    /// decoder (a small network run once per output step) from `light`.
    pub fn load(
        dir: &Path,
        int8: bool,
        heavy: &dyn Fn(&Path) -> Result<Session, String>,
        light: &dyn Fn(&Path) -> Result<Session, String>,
    ) -> Result<Self, String> {
        let (encoder, decoder) = model_files(int8);
        let preprocessor = heavy(&dir.join(PREPROCESSOR))?;
        let encoder = heavy(&dir.join(encoder))?;
        let decoder = light(&dir.join(decoder))?;
        let (vocab, blank) = load_vocab(&dir.join(VOCAB))?;
        let dim = |name: &str| -> Result<(usize, usize), String> {
            let input = decoder
                .inputs()
                .iter()
                .find(|i| i.name() == name)
                .ok_or_else(|| format!("the decoder has no input {name}"))?;
            let shape = input.dtype().tensor_shape().ok_or_else(|| format!("{name} isn't a tensor"))?;
            Ok((shape[0] as usize, shape[2] as usize))
        };
        let state_dims = [dim("input_states_1")?, dim("input_states_2")?];
        Ok(Self { preprocessor, encoder, decoder, vocab, blank, state_dims })
    }

    /// Transcribe 16 kHz mono samples.
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String, String> {
        let wave = Array2::from_shape_vec((1, samples.len()), samples.to_vec()).map_err(err)?.into_dyn();
        let wave_len = Array1::from_vec(vec![samples.len() as i64]).into_dyn();
        let (features, features_len) = {
            let out = self
                .preprocessor
                .run(inputs![
                    "waveforms" => TensorRef::from_array_view(wave.view()).map_err(err)?,
                    "waveforms_lens" => TensorRef::from_array_view(wave_len.view()).map_err(err)?,
                ])
                .map_err(err)?;
            (
                out["features"].try_extract_array::<f32>().map_err(err)?.to_owned(),
                out["features_lens"].try_extract_array::<i64>().map_err(err)?.to_owned(),
            )
        };
        let (encoded, encoded_len) = {
            let out = self
                .encoder
                .run(inputs![
                    "audio_signal" => TensorRef::from_array_view(features.view()).map_err(err)?,
                    "length" => TensorRef::from_array_view(features_len.view()).map_err(err)?,
                ])
                .map_err(err)?;
            // (batch, features, frames) → (batch, frames, features)
            let enc = out["outputs"].try_extract_array::<f32>().map_err(err)?;
            let enc = enc.permuted_axes(IxDyn(&[0, 2, 1])).to_owned();
            let len = out["encoded_lengths"].try_extract_array::<i64>().map_err(err)?;
            (enc, len.iter().next().copied().unwrap_or(0) as usize)
        };
        let frames = encoded.index_axis(Axis(0), 0).to_owned();
        let tokens = self.decode(&frames, encoded_len.min(frames.shape()[0]))?;
        Ok(detokenize(&self.vocab, &tokens))
    }

    /// Greedy TDT decoding over the encoder's frames.
    fn decode(&mut self, frames: &ArrayD<f32>, len: usize) -> Result<Vec<i32>, String> {
        let [(l1, h1), (l2, h2)] = self.state_dims;
        let mut state: State = (Array3::zeros((l1, 1, h1)), Array3::zeros((l2, 1, h2)));
        let mut tokens: Vec<i32> = Vec::new();
        let vocab_size = self.vocab.len();
        let (mut t, mut emitted) = (0usize, 0usize);
        while t < len {
            let frame = frames.index_axis(Axis(0), t).to_owned().insert_axis(Axis(0)).insert_axis(Axis(2));
            let target = Array2::from_shape_vec((1, 1), vec![tokens.last().copied().unwrap_or(self.blank)]).map_err(err)?;
            let target_len = Array1::from_vec(vec![1i32]);
            let out = self
                .decoder
                .run(inputs![
                    "encoder_outputs" => TensorRef::from_array_view(frame.view()).map_err(err)?,
                    "targets" => TensorRef::from_array_view(target.view()).map_err(err)?,
                    "target_length" => TensorRef::from_array_view(target_len.view()).map_err(err)?,
                    "input_states_1" => TensorRef::from_array_view(state.0.view()).map_err(err)?,
                    "input_states_2" => TensorRef::from_array_view(state.1.view()).map_err(err)?,
                ])
                .map_err(err)?;
            let (_, logits) = out["outputs"].try_extract_tensor::<f32>().map_err(err)?;
            let (token, step) = pick(logits, vocab_size);
            let token = token as i32;
            if token != self.blank {
                let s1 = out["output_states_1"].try_extract_array::<f32>().map_err(err)?;
                let s2 = out["output_states_2"].try_extract_array::<f32>().map_err(err)?;
                state = (
                    s1.to_owned().into_dimensionality().map_err(err)?,
                    s2.to_owned().into_dimensionality().map_err(err)?,
                );
                tokens.push(token);
                emitted += 1;
            }
            if step > 0 {
                t += step;
                emitted = 0;
            } else if token == self.blank || emitted == MAX_TOKENS_PER_STEP {
                t += 1;
                emitted = 0;
            }
        }
        Ok(tokens)
    }
}

/// The token (argmax over the vocabulary) and the frames to skip (argmax over the
/// duration logits after it; 0 when the model has no duration head).
pub fn pick(logits: &[f32], vocab_size: usize) -> (usize, usize) {
    let argmax = |xs: &[f32]| {
        xs.iter()
            .enumerate()
            .fold((0, f32::NEG_INFINITY), |best, (i, &x)| if x > best.1 { (i, x) } else { best })
            .0
    };
    let split = vocab_size.min(logits.len());
    let durations = &logits[split..];
    (argmax(&logits[..split]), if durations.is_empty() { 0 } else { argmax(durations) })
}

/// `token id` per line; `▁` is a word start. Returns the vocabulary and `<blk>`'s id.
pub fn load_vocab(path: &Path) -> Result<(Vec<String>, i32), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    parse_vocab(&text)
}

pub fn parse_vocab(text: &str) -> Result<(Vec<String>, i32), String> {
    let mut pairs = Vec::new();
    let mut blank = None;
    for line in text.lines() {
        let Some((token, id)) = line.trim_end().rsplit_once(' ') else { continue };
        let Ok(id) = id.parse::<usize>() else { continue };
        if token == "<blk>" {
            blank = Some(id as i32);
        }
        pairs.push((token.replace('\u{2581}', " "), id));
    }
    let size = pairs.iter().map(|(_, id)| id + 1).max().unwrap_or(0);
    let mut vocab = vec![String::new(); size];
    for (token, id) in pairs {
        vocab[id] = token;
    }
    Ok((vocab, blank.ok_or("the vocabulary has no <blk> token")?))
}

/// Join the tokens; word starts become single spaces, trimmed at the ends.
pub fn detokenize(vocab: &[String], tokens: &[i32]) -> String {
    let joined: String = tokens.iter().filter_map(|&t| vocab.get(t as usize)).map(String::as_str).collect();
    joined.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_token_and_the_duration() {
        // vocab of 3 (blank = 2), durations [0, 1, 2, 3, 4]
        assert_eq!(pick(&[0.1, 0.9, 0.0, 0.0, 0.0, 5.0, 0.0, 0.0], 3), (1, 2));
        assert_eq!(pick(&[0.1, 0.2, 0.9], 3), (2, 0));
    }

    #[test]
    fn reads_the_vocabulary_and_joins_words() {
        let (vocab, blank) = parse_vocab("<unk> 0\n\u{2581}hel 1\nlo 2\n\u{2581}world 3\n<blk> 4\n").unwrap();
        assert_eq!(blank, 4);
        assert_eq!(detokenize(&vocab, &[1, 2, 3]), "hello world");
        assert!(parse_vocab("a 0\n").is_err());
    }
}
