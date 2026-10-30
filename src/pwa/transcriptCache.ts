// The tail of a session's transcript, kept on the phone so its console opens at
// once, and offline (`transcriptSource`'s `cache`). Pure: no storage, no socket.
//
// The socket's frames already say where every line sits in the file: a page of
// history ends where the next begins, and live lines continue from the last
// `nextOffset`. So the cache is a run of contiguous chunks `[offset, nextOffset)`
// of one transcript, grown at either end as frames arrive and cut from the front
// past a size bound. Lines inside a chunk carry no offsets of their own (the
// desktop drops bookkeeping lines before they travel), so only whole chunks go.
//
// Reopening, the feed is handed the cached tail as its history and the socket
// asks to resume from the cache's end: the desktop goes on from there, or says
// `start` when it can't (another session, a truncated file) and the feed starts
// over from the desktop's copy. The desktop always wins.

import type { TranscriptPage } from "../ipc/transcript";

export interface Chunk {
  offset: number;
  nextOffset: number;
  lines: string[];
}

export interface TranscriptCache {
  sessionId: string;
  /** Offset of the first cached line; above zero there is more history. */
  start: number;
  /** Where the live stream goes on from. */
  end: number;
  chunks: Chunk[];
  /** When it last changed (epoch ms). */
  at: number;
}

/** Bounds for one session's cache: the newest of what's kept. */
export const MAX_LINES = 400;
export const MAX_CHARS = 600_000;

export function fresh(sessionId: string, offset: number, now = Date.now()): TranscriptCache {
  return { sessionId, start: offset, end: offset, chunks: [], at: now };
}

/** Live lines `[offset, nextOffset)`; null when they don't continue the cache. */
export function appended(
  c: TranscriptCache,
  sessionId: string | null,
  offset: number,
  nextOffset: number,
  lines: readonly string[],
  now = Date.now(),
): TranscriptCache | null {
  if (sessionId !== c.sessionId || offset !== c.end || nextOffset < offset) return null;
  if (nextOffset === offset && lines.length === 0) return c;
  return trim({ ...c, end: nextOffset, chunks: [...c.chunks, { offset, nextOffset, lines: [...lines] }], at: now });
}

/** A page of history; null when it doesn't end where the cache begins. */
export function prepended(c: TranscriptCache, page: TranscriptPage, now = Date.now()): TranscriptCache | null {
  if (page.sessionId !== c.sessionId || page.nextOffset !== c.start || page.offset > page.nextOffset) return null;
  const next = { ...c, start: page.offset, chunks: [{ offset: page.offset, nextOffset: page.nextOffset, lines: [...page.lines] }, ...c.chunks], at: now };
  // Grown at the front past the bound: the page goes again, not the tail.
  return size(next).lines > MAX_LINES || size(next).chars > MAX_CHARS ? c : next;
}

function size(c: TranscriptCache): { lines: number; chars: number } {
  let lines = 0;
  let chars = 0;
  for (const ch of c.chunks) {
    lines += ch.lines.length;
    for (const l of ch.lines) chars += l.length;
  }
  return { lines, chars };
}

/** Drop the oldest chunks past the bounds; the newest always stays. */
export function trim(c: TranscriptCache, maxLines = MAX_LINES, maxChars = MAX_CHARS): TranscriptCache {
  let { lines, chars } = size(c);
  if (lines <= maxLines && chars <= maxChars) return c;
  const chunks = [...c.chunks];
  while (chunks.length > 1 && (lines > maxLines || chars > maxChars)) {
    const gone = chunks.shift()!;
    lines -= gone.lines.length;
    for (const l of gone.lines) chars -= l.length;
  }
  return { ...c, chunks, start: chunks[0]?.offset ?? c.end };
}

/** The cached page ending at `before`, all of the cache up to there in one go;
 *  null when `before` isn't one of its chunk ends. */
export function pageEnding(c: TranscriptCache, before: number): TranscriptPage | null {
  if (c.chunks.length === 0 || before <= c.start) return null;
  const upto = before === c.end ? c.chunks.length : c.chunks.findIndex((ch) => ch.nextOffset === before) + 1;
  if (upto <= 0) return null;
  const lines = c.chunks.slice(0, upto).flatMap((ch) => ch.lines);
  return { sessionId: c.sessionId, lines, offset: c.start, nextOffset: before, end: c.end };
}

/** A kept value that still looks like a cache (it came off the disk). */
export function valid(v: unknown): v is TranscriptCache {
  const c = v as TranscriptCache | null;
  return (
    !!c &&
    typeof c.sessionId === "string" &&
    typeof c.start === "number" &&
    typeof c.end === "number" &&
    Array.isArray(c.chunks) &&
    c.chunks.every((ch) => typeof ch.offset === "number" && typeof ch.nextOffset === "number" && Array.isArray(ch.lines))
  );
}
