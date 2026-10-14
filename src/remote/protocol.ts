// What travels between the desktop app and a paired phone (design §11), in one
// place so both ends are checked against the same shapes: `RemoteMirror` builds the
// snapshot, the phone's PWA (`src/pwa/`) reads it; the PWA sends actions,
// `state/remoteActions` carries them out.
//
// Types only. The PWA is a separate bundle with no Tauri and no React in it, so
// nothing here may import a value.

import type { InstanceStatus } from "../ipc/registry";
import type { RateLimits } from "../ipc/usageLimits";
import type { StatusPhase } from "../state/status";

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
  | "create";

/** An action on an existing instance. */
export interface RemoteInstanceAction {
  type: Exclude<RemoteActionType, "create">;
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
}

/** An action message from a remote client, routed to the frontend handler. */
export type RemoteAction = RemoteInstanceAction | RemoteCreateAction;

/** A text frame on the terminal-mirror socket (`/api/term`); output itself is binary. */
export type TermControl =
  | { type: "notrunning" }
  | { type: "size"; cols: number; rows: number };
