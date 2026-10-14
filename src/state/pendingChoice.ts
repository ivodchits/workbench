// Pending choice (step T5) — what a "needs you" agent is asking, per instance, so
// the transcript view can show the question and take the answer.
//
// Built from the hook stream: `PermissionRequest` opens a prompt (a tool wanting
// permission, an `AskUserQuestion`, or an `ExitPlanMode` plan approval) and carries
// what is being asked. It is closed by whatever shows the prompt was dealt with —
// here, in the terminal, or by the turn ending:
//
//   - the hook events that follow an approval (`PostToolUse` for the tool,
//     `PostToolBatch`) or a new turn (`UserPromptSubmit`, `Stop`, …);
//   - the status engine leaving needs-you for any reason (an interrupt);
//   - the transcript. Choosing "No" or pressing Esc on a prompt fires **no** hook
//     (T0), so the view also reports the conversation it is showing, and a result
//     for the tool, or an interruption line, closes the prompt.
//
// Where the option list comes from (the T0 decision): a question's options are in
// the hook payload, and the digit to send is the option's position. A permission
// or plan prompt's options are not — the hook's `permission_suggestions` do not
// match what the TUI offers — so they are read from the bottom of the terminal
// screen (`parseOptionRows`), which is the one sanctioned read of terminal output.
// Until that succeeds, or when it can't, a permission prompt offers a plain Allow.
//
// Ephemeral, like live status: a prompt belongs to a running session.

import { useSyncExternalStore } from "react";

import { onHookEvent, type HookEnvelope, type HookEvent } from "../ipc/hooks";
import type { Item } from "../transcript/model";
import { getLiveStatuses, markInterrupted, onStatusTransition } from "./status";

export type ChoiceKind = "permission" | "question" | "plan";

/** One answer the prompt offers. */
export interface ChoiceOption {
  /** The digit that selects it in the TUI (1–9). */
  key: number;
  label: string;
  /** A question option's description; empty otherwise. */
  detail: string;
  /** Selecting it opens a text field in the TUI rather than answering. */
  typed: boolean;
}

export interface ChoiceQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

export interface PendingChoice {
  /** Unique per prompt, so a card can tell a new prompt from an update. */
  id: string;
  kind: ChoiceKind;
  toolName: string;
  input: Record<string, unknown>;
  /** From the `PreToolUse` just before (the request itself has none). */
  toolUseId: string | null;
  /** When the prompt opened, epoch ms. */
  at: number;
  /** `question` only. */
  questions: ChoiceQuestion[];
  options: ChoiceOption[];
  /** `hook` — the payload; `terminal` — read off the screen; `generic` — neither
   *  (yet): a permission prompt's Allow. */
  source: "hook" | "terminal" | "generic";
  /** Why the card can't take the answer itself (it is given in the terminal);
   *  null when it can. */
  terminalOnly: string | null;
  /** The answer sent from the card, until the prompt is seen to close. */
  sent: { label: string; at: number } | null;
}

export interface ChoiceState {
  /** The last tool announced by `PreToolUse` — the source of `toolUseId`. */
  lastTool: { id: string; name: string } | null;
  pending: PendingChoice | null;
}

const EMPTY_STATE: ChoiceState = { lastTool: null, pending: null };

// --- building a prompt -------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function questionsOf(input: Json): ChoiceQuestion[] {
  if (!Array.isArray(input.questions)) return [];
  return input.questions.filter(isObject).map((q) => ({
    header: str(q.header),
    question: str(q.question),
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).filter(isObject).map((o) => ({
      label: str(o.label),
      description: str(o.description),
    })),
  }));
}

const GENERIC_ALLOW: ChoiceOption[] = [{ key: 1, label: "Allow", detail: "", typed: false }];

function open(event: HookEvent, toolUseId: string | null, now: number): PendingChoice {
  const toolName = event.tool_name ?? "";
  const input = isObject(event.tool_input) ? event.tool_input : {};
  const base = { id: `${now}:${toolUseId ?? toolName}`, toolName, input, toolUseId, at: now, sent: null };

  if (toolName === "AskUserQuestion") {
    const questions = questionsOf(input);
    const only = questions.length === 1 ? questions[0] : null;
    // One question, one answer: digit n picks option n and answers at once.
    // Anything else needs several keys in step with the TUI (T0), so it is
    // answered there.
    const terminalOnly =
      questions.length === 0
        ? "this question could not be read"
        : questions.length > 1
          ? "several questions are answered one after another"
          : only?.multiSelect
            ? "more than one option can be picked"
            : !only || only.options.length === 0 || only.options.length > 9
              ? "this question has no options to pick from"
              : null;
    return {
      ...base,
      kind: "question",
      questions,
      options:
        terminalOnly || !only
          ? []
          : only.options.map((o, i) => ({ key: i + 1, label: o.label, detail: o.description, typed: false })),
      source: "hook",
      terminalOnly,
    };
  }
  if (toolName === "ExitPlanMode") {
    // What approving means depends on the user's settings (option 1 can be "yes,
    // and use auto mode"), so a plan is only answered from options actually read.
    return {
      ...base,
      kind: "plan",
      questions: [],
      options: [],
      source: "generic",
      terminalOnly: "the approval options have not been read from the terminal",
    };
  }
  return {
    ...base,
    kind: "permission",
    questions: [],
    options: GENERIC_ALLOW,
    source: "generic",
    terminalOnly: null,
  };
}

/** Pure transition: fold one hook event into an instance's prompt state. Returns
 *  `prev` itself when nothing changed. */
export function reduceChoice(prev: ChoiceState, event: HookEvent, now: number): ChoiceState {
  const pending = prev.pending;
  const closed = (): ChoiceState => (pending ? { ...prev, pending: null } : prev);

  switch (event.hook_event_name ?? "") {
    case "PreToolUse": {
      // Tools of one batch prompt one at a time (T0), so this never closes a
      // prompt — a subagent's tool can start while the main thread waits.
      const id = str(event.tool_use_id);
      return id ? { ...prev, lastTool: { id, name: event.tool_name ?? "" } } : prev;
    }
    case "PermissionRequest": {
      const last = prev.lastTool;
      const toolUseId = last && last.name === (event.tool_name ?? "") ? last.id : null;
      return { ...prev, pending: open(event, toolUseId, now) };
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      // The tool ran: its prompt was approved. Another tool finishing (a
      // subagent's) says nothing about this one.
      if (!pending) return prev;
      const id = str(event.tool_use_id);
      const same = pending.toolUseId
        ? id === pending.toolUseId
        : (event.tool_name ?? "") === pending.toolName;
      return same ? closed() : prev;
    }
    // Everything on which the status engine leaves needs-you.
    case "PostToolBatch":
    case "UserPromptSubmit":
    case "PermissionDenied":
    case "Stop":
    case "StopFailure":
    case "SessionEnd":
      return closed();
    default:
      return prev;
  }
}

// --- the transcript's say ----------------------------------------------------

/** Items looked at from the end; a prompt's own result is among the last few. */
const TAIL = 40;

/**
 * Whether the conversation shows the prompt as dealt with: `answered` — its tool
 * has a result; `declined` — the tool was refused, or the turn was interrupted
 * after the prompt opened (neither fires a hook). Null while it is still open.
 */
export function resolvedBy(pending: PendingChoice, items: readonly Item[]): "answered" | "declined" | null {
  for (let i = items.length - 1; i >= 0 && i >= items.length - TAIL; i--) {
    const item = items[i];
    if (item.kind === "tool" && item.id === pending.toolUseId) {
      if (item.status === "running") return null;
      return item.status === "denied" ? "declined" : "answered";
    }
    if (item.kind === "interrupted" && item.timestamp && Date.parse(item.timestamp) > pending.at) {
      return "declined";
    }
  }
  return null;
}

// --- options from the terminal screen ----------------------------------------

/** When to look at the terminal screen for a prompt's options, ms after it opens:
 *  the hook fires before the TUI has drawn the prompt. */
export const READ_AT_MS = [0, 150, 400, 900, 1800, 3500];

const OPTION_ROW = /^[\s│|]*([❯>›]\s*)?(\d)\.\s+(\S.*?)[\s│|]*$/;
/** Rows whose option opens a text field instead of answering. */
const TYPED_LABEL = /tell claude|type something|type here|chat about/i;
/** A prompt sits at the bottom of the screen: at most this many non-empty rows
 *  (the key hints) may follow its last option. */
const MAX_ROWS_AFTER = 6;

/** Whether a label row that wrapped onto `next` was cut inside a word. The TUI
 *  wraps at spaces and only cuts a word too long to fit — a path, in practice — so
 *  a row reaching the screen's edge was cut only if the word there is one. */
function cutMidWord(row: string, next: string, width: number): boolean {
  if (row.trimEnd().length < width - 1) return false;
  const end = row.replace(/[\s│|]+$/, "");
  const word = (end.split(/\s/).pop() ?? "") + (next.split(/\s/)[0] ?? "");
  return /[/\\]/.test(word) || word.length > 24;
}

/**
 * The numbered options of the prompt at the bottom of a terminal screen, or null
 * when there is no such prompt. Deliberately strict, since each option's digit is
 * what gets sent: the rows must count up from 1 without a gap, one of them must
 * carry the selection marker (`❯`), and nothing but a few hint lines may follow.
 * A numbered list in an answer has no marker; an old prompt is not at the bottom.
 */
export function parseOptionRows(screen: readonly string[]): ChoiceOption[] | null {
  const rows = screen.map((line) => {
    const m = OPTION_ROW.exec(line);
    return m ? { key: Number(m[2]), label: m[3], marked: Boolean(m[1]), column: line.indexOf(m[2]) } : null;
  });
  // The last row numbered 1 starts the candidate prompt.
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.key === 1) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  // The widest row is the screen's width (the TUI draws rules across it): a row
  // that reaches it was cut mid-word, and its next row carries straight on.
  const width = Math.max(...screen.map((line) => line.trimEnd().length));
  const options: ChoiceOption[] = [];
  let marked = false;
  let last = start;
  let column = 0;
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (!row) {
      // Directly under an option and indented past its number: the rest of a
      // wrapped label, or the option's hint line.
      const indent = screen[i].search(/\S/);
      if (indent <= column) continue;
      const more = screen[i].replace(/^[\s│|]+|[\s│|]+$/g, "");
      const option = options[options.length - 1];
      if (!more || last !== i - 1) continue;
      option.label += (cutMidWord(screen[i - 1], more, width) ? "" : " ") + more;
      last = i;
      continue;
    }
    if (row.key !== options.length + 1) return null;
    options.push({ key: row.key, label: row.label, detail: "", typed: false });
    marked ||= row.marked;
    column = row.column;
    last = i;
  }
  for (const option of options) option.typed = TYPED_LABEL.test(option.label);
  const after = screen.slice(last + 1).filter((line) => line.trim()).length;
  if (options.length < 2 || !marked || after > MAX_ROWS_AFTER) return null;
  return options;
}

// --- store -------------------------------------------------------------------

let states: ReadonlyMap<string, ChoiceState> = new Map();
const listeners = new Set<() => void>();

function put(instanceId: string, next: ChoiceState): void {
  if (states.get(instanceId) === next) return;
  const map = new Map(states);
  map.set(instanceId, next);
  states = map;
  for (const l of listeners) l();
}

function update(instanceId: string, change: (pending: PendingChoice) => PendingChoice | null): void {
  const state = states.get(instanceId);
  if (!state?.pending) return;
  const next = change(state.pending);
  if (next !== state.pending) put(instanceId, { ...state, pending: next });
}

function sameOptions(a: readonly ChoiceOption[], b: readonly ChoiceOption[]): boolean {
  return a.length === b.length && a.every((o, i) => o.label === b[i].label && o.typed === b[i].typed);
}

/** Fold one accepted hook event into the store. */
export function ingestChoiceEvent(envelope: HookEnvelope): void {
  const prev = states.get(envelope.instanceId) ?? EMPTY_STATE;
  put(envelope.instanceId, reduceChoice(prev, envelope.event, Date.now()));
}

export function getPendingChoice(instanceId: string): PendingChoice | null {
  return states.get(instanceId)?.pending ?? null;
}

/** Drop an instance's prompt (it was dealt with, or its session is gone). */
export function clearPendingChoice(instanceId: string): void {
  update(instanceId, () => null);
}

/** The options read off the terminal screen for prompt `id` (ignored if another
 *  prompt has replaced it, or its options are the payload's). */
export function setTerminalOptions(instanceId: string, id: string, options: ChoiceOption[]): void {
  update(instanceId, (p) =>
    p.id !== id || p.source === "hook" || (p.source === "terminal" && sameOptions(p.options, options))
      ? p
      : { ...p, options, source: "terminal", terminalOnly: null },
  );
}

/** Record that the card sent an answer, so it stops offering the options. */
export function markChoiceSent(instanceId: string, id: string, label: string): void {
  update(instanceId, (p) => (p.id !== id ? p : { ...p, sent: { label, at: Date.now() } }));
}

/**
 * The view reports the conversation it is showing. Closes the prompt when the
 * transcript says it was dealt with; a refusal or an interruption also ends the
 * turn without any hook, so the status is moved off needs-you here.
 */
export function reconcileWithTranscript(instanceId: string, items: readonly Item[]): void {
  const pending = getPendingChoice(instanceId);
  if (!pending) return;
  const outcome = resolvedBy(pending, items);
  if (!outcome) return;
  clearPendingChoice(instanceId);
  if (outcome === "declined" && getLiveStatuses().get(instanceId)?.phase === "needs_you") {
    markInterrupted(instanceId);
  }
}

/**
 * Start following the hook stream. Idempotent and never torn down, like the
 * status engine (a stored promise, so StrictMode's double mount subscribes once).
 */
let subscription: Promise<unknown> | null = null;
export function initPendingChoices(): void {
  if (subscription) return;
  subscription = onHookEvent(ingestChoiceEvent).catch(() => {});
  // However needs-you ended — an interrupt fires no hook — the prompt is over.
  onStatusTransition((instanceId, phase) => {
    if (phase !== "needs_you") clearPendingChoice(instanceId);
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Every instance's prompt state; a new map whenever any of them changes. */
export function getChoiceStates(): ReadonlyMap<string, ChoiceState> {
  return states;
}

/** Call `cb` on every change to any instance's prompt. */
export function onChoicesChanged(cb: () => void): () => void {
  return subscribe(cb);
}

/** Subscribe a component to every instance's prompt state (the phone's snapshot). */
export function useChoiceStates(): ReadonlyMap<string, ChoiceState> {
  return useSyncExternalStore(subscribe, getChoiceStates);
}

/** Subscribe a component to one instance's pending prompt. */
export function usePendingChoice(instanceId: string): PendingChoice | null {
  return useSyncExternalStore(subscribe, () => getPendingChoice(instanceId));
}
