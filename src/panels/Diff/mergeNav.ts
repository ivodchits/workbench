// The pure half of the merge view's navigation and live update (step V2), split out
// so it can be tested without an editor.

/** The one replacement that turns `old` into `next` (common prefix and suffix kept),
 *  or null when they are equal. Applying a refresh this way, rather than replacing
 *  the whole document, keeps the cursor and the scroll position where they were. */
export function textPatch(old: string, next: string): { from: number; to: number; insert: string } | null {
  if (old === next) return null;
  const max = Math.min(old.length, next.length);
  let start = 0;
  while (start < max && old.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    old.charCodeAt(old.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  ) {
    end++;
  }
  return { from: start, to: old.length - end, insert: next.slice(start, next.length - end) };
}

/**
 * Where the next (`dir` 1) or previous (-1) change starts, given the changes' start
 * positions in document order and the cursor. Null past the last or before the
 * first: unlike CodeMirror's own command this doesn't wrap, so the panel can move on
 * to the neighbouring file instead.
 *
 * "Previous" from inside a change is that change's own start, as in most editors.
 */
export function stepChange(starts: readonly number[], head: number, dir: 1 | -1): number | null {
  if (dir > 0) return starts.find((s) => s > head) ?? null;
  for (let i = starts.length - 1; i >= 0; i--) if (starts[i] < head) return starts[i];
  return null;
}
