// View mode (step T3) — whether a Claude console shows its terminal or its
// transcript. Per instance, persisted in prefs, and shared between the main
// window and torn-off windows: those are separate webviews with separate copies
// of this store, so a change is broadcast as a Tauri event and each window
// applies it.
//
// The mode only chooses what is on screen. The PTY and its terminal keep running
// either way (see `ConsolePanel`).

import { useSyncExternalStore } from "react";
import { emit, listen } from "@tauri-apps/api/event";

import { getPref, setPref } from "../ipc/prefs";

export type ViewMode = "terminal" | "transcript";

const CHANGED_EVENT = "console-view-mode";

interface Changed {
  instanceId: string;
  mode: ViewMode;
}

/** Instances showing their transcript. Replaced, never mutated (it is the
 *  `useSyncExternalStore` snapshot). */
let inTranscript: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function apply(instanceId: string, mode: ViewMode): boolean {
  if ((mode === "transcript") === inTranscript.has(instanceId)) return false;
  const next = new Set(inTranscript);
  if (mode === "transcript") next.add(instanceId);
  else next.delete(instanceId);
  inTranscript = next;
  for (const l of listeners) l();
  return true;
}

let started: Promise<void> | null = null;

/** Load the saved modes and start listening for changes made in other windows.
 *  Idempotent, app-lifetime. */
export function initViewModes(): Promise<void> {
  started ??= (async () => {
    try {
      await listen<Changed>(CHANGED_EVENT, (e) => void apply(e.payload.instanceId, e.payload.mode));
      const saved = await getPref("transcriptView", {});
      const next = new Set(inTranscript);
      for (const [id, on] of Object.entries(saved)) if (on) next.add(id);
      inTranscript = next;
      for (const l of listeners) l();
    } catch {
      // Not running under Tauri: every console simply stays on its terminal.
    }
  })();
  return started;
}

export function getViewMode(instanceId: string): ViewMode {
  return inTranscript.has(instanceId) ? "transcript" : "terminal";
}

export function setViewMode(instanceId: string, mode: ViewMode): void {
  if (!apply(instanceId, mode)) return;
  // After the load, so a toggle made before it finishes can't save a partial set.
  void initViewModes().then(() =>
    setPref("transcriptView", Object.fromEntries([...inTranscript].map((id) => [id, true]))),
  );
  void emit(CHANGED_EVENT, { instanceId, mode } satisfies Changed).catch(() => {});
}

export function toggleViewMode(instanceId: string): void {
  setViewMode(instanceId, getViewMode(instanceId) === "transcript" ? "terminal" : "transcript");
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Subscribe a component to one instance's view mode. */
export function useViewMode(instanceId: string): ViewMode {
  return useSyncExternalStore(subscribe, () => getViewMode(instanceId));
}
