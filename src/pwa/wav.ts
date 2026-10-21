// The phone's dictation as the desktop takes it (step R2): 16 kHz mono 16-bit WAV
// (`POST /api/assistant/audio`). The mic runs at the device's rate (44.1 or
// 48 kHz, usually), so it's brought down here.

export const TARGET_RATE = 16_000;

/** Bring `input` from `from` Hz down to `to` Hz: each output sample is the mean of
 *  the input samples it covers, which also takes off what's above the new
 *  Nyquist well enough for speech. At or below `to`, it's passed through. */
export function downsample(input: Float32Array, from: number, to = TARGET_RATE): Float32Array {
  if (from <= to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    out[i] = b > a ? sum / (b - a) : 0;
  }
  return out;
}

/** `downsample` a block at a time, as the mic streams (conversation mode, step V4):
 *  the same output as downsampling the whole recording at once. */
export class StreamDownsampler {
  private readonly ratio: number;
  /** Input from absolute index `offset` on, not yet used up. */
  private buf = new Float32Array(0);
  private offset = 0;
  private next = 0;

  constructor(
    private readonly from: number,
    private readonly to = TARGET_RATE,
  ) {
    this.ratio = from / to;
  }

  push(input: Float32Array): Float32Array {
    if (this.from <= this.to) return input;
    const joined = new Float32Array(this.buf.length + input.length);
    joined.set(this.buf);
    joined.set(input, this.buf.length);
    const have = this.offset + joined.length;
    const out: number[] = [];
    while (Math.floor((this.next + 1) * this.ratio) <= have) {
      const a = Math.floor(this.next * this.ratio);
      const b = Math.floor((this.next + 1) * this.ratio);
      let sum = 0;
      for (let j = a; j < b; j++) sum += joined[j - this.offset];
      out.push(b > a ? sum / (b - a) : 0);
      this.next++;
    }
    const keep = Math.floor(this.next * this.ratio);
    this.buf = joined.slice(keep - this.offset);
    this.offset = keep;
    return Float32Array.from(out);
  }
}

/** Mono 16-bit PCM WAV of `samples` (-1..1) at `rate`. */
export function encodeWav(samples: Float32Array, rate = TARGET_RATE): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(44 + samples.length * 2));
  const v = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return bytes;
}

/** Join recorded chunks into one buffer. */
export function concat(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Loudness of a chunk (0..1), scaled as the desktop's playback level is. */
export function levelOf(chunk: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return Math.min(1, Math.sqrt(sum / Math.max(1, chunk.length)) * 6);
}
