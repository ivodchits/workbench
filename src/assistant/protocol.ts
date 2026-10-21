// The Duck Protocol (step A2; design → Separable, not separate, boundary 2): one
// versioned message set that every surface speaks. The desktop drawer (A3) uses the
// in-process transport below; the phone gets a WebSocket transport (R1) carrying the
// same messages. A new surface is just a new transport.
//
// Surfaces send `ClientMessage`s and render `DuckEvent`s; they never reach into the
// engine or the thread store directly.

import type { DecisionRow, Spend, StoredMessage, ThreadRow } from "../ipc/assistant";
import type { ReaderView } from "./reader";
import type { DuckSettings } from "./settings";
import type { Mode, TrustConfig } from "./trust/decide";
import type { ReplayReport } from "./trust/replay";
import type { Effect } from "./trust/rules";

export type { DecisionRow };

/** The trust engine's state as a surface shows it. */
export interface TrustView extends TrustConfig {
  /** The built-in floor, with whether each entry is on. */
  floor: { id: string; label: string; on: boolean }[];
}

export const PROTOCOL_VERSION = 1;

/** Where a message came from; stored on it. `event` is Workbench itself: a
 *  follow-up a tool scheduled (a watched session finished), not the user.
 *  `phone-voice` was spoken on the phone (step R1): its reply is written to be
 *  heard, and heard there, not out of the desktop's speakers. */
export type Source = "desktop" | "phone" | "voice" | "phone-voice" | "event";

/** The user's own sources (not `event`, not Duck's `duck`). */
export const USER_SOURCES: ReadonlySet<string> = new Set(["desktop", "phone", "voice", "phone-voice"]);

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
  /** Files the call changes, shown as diffs (W5: the plugin file, its scripts). */
  review?: ReviewItem[];
}

/** One file a call changes, for the card's diff. */
export interface ReviewItem {
  label: string;
  /** null: the call makes the file. */
  before: string | null;
  after: string;
}

/** Duck's edit of a project's toolbar (W5), for the thread's chip: the diff of the
 *  plugin file and its scripts, and an undo with the same revision check. */
export interface PluginsEdit {
  projectId: string;
  project: string;
  /** null: the edit made the file. */
  before: string | null;
  after: string;
  /** The file's revision right after the edit. */
  revision: string;
  scripts: { name: string; before: string | null; after: string }[];
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
    | "note"
    /** Duck edited a project's toolbar (W5). */
    | "plugins"
    /** The trust engine says something about this thread (the rate guard). */
    | "trust"
    /** A worker task started here (D1): the thread shows its live card. */
    | "task"
    /** Duck pressed keys in a session's terminal (W6). */
    | "keys"
    /** A line of a session autopilot's step log (P1). */
    | "autopilot"
    /** Duck took a screenshot (V3). */
    | "screen"
    /** A read aloud stopped before its end (V3). */
    | "reader";
  text: string;
  /** `note` only. */
  note?: NoteEdit;
  /** `plugins` only. */
  plugins?: PluginsEdit;
  /** `task` only. */
  task?: { id: string };
}

/** A worker task as a surface shows it (step D1). */
export interface TaskView {
  id: string;
  threadId: string;
  title: string;
  kind: string;
  state: string;
  model: string;
  effort: string;
  tier: string;
  instanceId: string | null;
  folder: string;
  /** Epoch ms. */
  started: number | null;
  finished: number | null;
  headline: string | null;
  /** Step D2: a session or the API; why it runs there or waits; an API worker's
   *  cost so far. */
  runner: "session" | "api";
  why: string | null;
  costUsd: number | null;
  /** The worker's questions Duck answered. */
  answers: { question: string; answer: string; reason: string }[];
}

/** A session's plan autopilot as a surface shows it (step P1). */
export interface AutopilotView {
  instanceId: string;
  /** The session's title. */
  session: string;
  /** The thread it reports to. */
  threadId: string;
  state: "running" | "paused" | "stopped";
  /** The card's line ("step 2 of 5 (P1) · working"). */
  text: string;
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
  | { type: "settings.set"; settings: Partial<DuckSettings> }
  // Trust (step T1). Each change is answered with a `trust` event.
  /** The kill switch. */
  | { type: "trust.pause"; paused: boolean }
  | {
      type: "trust.rule.add";
      effect: Effect;
      pattern: string;
      /** null: global. */
      projectId: string | null;
    }
  | { type: "trust.rule.remove"; id: string }
  | { type: "trust.mode"; projectId: string; mode: Mode }
  /** Turn a floor entry off or back on (the surface asks for a typed confirm). */
  | { type: "trust.floor"; id: string; enabled: boolean }
  /** A page of the decision log, newest first, older than `before` (an id). */
  | { type: "trust.decisions"; before: number | null }
  /** Replay the past `days`' Claude Code tool calls through the prompt policy
   *  (step T2), with the judge on up to `judgeMax` of them. */
  | { type: "trust.replay"; days: number; judgeMax: number }
  /** Close a worker task (step D1): its console closes, its files stay. */
  | { type: "task.close"; taskId: string }
  /** Run a worker task again one tier up (step D2), as a new task. */
  | { type: "task.rerun"; taskId: string }
  /** A session autopilot's buttons on its card (step P1). */
  | { type: "autopilot"; instanceId: string; action: "pause" | "resume" | "stop" }
  /** The reader bar's buttons (step V3). */
  | { type: "reader"; action: ReaderAction };

export type ReaderAction = "pause" | "resume" | "next" | "prev" | "stop";

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
  /** The trust engine's state (step T1), on `sync` and after every change. */
  | { type: "trust"; trust: TrustView }
  /** Answer to `trust.decisions`. */
  | {
      type: "decisions";
      rows: DecisionRow[];
      before: number | null;
      /** Older rows exist. */
      more: boolean;
    }
  /** A decision was just logged. */
  | { type: "decision"; row: DecisionRow }
  /** Duck's worker tasks (step D1), newest first, on `sync` and after every
   *  change. */
  | { type: "tasks"; tasks: TaskView[] }
  /** Every autopilot not stopped (step P1), on `sync` and after every change. */
  | { type: "autopilots"; autopilots: AutopilotView[] }
  /** The replay's progress (`report` null, judged so far), then its report. */
  | { type: "replay"; done: number; of: number; report: ReplayReport | null }
  /** What's being read aloud (step V3), on `sync` and after every change; null
   *  when nothing is. */
  | { type: "reader"; reader: ReaderView | null }
  /** A request from a surface failed (an unknown thread, storage down, …). */
  | { type: "error"; message: string };

export type Stamped<T> = T & { v: typeof PROTOCOL_VERSION };

export interface Transport {
  send(msg: ClientMessage): void;
  subscribe(cb: (e: Stamped<DuckEvent>) => void): () => void;
}

/** What a transport connects to: the running Duck. */
export interface DuckEndpoint {
  /** With `reply`, the answers to this request (`threads`, `history`, an error…)
   *  go there only; changes still go to every surface. */
  handle(msg: ClientMessage, reply?: (e: DuckEvent) => void): void;
  onEvent(cb: (e: DuckEvent) => void): () => void;
}

/** The in-process transport for surfaces in the main window. */
export function createLocalTransport(duck: DuckEndpoint): Transport {
  return {
    send: (msg) => duck.handle(msg),
    subscribe: (cb) => duck.onEvent((e) => cb({ ...e, v: PROTOCOL_VERSION })),
  };
}
