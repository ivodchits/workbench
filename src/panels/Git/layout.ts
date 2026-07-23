// Git-panel layout state (G2) — splitter positions and collapsed sections, held
// in an in-memory map and mirrored into the prefs store. Same shape as `draft.ts`
// next door and for the same reason: the panel unmounts on every tab switch, so a
// dragged splitter can't live in component state alone, and a splitter that snaps
// back to its default every time you look away is worse than a fixed pane.
//
// Reads are synchronous against the cache. The panel shell folds `hydrate()` into
// its first load, so by the time a tab renders the stored positions are already
// here and the splits mount in the right place instead of jumping a beat later.

import { getPref, setPref, type GitLayout, type GitSplitState } from "../../ipc/prefs";

export type { GitSplitState };

/** How long an interaction must settle before the layout is mirrored to disk. */
const FLUSH_MS = 400;

let cache: GitLayout = { splits: {}, sections: {} };
let hydration: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Load the persisted layout, once per session. Anything moved while the read was
 *  in flight wins over the stored copy. */
export function hydrateGitLayout(): Promise<void> {
  hydration ??= getPref("gitLayout", { splits: {}, sections: {} })
    .then((stored) => {
      cache = {
        splits: { ...stored.splits, ...cache.splits },
        sections: { ...stored.sections, ...cache.sections },
      };
    })
    .catch(() => undefined);
  return hydration;
}

/** A split's stored position, or the caller's default when it's never been moved. */
export function readSplit(key: string, defaultSize: number): GitSplitState {
  return cache.splits[key] ?? { size: defaultSize, collapsed: false };
}

/** Record a split's position (mirrored to disk after a pause). */
export function writeSplit(key: string, state: GitSplitState): void {
  cache.splits[key] = state;
  scheduleFlush();
}

/** Whether a collapsible section is open. `fallback` decides it until the user
 *  first toggles it — so a section can follow its content (open when there's
 *  something in it) without that guess ever overriding an explicit choice. */
export function readSection(key: string, fallback: boolean): boolean {
  return cache.sections[key] ?? fallback;
}

export function writeSection(key: string, open: boolean): void {
  cache.sections[key] = open;
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void setPref("gitLayout", cache).catch(() => undefined);
  }, FLUSH_MS);
}
