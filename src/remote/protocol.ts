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

/** The whole state pushed to the phone on connect and on every change. */
export interface RemoteSnapshot {
  /** Epoch seconds. */
  updatedAt: number;
  usageLimits: RateLimits | null;
  instances: RemoteInstance[];
}

/** The action set a remote client can drive (design §11 "Expose:"). */
export type RemoteActionType =
  | "prompt"
  | "approve"
  | "deny"
  | "interrupt"
  | "start"
  | "stop";

/** An action message from a remote client, routed to the frontend handler. */
export interface RemoteAction {
  type: RemoteActionType;
  instanceId: string;
  /** Present for `prompt`. */
  text?: string;
}

/** A text frame on the terminal-mirror socket (`/api/term`); output itself is binary. */
export type TermControl =
  | { type: "notrunning" }
  | { type: "size"; cols: number; rows: number };
