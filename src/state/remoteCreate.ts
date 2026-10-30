// Sessions created from the phone (step R7) — the record of each `create` request,
// and the two checks on a new console's screen that the creation flow
// (`state/remoteActions`) waits on.
//
// The record is what makes a request idempotent: a retried tap or an action replayed
// after a reconnect carries the same `requestId`, finds it here, and does nothing.
// It also goes back to the phone in the snapshot (`RemoteMirror`), so the phone
// learns the new instance's id and what happened to its first prompt.
//
// Transient: a restart forgets it, and the phone only cares about the last minutes.

import { useSyncExternalStore } from "react";

import type { RemoteCreated } from "../remote/protocol";

/** How many requests are remembered (newest first). */
export const CREATED_KEEP = 20;

let created: readonly RemoteCreated[] = [];
const listeners = new Set<() => void>();

function set(next: readonly RemoteCreated[]): void {
  created = next;
  for (const l of listeners) l();
}

/** Record a new request. False if `requestId` was already seen — the caller must
 *  then do nothing. */
export function beginCreate(requestId: string): boolean {
  if (!requestId || created.some((c) => c.requestId === requestId)) return false;
  const entry: RemoteCreated = { requestId, instanceId: null, state: "creating", message: null };
  set([entry, ...created].slice(0, CREATED_KEEP));
  return true;
}

/** Update a request's record. No-op if it has been forgotten. */
export function updateCreate(requestId: string, patch: Partial<Omit<RemoteCreated, "requestId">>): void {
  if (!created.some((c) => c.requestId === requestId)) return;
  set(created.map((c) => (c.requestId === requestId ? { ...c, ...patch } : c)));
}

export function getCreated(): readonly RemoteCreated[] {
  return created;
}

/** Forget every request (tests). */
export function resetCreated(): void {
  set([]);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Subscribe a component to the request records. */
export function useCreated(): readonly RemoteCreated[] {
  return useSyncExternalStore(subscribe, getCreated);
}

// --- reading a new console's screen -----------------------------------------

/** A rule of the TUI's prompt box: a row that starts as a long horizontal line. */
const RULE = /^\s*─{20,}/;
/** The prompt row: the caret, then a placeholder or nothing. An option row of a
 *  dialog (`❯ 1. Yes, I trust this folder`) has a number and is not one. */
const PROMPT_ROW = /^\s*[❯>](\s|$)(?!\s*\d+\.)/;

/**
 * True when the screen shows Claude's empty prompt box — the caret row with a rule
 * directly above it and another a few rows below — so a pasted prompt will land in
 * it. This is the "ready" signal for a session created from the phone: the TUI
 * fires no hook at startup (T0: `SessionStart` never arrives), and the terminal
 * exists well before the box does.
 *
 * The workspace trust dialog has a rule above its options but its caret row is
 * numbered, so a folder Claude has not been told to trust never reads as ready.
 */
export function promptBoxReady(screen: readonly string[]): boolean {
  return promptRow(screen) !== null;
}

/** How far below the caret row the box's closing rule may be: a long prompt wraps
 *  over many rows in a narrow console (the transcript view's hidden terminal). */
const BOX_ROWS_MAX = 24;

/** The row of the prompt box's caret, or -1 when the screen shows no prompt box. */
function promptRowAt(screen: readonly string[]): number {
  for (let y = 1; y < screen.length; y++) {
    if (!PROMPT_ROW.test(screen[y]) || !RULE.test(screen[y - 1])) continue;
    for (let below = y + 1; below < Math.min(screen.length, y + 1 + BOX_ROWS_MAX); below++) {
      if (RULE.test(screen[below])) return y;
    }
  }
  return -1;
}

/** The prompt box's caret row, or null when the screen shows no prompt box. */
function promptRow(screen: readonly string[]): string | null {
  const y = promptRowAt(screen);
  return y < 0 ? null : screen[y];
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * True when the prompt box still holds `text` — its start, or the chip a long or
 * multi-line paste becomes — so the Enter after it was not taken. Only our own text
 * counts: an empty box, a placeholder, or a dialog in place of the box is false,
 * so a second Enter can never answer something else.
 */
export function inputHolds(screen: readonly string[], text: string): boolean {
  const row = promptRow(screen);
  if (row === null) return false;
  const input = squash(row.replace(PROMPT_ROW, ""));
  if (!input) return false;
  if (input.startsWith("[Pasted text")) return true;
  const head = squash(text).slice(0, 24);
  return head.length > 0 && input.startsWith(head.slice(0, Math.min(head.length, input.length)));
}

/**
 * True when the screen shows the prompt box with anything in it: a prompt that
 * wasn't taken, two run together, or the box's placeholder. An Enter then submits
 * what's there, or does nothing in an empty box; it can't answer a dialog, which
 * has no prompt box.
 */
export function inputHasText(screen: readonly string[]): boolean {
  const row = promptRow(screen);
  return row !== null && squash(row.replace(PROMPT_ROW, "")) !== "";
}

/** The empty box's placeholder (`Try "fix typecheck errors"`). */
const PLACEHOLDER = /^Try ".*"$/;

/**
 * True when the screen shows the prompt box with nothing typed in it: bare, or
 * showing its placeholder. False with text in it, and when there's no box (a
 * dialog, a console this window can't read): then it isn't known to be empty.
 */
export function inputEmpty(screen: readonly string[]): boolean {
  const row = promptRow(screen);
  if (row === null) return false;
  const input = squash(row.replace(PROMPT_ROW, ""));
  return input === "" || PLACEHOLDER.test(input);
}

/** Claude Code's spinner row while it works or compacts: a glyph, a verb with an
 *  ellipsis, then its parenthesis (`✽ Compacting conversation… (15s · ↓ 1.0k
 *  tokens)`, `* Fermenting… (running Stop hooks… 0/2 · 1s)`). A finished turn's
 *  line (`✻ Crunched for 1m 51s · done 1:28 PM`) has no ellipsis. */
const SPINNER_ROW = /^\s*\S\s+\S[^…]*…\s*\(/;
/** How many rows above the prompt box the spinner may sit (tips go under it). */
const SPINNER_ROWS_ABOVE = 8;

/**
 * True when the screen shows Claude Code at rest: its prompt box, with no
 * spinner just above it and no "esc to interrupt". The watchdog's check that a
 * turn or a compaction is over when its hook never came; anything it can't read
 * (a dialog, a picker, the transcript mode) is not at rest.
 */
export function screenAtRest(screen: readonly string[]): boolean {
  const y = promptRowAt(screen);
  if (y < 0) return false;
  if (screen.some((row) => /esc to interrupt/i.test(row))) return false;
  for (let above = Math.max(0, y - 1 - SPINNER_ROWS_ABOVE); above < y - 1; above++) {
    if (SPINNER_ROW.test(screen[above])) return false;
  }
  return true;
}

const TRUST_YES = /Yes, I trust this folder/;
const CARET = /^\s*❯/;

/**
 * The folder-trust dialog's cursor against its "Yes, I trust this folder" option:
 * 0 on it, a positive count of rows when it's below the cursor, negative above;
 * null when the screen shows no such dialog. Claude Code has drawn it both ways
 * (`❯ 1. Yes…` first, and `❯ No, exit` first), so the option is found by its words.
 */
export function trustDialogOffset(screen: readonly string[]): number | null {
  const yes = screen.findIndex((l) => TRUST_YES.test(l));
  if (yes < 0) return null;
  for (let d = 0; d <= 4; d++) {
    for (const y of d === 0 ? [yes] : [yes - d, yes + d]) {
      if (y >= 0 && y < screen.length && CARET.test(screen[y])) return yes - y;
    }
  }
  return null;
}

/** True when the screen's last line with text asks for a password or passphrase —
 *  an SSH login (remote project) that only the terminal can answer. */
export function asksForPassword(screen: readonly string[]): boolean {
  for (let y = screen.length - 1; y >= 0; y--) {
    const line = screen[y].trim();
    if (line) return /(password|passphrase)[^:]*:$/i.test(line);
  }
  return false;
}
