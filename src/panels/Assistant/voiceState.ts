// Push-to-talk on the desktop (step V1): the voice prefs, what the HUD shows, and
// where a transcript goes. The key and the recording are the backend's
// (`src-tauri/src/voice`); this hears its events.
//
// - A transcript gets its names fixed (`voiceNames.ts`: your project and session
//   names, and the term list), then goes to Duck in the open thread, marked
//   `voice`. With "send at once" off, it lands in the composer for an edit instead.
// - When the fixer changed something, the words as heard ride along, so Duck can
//   tell when a fix was wrong.
// - Press: the drawer opens, unless the window is hidden (then Duck answers in the
//   thread, and the reply waits there).
// - The key toggles by default (a press starts, the next press stops); "hold to
//   talk" is the setting's other choice.
//
// Conversation mode (step V4) is the key's default since 2026-10-21 (`press`):
// a press turns it on, the next turns it off, and the drawer's mic does the same.
// - The backend hears the turns (`voice-turn`). A `provisional` one goes to the
//   open thread at once as a provisional turn (the engine starts on it but keeps
//   nothing); `withdrawn` (you went on talking) drops it; `final` commits it. A
//   thread that's busy, or no thread yet, gets the turn as a plain message once
//   it's final. Conversation mode always sends: there's no composer to land in.
// - Talking over Duck stops its voice here too, so the rest of the reply isn't
//   queued after the backend cut it. On speakers the backend cancels Duck's echo
//   (part 2); the echo it measured removing is kept for the settings (`echo`).
// - After a spoken announcement, a short reply window listens (V5's, `replyWindow`):
//   a reply opens that thread and goes there.

import { useSyncExternalStore } from "react";
import { fixNames, voiceMessage } from "../../assistant/voiceNames";
import { getPref, setPref, type Prefs } from "../../ipc/prefs";
import {
  onConversationLevel,
  onConversationState,
  onVoiceState,
  onVoiceTranscript,
  onVoiceTurn,
  voiceConfigure,
  voiceConversation,
  voiceConversationOn,
  voiceReplyWindow,
  type ConversationPhase,
  type ConversationState,
  type Transcript,
  type VoicePhase,
  type VoiceTurn,
} from "../../ipc/voice";
import { getRegistry } from "../../state/registry";
import { commitTurn, getDuckState, openThread, sendMessage, sendProvisional, setDrawerOpen, withdrawTurn } from "./duckState";
import { isSpeaking, onAnnounced, stopSpeaking } from "./replySpeech";

export type VoicePrefs = Prefs["voice"];

export const DEFAULT_VOICE: VoicePrefs = {
  gpu: "never",
  hotkey: "Ctrl+Alt+Space",
  device: null,
  sendNow: true,
  toggle: true,
  press: "conversation",
  patience: "quick",
  echo: "auto",
  autoOffMin: 5,
  cue: true,
  replyWindow: true,
};

/** How long the reply window after an announcement listens, seconds. */
export const REPLY_WINDOW_S = 8;

export interface Conversation {
  /** The mode or a reply window is running. */
  on: boolean;
  /** It's a reply window, not the mode. */
  window: boolean;
  phase: ConversationPhase;
  held: boolean;
  /** You can talk over Duck (unless set not to). */
  duplex: boolean;
  /** Why it stopped (by itself, or an error). */
  message: string | null;
  /** The echo canceller is running. */
  cancelling: boolean;
}

/** The echo removed on speakers, as last measured (it outlives the run). */
export interface EchoMeasured {
  db: number;
  output: string | null;
}

export interface VoiceState {
  phase: VoicePhase;
  message: string | null;
  prefs: VoicePrefs;
  /** A transcript for the composer (`sendNow` off); `seq` tells a repeat apart. */
  dictated: { text: string; seq: number } | null;
  /** Why the key couldn't be registered. */
  keyProblem: string | null;
  conversation: Conversation;
  echo: EchoMeasured | null;
}

const OFF: Conversation = {
  on: false,
  window: false,
  phase: "off",
  held: false,
  duplex: false,
  message: null,
  cancelling: false,
};

let state: VoiceState = {
  phase: "idle",
  message: null,
  prefs: DEFAULT_VOICE,
  dictated: null,
  keyProblem: null,
  conversation: OFF,
  echo: null,
};
const listeners = new Set<() => void>();
let level = 0;

function set(patch: Partial<VoiceState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const getVoiceState = (): VoiceState => state;

export function useVoiceState(): VoiceState {
  return useSyncExternalStore(subscribe, getVoiceState);
}

/** The microphone's loudness in conversation mode, 0..1 (read per frame). */
export const getConversationLevel = (): number => (state.conversation.on ? level : 0);

function configure(prefs: VoicePrefs): void {
  void voiceConfigure({
    gpu: prefs.gpu,
    device: prefs.device,
    hotkey: prefs.hotkey,
    toggle: prefs.toggle,
    press: prefs.press,
    patience: prefs.patience,
    echo: prefs.echo,
    autoOffMin: prefs.autoOffMin,
    cue: prefs.cue,
  })
    .then(() => set({ keyProblem: null }))
    .catch((e: unknown) => set({ keyProblem: String(e) }));
}

/** Change the voice prefs: stored, and handed to the backend. */
export function setVoicePrefs(patch: Partial<VoicePrefs>): void {
  const prefs = { ...state.prefs, ...patch };
  set({ prefs });
  void setPref("voice", prefs);
  configure(prefs);
}

/** The names the fixer puts back: projects and sessions. */
function knownNames(): string[] {
  const r = getRegistry();
  return [...r.projects.map((p) => p.name), ...r.instances.map((i) => i.title)];
}

/** What a transcript sends: its names fixed, the words as heard beside a fix. */
export function messageFor(t: Pick<Transcript, "text">, names: string[]): string {
  return voiceMessage(t.text, names);
}

function heard(t: Transcript): void {
  if (!t.text.trim()) {
    set({ phase: "idle", message: "Nothing was heard." });
    return;
  }
  if (state.prefs.sendNow) sendMessage(messageFor(t, knownNames()), undefined, "voice");
  else set({ dictated: { text: fixNames(t.text.trim(), knownNames()).text, seq: (state.dictated?.seq ?? 0) + 1 } });
}

// ── conversation mode (V4) ──

/** Conversation mode on or off (the key, the drawer's mic, `toggleConversation`). */
export function setConversation(on: boolean): void {
  if (on && document.visibilityState === "visible") setDrawerOpen(true);
  void voiceConversation(on).catch((e: unknown) => set({ conversation: { ...OFF, message: String(e) } }));
}

export function toggleConversation(): void {
  setConversation(!(state.conversation.on && !state.conversation.window));
}

/** The newest run heard: an older one's late events are ignored. */
let run = 0;
/** Where the reply window's reply goes. */
let windowThread: string | null = null;
/** Turns sent provisionally, by id, with their thread. */
const sent = new Map<number, string>();

/** Where a turn goes, and what it sends. Exported for the tests. */
export function routeTurn(
  t: VoiceTurn,
  d: {
    current: () => string | null;
    provisional: (threadId: string | null, text: string) => boolean;
    commit: (threadId: string) => void;
    withdraw: (threadId: string) => void;
    send: (text: string) => void;
    open: (threadId: string) => void;
  },
  text: string,
): void {
  if (t.window && windowThread && t.phase !== "withdrawn" && d.current() !== windowThread) d.open(windowThread);
  switch (t.phase) {
    case "provisional": {
      const thread = d.current();
      if (d.provisional(thread, text) && thread) sent.set(t.id, thread);
      return;
    }
    case "withdrawn": {
      const thread = sent.get(t.id);
      sent.delete(t.id);
      if (thread) d.withdraw(thread);
      return;
    }
    case "final": {
      const thread = sent.get(t.id);
      sent.delete(t.id);
      if (thread) d.commit(thread);
      else d.send(text);
    }
  }
}

function onTurn(t: VoiceTurn): void {
  if (t.run < run) return;
  routeTurn(
    t,
    {
      current: () => getDuckState().current,
      provisional: sendProvisional,
      commit: commitTurn,
      withdraw: withdrawTurn,
      send: (text) => sendMessage(text, undefined, "voice"),
      open: openThread,
    },
    t.phase === "withdrawn" ? "" : messageFor(t, knownNames()),
  );
}

function onConversation(s: ConversationState): void {
  if (s.run < run) return;
  run = s.run;
  const on = s.state !== "off" && s.state !== "error";
  // Talking over Duck: the backend cut its voice; drop the rest of the reply.
  if (s.state === "hearing" && s.duplex && isSpeaking()) stopSpeaking();
  if (!on) {
    windowThread = null;
    sent.clear();
  }
  // Turned on (by the key too): the drawer opens, unless the window is hidden.
  if (s.state === "preparing" && !s.window && document.visibilityState === "visible") setDrawerOpen(true);
  set({
    conversation: {
      on,
      window: s.window,
      phase: s.state,
      held: s.held,
      duplex: s.duplex,
      message: on ? null : s.message,
      cancelling: s.cancelling,
    },
    ...(s.suppression !== null ? { echo: { db: s.suppression, output: s.output } } : {}),
  });
}

/** An announcement was said: listen a moment for a reply to it. */
function replyWindow(threadId: string): void {
  if (!state.prefs.replyWindow || state.conversation.on || state.phase !== "idle") return;
  windowThread = threadId;
  void voiceReplyWindow(REPLY_WINDOW_S).catch((e: unknown) => console.warn("voice: the reply window didn't open", e));
}

let started: Promise<void> | null = null;

/** Load the prefs, hand them to the backend, and listen. Idempotent. */
export function initVoice(): Promise<void> {
  started ??= (async () => {
    const prefs = { ...DEFAULT_VOICE, ...(await getPref("voice", DEFAULT_VOICE).catch(() => DEFAULT_VOICE)) };
    set({ prefs });
    configure(prefs);
    await onVoiceState(({ state: phase, message }) => {
      set({ phase, message });
      if (phase === "listening" && document.visibilityState === "visible") setDrawerOpen(true);
    });
    await onVoiceTranscript(heard);
    await onConversationState(onConversation);
    await onVoiceTurn(onTurn);
    await onConversationLevel((l) => {
      level = l;
    });
    onAnnounced(replyWindow);
    // After a reload, the mode may still be on.
    if (await voiceConversationOn().catch(() => false))
      set({ conversation: { ...OFF, on: true, phase: "listening" } });
  })().catch((e: unknown) => {
    started = null;
    console.warn("voice: didn't start", e);
  });
  return started;
}
