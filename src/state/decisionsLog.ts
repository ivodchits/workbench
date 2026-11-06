// The autopilot decisions log's change signal: Duck appends a session's log
// (`src/assistant/decisionsLog.ts`, through its port) and an open "decisions" panel
// reads the file again. The file itself is the record; this only counts writes.

import { useSyncExternalStore } from "react";

let versions: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

/** A session's log was written. */
export function decisionsLogged(instanceId: string): void {
  const next = new Map(versions);
  next.set(instanceId, (next.get(instanceId) ?? 0) + 1);
  versions = next;
  for (const l of listeners) l();
}

export function decisionsVersion(instanceId: string): number {
  return versions.get(instanceId) ?? 0;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** How many times the session's log was written since the app started. */
export function useDecisionsVersion(instanceId: string): number {
  return useSyncExternalStore(subscribe, () => decisionsVersion(instanceId));
}
