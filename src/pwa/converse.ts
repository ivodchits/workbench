// Conversation mode on the phone (step V4 part 3): the mic streamed to the desktop,
// which runs the turn pipeline on it (VAD, Smart Turn, Parakeet, the grace window:
// `voice/conversation.rs`) and answers with `conv.*` frames.
//
// - The browser's echo cancellation is on, so you can talk over Duck's voice
//   playing here. On the `shared` echo path (V7) the mic opens in the context
//   Duck's voice plays in (`stream`'s `shared`), which is kept when it stops.
// - Audio goes up as binary frames on Duck's socket: 16 kHz int16 while there's
//   sound (`AUDIO_PCM`), and only a sample count for silence (`AUDIO_GAP`), so a
//   quiet room costs a few bytes a second rather than 32 KB. The desktop fills a
//   gap with zeros, so its clock for pauses keeps running.
// - The silence gate ([`Framer`]) is loose on purpose: the desktop's VAD decides
//   what's speech. It keeps 4 frames before a sound (a soft first consonant) and
//   320 ms after it live, so the quick policy's 0.25 s check runs on real audio.
//   Longer silence is sent a few frames late, in gaps of 4.

import { AUDIO_GAP, AUDIO_PCM } from "../remote/protocol";
import { StreamDownsampler, TARGET_RATE } from "./wav";

/** 32 ms at 16 kHz, the desktop VAD's frame. */
export const FRAME = 512;
const PREROLL = 4;
const HANGOVER = 10;
const GAP_BATCH = 4;
/** Sound is this much over the room's noise (rms), and at least `MIN_RMS`. */
const OVER_NOISE = 2.5;
const MIN_RMS = 0.004;

export type Out = { pcm: Float32Array } | { gap: number };

/** Frames of 16 kHz audio in, what to send out: speech as it is, silence as gaps. */
export class Framer {
  private noise = 0.01;
  private quiet = HANGOVER;
  private held: Float32Array[] = [];
  private gap = 0;

  /** One frame; what to send now, in order. */
  push(frame: Float32Array): Out[] {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    const loud = rms > Math.max(MIN_RMS, this.noise * OVER_NOISE);
    // The noise floor falls fast and rises slowly, so speech doesn't raise it.
    this.noise = rms < this.noise ? 0.7 * this.noise + 0.3 * rms : 0.995 * this.noise + 0.005 * rms;
    this.quiet = loud ? 0 : this.quiet + 1;
    const out: Out[] = [];
    if (this.quiet <= HANGOVER) {
      if (this.gap) out.push({ gap: this.gap });
      this.gap = 0;
      for (const h of this.held) out.push({ pcm: h });
      this.held = [];
      out.push({ pcm: frame });
      return out;
    }
    this.held.push(frame);
    if (this.held.length > PREROLL) {
      this.gap += this.held.shift()!.length;
      if (this.gap >= GAP_BATCH * FRAME) {
        out.push({ gap: this.gap });
        this.gap = 0;
      }
    }
    return out;
  }
}

/** A frame as the desktop takes it. */
export function encode(o: Out): ArrayBuffer {
  if ("gap" in o) {
    const b = new ArrayBuffer(5);
    const v = new DataView(b);
    v.setUint8(0, AUDIO_GAP);
    v.setUint32(1, o.gap, true);
    return b;
  }
  const b = new ArrayBuffer(1 + o.pcm.length * 2);
  const v = new DataView(b);
  v.setUint8(0, AUDIO_PCM);
  for (let i = 0; i < o.pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, o.pcm[i]));
    v.setInt16(1 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return b;
}

const TAP = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("wb-converse", Tap);
`;

export interface Streaming {
  /** The mic's loudness now (0..1), for the duck. */
  level(): number;
  stop(): void;
}

/** The contexts the tap's module is in (it can be added once). */
const tapped = new WeakSet<BaseAudioContext>();

/** Open the mic and stream it through `send` until stopped, in a context of its
 *  own or in `shared` (kept open after). Throws when the mic is refused or
 *  missing. */
export async function stream(send: (frame: ArrayBuffer) => void, shared?: AudioContext): Promise<Streaming> {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = shared ?? new AudioContext();
  let nodes: AudioNode[] = [];
  const release = () => {
    media.getTracks().forEach((t) => t.stop());
    for (const n of nodes) n.disconnect();
    if (!shared) void ctx.close().catch(() => {});
  };
  try {
    if (!tapped.has(ctx)) {
      const url = URL.createObjectURL(new Blob([TAP], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
        tapped.add(ctx);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const source = ctx.createMediaStreamSource(media);
    const tap = new AudioWorkletNode(ctx, "wb-converse");
    nodes = [source, tap];
    const down = new StreamDownsampler(ctx.sampleRate, TARGET_RATE);
    const framer = new Framer();
    let pending = new Float32Array(0);
    let level = 0;
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const x = down.push(e.data);
      const joined = new Float32Array(pending.length + x.length);
      joined.set(pending);
      joined.set(x, pending.length);
      let at = 0;
      for (; at + FRAME <= joined.length; at += FRAME) {
        const frame = joined.slice(at, at + FRAME);
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        level = Math.min(1, Math.sqrt(sum / FRAME) * 6);
        for (const o of framer.push(frame)) send(encode(o));
      }
      pending = joined.slice(at);
    };
    source.connect(tap).connect(ctx.destination);
    await ctx.resume();
    return {
      level: () => level,
      stop() {
        tap.port.onmessage = null;
        release();
      },
    };
  } catch (e) {
    release();
    throw e;
  }
}

/** The soft "heard you" chime, two short notes, as the desktop's. */
export function chime(): void {
  try {
    const ctx = new AudioContext();
    const note = (freq: number, at: number, len: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, ctx.currentTime + at);
      g.gain.linearRampToValueAtTime(0.06, ctx.currentTime + at + 0.008);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + at + len);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + len);
    };
    note(660, 0, 0.07);
    note(880, 0.07, 0.09);
    setTimeout(() => void ctx.close().catch(() => {}), 400);
  } catch {
    // no audio: no chime
  }
}
