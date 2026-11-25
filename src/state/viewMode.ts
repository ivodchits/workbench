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

/** The mode each instance was put in (true = transcript); an instance never set
 *  shows its default. A remote console's tab (keyed by its panel id) defaults to
 *  the transcript, a local console to its terminal, so both are stored either way.
 *  Replaced, never mutated. */
let modes: ReadonlyMap<string, boolean> = new Map();
const listeners = new Set<() => void>();

function apply(instanceId: string, mode: ViewMode): boolean {
  const on = mode === "transcript";
  if (modes.get(instanceId) === on) return false;
  const next = new Map(modes);
  next.set(instanceId, on);
  modes = next;
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
      // Saved first, so a toggle made while loading wins over the stored mode.
      modes = new Map([...Object.entries(saved), ...modes]);
      for (const l of listeners) l();
    } catch {
      // Not running under Tauri: every console simply stays on its terminal.
    }
  })();
  return started;
}

export function getViewMode(instanceId: string, fallback: ViewMode = "terminal"): ViewMode {
  const on = modes.get(instanceId);
  return on === undefined ? fallback : on ? "transcript" : "terminal";
}

export function setViewMode(instanceId: string, mode: ViewMode): void {
  if (!apply(instanceId, mode)) return;
  // After the load, so a toggle made before it finishes can't save a partial set.
  void initViewModes().then(() =>
    setPref("transcriptView", Object.fromEntries(modes)),
  );
  void emit(CHANGED_EVENT, { instanceId, mode } satisfies Changed).catch(() => {});
}

export function toggleViewMode(instanceId: string, fallback: ViewMode = "terminal"): void {
  setViewMode(instanceId, getViewMode(instanceId, fallback) === "transcript" ? "terminal" : "transcript");
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Subscribe a component to one instance's view mode. */
export function useViewMode(instanceId: string, fallback: ViewMode = "terminal"): ViewMode {
  return useSyncExternalStore(subscribe, () => getViewMode(instanceId, fallback));
}
