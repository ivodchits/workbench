// Duck's tool registry (step A2). Every tool is declared with `defineTool`: a name,
// a description, a zod schema for its input, a default tier, and `run`. The registry
// hands the API a list sorted by name, so the tools prefix stays byte-identical from
// request to request (the prompt cache is a prefix match), and tells the engine each
// tool's tier and time budget.
//
// Rarely used tools are deferred (step M2): sent with `defer_loading`, so they stay
// out of the prompt until the model finds them with the regex tool search, which
// keeps the fixed prefix small. A found tool is appended, so the cache holds.
//
// Tiers (design → Tools): `read` and `reversible` run without asking; a
// `consequential` call waits for a confirmation unless the trust policy (T1) says
// otherwise. A tool's `trust` tells that policy what a call is about.
//
// A tool whose card has to show what will really happen (the argv a plugin action
// spawns, the diff of a file) does that work in `prepare`, before the gate. What it
// returns is kept with the call, through a parked confirmation and a restart, and
// handed to `describe`, `review`, `trust` and `run`, so the card shows what runs.
// `prepare` also gets the settings and the Google host (`PrepareEnv`), for a card
// that shows what a file outside the app holds now (the invoice's cells).

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { WorkbenchPort } from "../port";
import type { Notice, ReviewItem } from "../protocol";
import type { DuckSettings } from "../settings";
import type { Summarizer } from "../summarize";
import type { TaskManager } from "../tasks";
import type { AutopilotManager } from "../autopilot";
import type { TrustFacts } from "../trust/decide";
import type { RoutinesHost } from "./routines";
import type { ReaderHost } from "./readAloud";
import type { ScreenHost } from "./screenshot";
import type { QuietHost } from "./quiet";
import type { ThreadMoves } from "./threads";
import type { HaikuCall } from "./haikuTask";
import type { Level } from "../announce";
import type { McpHost } from "../mcp";
import type { GoogleHost } from "../google";
import type { CoreHost } from "../core";
import type { MemoryHost } from "../memory";
import type { ConfigHost } from "../config";
import type { SkillsHost } from "../skills";

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
  later(text: string, level?: Level): void;
  /** Duck's worker tasks (step D1); null where there are none (some tests). */
  tasks: TaskManager | null;
  /** Session summaries (step W3); null where there are none (some tests). */
  summaries: Summarizer | null;
  /** Plan autopilots (step P1); null where there are none (some tests). */
  autopilot: AutopilotManager | null;
  /** Read-aloud (step V3); null where there is none (some tests). */
  reader: ReaderHost | null;
  /** Screenshots (step V3); null where there are none (some tests). */
  screen: ScreenHost | null;
  /** Do Not Disturb and Speak (step V5); null where there are none (some tests). */
  quiet: QuietHost | null;
  /** One Haiku call for `haiku_task` (step M2); absent where there is none. */
  haiku?: HaikuCall | null;
  /** External MCP servers (step X1); null where there are none (some tests). */
  mcp: McpHost | null;
  /** The morning routine's Google sheet; absent where there is none. */
  google?: GoogleHost | null;
  /** Duck's core memory (step W4); absent where there is none. */
  core?: CoreHost | null;
  /** Duck's long-term memory (step L1); absent where there is none. */
  memory?: MemoryHost | null;
  /** Duck's prompt files (step L3); absent where there are none. */
  config?: ConfigHost | null;
  /** Routines and the backup (step L4); absent where there are none. */
  routines?: RoutinesHost | null;
  /** Duck's skills (step S2); absent where there are none. */
  skills?: SkillsHost | null;
  /** A loaded skill's `tools:` (step S2): the rest of this turn may call only
   *  these, and load_skill. */
  narrow?(skill: string, tools: readonly string[]): void;
  /** You asked Duck not to remember this thread (L1): `remember` refuses. */
  memoryOff?: boolean;
  /** Start a new Duck thread on `words`, which must be the user's own words from
   *  their latest message here (it throws otherwise). The new thread's turn runs on
   *  its own; resolves to its id. With `go` (step A7), the conversation moves into
   *  it once this reply is over, and its turn starts then, with `brief` as a note. */
  startThread(words: string, opts?: { go?: boolean; brief?: string; mode?: string }): Promise<string>;
  /** Duck's threads, and moving the conversation between them (step A7). */
  threads: ThreadMoves;
}

/** What `prepare` gets besides the port. */
export type PrepareEnv = Pick<ToolContext, "settings" | "google" | "memory"> & Partial<Pick<ToolContext, "tasks" | "config" | "skills">>;

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
  prepare?(input: z.infer<S>, port: WorkbenchPort, env?: PrepareEnv): Promise<P>;
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
  /** The `tools` array of a mode (step S1): only `names`, none deferred (the
   *  set is small), built once per set. Every tool when null. */
  toolsFor(names: readonly string[] | null): Anthropic.Beta.BetaToolUnion[];
  get(name: string): ToolDef | undefined;
  /** The tool's declared tier; an unknown tool counts as consequential. */
  tierOf(name: string): Tier;
  /** The tier of this call: `tierFor` over valid input, else the declared tier. */
  callTier(name: string, input: unknown, port: WorkbenchPort): Tier;
  /** The tool's `prepare` over valid input; undefined when it has none. Throws
   *  what `prepare` throws. */
  prepare(name: string, input: unknown, port: WorkbenchPort, env?: PrepareEnv): Promise<unknown>;
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

/** The server-side search the model finds deferred tools with. */
export const TOOL_SEARCH = {
  type: "tool_search_tool_regex_20251119",
  name: "tool_search_tool_regex",
} as const;

export function createRegistry(
  tools: readonly ToolDef[],
  opts: { deferred?: ReadonlySet<string> } = {},
): Registry {
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
  const deferred = opts.deferred ?? new Set<string>();
  for (const n of deferred) if (!byName.has(n)) throw new Error(`deferred tool not found: ${n}`);
  const apiTools: Anthropic.Beta.BetaToolUnion[] = [
    ...(deferred.size ? [TOOL_SEARCH] : []),
    ...sorted.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: inputSchema(t.schema),
      ...(deferred.has(t.name) && { defer_loading: true }),
    })),
  ];
  const subsets = new Map<string, Anthropic.Beta.BetaToolUnion[]>();
  return {
    apiTools,
    toolsFor(names) {
      if (!names) return apiTools;
      const key = [...names].sort().join(",");
      let tools = subsets.get(key);
      if (!tools) {
        const want = new Set(names);
        tools = apiTools.flatMap((t) => {
          if (!("name" in t) || !want.has(t.name)) return [];
          return "defer_loading" in t ? [{ ...t, defer_loading: false }] : [t];
        });
        subsets.set(key, tools);
      }
      return tools;
    },
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
    async prepare(name, input, port, env) {
      const t = byName.get(name);
      const parsed = t?.schema.safeParse(input);
      if (!t?.prepare || !parsed?.success) return undefined;
      return t.prepare(parsed.data, port, env);
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
