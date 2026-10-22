// Typed access to Duck's subscription brain (step M3): a headless `claude -p` per
// thread, on the subscription, whose tools are Duck's own over MCP. The backend
// emits what it says as `brain-event`, its end as `brain-exited`, and each tool
// call as `brain-tool-call`, which `brainToolResult` answers.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A tool as the brain's MCP server lists it. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** An MCP `CallToolResult`. */
export interface McpResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

export interface BrainToolCall {
  callId: string;
  threadId: string;
  name: string;
  input: unknown;
  /** The `tool_use` block's id in the brain's reply. */
  toolUseId: string | null;
}

export const brainSpawn = (
  threadId: string,
  workspace: string,
  prompt: string,
  tools: McpTool[],
  effort: string,
): Promise<{ resumed: boolean }> => invoke("brain_spawn", { threadId, workspace, prompt, tools, effort });

export const brainSend = (threadId: string, text: string): Promise<void> => invoke("brain_send", { threadId, text });

export const brainInterrupt = (threadId: string): Promise<void> => invoke("brain_interrupt", { threadId });

export const brainKill = (threadId: string): Promise<void> => invoke("brain_kill", { threadId });

export const brainToolResult = (callId: string, result: McpResult): Promise<void> =>
  invoke("brain_tool_result", { callId, result });

export const onBrainEvent = (cb: (threadId: string, msg: unknown) => void): Promise<UnlistenFn> =>
  listen<{ threadId: string; msg: unknown }>("brain-event", (e) => cb(e.payload.threadId, e.payload.msg));

export const onBrainExited = (cb: (threadId: string, code: number | null, stderr: string) => void): Promise<UnlistenFn> =>
  listen<{ threadId: string; code: number | null; stderr: string }>("brain-exited", (e) =>
    cb(e.payload.threadId, e.payload.code, e.payload.stderr),
  );

export const onBrainToolCall = (cb: (call: BrainToolCall) => void): Promise<UnlistenFn> =>
  listen<BrainToolCall>("brain-tool-call", (e) => cb(e.payload));
