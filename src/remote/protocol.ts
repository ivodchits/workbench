// What travels between the desktop app and a paired phone (design §11), in one
// place so both ends are checked against the same shapes: `RemoteMirror` builds the
// snapshot, the phone's PWA (`src/pwa/`) reads it; the PWA sends actions,
// `state/remoteActions` carries them out.
//
// Types only. The PWA is a separate bundle with no Tauri and no React in it, so
// nothing here may import a value.

import type { DuckEvent, Effort, Stamped } from "../assistant/protocol";
import type { InstanceStatus } from "../ipc/registry";
import type { RateLimits } from "../ipc/usageLimits";
import type { ChoiceKind, ChoiceOption, ChoiceQuestion } from "../state/pendingChoice";
import type { StatusPhase } from "../state/status";

/** What a "needs you" instance is asking (step R5): the desktop's pending prompt
 *  (`state/pendingChoice`), as much as the phone needs to show it and answer. */
export interface RemoteChoice {
  /** Names this prompt; an answer carries it, and is ignored once it has closed. */
  id: string;
  kind: ChoiceKind;
  toolName: string;
  /** The tool's arguments, long strings cut short. */
  input: Record<string, unknown>;
  /** `question` only. */
  questions: ChoiceQuestion[];
  /** The answers the phone may send; empty when `terminalOnly`. */
  options: ChoiceOption[];
  /** Why it is answered in the terminal instead; null when it can be answered here. */
  terminalOnly: string | null;
  /** The label of an answer already sent (from either end), until the prompt closes. */
  sent: string | null;
}

/** One instance as the phone sees it. */
export interface RemoteInstance {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  taskNote: string;
  branch: string | null;
  worktreeOn: boolean;
  /** The project runs on another host over SSH. */
  remote: boolean;
  /** Live phase from the status engine, or null when no session is running. */
  phase: StatusPhase | null;
  compacting: boolean;
  subagents: number;
  /** Persisted status: the fallback for a card with no live phase. */
  status: InstanceStatus;
  ctxTokens: number;
  /** Its console is running. */
  live: boolean;
  /** When this needs-you began (epoch seconds), if the phone route is on. */
  needsSince: number | null;
  escalated: boolean;
  stuck: boolean;
  /** The prompt it is waiting on, when the desktop knows what it asks (step R5). */
  choice: RemoteChoice | null;
}

/** A project the phone can start a session in (step R7). */
export interface RemoteProject {
  id: string;
  name: string;
  /** Its group's name, or null when ungrouped. */
  group: string | null;
  /** The project runs on another host over SSH. */
  remote: boolean;
}

/** How far a `create` request has got (step R7):
 *  - `creating` — the instance (and its worktree, if asked) is being made;
 *  - `starting` — its console is open and the first prompt waits for the TUI;
 *  - `started` — running, with no first prompt to send;
 *  - `sent` — the first prompt was submitted;
 *  - `queued` — the TUI never showed its prompt box, so the first prompt is the
 *    instance's queued prompt instead (sent after its first turn, or cancel it);
 *  - `failed` — nothing was left behind; `message` says why. */
export type RemoteCreateState = "creating" | "starting" | "started" | "sent" | "queued" | "failed";

/** The outcome of one `create` request, reported back against its id. */
export interface RemoteCreated {
  requestId: string;
  /** The new instance, once it exists. */
  instanceId: string | null;
  state: RemoteCreateState;
  /** Why it failed, or something worth knowing (a setup command failed, the SSH
   *  login wants a password). */
  message: string | null;
}

/** The whole state pushed to the phone on connect and on every change. */
export interface RemoteSnapshot {
  /** Epoch seconds. */
  updatedAt: number;
  usageLimits: RateLimits | null;
  instances: RemoteInstance[];
  projects: RemoteProject[];
  /** Recent `create` requests, newest first. */
  created: RemoteCreated[];
}

/** The action set a remote client can drive (design §11 "Expose:"). */
export type RemoteActionType =
  | "prompt"
  | "approve"
  | "deny"
  | "interrupt"
  | "start"
  | "stop"
  | "create"
  | "choose";

/** An action on an existing instance. */
export interface RemoteInstanceAction {
  type: Exclude<RemoteActionType, "create" | "choose">;
  instanceId: string;
  /** Present for `prompt`. */
  text?: string;
}

/** Start a new session in an existing project (step R7). The phone only ever names
 *  a project id, never a path. Sending the same `requestId` again does nothing. */
export interface RemoteCreateAction {
  type: "create";
  requestId: string;
  projectId: string;
  /** Defaults to the next free number, as the rail does. */
  title?: string;
  /** The first prompt, submitted once the TUI is ready. */
  text?: string;
  /** Isolate the session in a new worktree. */
  worktree?: boolean;
  /** The model to run on (step M1); omit to inherit the project's default. */
  model?: string;
}

/** Answer an instance's pending prompt (step R5): one of its options by digit, or
 *  `deny` to dismiss it. Ignored unless `choiceId` is still the open prompt. */
export interface RemoteChooseAction {
  type: "choose";
  instanceId: string;
  choiceId: string;
  option: number | "deny";
}

/** An action message from a remote client, routed to the frontend handler. */
export type RemoteAction = RemoteInstanceAction | RemoteCreateAction | RemoteChooseAction;

/** A text frame on the terminal-mirror socket (`/api/term`); output itself is binary. */
export type TermControl =
  | { type: "notrunning" }
  | { type: "size"; cols: number; rows: number };

/** A frame from the transcript socket (`/api/transcript`, step R4). All offsets are
 *  byte offsets in the transcript file, on line boundaries. */
export type TranscriptFrame =
  /** Connected: the live stream continues from `offset`; before it is history. */
  | { type: "start"; sessionId: string | null; offset: number }
  /** Reconnected where the phone left off (it named `session` and `offset`). */
  | { type: "resume"; sessionId: string | null; offset: number }
  /** Appended lines (only the conversation; may be empty). */
  | { type: "lines"; sessionId: string | null; lines: string[]; offset: number; nextOffset: number }
  /** Another transcript, or the file was truncated: start over from `offset`. */
  | { type: "rotated"; sessionId: string | null; offset: number; reason: string }
  /** The history page asked for with `{ type: "back", id, before }`. */
  | {
      type: "page";
      id: number;
      sessionId: string | null;
      lines: string[];
      offset: number;
      nextOffset: number;
      end: number;
    };

/** A request on the transcript socket: the page of history ending at `before`. */
export interface TranscriptBack {
  type: "back";
  id: number;
  before: number;
}

// ── Duck (step R1): the socket at `/api/assistant` ──────────────────────────────
// The Duck Protocol (`src/assistant/protocol.ts`), less what a phone may not do.

/** A frame the phone sends to Duck. Anything else is refused with an `error`. */
export type RemoteDuckMessage =
  /** The thread list, open confirmations, settings, trust, tasks and the spend. */
  | { type: "sync" }
  | { type: "thread.open"; threadId: string }
  | { type: "thread.new" }
  | {
      type: "send";
      /** `null` starts a new thread. */
      threadId: string | null;
      text: string;
      /** Spoken (dictated through `/api/assistant/audio`): the names get fixed, and
       *  the reply is written to be heard. */
      voice?: boolean;
      /** Make the reply into audio for this phone: `tts` frames follow it, a
       *  sentence at a time as it streams, then `ttsEnd`. */
      speak?: boolean;
      effort?: Effort;
    }
  | { type: "stop"; threadId: string }
  | { type: "confirm"; threadId: string; toolUseId: string; allow: boolean }
  /** The kill switch: pauses trust. Resuming is done on the desktop. */
  | { type: "trust.pause" }
  | { type: "trust.decisions"; before: number | null }
  | { type: "task.close"; taskId: string }
  | { type: "task.rerun"; taskId: string }
  | { type: "autopilot"; instanceId: string; action: "pause" | "resume" | "stop" };

/** A frame Duck sends the phone: any Duck event, plus the phone's own. */
export type RemoteDuckFrame =
  | Stamped<DuckEvent>
  /** A sentence of the reply to a `speak` message, as audio at
   *  `GET /api/assistant/tts/{id}`. `reply` names the reply; `part` counts from 0
   *  and the parts come in order: play each as it comes. `text` is what it says
   *  (for the phone's own voice when the audio can't be had). */
  | { type: "tts"; threadId: string; reply: string; part: number; id: string; seconds: number; text: string; v: number }
  /** No more parts of `reply` are coming (`parts` were sent). Not sent for a
   *  reply the phone stopped. */
  | { type: "ttsEnd"; threadId: string; reply: string; parts: number; v: number }
  /** Frames were dropped (a slow link): ask for the open thread again. */
  | { type: "lagged" };
