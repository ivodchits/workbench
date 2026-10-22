// Typed access to Duck's host for stdio MCP servers (step B2,
// `src-tauri/src/assistant/mcp_host.rs`): the servers in your Claude Code config,
// started by Duck on first use and stopped after 10 minutes idle. Your Firefox
// bridge is the first.

import { invoke } from "@tauri-apps/api/core";

/** A tool as the server lists it (MCP `Tool`). */
export interface HostedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface HostedTools {
  tools: HostedTool[];
  /** Epoch ms the list was fetched. */
  at: number;
  /** From the cache, without starting the server. */
  cached: boolean;
}

/** A stdio server Duck could host: its name and its command's name. */
export interface HostableServer {
  name: string;
  command: string | null;
}

/** A server's tools, from the cache unless `refresh` (which starts the server). */
export function mcpHostTools(server: string, refresh = false): Promise<HostedTools> {
  return invoke("mcp_host_tools", { server, refresh });
}

/** Call a tool; the MCP `CallToolResult`. */
export function mcpHostCall(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  return invoke("mcp_host_call", { server, tool, args, timeoutMs: timeoutMs ?? null });
}

export function mcpHostServers(): Promise<HostableServer[]> {
  return invoke("mcp_host_servers");
}

export function mcpHostRunning(): Promise<string[]> {
  return invoke("mcp_host_running");
}

export function mcpHostStop(server: string): Promise<void> {
  return invoke("mcp_host_stop", { server });
}

/** Start Firefox on a profile, apart from any Firefox already open. */
export function firefoxStartProfile(profile: string): Promise<void> {
  return invoke("firefox_start_profile", { profile });
}
