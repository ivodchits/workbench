// Prompt composer state (step T4) — the draft each console's transcript view is
// holding, and the pure rules the composer applies to what is typed.
//
// A draft belongs to an instance, not to a mounted component: it survives the
// terminal/transcript toggle, a tab switch, tearing the console off into its own
// window, and a restart (it is kept in `localStorage`, which every window of the
// app shares). It is cleared when the prompt is sent.
//
// Framework-free apart from the one hook, so the rules are testable on their own.

import { useSyncExternalStore } from "react";

import { spliceReference } from "./fileDrag";

const KEY_PREFIX = "wb-draft:";

const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

function stored(instanceId: string): string {
  try {
    return localStorage.getItem(KEY_PREFIX + instanceId) ?? "";
  } catch {
    return ""; // storage unavailable: drafts just live for this window's lifetime
  }
}

export function getDraft(instanceId: string): string {
  let draft = drafts.get(instanceId);
  if (draft === undefined) {
    draft = stored(instanceId);
    drafts.set(instanceId, draft);
  }
  return draft;
}

export function setDraft(instanceId: string, text: string): void {
  if (getDraft(instanceId) === text) return;
  drafts.set(instanceId, text);
  try {
    if (text) localStorage.setItem(KEY_PREFIX + instanceId, text);
    else localStorage.removeItem(KEY_PREFIX + instanceId);
  } catch {
    // not persisted; the in-memory draft still holds
  }
  for (const l of listeners) l();
}

/** Add `text` to an instance's draft from outside its composer (a template picked
 *  in the library). Goes on its own line after
 *  whatever is already there. */
export function insertIntoDraft(instanceId: string, text: string): void {
  const draft = getDraft(instanceId);
  setDraft(instanceId, draft && !draft.endsWith("\n") ? `${draft}\n${text}` : draft + text);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Subscribe a component to one instance's draft. */
export function useDraft(instanceId: string): string {
  return useSyncExternalStore(subscribe, () => getDraft(instanceId));
}

/** Attribute the composer's text field carries, so focus (and, in step D1, a
 *  drop) can find the field of a given instance. */
export const COMPOSER_ATTR = "data-wb-composer";

/** Put the keyboard in an instance's composer, if one is on screen. */
export function focusComposer(instanceId: string): void {
  document
    .querySelector<HTMLTextAreaElement>(`textarea[${COMPOSER_ATTR}="${CSS.escape(instanceId)}"]`)
    ?.focus({ preventScroll: true });
}

/** Put file references (step D1) into an instance's draft: at the caret of its
 *  composer when one is on screen, else at the end. */
export function insertReferences(instanceId: string, text: string): void {
  const field = document.querySelector<HTMLTextAreaElement>(
    `textarea[${COMPOSER_ATTR}="${CSS.escape(instanceId)}"]`,
  );
  const draft = getDraft(instanceId);
  const next = spliceReference(
    draft,
    field?.selectionStart ?? draft.length,
    field?.selectionEnd ?? draft.length,
    text,
  );
  setDraft(instanceId, next.text);
  if (!field) return;
  field.focus({ preventScroll: true });
  // Once the field has rendered the new text (which leaves its caret at the end).
  requestAnimationFrame(() => field.setSelectionRange(next.caret, next.caret));
}

// --- rules -------------------------------------------------------------------

const ESC = "\x1b";

/** The bytes a terminal sends for a paste of `text` in bracketed-paste mode, which
 *  the claude TUI always enables: the block arrives as one paste, so a line break
 *  in it does not submit. Escape characters are dropped — one could end the paste
 *  early and have the rest read as keystrokes. */
export function encodePaste(text: string): Uint8Array {
  const body = text.split(ESC).join("").replace(/\r?\n/g, "\r");
  return new TextEncoder().encode(`${ESC}[200~${body}${ESC}[201~`);
}

/** Built-in commands that, typed bare, answer inside the TUI — a menu to pick
 *  from, or a screen that is never written to the transcript. Sent from the
 *  composer they would leave the session waiting in a dialog the transcript view
 *  can't show, so the composer sends them and shows the terminal. Everything else
 *  (`/clear`, `/compact`, custom commands, skills) passes through as typed. */
const TERMINAL_COMMANDS = new Set([
  "agents",
  "bashes",
  "config",
  "context",
  "cost",
  "doctor",
  "export",
  "help",
  "hooks",
  "ide",
  "login",
  "logout",
  "mcp",
  "memory",
  "model",
  "output-style",
  "permissions",
  "plugin",
  "resume",
  "rewind",
  "status",
  "statusline",
  "tasks",
  "theme",
  "usage",
]);

/** If `text` is one of those commands with no argument, its name (`"model"`);
 *  otherwise null. With an argument (`/model opus`) the command acts directly. */
export function terminalCommand(text: string): string | null {
  const m = /^\/([a-z][a-z-]*)$/.exec(text.trim());
  return m && TERMINAL_COMMANDS.has(m[1]) ? m[1] : null;
}

/** `text` with `insert` put in place of the range `[start, end)`, and where the
 *  caret (or selection) should be afterwards: on the first `{n}` placeholder of
 *  the inserted text when it has one, so it can be typed over, else after it. */
export function spliceText(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; selection: [number, number] } {
  const next = text.slice(0, start) + insert + text.slice(end);
  const hole = /\{\d+\}/.exec(insert);
  const selection: [number, number] = hole
    ? [start + hole.index, start + hole.index + hole[0].length]
    : [start + insert.length, start + insert.length];
  return { text: next, selection };
}
