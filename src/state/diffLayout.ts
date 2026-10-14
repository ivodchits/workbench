// The review panel's diff layout (step V1): unified or side by side. One choice for
// every review panel, persisted in prefs.

import { useSyncExternalStore } from "react";

import { getPref, setPref, type DiffLayout } from "../ipc/prefs";

let layout: DiffLayout = "unified";
const listeners = new Set<() => void>();

let loaded: Promise<void> | null = null;
let changed = false;

function load(): void {
  loaded ??= getPref("diffLayout", "unified")
    .then((saved) => {
      // A choice made while the load was in flight wins over the saved one.
      if (changed || (saved !== "unified" && saved !== "split")) return;
      layout = saved;
      for (const l of listeners) l();
    })
    .catch(() => {});
}

export function setDiffLayout(next: DiffLayout): void {
  changed = true;
  if (next === layout) return;
  layout = next;
  for (const l of listeners) l();
  void setPref("diffLayout", next).catch(() => {});
}

function subscribe(cb: () => void): () => void {
  load();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useDiffLayout(): DiffLayout {
  return useSyncExternalStore(subscribe, () => layout);
}
