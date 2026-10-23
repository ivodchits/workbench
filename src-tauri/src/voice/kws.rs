//! The keyword spotter behind the wake word (step V6): sherpa-onnx's KWS ported to
//! our ONNX Runtime, so nothing else is linked in. The model is sherpa-onnx's
//! `kws-zipformer-zh-en-3M-2025-12-20`, a 3M streaming zipformer transducer whose
//! tokens are phones (ARPAbet for English), so a phrase is given as its sounds and
//! «Эй, Дак» is spelled the way it's said ([`KEYWORDS`]).
//!
//! - **Features** ([`Fbank`]): Kaldi's 80-bin log-mel filterbank as
//!   kaldi-native-fbank computes it for sherpa (25 ms Povey windows every 10 ms,
//!   no edge snipping, samples in −1..1).
//! - **Encoder**: 45 frames in, a hop of 32 (0.32 s); its cached states are every
//!   input but `x`, each fed back from the output named `new_<input>`, so nothing
//!   about the layer stack is hard-coded.
//! - **Search**: sherpa's keyword beam search (`transducer-keyword-decoder.cc`):
//!   four paths, boosted along a keyword graph ([`Graph`], Aho-Corasick), a path off
//!   every keyword forgetting its tokens. A keyword counts when the best path has
//!   just finished it, its tokens' mean probability reaches the threshold, and two
//!   blank frames followed. 1.5 s of blanks resets the stream, as sherpa does.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use ort::session::{Session, SessionInputValue};
use ort::value::{DynValue, Tensor, TensorElementType, ValueType};
use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

pub const DIR: &str = "kws-zipformer-zh-en-3M-2025-12-20";
pub const ENCODER: &str = "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx";
pub const DECODER: &str = "decoder-epoch-13-avg-2-chunk-16-left-64.onnx";
pub const JOINER: &str = "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx";
pub const TOKENS: &str = "tokens.txt";

/// "Hey Duck" and «Эй, Дак», as phones. The Russian has no "h" and an open "a";
/// the two mixes cover an English "hey" with a Russian "дак" and the reverse.
pub const KEYWORDS: &[&str] = &["HH EY1 D AH1 K", "EY1 D AH1 K", "EY1 D AA1 K", "HH EY1 D AA1 K"];

const RATE: usize = 16_000;
const SHIFT: usize = 160;
const LENGTH: usize = 400;
const PADDED: usize = 512;
const BINS: usize = 80;
/// Paths kept (sherpa's `max_active_paths`).
const PATHS: usize = 4;
/// Blank frames needed after a keyword (sherpa's `num_trailing_blanks`: more than 1).
const TRAILING: usize = 1;
/// Blanks this long reset the stream (sherpa: 1.5 s of 40 ms frames).
const RESET_FRAMES: usize = 38;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ── features ────────────────────────────────────────────────────────────────

/// Kaldi's filterbank, a stream at a time: frame `i` covers samples from
/// `160 i − 120` (centred, `snip_edges = false`), the start mirrored.
pub struct Fbank {
    window: Vec<f32>,
    /// Per mel bin: its first FFT bin and weights.
    mel: Vec<(usize, Vec<f32>)>,
    fft: Arc<dyn Fft<f32>>,
    /// Samples from absolute index `offset` on.
    samples: Vec<f32>,
    offset: usize,
    head: Vec<f32>,
    next: usize,
    buf: Vec<Complex32>,
}

fn mel_scale(f: f32) -> f32 {
    1127.0 * (1.0 + f / 700.0).ln()
}

impl Default for Fbank {
    fn default() -> Self {
        Self::new()
    }
}

impl Fbank {
    pub fn new() -> Self {
        let window = (0..LENGTH)
            .map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (LENGTH - 1) as f64).cos()).powf(0.85) as f32)
            .collect();
        let (low, high) = (mel_scale(20.0), mel_scale(RATE as f32 / 2.0 - 400.0));
        let delta = (high - low) / (BINS + 1) as f32;
        let bin_hz = RATE as f32 / PADDED as f32;
        let mel = (0..BINS)
            .map(|b| {
                let (left, center, right) = (low + b as f32 * delta, low + (b + 1) as f32 * delta, low + (b + 2) as f32 * delta);
                let mut first = None;
                let mut w = Vec::new();
                for i in 0..PADDED / 2 {
                    let m = mel_scale(bin_hz * i as f32);
                    if m > left && m < right {
                        first.get_or_insert(i);
                        w.push(if m <= center { (m - left) / (center - left) } else { (right - m) / (right - center) });
                    } else if first.is_some() {
                        break;
                    }
                }
                (first.unwrap_or(0), w)
            })
            .collect();
        let fft = FftPlanner::new().plan_fft_forward(PADDED);
        Self { window, mel, fft, samples: Vec::new(), offset: 0, head: Vec::new(), next: 0, buf: vec![Complex32::default(); PADDED] }
    }

    /// Take samples; append the frames they complete to `out`.
    pub fn accept(&mut self, x: &[f32], out: &mut Vec<[f32; BINS]>) {
        self.samples.extend_from_slice(x);
        if self.head.len() < LENGTH {
            let more = (LENGTH - self.head.len()).min(x.len());
            self.head.extend_from_slice(&x[..more]);
        }
        let have = self.offset + self.samples.len();
        loop {
            // 160 i + 80 − 200.
            let start = (self.next * SHIFT) as i64 - 120;
            if start + LENGTH as i64 > have as i64 {
                break;
            }
            let mut w = [0f32; LENGTH];
            for (j, v) in w.iter_mut().enumerate() {
                let s = start + j as i64;
                *v = if s < 0 { self.head[(-s - 1) as usize] } else { self.samples[s as usize - self.offset] };
            }
            out.push(self.frame(&mut w));
            self.next += 1;
        }
        // Keep what the next frame reaches.
        let keep = ((self.next * SHIFT) as i64 - 120).max(0) as usize;
        if keep > self.offset {
            self.samples.drain(..(keep - self.offset).min(self.samples.len()));
            self.offset = keep;
        }
    }

    fn frame(&mut self, w: &mut [f32; LENGTH]) -> [f32; BINS] {
        let mean = w.iter().sum::<f32>() / LENGTH as f32;
        w.iter_mut().for_each(|v| *v -= mean);
        for i in (1..LENGTH).rev() {
            w[i] -= 0.97 * w[i - 1];
        }
        w[0] -= 0.97 * w[0];
        for (b, (v, h)) in self.buf.iter_mut().zip(w.iter().zip(&self.window)) {
            *b = Complex32::new(v * h, 0.0);
        }
        self.buf[LENGTH..].iter_mut().for_each(|b| *b = Complex32::default());
        self.fft.process(&mut self.buf);
        let mut out = [0f32; BINS];
        for (o, (first, ws)) in out.iter_mut().zip(&self.mel) {
            let e: f32 = ws.iter().enumerate().map(|(k, wt)| wt * self.buf[first + k].norm_sqr()).sum();
            *o = e.max(f32::EPSILON).ln();
        }
        out
    }
}

// ── the keyword graph ───────────────────────────────────────────────────────

struct Node {
    token: i32,
    token_score: f32,
    node_score: f32,
    output_score: f32,
    level: usize,
    ac_threshold: f32,
    is_end: bool,
    phrase: usize,
    next: HashMap<i32, usize>,
    fail: usize,
    output: Option<usize>,
}

/// sherpa's `ContextGraph`: the keywords' tokens as a trie with fail links, each
/// token on a keyword's path boosted by its score.
pub struct Graph {
    nodes: Vec<Node>,
}

const ROOT: usize = 0;

impl Graph {
    /// `keywords`: each one's tokens, its boost per token, and its threshold.
    pub fn new(keywords: &[(Vec<i32>, f32, f32)]) -> Self {
        let node = |token, token_score, node_score, output_score, level, ac_threshold, is_end, phrase| Node {
            token,
            token_score,
            node_score,
            output_score,
            level,
            ac_threshold,
            is_end,
            phrase,
            next: HashMap::new(),
            fail: ROOT,
            output: None,
        };
        let mut nodes = vec![node(-1, 0.0, 0.0, 0.0, 0, 0.0, false, usize::MAX)];
        for (k, (tokens, score, threshold)) in keywords.iter().enumerate() {
            let mut at = ROOT;
            for (j, &t) in tokens.iter().enumerate() {
                let last = j + 1 == tokens.len();
                let base = nodes[at].node_score;
                at = match nodes[at].next.get(&t).copied() {
                    None => {
                        let id = nodes.len();
                        let s = base + score;
                        nodes.push(node(
                            t,
                            *score,
                            s,
                            if last { s } else { 0.0 },
                            j + 1,
                            if last { *threshold } else { 0.0 },
                            last,
                            if last { k } else { usize::MAX },
                        ));
                        nodes[at].next.insert(t, id);
                        id
                    }
                    Some(id) => {
                        let n = &mut nodes[id];
                        n.token_score = n.token_score.max(*score);
                        n.node_score = base + n.token_score;
                        n.is_end = last || n.is_end;
                        n.output_score = if n.is_end { n.node_score } else { 0.0 };
                        if last {
                            n.phrase = k;
                            n.ac_threshold = *threshold;
                        }
                        id
                    }
                };
            }
        }
        let mut g = Self { nodes };
        g.fill_fail_output();
        g
    }

    fn fill_fail_output(&mut self) {
        let mut queue: std::collections::VecDeque<usize> = self.nodes[ROOT].next.values().copied().collect();
        for &c in &queue {
            self.nodes[c].fail = ROOT;
        }
        while let Some(cur) = queue.pop_front() {
            let children: Vec<(i32, usize)> = self.nodes[cur].next.iter().map(|(&t, &c)| (t, c)).collect();
            for (t, child) in children {
                let mut fail = self.nodes[cur].fail;
                if let Some(&n) = self.nodes[fail].next.get(&t) {
                    fail = n;
                } else {
                    fail = self.nodes[fail].fail;
                    while !self.nodes[fail].next.contains_key(&t) {
                        fail = self.nodes[fail].fail;
                        if self.nodes[fail].token == -1 {
                            break;
                        }
                    }
                    if let Some(&n) = self.nodes[fail].next.get(&t) {
                        fail = n;
                    }
                }
                self.nodes[child].fail = fail;
                // The nearest keyword end along the fail links.
                let mut o = fail;
                let output = loop {
                    if self.nodes[o].is_end {
                        break Some(o);
                    }
                    o = self.nodes[o].fail;
                    if self.nodes[o].token == -1 {
                        break None;
                    }
                };
                self.nodes[child].output = output;
                self.nodes[child].output_score += output.map_or(0.0, |o| self.nodes[o].output_score);
                queue.push_back(child);
            }
        }
    }

    /// One token from `state` (strict): the score to add, and where it lands.
    fn step(&self, state: usize, token: i32) -> (f32, usize) {
        let (node, score) = match self.nodes[state].next.get(&token) {
            Some(&n) => (n, self.nodes[n].token_score),
            None => {
                let mut n = self.nodes[state].fail;
                while !self.nodes[n].next.contains_key(&token) {
                    n = self.nodes[n].fail;
                    if self.nodes[n].token == -1 {
                        break;
                    }
                }
                if let Some(&m) = self.nodes[n].next.get(&token) {
                    n = m;
                }
                (n, self.nodes[n].node_score - self.nodes[state].node_score)
            }
        };
        (score + self.nodes[node].output_score, node)
    }

    /// The keyword `state` has just finished, if any.
    fn matched(&self, state: usize) -> Option<usize> {
        if self.nodes[state].is_end {
            Some(state)
        } else {
            self.nodes[state].output
        }
    }
}

// ── the model and the search ────────────────────────────────────────────────

#[derive(Clone)]
struct Hyp {
    ys: Vec<i64>,
    probs: Vec<f32>,
    /// The encoder frame each token was heard at.
    times: Vec<usize>,
    log_prob: f64,
    state: usize,
    trailing: usize,
}

/// A keyword heard: which (an index into the keywords given), its tokens' mean
/// probability, and the stream's seconds it started and ended at.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub keyword: usize,
    pub score: f32,
    pub start: f32,
    pub at: f32,
}

enum Init {
    F32(Vec<i64>),
    I64(Vec<i64>),
}

/// The loaded spotter and one stream through it.
pub struct Spotter {
    encoder: Session,
    decoder: Session,
    joiner: Session,
    graph: Graph,
    /// The encoder's state inputs, and their shapes for a fresh stream.
    inits: Vec<(String, Init)>,
    states: Vec<DynValue>,
    chunk: usize,
    hop: usize,
    blank_hyps: Vec<Hyp>,
    // The stream.
    fbank: Fbank,
    frames: Vec<[f32; BINS]>,
    /// Feature frames dropped from the front of `frames`, and processed.
    dropped: usize,
    processed: usize,
    hyps: Vec<Hyp>,
    /// Encoder frames decoded so far, and the feature frames each stands for.
    out_frames: usize,
    per_out: f32,
    decoded: HashMap<[i64; 2], Vec<f32>>,
}

/// `tokens.txt`: a token and its id per line.
pub fn read_tokens(text: &str) -> HashMap<String, i32> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.rsplitn(2, ' ');
            let id = it.next()?.trim().parse().ok()?;
            Some((it.next()?.to_string(), id))
        })
        .collect()
}

/// A keyword's phones as token ids.
pub fn encode(phones: &str, tokens: &HashMap<String, i32>) -> Result<Vec<i32>, String> {
    phones.split_whitespace().map(|p| tokens.get(p).copied().ok_or_else(|| format!("no token {p}"))).collect()
}

/// How eager the spotter is, 0..1: its boost per token and threshold. 0.5 is
/// sherpa's defaults (1.0 and 0.25).
pub fn tuning(sensitivity: f32) -> (f32, f32) {
    let s = sensitivity.clamp(0.0, 1.0);
    (0.5 + s, 0.35 - 0.2 * s)
}

impl Spotter {
    /// Load from `dir` (the model's folder), listening for `keywords` (phones).
    pub fn load(
        dir: &Path,
        keywords: &[&str],
        sensitivity: f32,
        session: &dyn Fn(&Path) -> Result<Session, String>,
    ) -> Result<Self, String> {
        let encoder = session(&dir.join(ENCODER))?;
        let decoder = session(&dir.join(DECODER))?;
        let joiner = session(&dir.join(JOINER))?;
        let tokens = read_tokens(&std::fs::read_to_string(dir.join(TOKENS)).map_err(err)?);
        let (boost, threshold) = tuning(sensitivity);
        let kws = keywords.iter().map(|k| Ok((encode(k, &tokens)?, boost, threshold))).collect::<Result<Vec<_>, String>>()?;
        let meta = encoder.metadata().map_err(err)?;
        let num = |k: &str| meta.custom(k).and_then(|v| v.trim().parse::<usize>().ok()).ok_or_else(|| format!("the encoder has no {k}"));
        let (chunk, hop) = (num("T")?, num("decode_chunk_len")?);
        drop(meta);
        let mut inits = Vec::new();
        for i in encoder.inputs().iter().filter(|i| i.name() != "x") {
            let ValueType::Tensor { ty, shape, .. } = i.dtype() else { return Err(format!("{} isn't a tensor", i.name())) };
            let dims: Vec<i64> = shape.iter().map(|&d| if d < 0 { 1 } else { d }).collect();
            inits.push((
                i.name().to_string(),
                match ty {
                    TensorElementType::Int64 => Init::I64(dims),
                    _ => Init::F32(dims),
                },
            ));
        }
        let blank_hyps = vec![Hyp { ys: vec![-1, 0], probs: Vec::new(), times: Vec::new(), log_prob: 0.0, state: ROOT, trailing: 0 }];
        let mut s = Self {
            encoder,
            decoder,
            joiner,
            graph: Graph::new(&kws),
            inits,
            states: Vec::new(),
            chunk,
            hop,
            hyps: blank_hyps.clone(),
            blank_hyps,
            fbank: Fbank::new(),
            frames: Vec::new(),
            dropped: 0,
            processed: 0,
            out_frames: 0,
            per_out: 4.0,
            decoded: HashMap::new(),
        };
        s.reset()?;
        Ok(s)
    }

    /// A fresh stream: no audio, no states, no paths.
    pub fn reset(&mut self) -> Result<(), String> {
        self.fbank = Fbank::new();
        self.frames.clear();
        self.dropped = 0;
        self.processed = 0;
        self.out_frames = 0;
        self.restart()
    }

    /// The encoder's states and the paths start over; the audio stays.
    fn restart(&mut self) -> Result<(), String> {
        self.states = self
            .inits
            .iter()
            .map(|(_, init)| match init {
                Init::F32(d) => Tensor::from_array((d.clone(), vec![0f32; d.iter().product::<i64>() as usize])).map(|t| t.into_dyn()),
                Init::I64(d) => Tensor::from_array((d.clone(), vec![0i64; d.iter().product::<i64>() as usize])).map(|t| t.into_dyn()),
            })
            .collect::<Result<_, _>>()
            .map_err(err)?;
        self.hyps = self.blank_hyps.clone();
        self.decoded.clear();
        Ok(())
    }

    /// Feed 16 kHz samples (−1..1); the first keyword they complete.
    pub fn accept(&mut self, x: &[f32]) -> Result<Option<Hit>, String> {
        self.fbank.accept(x, &mut self.frames);
        let mut hit = None;
        while self.processed + self.chunk < self.dropped + self.frames.len() {
            let best_trailing = self.best().trailing;
            if best_trailing >= RESET_FRAMES {
                self.restart()?;
            }
            let from = self.processed - self.dropped;
            let feats: Vec<f32> = self.frames[from..from + self.chunk].iter().flatten().copied().collect();
            self.processed += self.hop;
            if let Some(h) = self.chunk_step(feats)? {
                hit.get_or_insert(h);
            }
            let used = self.processed - self.dropped;
            self.frames.drain(..used);
            self.dropped = self.processed;
        }
        Ok(hit)
    }

    fn best(&self) -> &Hyp {
        self.hyps.iter().max_by(|a, b| a.log_prob.total_cmp(&b.log_prob)).unwrap_or(&self.blank_hyps[0])
    }

    fn chunk_step(&mut self, feats: Vec<f32>) -> Result<Option<Hit>, String> {
        let x = Tensor::from_array(([1usize, self.chunk, BINS], feats)).map_err(err)?;
        let mut inputs: Vec<(String, SessionInputValue)> = vec![("x".into(), x.into())];
        for ((name, _), v) in self.inits.iter().zip(std::mem::take(&mut self.states)) {
            inputs.push((name.clone(), v.into()));
        }
        let mut out = self.encoder.run(inputs).map_err(err)?;
        let mut states = Vec::with_capacity(self.inits.len());
        for (name, _) in &self.inits {
            states.push(out.remove(format!("new_{name}")).ok_or_else(|| format!("the encoder gave no new_{name}"))?);
        }
        let enc = out.remove("encoder_out").ok_or("the encoder gave no encoder_out")?;
        drop(out);
        self.states = states;
        let (shape, data) = enc.try_extract_tensor::<f32>().map_err(err)?;
        let (t_len, dim) = (shape[1] as usize, shape[2] as usize);
        self.per_out = self.hop as f32 / t_len.max(1) as f32;
        let data = data.to_vec();
        let mut hit = None;
        for t in 0..t_len {
            if let Some(h) = self.frame_step(&data[t * dim..(t + 1) * dim])? {
                hit.get_or_insert(h);
            }
            self.out_frames += 1;
        }
        Ok(hit)
    }

    fn decoder_out(&mut self, ctx: [i64; 2]) -> Result<Vec<f32>, String> {
        if let Some(d) = self.decoded.get(&ctx) {
            return Ok(d.clone());
        }
        let y = Tensor::from_array(([1usize, 2], ctx.to_vec())).map_err(err)?;
        let out = self.decoder.run(vec![("y".to_string(), SessionInputValue::from(y))]).map_err(err)?;
        let (_, d) = out["decoder_out"].try_extract_tensor::<f32>().map_err(err)?;
        let d = d.to_vec();
        if self.decoded.len() > 256 {
            self.decoded.clear();
        }
        self.decoded.insert(ctx, d.clone());
        Ok(d)
    }

    fn frame_step(&mut self, enc: &[f32]) -> Result<Option<Hit>, String> {
        let prev = std::mem::take(&mut self.hyps);
        let n = prev.len();
        let dim = enc.len();
        let mut dec = Vec::with_capacity(n * dim);
        for h in &prev {
            let l = h.ys.len();
            dec.extend(self.decoder_out([h.ys[l - 2], h.ys[l - 1]])?);
        }
        let encs: Vec<f32> = (0..n).flat_map(|_| enc.iter().copied()).collect();
        let out = self
            .joiner
            .run(vec![
                ("encoder_out".to_string(), SessionInputValue::from(Tensor::from_array(([n, dim], encs)).map_err(err)?)),
                ("decoder_out".to_string(), SessionInputValue::from(Tensor::from_array(([n, dim], dec)).map_err(err)?)),
            ])
            .map_err(err)?;
        let (shape, logits) = out["logit"].try_extract_tensor::<f32>().map_err(err)?;
        let vocab = shape[1] as usize;
        let mut logprobs = logits.to_vec();
        drop(out);
        for row in logprobs.chunks_mut(vocab) {
            let max = row.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            let sum: f32 = row.iter().map(|v| (v - max).exp()).sum();
            let lse = max + sum.ln();
            row.iter_mut().for_each(|v| *v -= lse);
        }
        // The best `PATHS` continuations over every path.
        let mut scored: Vec<(f64, usize)> =
            logprobs.iter().enumerate().map(|(k, &lp)| (lp as f64 + prev[k / vocab].log_prob, k)).collect();
        let top = PATHS.min(scored.len());
        scored.select_nth_unstable_by(top - 1, |a, b| b.0.total_cmp(&a.0));
        scored.truncate(top);
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));

        let mut next: Vec<Hyp> = Vec::with_capacity(top);
        for (total, k) in scored {
            let (hi, token) = (k / vocab, (k % vocab) as i64);
            let mut h = prev[hi].clone();
            let mut context = 0f32;
            // Blank is 0, and <unk> (2) counts as blank.
            if token != 0 && token != 2 {
                h.ys.push(token);
                h.probs.push(logprobs[k].exp());
                h.times.push(self.out_frames);
                h.trailing = 0;
                let (score, state) = self.graph.step(h.state, token as i32);
                context = score;
                h.state = state;
                if self.graph.nodes[state].token == -1 {
                    // Off every keyword: forget the tokens.
                    h.ys = vec![-1, 0];
                    h.probs.clear();
                    h.times.clear();
                }
            } else {
                h.trailing += 1;
            }
            h.log_prob = total + context as f64;
            match next.iter_mut().find(|o| o.ys == h.ys) {
                Some(o) => {
                    let (a, b) = (o.log_prob, h.log_prob);
                    let m = a.max(b);
                    o.log_prob = m + ((a - m).exp() + (b - m).exp()).ln();
                }
                None => next.push(h),
            }
        }
        self.hyps = next;
        let best = self.best().clone();
        let Some(m) = self.graph.matched(best.state) else { return Ok(None) };
        let node = &self.graph.nodes[m];
        let level = node.level.min(best.probs.len()).max(1);
        let score = best.probs.iter().take(level).sum::<f32>() / level as f32;
        if best.trailing > TRAILING && score >= node.ac_threshold {
            self.hyps = self.blank_hyps.clone();
            let secs = |frame: usize| frame as f32 * self.per_out * SHIFT as f32 / RATE as f32;
            let first = best.times.len().saturating_sub(node.level);
            let start = best.times.get(first).map_or(0.0, |&f| secs(f));
            return Ok(Some(Hit { keyword: node.phrase, score, start, at: secs(self.out_frames + 1) }));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_graph_boosts_a_keyword_and_takes_it_back_off_its_path() {
        // Two keywords sharing a prefix: 1 2 3, and 1 2 4.
        let g = Graph::new(&[(vec![1, 2, 3], 1.0, 0.25), (vec![1, 2, 4], 1.5, 0.3)]);
        let (s1, a) = g.step(ROOT, 1);
        let (s2, b) = g.step(a, 2);
        assert_eq!((s1, s2), (1.5, 1.5));
        let (s3, end) = g.step(b, 4);
        // The last token's boost and the keyword's whole score on reaching its end.
        assert_eq!(s3, 1.5 + 4.5);
        assert_eq!(g.matched(end).map(|n| g.nodes[n].phrase), Some(1));
        assert_eq!(g.nodes[end].ac_threshold, 0.3);
        // Off the path: the boost so far is taken back.
        let (back, at) = g.step(b, 7);
        assert_eq!((back, at), (-3.0, ROOT));
        assert_eq!(g.matched(b), None);
    }

    #[test]
    fn a_keyword_inside_another_is_found_by_its_fail_link() {
        // "2 3" is inside "1 2 3 4": reaching "1 2 3" matches it on the way.
        let g = Graph::new(&[(vec![1, 2, 3, 4], 1.0, 0.2), (vec![2, 3], 1.0, 0.2)]);
        let (_, a) = g.step(ROOT, 1);
        let (_, b) = g.step(a, 2);
        let (_, c) = g.step(b, 3);
        assert_eq!(g.matched(c).map(|n| g.nodes[n].phrase), Some(1));
    }

    #[test]
    fn reads_tokens_and_spells_keywords() {
        let t = read_tokens("<blk> 0\nHH 36\nEY1 32\nD 23\nAH1 10\nK 44\nǚ 259\n");
        assert_eq!(encode("HH EY1 D AH1 K", &t).unwrap(), vec![36, 32, 23, 10, 44]);
        assert_eq!(t["ǚ"], 259);
        assert!(encode("HH ZZ", &t).is_err());
        assert_eq!(tuning(0.5), (1.0, 0.25));
        assert!(tuning(1.0).1 < tuning(0.0).1);
    }

    /// The port against sherpa-onnx on the same clips (`cargo test --release
    /// kws_matches_sherpa -- --ignored --nocapture`): `WB_MODELS` has the runtime,
    /// `WB_KWS_DIR` the model, `WB_KWS_CLIPS` 16 kHz clips with `meta.json`, and
    /// `WB_KWS_REF` sherpa's hits per clip (JSON: file → seconds).
    #[test]
    #[ignore]
    fn kws_matches_sherpa() {
        let var = |k: &str| std::path::PathBuf::from(std::env::var(k).unwrap_or_else(|_| panic!("{k}")));
        super::super::engine::init_runtime(&var("WB_MODELS")).unwrap();
        let mut s = Spotter::load(&var("WB_KWS_DIR"), KEYWORDS, 0.5, &super::super::engine::tiny_session).unwrap();
        let clips = var("WB_KWS_CLIPS");
        let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(clips.join("meta.json")).unwrap()).unwrap();
        let reference: serde_json::Value = serde_json::from_slice(&std::fs::read(var("WB_KWS_REF")).unwrap()).unwrap();
        let (mut agree, mut total, mut audio, mut hits) = (0, 0, 0f32, [0usize; 2]);
        let t = std::time::Instant::now();
        for m in meta.as_array().unwrap() {
            let file = m["file"].as_str().unwrap();
            let x = super::super::read_wav(&clips.join(file)).unwrap();
            audio += x.len() as f32 / RATE as f32;
            s.reset().unwrap();
            let mut got = Vec::new();
            for c in x.chunks(1600) {
                if let Some(h) = s.accept(c).unwrap() {
                    got.push(h.at);
                    s.reset().unwrap();
                }
            }
            let want = reference[file].as_array().map_or(0, |a| a.len());
            total += 1;
            if (want > 0) == !got.is_empty() {
                agree += 1;
            } else {
                println!("differs: {file}: sherpa {want}, port {got:?}");
            }
            hits[m["wake"].as_bool().unwrap() as usize] += !got.is_empty() as usize;
        }
        let ms = t.elapsed().as_secs_f32();
        println!("{agree}/{total} agree; wake hits {}, other hits {}; {ms:.1} s for {audio:.0} s ({:.2}% realtime)", hits[1], hits[0], 100.0 * ms / audio);
        assert!(agree as f32 >= 0.97 * total as f32);
    }

    #[test]
    fn the_filterbank_frames_a_stream_as_it_would_whole() {
        let x: Vec<f32> = (0..8000).map(|i| ((i as f32) * 0.05).sin() * 0.3 + ((i * 7919) % 13) as f32 * 0.001).collect();
        let mut whole = Vec::new();
        Fbank::new().accept(&x, &mut whole);
        // Frames whose window ends by the last sample: (8000 − 280) / 160 + 1.
        assert_eq!(whole.len(), 49);
        let mut parts = Vec::new();
        let mut f = Fbank::new();
        for c in x.chunks(333) {
            f.accept(c, &mut parts);
        }
        assert_eq!(parts.len(), whole.len());
        for (a, b) in parts.iter().zip(&whole) {
            for (u, v) in a.iter().zip(b) {
                assert!((u - v).abs() < 1e-4, "{u} vs {v}");
            }
        }
    }
}
