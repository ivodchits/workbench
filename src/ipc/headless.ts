// Typed wrappers over the headless worker commands (step D4,
// `src-tauri/src/assistant/headless.rs`): a Duck worker as `claude -p` over
// stream-json, with no PTY.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A permission answer over the protocol: allow (with the tool's input, a
 *  question's answers added) or deny. */
export type HeadlessResponse =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

/** One protocol message from a worker (the backend forwards control requests and
 *  their cancels, turn results and system messages). */
export interface HeadlessMessage {
  type: string;
  subtype?: string;
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    tool_use_id?: string;
    input?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export const headlessSpawn = (
  instanceId: string,
  cwd: string,
  resumeSessionId: string | null,
  prompt: string | null,
): Promise<{ sessionId: string; cwd: string }> =>
  invoke("headless_spawn", { instanceId, cwd, resumeSessionId, prompt });

export const headlessSend = (instanceId: string, text: string): Promise<void> =>
  invoke("headless_send", { instanceId, text });

export const headlessInterrupt = (instanceId: string): Promise<void> =>
  invoke("headless_interrupt", { instanceId });

export const headlessAnswer = (instanceId: string, requestId: string, response: HeadlessResponse): Promise<void> =>
  invoke("headless_answer", { instanceId, requestId, response });

export const headlessKill = (instanceId: string): Promise<void> => invoke("headless_kill", { instanceId });

export function onHeadlessEvent(cb: (id: string, msg: HeadlessMessage) => void): Promise<UnlistenFn> {
  return listen<{ id: string; msg: HeadlessMessage }>("headless-event", (e) => cb(e.payload.id, e.payload.msg));
}

/** A worker's process ended on its own (not stopped by Workbench). */
export function onHeadlessExited(
  cb: (id: string, code: number | null, stderr: string) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; code: number | null; stderr: string }>("headless-exited", (e) =>
    cb(e.payload.id, e.payload.code, e.payload.stderr),
  );
}
