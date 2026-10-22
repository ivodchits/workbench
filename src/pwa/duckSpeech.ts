// Duck's spoken replies on the phone (step R2, V2's phone half).
//
// - The desktop's voice (the default): the desktop makes each sentence as audio
//   as the reply streams (`tts` frames, in order). Each is fetched as soon as it's
//   announced and played after the one before, so sentence 1 plays while 2 is
//   fetched. The beak follows the loudness of what's playing.
// - The phone's own voice (`speechSynthesis`): the phone cuts the streaming reply
//   into sentences itself and speaks them. It's also the fallback for a sentence
//   whose audio can't be had (the link dropped, the desktop forgot it).
//
// The order is `speechQueue.ts`'s; this is the browser's side. Playback needs a
// tap first on phones: `unlock()` from a tap handler.
//
// How the audio leaves the page is the phone's echo path (`EchoPath`, V7), for the
// browser's echo cancellation to see it as what's playing: straight out of this
// context (`separate`, as before V7, and `shared`, where conversation mode's mic
// opens in this same context: `audioContext()`), or through an `<audio>` element
// fed from it (`element`).

import type { Lang } from "../assistant/speakable";
import type { EchoPath } from "../remote/protocol";
import { authHeader } from "./net";
import type { Out } from "./speechQueue";

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let playing: AudioBufferSourceNode | null = null;
let endPlaying: (() => void) | null = null;
const samples = new Float32Array(1024);
let path: EchoPath = "separate";
let element: HTMLAudioElement | null = null;
let feed: MediaStreamAudioDestinationNode | null = null;

function context(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = samples.length;
    wire();
  }
  return ctx;
}

/** Where the analyser's output goes, for the path. */
function wire(): void {
  if (!ctx || !analyser) return;
  analyser.disconnect();
  if (path !== "element") {
    analyser.connect(ctx.destination);
    if (element) element.pause();
    return;
  }
  feed ??= ctx.createMediaStreamDestination();
  analyser.connect(feed);
  if (!element) {
    element = new Audio();
    element.srcObject = feed.stream;
  }
  void element.play().catch(() => {});
}

/** How Duck's voice leaves the page (V7). */
export function setEchoPath(p: EchoPath): void {
  if (p === path) return;
  path = p;
  wire();
}

/** The context Duck's voice plays in: the mic opens in it on the `shared` path. */
export function audioContext(): AudioContext {
  return context();
}

/** Allow playback: call from a tap. */
export function unlock(): void {
  try {
    void context().resume().catch(() => {});
    if (element && path === "element") void element.play().catch(() => {});
    // iOS also wants its speech voice woken from a tap.
    if ("speechSynthesis" in window && !speechSynthesis.speaking) speechSynthesis.cancel();
  } catch {
    // no Web Audio: replies come as text
  }
}

/** The loudness of what's playing now (0..1), as the desktop measures it. */
export function playbackLevel(): number {
  if (!analyser || !playing) return 0;
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.min(1, Math.sqrt(sum / samples.length) * 6);
}

/** A sentence the desktop made, fetched and decoded. */
export async function fetchPart(id: string): Promise<AudioBuffer | null> {
  const res = await fetch(`/api/assistant/tts/${encodeURIComponent(id)}`, { headers: authHeader(), cache: "no-store" });
  if (!res.ok) return null;
  return context().decodeAudioData(await res.arrayBuffer());
}

function pickVoice(lang: Lang): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang.toLowerCase().startsWith(lang) && v.localService) ?? voices.find((v) => v.lang.toLowerCase().startsWith(lang));
}

export const browserOut: Out = {
  play(buffer) {
    const c = context();
    return new Promise((resolve) => {
      const src = c.createBufferSource();
      src.buffer = buffer;
      src.connect(analyser!);
      playing = src;
      endPlaying = resolve;
      src.onended = () => {
        if (playing === src) playing = null;
        if (endPlaying === resolve) endPlaying = null;
        resolve();
      };
      src.start();
    });
  },
  say(text, lang) {
    if (!("speechSynthesis" in window)) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang === "ru" ? "ru-RU" : "en-US";
      const voice = pickVoice(lang);
      if (voice) u.voice = voice;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  },
  cut() {
    const src = playing;
    playing = null;
    try {
      src?.stop();
    } catch {
      // already ended
    }
    endPlaying?.();
    endPlaying = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  },
};
