// The phone's mic (step R2): record a clip for Duck, as 16 kHz WAV.
//
// getUserMedia → an AudioWorklet that hands each block of samples back → kept
// here at the device's rate → brought down to 16 kHz and written as a WAV when the
// recording stops. A browser gives the mic to a secure page only (the Funnel
// address), so `micAvailable` says whether to offer it.

import { concat, downsample, encodeWav, levelOf, TARGET_RATE } from "./wav";

/** The desktop takes at most a minute; stop a little before it. */
export const MAX_SECONDS = 59;

/** The worklet: post each input block back to the page. Loaded from a blob URL,
 *  since the page is one file. */
const TAP = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("wb-tap", Tap);
`;

export function micAvailable(): boolean {
  return isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";
}

export interface Recording {
  /** The loudness now (0..1), for the duck. */
  level(): number;
  /** Seconds recorded so far. */
  seconds(): number;
  /** Stop and hand back the clip as WAV, or null when nothing was recorded. */
  stop(): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Stop and drop it. */
  cancel(): void;
}

/** Start recording. Throws when the mic is refused or missing. `onLimit` is called
 *  once the clip reaches `MAX_SECONDS`; the caller then stops it. */
export async function record(onLimit: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const release = () => {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };
  try {
    const url = URL.createObjectURL(new Blob([TAP], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = ctx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(ctx, "wb-tap");
    const chunks: Float32Array[] = [];
    let count = 0;
    let level = 0;
    let limited = false;
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      chunks.push(e.data);
      count += e.data.length;
      level = levelOf(e.data);
      if (!limited && count >= MAX_SECONDS * ctx.sampleRate) {
        limited = true;
        onLimit();
      }
    };
    // The worklet only runs while connected to the output; it writes nothing to it.
    source.connect(tap).connect(ctx.destination);
    await ctx.resume();
    return {
      level: () => level,
      seconds: () => count / ctx.sampleRate,
      async stop() {
        const rate = ctx.sampleRate;
        tap.port.onmessage = null;
        release();
        const samples = downsample(concat(chunks), rate, TARGET_RATE);
        return samples.length > TARGET_RATE / 4 ? encodeWav(samples.subarray(0, MAX_SECONDS * TARGET_RATE)) : null;
      },
      cancel() {
        tap.port.onmessage = null;
        release();
      },
    };
  } catch (e) {
    release();
    throw e;
  }
}
