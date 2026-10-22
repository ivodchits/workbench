// External MCP servers (step X1): the user's own apps that speak MCP, such as Quest
// Log (calendar, agenda, notes). The backend makes the requests
// (`assistant_mcp_request`: the session, SSE, a token from the environment); this
// is the part the `mcp_*` tools use: the server's tool list, cached for a few
// minutes, and calls whose result comes back as text.
//
// The servers come from the settings (`mcpServers`). They are not part of the API's
// tools list: Duck asks `mcp_tools` for a server's catalog and calls through
// `mcp_read` / `mcp_call`, so a server that is down, or changes its tools, never
// touches the cached prompt prefix.

import type { McpServerSpec } from "./settings";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

export interface McpHost {
  listTools(server: McpServerSpec): Promise<McpTool[]>;
  callTool(server: McpServerSpec, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallResult>;
}

/** `mcpRequest` from `ipc/assistant`, or a fake in tests. */
export type McpRequest = (
  url: string,
  tokenEnv: string | null,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

const CATALOG_TTL_MS = 5 * 60_000;
const MAX_PAGES = 10;

export function createMcpHost(request: McpRequest, now: () => number = Date.now): McpHost {
  const catalogs = new Map<string, { at: number; tools: McpTool[] }>();
  const key = (s: McpServerSpec) => `${s.url} ${s.tokenEnv ?? ""}`;

  return {
    async listTools(server) {
      const hit = catalogs.get(key(server));
      if (hit && now() - hit.at < CATALOG_TTL_MS) return hit.tools;
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = (await request(server.url, server.tokenEnv, "tools/list", cursor ? { cursor } : {})) as {
          tools?: unknown[];
          nextCursor?: unknown;
        } | null;
        for (const t of res?.tools ?? []) {
          const r = t as Record<string, unknown>;
          if (typeof r?.name !== "string") continue;
          tools.push({
            name: r.name,
            ...(typeof r.description === "string" && { description: r.description }),
            ...(typeof r.inputSchema === "object" && r.inputSchema !== null
              ? { inputSchema: r.inputSchema as Record<string, unknown> }
              : {}),
          });
        }
        cursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
        if (!cursor) break;
      }
      catalogs.set(key(server), { at: now(), tools });
      return tools;
    },

    async callTool(server, tool, args, timeoutMs) {
      const res = (await request(server.url, server.tokenEnv, "tools/call", { name: tool, arguments: args }, timeoutMs)) as {
        content?: unknown[];
        structuredContent?: unknown;
        isError?: unknown;
      } | null;
      return { text: resultText(res), isError: res?.isError === true };
    },
  };
}

/** A `tools/call` result as text: its text blocks, else its structured content. */
export function resultText(
  res: { content?: unknown[]; structuredContent?: unknown } | null,
): string {
  const parts: string[] = [];
  for (const b of res?.content ?? []) {
    const r = b as Record<string, unknown>;
    if (r?.type === "text" && typeof r.text === "string") parts.push(r.text);
    else if (r?.type === "resource" && r.resource && typeof (r.resource as { text?: unknown }).text === "string")
      parts.push((r.resource as { text: string }).text);
    else if (typeof r?.type === "string") parts.push(`[${r.type} content left out]`);
  }
  if (parts.length) return parts.join("\n");
  if (res?.structuredContent !== undefined) return JSON.stringify(res.structuredContent);
  return "(no content)";
}
