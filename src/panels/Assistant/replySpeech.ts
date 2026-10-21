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
// - Nothing to say yet `ACK_MS` after a spoken message (Duck usually starts with
//   an acknowledgement of its own, "Checking the backend session."): a stock one
//   is said, so you know it heard you.
// - The duck's beak follows `getSpeechLevel()`, the loudness of what's playing,
//   read each frame (too fast for React state).
// - Ctrl+Shift+L in a console speaks the selection through the same voice
//   (`speakText`), when the runtime is set up.
// - When replies are spoken with the local voice, the backend starts it with the
//   app and keeps it loaded (English; Silero loads on the first Russian message
//   and stays), so no reply is cold. Otherwise it stops after 5 idle minutes.
// - Read-aloud (step V3) plays here through `desktopVoice`, a section per
//   utterance, once the reply that asked for it is over (`quietFor`). Whatever
//   stops a reply (a new message, Esc, the push-to-talk key) cuts it too, and the
//   reader holds its place.
// - Speak (V5) is the master switch: off, nothing here uses the voice but
//   Ctrl+Shift+L. Announcements (`announce`) speak through the same queue.
// - Once an announcement has been said, `onAnnounced` hears its thread, and
//   conversation mode (V4) opens the reply window for it.
// - A conversation Duck moved into another thread (A7): the reply there is said
//   after the rest of "Moving to the Demiurge thread.", not over it.

import { useSyncExternalStore } from "react";
import { registerDesktopSpeech } from "../../assistant";
import { oneShot } from "../../assistant/client";
import type { Voice } from "../../assistant/reader";
import { USER_SOURCES } from "../../assistant/protocol";
import { langOf, prepareSentence, Sentences } from "../../assistant/speakable";
import type { StoredMessage } from "../../ipc/assistant";
import { getPref, setPref, type Prefs } from "../../ipc/prefs";
import { onTtsLevel, onTtsState, ttsConfigure, ttsEnd, ttsSay, ttsStatus, ttsStop, ttsWarm } from "../../ipc/tts";

export type SpeechPrefs = Prefs["speech"];

export const DEFAULT_SPEECH: SpeechPrefs = {
  on: true,
  speak: "voice",
  engine: "local",
  chirpFallback: false,
  voiceEn: "af_heart",
  voiceRu: "kseniya",
  rate: 1,
};

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

/** Speak, the master switch (V5); off cuts what's speaking. */
export function setSpeakOn(on: boolean): void {
  if (!on) stopSpeaking();
  setSpeechPrefs({ on });
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
  /** A sentence of it was queued. */
  said: boolean;
  utterance: number;
  sentences: Sentences;
  /** Sentences are prepared in order: each waits for the one before. */
  chain: Promise<void>;
}

let nextUtterance = Date.now();
/** The reply being spoken, per thread (one at a time in practice). */
const replies = new Map<string, Reply>();

/** The Haiku rewrite of a Russian sentence Silero couldn't say whole. */
export const rewriteRussian = (s: string, signal: AbortSignal): Promise<string> =>
  oneShot("speakable_ru", s, { signal });

/** A reply with nothing to say this long after your message gets a stock
 *  acknowledgement. */
export const ACK_MS = 3500;
const ACKS = ["One moment.", "On it.", "Let me check."];

function say(r: Reply, sentence: string): void {
  r.said = true;
  const ready = prepareSentence(sentence, rewriteRussian);
  r.chain = r.chain.then(async () => {
    const s = await ready;
    if (s && replies.get(r.key) === r) await ttsSay(r.utterance, s.text, s.lang).catch(() => {});
  });
}

/** The announcement speaking now, and the thread a reply to it goes to. */
let announcing: { utterance: number; threadId: string } | null = null;
let announced: ((threadId: string) => void) | null = null;

/** Hear when an announcement has been said in full (not cut). */
export function onAnnounced(cb: (threadId: string) => void): void {
  announced = cb;
}

function begin(key: string, keep = false): Reply {
  if (!keep) stopSpeaking();
  const r: Reply = { key, said: false, utterance: nextUtterance++, sentences: new Sentences(), chain: Promise.resolve() };
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

// ── read-aloud ──

/** Sections of a read waiting for their end, by utterance. */
const reading = new Map<number, { ok: (heard: boolean) => void; fail: (e: Error) => void }>();
let cuts = 0;

function endReads(heard: boolean): void {
  for (const w of reading.values()) w.ok(heard);
  reading.clear();
}

/** A read's voice on this PC. */
export const desktopVoice: Voice = {
  where: "desktop",
  async play(sentences) {
    if (!state.prefs.on) throw new Error("Speak is off on this PC (the speaker by Duck's button)");
    const mine = cuts;
    const u = nextUtterance++;
    const heard = new Promise<boolean>((ok, fail) => reading.set(u, { ok, fail }));
    for (const next of sentences) {
      const s = await next;
      if (mine !== cuts) {
        reading.delete(u);
        return false;
      }
      if (s) await ttsSay(u, s.text, s.lang);
    }
    await ttsEnd(u);
    return heard;
  },
  cut() {
    cuts++;
    endReads(false);
    void ttsStop().catch(() => {});
  },
};

/** Resolves once nothing is speaking or still to be spoken for `threadId`'s reply
 *  (or after a minute, whatever is). */
export function quietFor(threadId: string): Promise<void> {
  const until = Date.now() + 60_000;
  return new Promise((resolve) => {
    const check = () => {
      if ((!replies.has(threadId) && state.speaking === null) || Date.now() > until) resolve();
      else setTimeout(check, 100);
    };
    check();
  });
}

/** Cut what's speaking and drop the rest of the reply. */
export function stopSpeaking(): void {
  const was = replies.size > 0 || state.speaking !== null || reading.size > 0;
  replies.clear();
  if (was) void ttsStop().catch(() => {});
}

export function isSpeaking(): boolean {
  return replies.size > 0 || state.speaking !== null || reading.size > 0;
}

// ── hooks from the drawer's event stream (duckState) ──

/** A message from the phone is answered there (step R1), not out of these speakers. */
const DESKTOP_SOURCES = new Set(["desktop", "voice"]);

/** A message of yours started a turn: speak its reply if the setting says so.
 *  `moved`: Duck brought it over from the thread you were in (A7), whose reply
 *  still finishes first. */
export function onUserMessage(m: StoredMessage, text: string, moved = false): void {
  if (!USER_SOURCES.has(m.source)) return;
  // Whatever was speaking, you've moved on.
  if (!moved) stopSpeaking();
  if (!DESKTOP_SOURCES.has(m.source) || !state.prefs.on) return;
  const { speak } = state.prefs;
  if (speak === "off" || (speak === "voice" && m.source !== "voice")) return;
  // Not gated on `ready`: when the voice isn't set up, the backend's error says so
  // in the drawer, rather than the reply going silently unspoken.
  // Silero takes 10-20 s to load cold: start it while Duck thinks.
  if (langOf(text) === "ru") void ttsWarm(true).catch(() => {});
  const r = begin(m.threadId, moved);
  setTimeout(() => {
    if (replies.get(m.threadId) === r && !r.said) say(r, ACKS[Math.floor(Math.random() * ACKS.length)]);
  }, ACK_MS);
  if (!state.ready) void refreshReady();
}

export function onReplyDelta(threadId: string, text: string): void {
  const r = replies.get(threadId);
  if (r) for (const s of r.sentences.push(text)) say(r, s);
}

/** A tool call starts: what the reply has so far is said now (an acknowledgement
 *  before the call would otherwise wait for the text after it). */
export function onToolStart(threadId: string): void {
  const r = replies.get(threadId);
  if (r) for (const s of r.sentences.end()) say(r, s);
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

// ── announcements (V5) ──

/** Say an announcement; false when Speak is off or the voice isn't set up. */
export function announce(text: string, threadId?: string): Promise<boolean> {
  if (!state.prefs.on || !state.ready || !text.trim()) return Promise.resolve(false);
  const r = begin("announce");
  announcing = threadId ? { utterance: r.utterance, threadId } : null;
  for (const s of r.sentences.push(text)) say(r, s);
  finish("announce");
  return Promise.resolve(true);
}

let started: Promise<void> | null = null;

export function initSpeech(): Promise<void> {
  started ??= (async () => {
    const prefs = { ...DEFAULT_SPEECH, ...(await getPref("speech", DEFAULT_SPEECH).catch(() => DEFAULT_SPEECH)) };
    set({ prefs });
    configure(prefs);
    await refreshReady();
    registerDesktopSpeech({
      voice: desktopVoice,
      quiet: quietFor,
      announce,
      busy: isSpeaking,
      speakOn: () => state.prefs.on,
      setSpeakOn,
    });
    await onTtsLevel((l) => {
      level = l;
    });
    await onTtsState((e) => {
      if (announcing?.utterance === e.utterance && e.state !== "speaking") {
        const done = e.state === "done" ? announcing.threadId : null;
        announcing = null;
        if (done) announced?.(done);
      } else if (e.state === "stopped") announcing = null;
      const read = reading.get(e.utterance);
      if (e.state === "done" && read) {
        reading.delete(e.utterance);
        read.ok(true);
      } else if (e.state === "error" && read) {
        reading.delete(e.utterance);
        read.fail(new Error(e.message ?? "the voice failed"));
      } else if (e.state === "stopped") endReads(false);
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
