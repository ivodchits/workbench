// Duck's tool registry (step A2). Every tool is declared with `defineTool`: a name,
// a description, a zod schema for its input, a default tier, and `run`. The registry
// hands the API a list sorted by name, so the tools prefix stays byte-identical from
// request to request (the prompt cache is a prefix match), and tells the engine each
// tool's tier and time budget.
//
// Tiers (design → Tools): `read` and `reversible` run without asking; a
// `consequential` call waits for a confirmation unless the trust policy (T1) says
// otherwise. A tool's `trust` tells that policy what a call is about.
//
// A tool whose card has to show what will really happen (the argv a plugin action
// spawns, the diff of a file) does that work in `prepare`, before the gate. What it
// returns is kept with the call, through a parked confirmation and a restart, and
// handed to `describe`, `review`, `trust` and `run`, so the card shows what runs.

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { WorkbenchPort } from "../port";
import type { Notice, ReviewItem } from "../protocol";
import type { DuckSettings } from "../settings";
import type { TaskManager } from "../tasks";
import type { TrustFacts } from "../trust/decide";

export type Tier = "read" | "reversible" | "consequential";

/** What a tool's `run` gets besides its input. */
export interface ToolContext {
  port: WorkbenchPort;
  threadId: string;
  /** Aborted when the turn is stopped or the tool runs out of time. */
  signal: AbortSignal;
  settings: DuckSettings;
  /** The user's latest message in this thread (what they asked for), or null. */
  request: string | null;
  /** Show something in the thread that the model never sees (a note-edit chip). */
  notice(n: Notice): Promise<void>;
  /** Post a follow-up into the thread later, as a Workbench event that starts a
   *  turn of its own: how start + notify tools report back. */
  later(text: string): void;
  /** Duck's worker tasks (step D1); null where there are none (some tests). */
  tasks: TaskManager | null;
}

/** A tool may return text, API content blocks (e.g. an image), or any JSON value. */
export type ToolOutput =
  | string
  | Anthropic.Beta.BetaToolResultBlockParam["content"]
  | Record<string, unknown>
  | unknown[];

export interface ToolDef<S extends z.ZodType = z.ZodType, P = unknown> {
  name: string;
  description: string;
  schema: S;
  tier: Tier;
  /** A tier that depends on the input or the app's state (resuming a session that
   *  is running ends its process); `tier` when absent or when it throws. */
  tierFor?(input: z.infer<S>, port: WorkbenchPort): Tier;
  /** Work the card needs done before the gate (JSON-safe result). A throw fails
   *  the call with its message, before any card. */
  prepare?(input: z.infer<S>, port: WorkbenchPort): Promise<P>;
  /** One sentence for the confirmation card: what this call will do. */
  describe?(input: z.infer<S>, port: WorkbenchPort, prepared: P): string;
  /** Files the card shows as diffs. */
  review?(input: z.infer<S>, prepared: P): ReviewItem[];
  /** What the trust engine needs about the call: its project, a specifier for
   *  rules, text for the floor. `{projectId: null}` when absent or when it throws. */
  trust?(input: z.infer<S>, port: WorkbenchPort, prepared: P): TrustFacts;
  /** The longest the turn waits for `run`. Work that can take longer is written as
   *  start + notify: return a handle at once, report completion later as a new
   *  message in the thread. */
  timeoutMs: number;
  /** `ctx.prepared` is what `prepare` returned (undefined without one). */
  run(input: z.infer<S>, ctx: ToolContext & { prepared: P }): Promise<ToolOutput> | ToolOutput;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function defineTool<S extends z.ZodType, P = undefined>(
  def: Omit<ToolDef<S, P>, "timeoutMs"> & { timeoutMs?: number },
): ToolDef<S, P> {
  if (!NAME.test(def.name)) throw new Error(`bad tool name: ${def.name}`);
  return { ...def, timeoutMs: def.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

export interface Registry {
  /** The `tools` array for the request, sorted by name. */
  readonly apiTools: Anthropic.Beta.BetaToolUnion[];
  get(name: string): ToolDef | undefined;
  /** The tool's declared tier; an unknown tool counts as consequential. */
  tierOf(name: string): Tier;
  /** The tier of this call: `tierFor` over valid input, else the declared tier. */
  callTier(name: string, input: unknown, port: WorkbenchPort): Tier;
  /** The tool's `prepare` over valid input; undefined when it has none. Throws
   *  what `prepare` throws. */
  prepare(name: string, input: unknown, port: WorkbenchPort): Promise<unknown>;
  /** The confirmation card's sentence for this call, when the tool has one. */
  describe(name: string, input: unknown, port: WorkbenchPort, prepared?: unknown): string | undefined;
  /** The card's diffs, when the tool has any. */
  review(name: string, input: unknown, prepared?: unknown): ReviewItem[] | undefined;
  /** The call's facts for the trust engine (`ToolDef.trust`). */
  trustFacts(name: string, input: unknown, port: WorkbenchPort, prepared?: unknown): TrustFacts;
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
    callTier(name, input, port) {
      const t = byName.get(name);
      if (!t) return "consequential";
      const parsed = t.schema.safeParse(input);
      if (!t.tierFor || !parsed.success) return t.tier;
      try {
        return t.tierFor(parsed.data, port);
      } catch {
        return t.tier;
      }
    },
    async prepare(name, input, port) {
      const t = byName.get(name);
      const parsed = t?.schema.safeParse(input);
      if (!t?.prepare || !parsed?.success) return undefined;
      return t.prepare(parsed.data, port);
    },
    describe(name, input, port, prepared) {
      const t = byName.get(name);
      const parsed = t?.schema.safeParse(input);
      if (!t?.describe || !parsed?.success) return undefined;
      try {
        return t.describe(parsed.data, port, prepared);
      } catch {
        return undefined;
      }
    },
    review(name, input, prepared) {
      const t = byName.get(name);
      const parsed = t?.schema.safeParse(input);
      if (!t?.review || !parsed?.success) return undefined;
      try {
        return t.review(parsed.data, prepared);
      } catch {
        return undefined;
      }
    },
    trustFacts(name, input, port, prepared) {
      const t = byName.get(name);
      const parsed = t?.schema.safeParse(input);
      if (!t?.trust || !parsed?.success) return { projectId: null };
      try {
        return t.trust(parsed.data, port, prepared);
      } catch {
        return { projectId: null };
      }
    },
  };
}
