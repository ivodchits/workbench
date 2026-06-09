// Typed access to the Phase-2 hook bridge (step 2.1). The Rust backend runs a
// local `axum` endpoint that receives Claude Code's `http` hooks, drops events
// from sessions Workbench didn't mint (the session-id filter, design §4.4), and
// forwards the survivors to the frontend as a `hook-event`. The status state
// machine that turns this stream into card status is step 2.2 — this module is the
// seam it builds on, plus a status readout for the chrome.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A hook event as received from Claude Code. Field names mirror the hook payload
 *  (snake_case); event-specific fields beyond these come through as extra keys. */
export interface HookEvent {
  /** The minted UUID Workbench passed as `--session-id`. */
  session_id: string;
  /** e.g. "PreToolUse", "PermissionRequest", "Stop". */
  hook_event_name: string | null;
  transcript_path: string | null;
  cwd: string | null;
  permission_mode: string | null;
  /** Present on tool/permission events. */
  tool_name: string | null;
  /** Any remaining event-specific fields (tool_input, message, source, …). */
  [key: string]: unknown;
}

/** An accepted, instance-tagged event emitted to the frontend. */
export interface HookEnvelope {
  /** The card this event belongs to (resolved from `session_id`). */
  instanceId: string;
  /** Receipt time, epoch seconds. */
  receivedAt: number;
  event: HookEvent;
}

/** Snapshot of the hook server, for the chrome's status readout. */
export interface HookServerStatus {
  port: number;
  listening: boolean;
  /** Total POSTs received (incl. foreign + malformed). */
  received: number;
  /** Events that passed the session-id filter and were forwarded. */
  accepted: number;
  /** Events dropped because their session isn't a Workbench instance. */
  dropped: number;
}

/** Read the current hook server status (port + counters). */
export function getHookServerStatus(): Promise<HookServerStatus> {
  return invoke("hook_server_status");
}

/** Subscribe to accepted hook events. Returns an unlisten function. */
export function onHookEvent(cb: (envelope: HookEnvelope) => void): Promise<UnlistenFn> {
  return listen<HookEnvelope>("hook-event", (event) => cb(event.payload));
}
