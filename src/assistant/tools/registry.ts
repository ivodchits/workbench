// Duck's tool registry (step A2). Every tool is declared with `defineTool`: a name,
// a description, a zod schema for its input, a default tier, and `run`. The registry
// hands the API a list sorted by name, so the tools prefix stays byte-identical from
// request to request (the prompt cache is a prefix match), and tells the engine each
// tool's tier and time budget.
//
// Tiers (design → Tools): `read` and `reversible` run without asking; a
// `consequential` call waits for a confirmation unless the trust policy (T1) says
// otherwise.

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { WorkbenchPort } from "../port";

export type Tier = "read" | "reversible" | "consequential";

/** What a tool's `run` gets besides its input. */
export interface ToolContext {
  port: WorkbenchPort;
  threadId: string;
  /** Aborted when the turn is stopped or the tool runs out of time. */
  signal: AbortSignal;
}

/** A tool may return text, API content blocks (e.g. an image), or any JSON value. */
export type ToolOutput =
  | string
  | Anthropic.Beta.BetaToolResultBlockParam["content"]
  | Record<string, unknown>
  | unknown[];

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  tier: Tier;
  /** The longest the turn waits for `run`. Work that can take longer is written as
   *  start + notify: return a handle at once, report completion later as a new
   *  message in the thread. */
  timeoutMs: number;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput> | ToolOutput;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function defineTool<S extends z.ZodType>(
  def: Omit<ToolDef<S>, "timeoutMs"> & { timeoutMs?: number },
): ToolDef<S> {
  if (!NAME.test(def.name)) throw new Error(`bad tool name: ${def.name}`);
  return { ...def, timeoutMs: def.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

export interface Registry {
  /** The `tools` array for the request, sorted by name. */
  readonly apiTools: Anthropic.Beta.BetaToolUnion[];
  get(name: string): ToolDef | undefined;
  /** The tool's declared tier; an unknown tool counts as consequential. */
  tierOf(name: string): Tier;
}

function inputSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  // `$schema` is noise to the API; everything else is the tool's contract.
  const json = { ...z.toJSONSchema(schema) } as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== "object")
    throw new Error("a tool's input must be an object");
  return json as Anthropic.Beta.BetaTool.InputSchema;
}

export function createRegistry(tools: readonly ToolDef[]): Registry {
  const byName = new Map<string, ToolDef>();
  for (const t of tools) {
    if (byName.has(t.name)) throw new Error(`duplicate tool: ${t.name}`);
    byName.set(t.name, t);
  }
  const sorted = [...byName.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  // Built once: the same objects, serialized the same way, on every request.
  // Inputs are small, so they aren't streamed eagerly (the server validates them
  // against the schema before the call reaches us; the engine validates again).
  const apiTools: Anthropic.Beta.BetaTool[] = sorted.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: inputSchema(t.schema),
  }));
  return {
    apiTools,
    get: (name) => byName.get(name),
    tierOf: (name) => byName.get(name)?.tier ?? "consequential",
  };
}
