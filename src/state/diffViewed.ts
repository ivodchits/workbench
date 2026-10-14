// "Viewed" marks in the review panel (step V2): per review panel, the files you've
// been through, each remembered with the file's stamp at the time (`DiffFile.stamp`:
// size, modification time and counts). A file whose stamp has moved since — the
// agent edited it again — counts as not viewed, so a mark never hides a new change.
//
// In memory for the app's lifetime, keyed by the panel's diff id; closing the app
// forgets them.

import { useSyncExternalStore } from "react";

import type { DiffFile } from "../ipc/git";

/** diffId → path → stamp when marked. Replaced, never mutated (snapshot). */
let marks: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map();
const listeners = new Set<() => void>();

const EMPTY: ReadonlyMap<string, string> = new Map();

function set(diffId: string, next: ReadonlyMap<string, string>): void {
  const all = new Map(marks);
  all.set(diffId, next);
  marks = all;
  for (const l of listeners) l();
}

/** Whether `file` is marked viewed in that panel and unchanged since. */
export function isViewed(viewed: ReadonlyMap<string, string>, file: DiffFile): boolean {
  const at = viewed.get(file.path);
  return at !== undefined && at === (file.stamp ?? "");
}

export function setViewed(diffId: string, file: DiffFile, on: boolean): void {
  const next = new Map(marks.get(diffId) ?? EMPTY);
  if (on) next.set(file.path, file.stamp ?? "");
  else next.delete(file.path);
  set(diffId, next);
}

export function toggleViewed(diffId: string, file: DiffFile): void {
  setViewed(diffId, file, !isViewed(marks.get(diffId) ?? EMPTY, file));
}

export function getViewed(diffId: string): ReadonlyMap<string, string> {
  return marks.get(diffId) ?? EMPTY;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The panel's marks; pair with `isViewed` against the current file list. */
export function useViewed(diffId: string): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => getViewed(diffId));
}
