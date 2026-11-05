// A voice message for a session: the composer's mic button. Recorded and
// transcribed on this PC by Duck's voice input (Parakeet, `src-tauri/src/voice`,
// `voice_note_*`), and the text goes into the session's draft at its end, to read
// over, fix and send with ↵ as any prompt. It never goes to Duck.
//
// One microphone, so one recording at a time across the window: the state is the
// module's, and says whose composer it is for. The text lands in that session's
// draft even if its console was closed meanwhile.

import { useSyncExternalStore } from "react";

import { invoke } from "@tauri-apps/api/core";

import type { Transcript } from "../ipc/voice";
import { fixNames } from "../assistant/voiceNames";
import { getDraft, setDraft } from "../state/composer";
import { getRegistry } from "../state/registry";
import { joinDictation } from "../util/dictation";

/** The capture keeps two minutes (`capture::MAX`); stop just before it. */
export const NOTE_MAX_S = 118;

export type NotePhase = "idle" | "starting" | "recording" | "transcribing";

export interface NoteState {
  phase: NotePhase;
  /** The session it's for (null when idle). */
  instanceId: string | null;
  /** When recording began (ms), for the timer. */
  since: number;
  /** The last problem, for that session's composer; cleared by the next start. */
  error: { instanceId: string; text: string } | null;
}

let state: NoteState = { phase: "idle", instanceId: null, since: 0, error: null };
const listeners = new Set<() => void>();
let limit: ReturnType<typeof setTimeout> | null = null;

function set(next: Partial<NoteState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const getNoteState = (): NoteState => state;

export function useNoteState(): NoteState {
  return useSyncExternalStore(subscribe, getNoteState);
}

/** What a refusal says, in the composer: the backend's sentences as they are,
 *  with where to look when the microphone wouldn't open. */
export function noteError(e: unknown): string {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  if (text.startsWith("The microphone didn't open"))
    return `${text} — is one plugged in, and allowed in Windows Settings › Privacy › Microphone?`;
  return text;
}

function clearLimit(): void {
  if (limit) clearTimeout(limit);
  limit = null;
}

/** Start recording for `instanceId`. Another session's recording is in the way:
 *  nothing (its button says so). */
export async function startNote(instanceId: string): Promise<void> {
  if (state.phase !== "idle") return;
  set({ phase: "starting", instanceId, error: null });
  try {
    await invoke("voice_note_start");
  } catch (e) {
    set({ phase: "idle", instanceId: null, error: { instanceId, text: noteError(e) } });
    return;
  }
  // `cancelNote` may have run meanwhile (TS narrows `state` from before the await).
  if (getNoteState().phase !== "starting") {
    // Cancelled while the microphone opened.
    void invoke("voice_note_cancel").catch(() => {});
    return;
  }
  set({ phase: "recording", since: Date.now() });
  clearLimit();
  limit = setTimeout(() => void stopNote(), NOTE_MAX_S * 1000);
}

/** Stop, transcribe, and put the text in the session's draft. */
export async function stopNote(): Promise<void> {
  if (state.phase !== "recording") return;
  clearLimit();
  const instanceId = state.instanceId as string;
  set({ phase: "transcribing" });
  try {
    const t = await invoke<Transcript | null>("voice_note_stop");
    const text = t?.text.trim() ?? "";
    if (!text) {
      set({
        phase: "idle",
        instanceId: null,
        error: { instanceId, text: t ? "Nothing was heard — is the right microphone picked in Duck's voice settings?" : "Too short to hear." },
      });
      return;
    }
    // Russian speech writes English names in Cyrillic: Duck's name fixer puts the
    // projects', sessions' and common terms' spelling back.
    const r = getRegistry();
    const names = [...r.projects.map((p) => p.name), ...r.instances.map((i) => i.title)];
    setDraft(instanceId, joinDictation(getDraft(instanceId), fixNames(text, names).text));
    set({ phase: "idle", instanceId: null });
  } catch (e) {
    set({ phase: "idle", instanceId: null, error: { instanceId, text: noteError(e) } });
  }
}

/** Stop and drop it. */
export function cancelNote(): void {
  if (state.phase !== "recording" && state.phase !== "starting") return;
  clearLimit();
  void invoke("voice_note_cancel").catch(() => {});
  set({ phase: "idle", instanceId: null });
}

/** Forget the problem shown for `instanceId`. */
export function dismissNoteError(instanceId: string): void {
  if (state.error?.instanceId === instanceId) set({ error: null });
}
