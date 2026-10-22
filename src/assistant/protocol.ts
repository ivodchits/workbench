// The Duck Protocol (step A2; design → Separable, not separate, boundary 2): one
// versioned message set that every surface speaks. The desktop drawer (A3) uses the
// in-process transport below; the phone gets a WebSocket transport (R1) carrying the
// same messages. A new surface is just a new transport.
//
// Surfaces send `ClientMessage`s and render `DuckEvent`s; they never reach into the
// engine or the thread store directly.

import type { DecisionRow, Spend, StoredMessage, ThreadRow } from "../ipc/assistant";
import type { ReaderView } from "./reader";
import type { Brain } from "./routing";
import type { Backend } from "./brain/policy";
import type { DuckSettings } from "./settings";
import type { Mode, TrustConfig } from "./trust/decide";
import type { Promotion, PromotionPreview } from "./trust/promote";
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

/** Where you talk to Duck from: the desktop's drawer, or a phone (step A7: each
 *  keeps its own open thread). */
export type Surface = "desktop" | "phone";

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

/** Duck's edit of its core memory (step W4) or of a long-term memory file (L1),
 *  for the thread's chip: the diff, and an undo over the text Duck left. */
export interface MemoryEdit {
  path: string;
  /** A long-term memory file, relative to the workspace (`memory/decisions.md`);
   *  absent for `core.md`. */
  file?: string;
  /** null: the edit made the file. */
  before: string | null;
  after: string;
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
    | "reader"
    /** The thread moved to Haiku past the budget's soft limit (M2), or to the
     *  other brain (M3). */
    | "budget"
    /** The older turns were summarized for the model (A6). */
    | "compacted"
    /** Duck edited its core memory (W4) or its long-term memory (L1). */
    | "memory"
    /** You asked Duck not to remember this thread, or to again (L1). */
    | "memoryOff";
  text: string;
  /** `note` only. */
  note?: NoteEdit;
  /** `plugins` only. */
  plugins?: PluginsEdit;
  /** `memory` only. */
  memory?: MemoryEdit;
  /** `memoryOff` only: false when you turned memory back on. */
  off?: boolean;
  /** `task` only. */
  task?: { id: string };
  /** `compacted` only: Duck's summary, which the requests send in place of every
   *  message up to and including `through` (a seq). */
  compaction?: { summary: string; through: number };
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
  /** A change to Duck (step L3): its card offers the diff and the merge. */
  self: boolean;
  /** Its branch once it finished; `safety` lists the files in the safety layer. */
  changes: { branch: string; files: string[]; uncommitted: string[]; safety: string[] } | null;
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
      /** The model for this one message (step M2): Sonnet past the soft limit. */
      brain?: Brain;
      /** Conversation mode (step V4): start now, keep only on `turn.commit`. */
      provisional?: boolean;
      /** The mode of the thread a `null` `threadId` starts (step S1). */
      mode?: string;
    }
  | { type: "stop"; threadId: string }
  /** A provisional turn stands, or is dropped (you went on talking). */
  | { type: "turn.commit"; threadId: string }
  | { type: "turn.withdraw"; threadId: string }
  | {
      type: "confirm";
      threadId: string;
      toolUseId: string;
      allow: boolean;
    }
  | { type: "thread.new"; mode?: string }
  /** Delete a thread (refused while a reply is running: stop it first). */
  | { type: "thread.delete"; threadId: string }
  /** Compact a thread (step A6): now, or once the reply running there is over. */
  | { type: "thread.compact"; threadId: string }
  /** Don't remember this thread (step L1), or do again. */
  | { type: "thread.memory"; threadId: string; off: boolean }
  /** Keep a thread from housekeeping's clean-up of idle threads (step L4). */
  | { type: "thread.keep"; threadId: string; keep: boolean }
  /** The thread a surface shows now (null: none), so housekeeping leaves it (L4). */
  | { type: "thread.view"; surface: string; threadId: string | null }
  /** Pause, resume, delete or run now a routine (step L4). */
  | { type: "routine.set"; id: string; action: "pause" | "resume" | "delete" | "run" }
  /** Set up the backup: a private GitHub repo (the settings' button, step L4). */
  | { type: "backup.create"; name: string }
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
  /** What promoting an often-approved pattern to Claude Code's allow list would
   *  write (step T3); answered with `promotionPreview`. */
  | { type: "trust.promotion.preview"; key: string }
  /** Promote it: to the project's Claude Code allow list (written over `before`,
   *  the text the preview showed), or as a Duck rule. Answered with `promoted`. */
  | { type: "trust.promote"; key: string; to: "claude" | "rule"; before: string | null }
  | { type: "trust.promotion.dismiss"; key: string }
  /** How long turns took per mode and brain, the past 30 days (step D3);
   *  answered with `timings`. */
  | { type: "timings.get" }
  /** Close a worker task (step D1): its console closes, its files stay. */
  | { type: "task.close"; taskId: string }
  /** Run a worker task again one tier up (step D2), as a new task. */
  | { type: "task.rerun"; taskId: string }
  /** Open a change to Duck's branch in the Diff/Review panel (step L3). */
  | { type: "task.diff"; taskId: string }
  /** A session autopilot's buttons on its card (step P1). */
  | { type: "autopilot"; instanceId: string; action: "pause" | "resume" | "stop" }
  /** The reader bar's buttons (step V3). */
  | { type: "reader"; action: ReaderAction }
  /** Duck's Do Not Disturb (step V5): until a moment (epoch ms), or off (null). */
  | { type: "dnd"; until: number | null };

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
  /** A provisional turn started (step V4): its message isn't kept yet. */
  | { type: "provisional"; threadId: string; text: string; source: Source }
  /** A provisional turn was dropped: forget its streamed text. */
  | { type: "withdrawn"; threadId: string }
  /** Duck moved the conversation (step A7): `surface` opens `threadId`, where
   *  your next turn goes. The open thread is the surface's, so it acts on this. */
  | { type: "goThread"; threadId: string; from: string; surface: Surface }
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
  /** The model and effort a turn runs at (step M2), as it starts. */
  | { type: "routing"; threadId: string; mode?: string; brain: Brain; effort: Effort; backend?: Backend }
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
  /** Duck's routines and its backup (step L4), on `sync` and after every change. */
  | { type: "routines"; routines: RoutineView[]; backup: BackupView | null }
  /** The replay's progress (`report` null, judged so far), then its report. */
  | { type: "replay"; done: number; of: number; report: ReplayReport | null }
  /** The patterns approved often enough to promote (step T3), on `sync` and after
   *  every change. */
  | { type: "promotions"; promotions: Promotion[] }
  /** Answer to `trust.promotion.preview`. */
  | { type: "promotionPreview"; preview: PromotionPreview }
  /** A promotion went through: what it did. */
  | { type: "promoted"; key: string; text: string }
  /** Answer to `timings.get`: a line per mode, brain and model. */
  | { type: "timings"; lines: string[] }
  /** Duck's skills and the modes (built in, and from skills) (step S2), on `sync`
   *  and after every change. */
  | { type: "skills"; skills: SkillView[]; modes: ModeView[] }
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
/** A routine, for the settings (step L4). */
export interface RoutineView {
  id: string;
  title: string;
  /** The schedule in words. */
  when: string;
  does: string;
  on: boolean;
  builtIn: boolean;
  /** Epoch ms. */
  next: number;
  last: number | null;
  lastResult: string | null;
}

/** One of Duck's skills (step S2), for the settings. */
export interface SkillView {
  name: string;
  description: string;
  /** The `SKILL.md`'s absolute path, for the editor. */
  path: string;
  /** The mode it declares, if it's a mode. */
  mode: string | null;
  /** The tools it narrows a turn to. */
  tools: string[] | null;
  /** Why it isn't used; empty when it can be. */
  problems: string[];
  enabled: boolean;
}

/** A mode a new thread can start in (step S1; S2 adds yours), for the picker. */
export interface ModeView {
  id: string;
  title: string;
  about: string;
  /** From a skill (step S2), not built in. */
  own: boolean;
}

/** Where Duck's data is backed up (step L4). */
export interface BackupView {
  repo: boolean;
  remote: string | null;
  /** Commits not pushed yet; null when never pushed. */
  ahead: number | null;
  /** The last push's error while it's failing. */
  failing: string | null;
}

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
