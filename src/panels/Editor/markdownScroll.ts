// Remembers per-preview scroll offsets so a markdown preview shows the same
// section after you switch tabs away and back. Dockview unmounts hidden panels
// (onlyWhenVisible), so React state can't survive the round trip — this
// module-level map outlives the remount, keyed by a stable per-preview id the
// caller supplies (see `MarkdownPreview`). Mirrors how `terminalPool` stashes a
// console's scroll position across the same unmount/remount cycle.

const offsets = new Map<string, number>();

export function loadScroll(key: string): number {
  return offsets.get(key) ?? 0;
}

export function saveScroll(key: string, top: number): void {
  offsets.set(key, top);
}
