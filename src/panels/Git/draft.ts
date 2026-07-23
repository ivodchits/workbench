// Commit-message drafts (G1) — an in-memory map keyed by repo root, mirrored into
// the prefs store. Switching tabs unmounts the working-tree tab and closing the
// panel unmounts the whole thing, so the box can't hold a half-written message in
// component state alone; losing one to a mis-click is unacceptable.
//
// Reads are synchronous against the cache so a tab switch restores instantly;
// the prefs round-trip only costs a beat on the session's first panel mount, and
// writes are debounced so typing doesn't hit the disk per keystroke.

import { getPref, setPref, type CommitDraft } from "../../ipc/prefs";

export type { CommitDraft };

export const EMPTY_DRAFT: CommitDraft = { subject: "", body: "" };

/** How long typing must pause before the draft is mirrored to disk. */
const FLUSH_MS = 600;

let cache: Record<string, CommitDraft> = {};
let hydration: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Load the persisted drafts, once per session. Anything typed while the read was
 * in flight wins over the stored copy — the user's keystrokes are never the stale
 * side of that race.
 */
export function hydrateDrafts(): Promise<void> {
  hydration ??= getPref("commitDrafts", {})
    .then((stored) => {
      cache = { ...stored, ...cache };
    })
    .catch(() => undefined);
  return hydration;
}

/** The draft for a repo, read synchronously from the cache. */
export function readDraft(repoRoot: string): CommitDraft {
  return cache[repoRoot] ?? EMPTY_DRAFT;
}

/** True once the draft for a repo has anything worth keeping. */
export function draftIsEmpty(draft: CommitDraft): boolean {
  return draft.subject.trim() === "" && draft.body.trim() === "";
}

/** Record a draft (mirrored to disk after a pause). An empty one is dropped. */
export function writeDraft(repoRoot: string, draft: CommitDraft): void {
  if (draftIsEmpty(draft)) delete cache[repoRoot];
  else cache[repoRoot] = draft;
  scheduleFlush();
}

/** Drop a repo's draft — called once its commit lands. */
export function clearDraft(repoRoot: string): void {
  if (!(repoRoot in cache)) return;
  delete cache[repoRoot];
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void setPref("commitDrafts", cache).catch(() => undefined);
  }, FLUSH_MS);
}
