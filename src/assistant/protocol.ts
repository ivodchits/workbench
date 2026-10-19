// The Duck Protocol (step A2; design → Separable, not separate, boundary 2): one
// versioned message set that every surface speaks. The desktop drawer (A3) uses the
// in-process transport below; the phone gets a WebSocket transport (R1) carrying the
// same messages. A new surface is just a new transport.
//
// Surfaces send `ClientMessage`s and render `DuckEvent`s; they never reach into the
// engine or the thread store directly.

import type { Spend, StoredMessage, ThreadRow } from "../ipc/assistant";
import type { DuckSettings } from "./settings";

export const PROTOCOL_VERSION = 1;

/** Where a message came from; stored on it. `event` is Workbench itself: a
 *  follow-up a tool scheduled (a watched session finished), not the user. */
export type Source = "desktop" | "phone" | "voice" | "event";

/** Per-message effort (the API's `output_config.effort`). */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** What a thread's turn is doing: `waiting` = parked on a confirmation. */
export type TurnState = "idle" | "thinking" | "streaming" | "tool" | "waiting";

/** A tool call parked until someone allows or denies it. */
export interface ConfirmRequest {
  threadId: string;
  batchId: string;
  toolUseId: string;
  name: string;
  input: unknown;
  /** What the call will do, in a sentence, when the tool can say (e.g. which
   *  option of which session's prompt). */
  summary?: string;
}

/** A note Duck changed (step W2), for the thread's "Duck edited" chip: enough to
 *  show the diff and to undo it with the same revision check. */
export interface NoteEdit {
  projectId: string;
  project: string;
  name: string;
  /** null: the note was made by the edit. */
  before: string | null;
  /** null: the edit deleted the note. */
  after: string | null;
  /** The note's revision right after the edit; null after a delete. */
  revision: string | null;
}

/** The payload of a `notice` message: something the thread shows but the model
 *  never sees (a stopped turn, the budget cap, a refusal, an error). */
export interface Notice {
  kind:
    | "stopped"
    | "cap"
    | "refusal"
    | "max_tokens"
    | "context"
    | "error"
    | "rounds"
    | "note";
  text: string;
  /** `note` only. */
  note?: NoteEdit;
}

// ── surface → Duck ──────────────────────────────────────────────────────────

export type ClientMessage =
  | {
      type: "send";
      /** `null` starts a new thread. */
      threadId: string | null;
      text: string;
      source: Source;
      effort?: Effort;
    }
  | { type: "stop"; threadId: string }
  | {
      type: "confirm";
      threadId: string;
      toolUseId: string;
      allow: boolean;
    }
  | { type: "thread.new"; mode?: string }
  /** Delete a thread (refused while a reply is running: stop it first). */
  | { type: "thread.delete"; threadId: string }
  /** Ask for the thread list, the open confirmations and the spend (a surface
   *  connecting). */
  | { type: "sync" }
  /** Ask for a thread's stored messages. */
  | { type: "thread.open"; threadId: string }
  /** Change Duck's settings (step W2). */
  | { type: "settings.set"; settings: Partial<DuckSettings> };

// ── Duck → surface ──────────────────────────────────────────────────────────

export type DuckEvent =
  /** Answer to `sync`: every thread, most recent first. */
  | { type: "threads"; threads: ThreadRow[] }
  /** Answer to `thread.open`. */
  | {
      type: "history";
      threadId: string;
      messages: StoredMessage[];
      state: TurnState;
    }
  /** A thread was created or renamed. */
  | { type: "thread"; thread: ThreadRow }
  /** A thread was deleted, with its messages and open confirmations. */
  | { type: "threadDeleted"; threadId: string }
  /** A message was appended to a thread (and stored). */
  | { type: "message"; message: StoredMessage }
  /** Reply text as it streams; the full message follows as `message`. */
  | { type: "delta"; threadId: string; text: string }
  | {
      type: "tool";
      threadId: string;
      phase: "start" | "end";
      toolUseId: string;
      name: string;
      input: unknown;
      /** On `end`: whether it succeeded. */
      ok?: boolean;
    }
  | { type: "confirm"; request: ConfirmRequest }
  /** A confirmation was answered (here or on another surface). */
  | { type: "confirmed"; threadId: string; toolUseId: string; allow: boolean }
  | { type: "turnState"; threadId: string; state: TurnState; queued: number }
  /** The month's API spend, after every metered call and on `sync`. `turns` holds
   *  each thread's latest turn cost (since the app started), in USD. */
  | { type: "spend"; spend: Spend; turns: Record<string, number> }
  /** Duck's settings, on `sync` and after every change. */
  | { type: "settings"; settings: DuckSettings }
  /** A request from a surface failed (an unknown thread, storage down, …). */
  | { type: "error"; message: string };

export type Stamped<T> = T & { v: typeof PROTOCOL_VERSION };

export interface Transport {
  send(msg: ClientMessage): void;
  subscribe(cb: (e: Stamped<DuckEvent>) => void): () => void;
}

/** What a transport connects to: the running Duck. */
export interface DuckEndpoint {
  handle(msg: ClientMessage): void;
  onEvent(cb: (e: DuckEvent) => void): () => void;
}

/** The in-process transport for surfaces in the main window. */
export function createLocalTransport(duck: DuckEndpoint): Transport {
  return {
    send: (msg) => duck.handle(msg),
    subscribe: (cb) => duck.onEvent((e) => cb({ ...e, v: PROTOCOL_VERSION })),
  };
}
