// What travels between the desktop app and a paired phone (design §11), in one
// place so both ends are checked against the same shapes: `RemoteMirror` builds the
// snapshot, the phone's PWA (`src/pwa/`) reads it; the PWA sends actions,
// `state/remoteActions` carries them out.
//
// Types only. The PWA is a separate bundle with no Tauri and no React in it, so
// nothing here may import a value.

import type { DuckEvent, Effort, Stamped } from "../assistant/protocol";
import type { HostDown, HostUp } from "../assistant/hosts";
import type { PhoneAlarm, ReminderRecord } from "../assistant/reminders";
import type { OfflineThread } from "../assistant/offline";
import type { AttachmentRef } from "../assistant/attachments";
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

/** A frame the phone sends to Duck. Anything else is refused with an `error`.
 *  A socket can also be a host (step H1): it sends `HostUp` frames (`hello`,
 *  `device.result`), which go to the hosts, not to Duck. */
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
      /** Conversation mode (step V4): start now, keep only on `turn.commit`. */
      provisional?: boolean;
      /** Files uploaded first (step G1, `attach.chunk`), by the ids `attached`
       *  gave; `text` may then be empty. */
      attachments?: string[];
    }
  /** A file going up (step G1), in parts of base64 (each but the last a whole
   *  number of 3-byte groups), in order; `attached` answers the last. */
  | { type: "attach.chunk"; upload: string; name: string; part: number; data: string; last: boolean }
  | { type: "stop"; threadId: string }
  /** A provisional turn stands, or is dropped (you went on talking). */
  | { type: "turn.commit"; threadId: string }
  | { type: "turn.withdraw"; threadId: string }
  /** Files shared just after a spoken turn (step G2), by id: the turn starts again
   *  with them while it hasn't stood, else they follow it. */
  | { type: "turn.files"; threadId: string; attachments: string[] }
  | { type: "confirm"; threadId: string; toolUseId: string; allow: boolean; choice?: string }
  /** The kill switch: pauses trust. Resuming is done on the desktop. */
  | { type: "trust.pause" }
  | { type: "trust.decisions"; before: number | null }
  | { type: "task.close"; taskId: string }
  | { type: "task.rerun"; taskId: string }
  | { type: "autopilot"; instanceId: string; action: "pause" | "resume" | "stop" }
  /** The reader bar (step V3): a read playing on the phone comes as `tts` parts. */
  | { type: "reader"; action: "pause" | "resume" | "next" | "prev" | "stop" }
  /** Duck's Do Not Disturb (step V5): until a moment (epoch ms), or off (null). */
  | { type: "dnd"; until: number | null }
  /** A drawing (step G3), answered with `drawing`; its PNG is at
   *  `GET /api/assistant/image/{id}/{name}`. */
  | { type: "drawing.get"; drawingId: string }
  /** The drawing the phone's viewer shows (null: closed): its worker stays warm. */
  | { type: "canvas"; drawingId: string | null };

/** What a phone host sends besides Duck messages (steps H1, H5): its `hello` and
 *  results, and Done or Snooze tapped on a reminder its app rang; H7: what its
 *  offline brain made (`src/assistant/offline.ts`). */
export type RemoteHostMessage =
  | HostUp
  | { type: "reminder.action"; id: string; action: "done" | "snooze" }
  | { type: "offline.sync"; reminders: ReminderRecord[]; threads: OfflineThread[] };

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
  /** Drop every part still queued (a read was paused or skipped, step V3). */
  | { type: "ttsCut"; threadId: string; v: number }
  /** Frames were dropped (a slow link): ask for the open thread again. */
  | { type: "lagged" }
  /** To a socket that's a host (step H1, `src/assistant/hosts.ts`): run a tool,
   *  or stop running one. */
  | (HostDown & { v: number })
  /** To a phone host (step H5): the open reminders' coming times, which its app
   *  arms as exact alarms; sent on hello and on every change. */
  | { type: "phone.reminders"; alarms: PhoneAlarm[]; v: number }
  /** A file the phone sent is stored (step G1): `file` to send with a message, or
   *  why it wasn't. */
  | { type: "attached"; upload: string; file?: AttachmentRef; error?: string; v: number }
  /** To a phone host (step H7): what the desktop took of an `offline.sync`, by id. */
  | { type: "offline.synced"; reminders: string[]; threads: string[]; v: number }
  | RemoteConvFrame;

// Conversation mode on the phone (step V4 part 3). The page streams its mic to the
// desktop, which runs the turn pipeline (`voice/conversation.rs`) on it. These
// frames are the desktop server's, not Duck's: they never reach the webview.

/** The phone's audio, as binary frames: a first byte, then its body. */
export const AUDIO_PCM = 0; // 16 kHz mono int16 little-endian samples
export const AUDIO_GAP = 1; // a u32 (LE): that many samples of silence

/** What the phone tells the desktop about conversation mode. */
/** How the phone plays Duck's voice in conversation mode (V7): its own audio
 *  context (as before V7), the mic's, or an `<audio>` element fed from it. Which
 *  one the browser's echo cancellation removes is what V7's measurement finds. */
export type EchoPath = "separate" | "shared" | "element";

export type RemoteConvMessage =
  /** Start it, with these pauses (or the desktop's setting); `path` and `voice`
   *  say how Duck's voice plays here, for a recording (V7). */
  | { type: "conv.start"; patience?: "quick" | "patient" | "thinking"; path?: EchoPath; voice?: "desktop" | "phone" }
  | { type: "conv.stop" }
  /** Duck's voice is playing on the phone (you may talk over it). */
  | { type: "conv.playing"; on: boolean }
  /** A sentence of Duck's started playing here: its words, and the desktop's audio
   *  id when it's the desktop's voice (V7: what Duck is saying, so its echo isn't
   *  taken for you). */
  | { type: "conv.said"; text: string; id?: string; voice: "desktop" | "phone" };

/** What the desktop's pipeline tells the phone. */
export type RemoteConvFrame =
  /** The state (`listening`, `hearing`, `grace`, `preparing`, `off`, `error`). */
  | { type: "conv.state"; run: number; state: string; held: boolean; message: string | null }
  /** A turn: `provisional` (send it so), `withdrawn` or `final`. */
  | { type: "conv.turn"; run: number; id: number; text: string; phase: "provisional" | "withdrawn" | "final" }
  /** You talked over Duck, or said "stop": stop its voice. */
  | { type: "conv.cut" }
  /** A turn went out: the soft chime, if the phone plays it. */
  | { type: "conv.cue" };
