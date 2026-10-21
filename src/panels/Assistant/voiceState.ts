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

import { useSyncExternalStore } from "react";
import { fixNames, voiceMessage } from "../../assistant/voiceNames";
import { getPref, setPref, type Prefs } from "../../ipc/prefs";
import { onVoiceState, onVoiceTranscript, voiceConfigure, type Transcript, type VoicePhase } from "../../ipc/voice";
import { getRegistry } from "../../state/registry";
import { sendMessage, setDrawerOpen } from "./duckState";

export type VoicePrefs = Prefs["voice"];

export const DEFAULT_VOICE: VoicePrefs = { gpu: "never", hotkey: "Ctrl+Alt+Space", device: null, sendNow: true };

export interface VoiceState {
  phase: VoicePhase;
  message: string | null;
  prefs: VoicePrefs;
  /** A transcript for the composer (`sendNow` off); `seq` tells a repeat apart. */
  dictated: { text: string; seq: number } | null;
  /** Why the key couldn't be registered. */
  keyProblem: string | null;
}

let state: VoiceState = { phase: "idle", message: null, prefs: DEFAULT_VOICE, dictated: null, keyProblem: null };
const listeners = new Set<() => void>();

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

function configure(prefs: VoicePrefs): void {
  void voiceConfigure({ gpu: prefs.gpu, device: prefs.device, hotkey: prefs.hotkey })
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
  })().catch((e: unknown) => {
    started = null;
    console.warn("voice: didn't start", e);
  });
  return started;
}
