// The external MCP tools (step X1), over `ctx.mcp` and the servers in the settings.
// `mcp_tools` lists the servers, or one server's tools with their input schemas:
// the only way a server's schemas reach Duck, so they cost nothing until a request
// needs that server. An entry with `tools` (Gmail, of a Google Workspace server)
// offers only those: the rest aren't listed and can't be called.
// Reads go through `mcp_read`, which runs only the tools the server's settings name
// in `readTools`; everything else (creating, changing, completing or deleting
// something in the user's app) goes through `mcp_call`, a consequential call: a
// card unless a trust rule (`assistant:mcp_call(quest_log:create_entry)`) or the
// user's own words allow it.
//
// What a server returns is the user's data from another app, so it comes back
// wrapped as untrusted, like a session's transcript.

import { z } from "zod";
import { offers } from "../mcp";
import type { McpServerSpec } from "../settings";
import { grantArg } from "./act";
import { defineTool, type ToolContext } from "./registry";

const TIMEOUT_MS = 30_000;

const serverArg = z.string().min(1).max(32).describe("The server's name, as in <mcp_servers>.");
const toolArg = z.string().min(1).max(128).describe("The tool's name on that server, from mcp_tools.");
const argsArg = z
  .record(z.string(), z.any())
  .optional()
  .describe("The tool's arguments, matching its input schema from mcp_tools.");

function servers(ctx: Pick<ToolContext, "settings">): McpServerSpec[] {
  return ctx.settings.mcpServers.filter((s) => s.enabled);
}

function findServer(ctx: Pick<ToolContext, "settings">, name: string): McpServerSpec {
  const on = servers(ctx);
  const s = on.find((x) => x.name === name.trim().toLowerCase());
  if (s) return s;
  const names = on.map((x) => x.name);
  throw new Error(
    names.length
      ? `no MCP server "${name}"; the servers are ${names.join(", ")}.`
      : "no MCP servers are set up (Duck's settings, mcpServers).",
  );
}

/** Refuses a tool the server's entry doesn't offer, before calling the server. */
function offered(server: McpServerSpec, tool: string) {
  if (!offers(server, tool)) throw new Error(`${server.name} has no tool ${tool}; mcp_tools lists its tools.`);
}

function host(ctx: ToolContext) {
  if (!ctx.mcp) throw new Error("MCP servers aren't available here.");
  return ctx.mcp;
}

const attr = (v: string) => v.replace(/["<>]/g, "");

async function call(
  ctx: ToolContext,
  server: McpServerSpec,
  tool: string,
  args: Record<string, unknown> | undefined,
): Promise<string> {
  const r = await host(ctx).callTool(server, tool, args ?? {}, TIMEOUT_MS - 2_000);
  if (r.isError) throw new Error(`${server.name}: ${tool} failed: ${r.text}`);
  return wrapMcp(server.name, tool, r.text);
}

/** A server's text wrapped as untrusted, any closing tag inside defused. */
export function wrapMcp(server: string, tool: string, text: string): string {
  const body = text.replace(/<\/mcp_result>/gi, "</mcp_result_>");
  return `<mcp_result server="${attr(server)}" tool="${attr(tool)}" untrusted>\n${body}\n</mcp_result>`;
}

/** The call's arguments in one short line, for the card. */
function argsLine(args: Record<string, unknown> | undefined): string {
  if (!args || !Object.keys(args).length) return "";
  const s = JSON.stringify(args);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

export const mcpTools = defineTool({
  name: "mcp_tools",
  description:
    "The user's own apps that Duck reaches over MCP: the servers listed in <mcp_servers>, a line each on what it's for. Without `server`, lists the servers set up; with it, that server's tools, each with its input schema and whether it only reads (call those with mcp_read; the rest with mcp_call). Look a server's tools up once per conversation before calling them. A server's app has to be running: if it can't be reached, say so. Signing in is the user's: when a server says it needs authorization, give the user its sign-in link to open in their browser, and try again once they say they've signed in; never sign in for them or ask for a password or code.",
  schema: z.object({ server: serverArg.optional() }),
  tier: "read",
  timeoutMs: TIMEOUT_MS,
  async run({ server }, ctx) {
    if (!server) {
      const on = servers(ctx);
      if (!on.length) return "No MCP servers are set up.";
      return { servers: on.map((s) => ({ name: s.name, url: s.url, ...(s.description && { description: s.description }) })) };
    }
    const s = findServer(ctx, server);
    const tools = (await host(ctx).listTools(s)).filter((t) => offers(s, t.name));
    const reads = new Set(s.readTools);
    return {
      server: s.name,
      tools: tools.map((t) => ({
        name: t.name,
        ...(reads.has(t.name) && { readOnly: true }),
        ...(t.description && { description: t.description }),
        ...(t.inputSchema && { input_schema: t.inputSchema }),
      })),
    };
  },
});

export const mcpRead = defineTool({
  name: "mcp_read",
  description:
    "Call one of an MCP server's read-only tools (readOnly in mcp_tools; look the server's tools up there first): searching, listing, reading. Runs at once. A tool that changes something is refused here: use mcp_call.",
  schema: z.object({ server: serverArg, tool: toolArg, arguments: argsArg }),
  tier: "read",
  timeoutMs: TIMEOUT_MS,
  async run({ server, tool, arguments: args }, ctx) {
    const s = findServer(ctx, server);
    offered(s, tool);
    if (!s.readTools.includes(tool))
      throw new Error(`${tool} isn't one of ${s.name}'s read-only tools; call it with mcp_call (the user confirms it).`);
    return call(ctx, s, tool, args);
  },
});

export const mcpCall = defineTool({
  name: "mcp_call",
  description:
    "Call an MCP server's tool that changes something in the user's app (from mcp_tools, not readOnly; look the server's tools up there first): creating, editing, completing or deleting an item, sending or drafting a message, editing or sharing a file. These are real actions in the user's data. The user is asked first, unless a trust rule allows it or their own words asked for it (`grantedBy`). Use mcp_read for tools that only read.",
  schema: z.object({ server: serverArg, tool: toolArg, arguments: argsArg, grantedBy: grantArg }),
  tier: "consequential",
  timeoutMs: TIMEOUT_MS,
  describe({ server, tool, arguments: args }) {
    const line = argsLine(args);
    return `${server}: ${tool}${line ? ` ${line}` : ""}`;
  },
  trust: ({ server, tool, grantedBy }) => ({
    projectId: null,
    specifier: `${server.trim().toLowerCase()}:${tool}`,
    grant: grantedBy?.trim() || undefined,
  }),
  async run({ server, tool, arguments: args }, ctx) {
    const s = findServer(ctx, server);
    offered(s, tool);
    return call(ctx, s, tool, args);
  },
});

export const MCP_TOOLS = [mcpTools, mcpRead, mcpCall];
