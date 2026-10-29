// Typed access to the transcript-tailing stream (step 3.1). The Rust backend
// follows each live session's `~/.claude/projects/<…>/<session-id>.jsonl`, reads
// the latest turn's `usage` (the current context-window components), and emits a
// `usage-updated` event per instance as it changes. The usage engine
// (`state/usage`) folds these onto the registry store so the rail card and console
// header show context-window occupancy live — matching Claude Code's `/context`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A live token update for one instance: the latest turn's usage. The context
 *  window is `inputTokens + cacheCreationTokens + cacheReadTokens`; it shrinks
 *  after a `/compact` or `/clear`. */
export interface UsageUpdate {
  instanceId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Subscribe to per-instance token updates. Returns an unlisten function. */
export function onUsageUpdate(cb: (update: UsageUpdate) => void): Promise<UnlistenFn> {
  return listen<UsageUpdate>("usage-updated", (event) => cb(event.payload));
}

/** A main-thread turn ended (its `turn_duration` line was written), with the
 *  background agents + workflows + shells + monitors still running at that point. */
export interface TurnEnded {
  instanceId: string;
  pendingBackground: number;
}

/** Subscribe to turn ends. Only turns appended while the app is tailing — a
 *  transcript's history is never replayed. Returns an unlisten function. */
export function onTurnEnded(cb: (ended: TurnEnded) => void): Promise<UnlistenFn> {
  return listen<TurnEnded>("turn-ended", (event) => cb(event.payload));
}

// --- transcript stream (step T1) --------------------------------------------
// The lines themselves: paged reads for history and a per-instance follow for
// what Claude Code appends. Lines are raw JSONL text — `transcript/model` (T2)
// parses them. Every offset is a byte offset on a line boundary, so history and
// the live stream join without a gap: `followTranscript` returns the offset the
// live stream continues from, and everything before it is read with
// `readTranscriptBack`.

/** One page of transcript lines. */
export interface TranscriptPage {
  /** The transcript the page came from (its session id); null when the instance
   *  has no transcript yet. Compare with the follow's to discard a stale page. */
  sessionId: string | null;
  /** Raw JSONL lines, in file order. */
  lines: string[];
  /** Offset of the first line. */
  offset: number;
  /** Offset just past the last line — where the next forward read continues. */
  nextOffset: number;
  /** End of the last complete line in the file; `nextOffset === end` means the
   *  page reached it. */
  end: number;
}

/** Where a follow stands when it is taken. */
export interface TranscriptFollow {
  sessionId: string | null;
  /** The live stream continues from here; everything before it is history. */
  offset: number;
}

/** New complete lines of a followed transcript. Re-delivery is possible when a
 *  second consumer joins a running follow — dedupe by `offset`. */
export interface TranscriptAppended {
  instanceId: string;
  sessionId: string | null;
  lines: string[];
  offset: number;
  nextOffset: number;
}

/** The instance moved to another transcript: drop the lines held for it. */
export interface TranscriptRotated {
  instanceId: string;
  /** The transcript it is on now; null between a `/clear` and its first prompt. */
  sessionId: string | null;
  /** The live stream continues from here. Non-zero means there is history to page
   *  (the console was resumed onto an existing session). */
  offset: number;
  /** "clear" — `/clear`; "session" — the console moved to another session;
   *  "truncated" — the file shrank. */
  reason: "clear" | "session" | "truncated";
}

/** Start following an instance's transcript (reference-counted in the backend).
 *  Subscribe to `onTranscriptAppended` *before* calling this, and pair every call
 *  with `unfollowTranscript`. */
export function followTranscript(instanceId: string): Promise<TranscriptFollow> {
  return invoke("transcript_follow", { instanceId });
}

/** Release a follow taken with `followTranscript`. */
export function unfollowTranscript(instanceId: string): Promise<void> {
  return invoke("transcript_unfollow", { instanceId });
}

/** Read complete lines forward from `fromOffset` (0, or an offset the backend
 *  returned). `maxBytes` defaults to 256 KiB; a longer single line comes whole. */
export function readTranscript(
  instanceId: string,
  fromOffset: number,
  maxBytes?: number,
): Promise<TranscriptPage> {
  return invoke("transcript_read", { instanceId, fromOffset, maxBytes });
}

/** Read the page of complete lines ending at `beforeOffset` (the end of the file
 *  when omitted) — history, newest page first. */
export function readTranscriptBack(
  instanceId: string,
  beforeOffset?: number,
  maxBytes?: number,
): Promise<TranscriptPage> {
  return invoke("transcript_read_back", { instanceId, beforeOffset, maxBytes });
}

/** `readTranscriptBack` for any session by its id, not an instance's current one:
 *  the office's standup (O5.5) reads yesterday's sessions. */
export function readSessionBack(
  sessionId: string,
  beforeOffset?: number,
  maxBytes?: number,
): Promise<TranscriptPage> {
  return invoke("transcript_read_session_back", { sessionId, beforeOffset, maxBytes });
}

/** Subscribe to appended lines for every followed instance. */
export function onTranscriptAppended(cb: (e: TranscriptAppended) => void): Promise<UnlistenFn> {
  return listen<TranscriptAppended>("transcript-appended", (event) => cb(event.payload));
}

/** Subscribe to transcript rotations for every followed instance. */
export function onTranscriptRotated(cb: (e: TranscriptRotated) => void): Promise<UnlistenFn> {
  return listen<TranscriptRotated>("transcript-rotated", (event) => cb(event.payload));
}
