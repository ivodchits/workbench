// Review comments (step V3): notes left on lines of an agent's changes in the review
// panel, collected per instance and sent back to it as one prompt.
//
// A comment names a file (relative to the instance's working dir, as the review
// panel lists it), a line range in the *working-tree* version — the file the agent
// will open — the code those lines held when the comment was made, and the note.
// The panel keeps the line numbers following edits while the file is open; the
// quote is kept as written, so the prompt shows what the reviewer was looking at.
//
// In memory only, like the prompt queue: a comment is for a live session, and is
// dropped once it has been sent.

import { useSyncExternalStore } from "react";

export interface ReviewComment {
  id: string;
  /** Path relative to the working dir, forward slashes. */
  path: string;
  /** 1-based, inclusive. */
  fromLine: number;
  toLine: number;
  /** The commented lines' text when the comment was made. */
  quote: string;
  note: string;
}

const EMPTY: readonly ReviewComment[] = [];
let byInstance: ReadonlyMap<string, readonly ReviewComment[]> = new Map();
const listeners = new Set<() => void>();
let seq = 0;

function put(instanceId: string, list: readonly ReviewComment[]): void {
  const next = new Map(byInstance);
  if (list.length === 0) next.delete(instanceId);
  else next.set(instanceId, list);
  byInstance = next;
  for (const l of listeners) l();
}

/** The instance's pending comments, in file then line order. */
export function getComments(instanceId: string): readonly ReviewComment[] {
  return byInstance.get(instanceId) ?? EMPTY;
}

function ordered(list: ReviewComment[]): ReviewComment[] {
  return list.sort((a, b) =>
    a.path === b.path ? a.fromLine - b.fromLine || a.toLine - b.toLine : a.path < b.path ? -1 : 1,
  );
}

/** Add a comment; returns its id. */
export function addComment(instanceId: string, comment: Omit<ReviewComment, "id">): string {
  const id = `c${++seq}`;
  put(instanceId, ordered([...getComments(instanceId), { ...comment, id }]));
  return id;
}

/** Change a comment's note. An empty note removes it. */
export function editComment(instanceId: string, id: string, note: string): void {
  if (!note.trim()) {
    removeComment(instanceId, id);
    return;
  }
  put(
    instanceId,
    getComments(instanceId).map((c) => (c.id === id ? { ...c, note } : c)),
  );
}

/** Follow line moves reported by an open editor: `lines` maps comment id to its
 *  new range. Comments not named are left alone; nothing happens if nothing moved. */
export function moveComments(instanceId: string, lines: ReadonlyMap<string, [number, number]>): void {
  let moved = false;
  const next = getComments(instanceId).map((c) => {
    const at = lines.get(c.id);
    if (!at || (at[0] === c.fromLine && at[1] === c.toLine)) return c;
    moved = true;
    return { ...c, fromLine: at[0], toLine: at[1] };
  });
  if (moved) put(instanceId, ordered(next));
}

export function removeComment(instanceId: string, id: string): void {
  put(
    instanceId,
    getComments(instanceId).filter((c) => c.id !== id),
  );
}

export function clearComments(instanceId: string): void {
  if (byInstance.has(instanceId)) put(instanceId, EMPTY);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Subscribe a component to one instance's comments. */
export function useComments(instanceId: string): readonly ReviewComment[] {
  return useSyncExternalStore(subscribe, () => getComments(instanceId));
}

// --- the prompt ----------------------------------------------------------------

/** Lines of code quoted per comment, and the width a quoted line is cut to. */
const QUOTE_LINES = 3;
const QUOTE_WIDTH = 120;

/** `path:12`, or `path:12-14` for a range. */
export function location(c: Pick<ReviewComment, "path" | "fromLine" | "toLine">): string {
  return c.fromLine === c.toLine ? `${c.path}:${c.fromLine}` : `${c.path}:${c.fromLine}-${c.toLine}`;
}

/** The code a comment quotes, cut down to a few short lines, each starting `> `. */
export function quoteLines(quote: string): string[] {
  const lines = quote.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  // Drop the indentation the lines share, so a deep block doesn't run off the side.
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  );
  const cut = (l: string) => {
    const s = Number.isFinite(indent) ? l.slice(indent) : l;
    return s.length > QUOTE_WIDTH ? `${s.slice(0, QUOTE_WIDTH - 1)}…` : s;
  };
  const shown = lines.slice(0, QUOTE_LINES).map((l) => `> ${cut(l)}`.trimEnd());
  if (lines.length > QUOTE_LINES) shown.push(`> … (${lines.length - QUOTE_LINES} more)`);
  return shown;
}

/** One prompt carrying every comment: where it is, the code, and the note. Line
 *  numbers are in the files as they are now on disk. */
export function buildCommentsPrompt(comments: readonly ReviewComment[]): string {
  const n = comments.length;
  const head =
    n === 1
      ? "Review comment on your changes. Line numbers are in the files as they are now. Please address it:"
      : `Review comments on your changes (${n}). Line numbers are in the files as they are now. Please address each one:`;
  const blocks = comments.map((c, i) => {
    const note = c.note.trim().split("\n").map((l) => `   ${l}`.trimEnd());
    return [`${i + 1}. ${location(c)}`, ...quoteLines(c.quote).map((l) => `   ${l}`), ...note].join("\n");
  });
  return [head, ...blocks].join("\n\n");
}
