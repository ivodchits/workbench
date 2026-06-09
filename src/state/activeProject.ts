// Active-project store (step 1.6b) — which project's workspace is on screen.
//
// Per design §3 the dock layout is persisted *per project*; selecting a project
// in the rail makes it the active context, and the `Workspace` swaps the dock to
// that project's saved panel set (consoles + shells from other projects keep
// running in the background — only the *view* changes). The selection is
// persisted to prefs so launch lands you back where you left off.
//
// A tiny external store exposed to React via `useSyncExternalStore`, mirroring
// the `consoles` / `shells` stores.

import { useSyncExternalStore } from "react";
import { getPref, setPref } from "../ipc/prefs";

let activeProjectId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Read the active project id outside React (used by the Workspace's persist). */
export function getActiveProject(): string | null {
  return activeProjectId;
}

/** Select the active project (no-op if unchanged); persisted to prefs. */
export function setActiveProject(id: string | null): void {
  if (activeProjectId === id) return;
  activeProjectId = id;
  emit();
  void setPref("activeProjectId", id ?? "");
}

/** Restore the last-selected project from prefs. Returns the restored id (or null
 *  if none was saved) so the caller can sequence its default-selection logic. */
export async function initActiveProject(): Promise<string | null> {
  const saved = await getPref("activeProjectId", "");
  if (saved && activeProjectId === null) {
    activeProjectId = saved;
    emit();
  }
  return activeProjectId;
}

/** Subscribe a component to the active-project id. */
export function useActiveProject(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => activeProjectId,
  );
}
