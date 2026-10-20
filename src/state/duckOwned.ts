// Duck's workers (step D1): the sessions Duck started for a task. Their card says
// "duck" beside the title, and they don't ping you (`notifications.ts`): Duck hears
// their news and reports it in its thread. Duck fills this from its task store at
// start and as tasks start and close; it's ephemeral, like live status.

import { useSyncExternalStore } from "react";

let owned: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

/** Mark a session as Duck's worker for the task `title`, or (null) as yours again. */
export function setDuckOwned(instanceId: string, title: string | null): void {
  if ((owned.get(instanceId) ?? null) === title) return;
  const next = new Map(owned);
  if (title === null) next.delete(instanceId);
  else next.set(instanceId, title);
  owned = next;
  for (const l of listeners) l();
}

/** The task a session works on for Duck; null when it's yours. */
export function duckTask(instanceId: string): string | null {
  return owned.get(instanceId) ?? null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useDuckTask(instanceId: string): string | null {
  return useSyncExternalStore(subscribe, () => owned.get(instanceId) ?? null);
}

/** Every worker: instance id → task. */
export function useDuckTasks(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => owned);
}
