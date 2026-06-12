// Typed wrappers over the Rust MCP-manager commands (step 3.7 — design §7).
// Reads parse the three scope configs directly; writes drive the `claude mcp` CLI.
// The backend serializes these structs as camelCase, so the types map across the
// IPC boundary directly.

import { invoke } from "@tauri-apps/api/core";

/** Configuration scope, in precedence order (local > project > user). */
export type McpScope = "user" | "project" | "local";
export type McpTransport = "stdio" | "http" | "sse";

/** An env var or HTTP header, as an ordered pair for row-by-row editing. */
export interface KeyValue {
  key: string;
  value: string;
}

export interface McpServer {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  /** stdio: the launch command. */
  command: string | null;
  /** stdio: args after the command. */
  args: string[];
  /** http/sse: the endpoint url. */
  url: string | null;
  env: KeyValue[];
  headers: KeyValue[];
  /** A higher-precedence scope defines a server with this name, overriding it. */
  shadowed: boolean;
}

export interface NewMcpServer {
  projectRoot: string;
  scope: McpScope;
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: KeyValue[];
  headers?: KeyValue[];
  /** On an edit (esp. a rename), the previous name to remove before adding. */
  replaces?: string | null;
}

/** List all MCP servers visible to a project, across scopes, with shadowing. */
export function mcpList(projectRoot: string): Promise<McpServer[]> {
  return invoke("mcp_list", { projectRoot });
}

/** Add (or replace) a server via `claude mcp add`. */
export function mcpAdd(input: NewMcpServer): Promise<void> {
  return invoke("mcp_add", { input });
}

/** Remove a server from a specific scope via `claude mcp remove`. */
export function mcpRemove(projectRoot: string, scope: McpScope, name: string): Promise<void> {
  return invoke("mcp_remove", { projectRoot, scope, name });
}

/** Raw text of the project's `.mcp.json` ("" when absent) for the JSON editor. */
export function mcpProjectFile(projectRoot: string): Promise<string> {
  return invoke("mcp_project_file", { projectRoot });
}

/** Save `.mcp.json` (validated as JSON; an empty body removes the file). */
export function mcpSaveProjectFile(projectRoot: string, content: string): Promise<void> {
  return invoke("mcp_save_project_file", { projectRoot, content });
}
