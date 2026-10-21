// Spoken replies on the desktop (step V2): which of Duck's replies are spoken, and
// feeding them to the voice a sentence at a time as they stream.
//
// - "Speak replies" is off, only for a spoken message (the default), or always.
//   A reply is spoken when the message that started its turn qualifies.
// - Each spoken reply is an utterance: its sentences come out of `Sentences` as
//   the deltas arrive, are made speakable (`toSpoken`; a Russian one that still
//   has a digit or a Latin letter gets the Haiku rewrite, or the rule pass when
//   Haiku is slow or unreachable) and queued in order with `ttsSay`. The voice
//   (`src-tauri/src/voice/tts.rs`) plays sentence 1 while sentence 2 is made.
// - A new message, Esc, the stop button and the push-to-talk key stop it.
// - The duck's beak follows `getSpeechLevel()`, the loudness of what's playing,
//   read each frame (too fast for React state).
// - Ctrl+Shift+L in a console speaks the selection through the same voice
//   (`speakText`), when the runtime is set up.

import { useSyncExternalStore } from "react";
import { oneShot } from "../../assistant/client";
import { langOf, needsRewrite, russianFallback, Sentences, toSpoken, type Lang } from "../../assistant/speakable";
import type { StoredMessage } from "../../ipc/assistant";
import { getPref, setPref, type Prefs } from "../../ipc/prefs";
import { onTtsLevel, onTtsState, ttsConfigure, ttsEnd, ttsSay, ttsStatus, ttsStop, ttsWarm } from "../../ipc/tts";

export type SpeechPrefs = Prefs["speech"];

export const DEFAULT_SPEECH: SpeechPrefs = {
  speak: "voice",
  engine: "local",
  chirpFallback: false,
  voiceEn: "af_heart",
  voiceRu: "kseniya",
  rate: 1,
};

/** How long a Russian sentence waits for Haiku before the rule pass says it. */
const REWRITE_TIMEOUT_MS = 4000;

export interface SpeechState {
  prefs: SpeechPrefs;
  /** The voice is set up (models downloaded, runtime installed), or Chirp is chosen. */
  ready: boolean;
  /** Audio is playing for this utterance. */
  speaking: number | null;
  error: string | null;
}

let state: SpeechState = { prefs: DEFAULT_SPEECH, ready: false, speaking: null, error: null };
const listeners = new Set<() => void>();
let level = 0;

function set(patch: Partial<SpeechState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const getSpeechState = (): SpeechState => state;
export const useSpeechState = (): SpeechState => useSyncExternalStore(subscribe, getSpeechState);
/** The loudness of what's playing now, 0..1. */
export const getSpeechLevel = (): number => (state.speaking === null ? 0 : level);

function configure(prefs: SpeechPrefs): void {
  void ttsConfigure({ ...prefs, warmOnTalk: prefs.speak !== "off" }).catch((e: unknown) =>
    console.warn("speech: configure failed", e),
  );
}

export function setSpeechPrefs(patch: Partial<SpeechPrefs>): void {
  const prefs = { ...state.prefs, ...patch };
  set({ prefs });
  void setPref("speech", prefs);
  configure(prefs);
  void refreshReady();
}

/** Re-read whether the voice can speak (after a download, or a change of engine). */
export async function refreshReady(): Promise<boolean> {
  const s = await ttsStatus().catch(() => null);
  const ready = state.prefs.engine === "chirp" ? !!s?.chirpKey : !!s && s.installed && s.missingBytes === 0;
  set({ ready });
  return ready;
}

// ── utterances ──

interface Reply {
  /** The thread it answers in (or "selection"). */
  key: string;
  utterance: number;
  sentences: Sentences;
  /** Sentences are prepared in order: each waits for the one before. */
  chain: Promise<void>;
}

let nextUtterance = Date.now();
/** The reply being spoken, per thread (one at a time in practice). */
const replies = new Map<string, Reply>();

/** A Russian sentence Silero can say whole. */
async function speakableRussian(s: string): Promise<string> {
  if (!needsRewrite(s)) return s;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REWRITE_TIMEOUT_MS);
  try {
    const out = (await oneShot("speakable_ru", s, { signal: ctl.signal })).trim();
    return out && !needsRewrite(out) ? out : russianFallback(out || s);
  } catch {
    return russianFallback(s);
  } finally {
    clearTimeout(timer);
  }
}

async function prepare(sentence: string): Promise<{ text: string; lang: Lang } | null> {
  const spoken = toSpoken(sentence);
  if (!/[\p{L}\p{N}]/u.test(spoken)) return null;
  const lang = langOf(spoken);
  return { text: lang === "ru" ? await speakableRussian(spoken) : spoken, lang };
}

function say(r: Reply, sentence: string): void {
  const ready = prepare(sentence);
  r.chain = r.chain.then(async () => {
    const s = await ready;
    if (s && replies.get(r.key) === r) await ttsSay(r.utterance, s.text, s.lang).catch(() => {});
  });
}

function begin(key: string): Reply {
  stopSpeaking();
  const r: Reply = { key, utterance: nextUtterance++, sentences: new Sentences(), chain: Promise.resolve() };
  replies.set(key, r);
  set({ error: null });
  return r;
}

function finish(key: string): void {
  const r = replies.get(key);
  if (!r) return;
  for (const s of r.sentences.end()) say(r, s);
  void r.chain.then(() => {
    if (replies.get(key) === r) {
      replies.delete(key);
      void ttsEnd(r.utterance);
    }
  });
}

/** Cut what's speaking and drop the rest of the reply. */
export function stopSpeaking(): void {
  const was = replies.size > 0 || state.speaking !== null;
  replies.clear();
  if (was) void ttsStop().catch(() => {});
}

export function isSpeaking(): boolean {
  return replies.size > 0 || state.speaking !== null;
}

// ── hooks from the drawer's event stream (duckState) ──

const USER_SOURCES = new Set(["desktop", "phone", "voice"]);

/** A message of yours started a turn: speak its reply if the setting says so. */
export function onUserMessage(m: StoredMessage, text: string): void {
  if (!USER_SOURCES.has(m.source)) return;
  // Whatever was speaking, you've moved on.
  stopSpeaking();
  const { speak } = state.prefs;
  if (speak === "off" || (speak === "voice" && m.source !== "voice")) return;
  // Not gated on `ready`: when the voice isn't set up, the backend's error says so
  // in the drawer, rather than the reply going silently unspoken.
  // Silero takes 10-20 s to load cold: start it while Duck thinks.
  if (langOf(text) === "ru") void ttsWarm(true).catch(() => {});
  begin(m.threadId);
  if (!state.ready) void refreshReady();
}

export function onReplyDelta(threadId: string, text: string): void {
  const r = replies.get(threadId);
  if (r) for (const s of r.sentences.push(text)) say(r, s);
}

/** The turn is over (idle) or parked on a confirmation: the reply is complete. */
export function onTurnEnded(threadId: string): void {
  finish(threadId);
}

// ── speak selection ──

/** Speak `text` in Duck's voice; false when the voice isn't set up (use the system one). */
export function speakText(text: string): boolean {
  if (!state.ready || !text.trim()) return false;
  const key = "selection";
  const r = begin(key);
  for (const s of r.sentences.push(text)) say(r, s);
  finish(key);
  return true;
}

let started: Promise<void> | null = null;

export function initSpeech(): Promise<void> {
  started ??= (async () => {
    const prefs = { ...DEFAULT_SPEECH, ...(await getPref("speech", DEFAULT_SPEECH).catch(() => DEFAULT_SPEECH)) };
    set({ prefs });
    configure(prefs);
    await refreshReady();
    await onTtsLevel((l) => {
      level = l;
    });
    await onTtsState((e) => {
      if (e.state === "speaking") set({ speaking: e.utterance, error: null });
      else {
        if (state.speaking === e.utterance || e.state === "stopped") set({ speaking: null });
        if (e.state === "error") set({ error: e.message });
      }
      if (e.state !== "speaking") level = 0;
    });
  })().catch((e: unknown) => {
    started = null;
    console.warn("speech: didn't start", e);
  });
  return started;
}
