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
// Server tools (step B1: web search and fetch) go in the list as they are, after
// the tool search: the API runs them, so they have no definition here, and a mode
// offers them by name like any other.
//
// A hosted MCP server's tools (step B2: `firefox__*`) are known only at run time,
// from the server's cached list: `setExternal` puts them after Duck's own, always
// deferred. A deferred tool nothing has found yet doesn't touch the cached prefix,
// so a server added or changed between requests costs nothing.
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
//
// A tool's host (step H1, `hosts.ts`) says where it runs: `workbench` (the
// default) and `any` here; `pc` and `phone` on a host that connects. A host
// tool is declared here without `run`: its schema, tier and `trust` stay with
// the engine, its call goes to the host. Host tools are always deferred, so the
// list doesn't change with what's connected.

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
import type { HostedCaller } from "./mcpHost";
import type { GoogleHost } from "../google";
import type { CoreHost } from "../core";
import type { MemoryHost } from "../memory";
import type { ConfigHost } from "../config";
import type { SkillsHost } from "../skills";
import type { MusicProvider } from "../music/provider";
import type { RemindersHost } from "../reminders";
import type { Surface } from "../protocol";
import { isRemoteHost, type Host, type HostCaller } from "../hosts";
import type { AttachmentRef } from "../attachments";

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
  /** A file this thread has (step G1): sent by the user, or made by a worker. */
  attachment?: (id: string) => AttachmentRef | undefined;
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
  /** The hosted stdio servers and the browser's profiles (step B2); absent where
   *  there are none. */
  hosted?: HostedCaller | null;
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
  /** The connected hosts (step H1), for a `pc` or `phone` tool; absent where
   *  there are none. */
  hosts?: HostCaller | null;
  /** Music and video search and play (step H3); absent where there is none. */
  music?: MusicProvider | null;
  /** Where the user's latest message in this thread was typed or said (step H3:
   *  music plays there unless they name a device); absent in some tests. */
  surface?: Surface;
  /** The user's reminders (step H8); absent where there are none. */
  reminders?: RemindersHost | null;
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
  /** The input schema sent to the API as it is, instead of `schema`'s (step B2: an
   *  MCP server's own JSON Schema; `schema` then only checks it's an object). */
  inputSchema?: Record<string, unknown>;
  tier: Tier;
  /** Where it runs (step H1); `workbench` when absent. */
  host?: Host;
  /** A tier that depends on the input or the app's state (resuming a session that
   *  is running ends its process); `tier` when absent or when it throws. */
  tierFor?(input: z.infer<S>, port: WorkbenchPort, prepared?: P): Tier;
  /** Work the card needs done before the gate (JSON-safe result). A throw fails
   *  the call with its message, before any card. */
  prepare?(input: z.infer<S>, port: WorkbenchPort, env?: PrepareEnv): Promise<P>;
  /** One sentence for the confirmation card: what this call will do. */
  describe?(input: z.infer<S>, port: WorkbenchPort, prepared: P): string;
  /** Files the card shows as diffs. */
  review?(input: z.infer<S>, prepared: P): ReviewItem[];
  /** The card's ways to allow it (step B2: the login card), in place of one
   *  "allow"; the one picked reaches `run` as `prepared.choice` (`prepare` must
   *  return an object). An answer without a choice takes the first. */
  choices?: readonly { id: string; label: string }[];
  /** The card's "deny" button, when it isn't "deny" ("Skip"). */
  denyLabel?: string;
  /** What the trust engine needs about the call: its project, a specifier for
   *  rules, text for the floor. `{projectId: null}` when absent or when it throws. */
  trust?(input: z.infer<S>, port: WorkbenchPort, prepared: P): TrustFacts;
  /** A host tool's answer as the model gets it (step H5: a notification's text
   *  wrapped as untrusted). Runs in the engine, not on the host. */
  shape?(output: unknown): unknown;
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
  def: Omit<ToolDef<S, P>, "timeoutMs" | "run"> & { timeoutMs?: number; run?: ToolDef<S, P>["run"] },
): ToolDef<S, P> {
  if (!NAME.test(def.name)) throw new Error(`bad tool name: ${def.name}`);
  const { host } = def;
  if (isRemoteHost(host)) {
    if (def.run) throw new Error(`${def.name} runs on ${host}, not here`);
    const name = def.name;
    return {
      ...def,
      timeoutMs: def.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      run: async (input, ctx) => {
        if (!ctx.hosts) throw new Error("no host can run it here");
        const out = await ctx.hosts.call(host, name, input, ctx.signal);
        return (def.shape ? def.shape(out) : out) as ToolOutput;
      },
    };
  }
  if (!def.run) throw new Error(`${def.name} has no run`);
  return { ...def, run: def.run, timeoutMs: def.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

/** The names of `tools` that run on `host`. */
export function toolsOn(tools: readonly ToolDef[], host: Host): Set<string> {
  return new Set(tools.filter((t) => (t.host ?? "workbench") === host).map((t) => t.name));
}

export interface Registry {
  /** The `tools` array for the request: Duck's own sorted by name, then the
   *  hosted servers' (B2), deferred. */
  readonly apiTools: Anthropic.Beta.BetaToolUnion[];
  /** Replace the hosted servers' tools (step B2). A name that is one of Duck's
   *  own is left out. */
  setExternal(tools: readonly ToolDef[]): void;
  /** The `tools` array of a mode (step S1): only `names`, none deferred (the
   *  set is small), built once per set. Every tool when null. */
  toolsFor(names: readonly string[] | null): Anthropic.Beta.BetaToolUnion[];
  get(name: string): ToolDef | undefined;
  /** The tool's declared tier; an unknown tool counts as consequential. */
  tierOf(name: string): Tier;
  /** The tier of this call: `tierFor` over valid input, else the declared tier. */
  callTier(name: string, input: unknown, port: WorkbenchPort, prepared?: unknown): Tier;
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
  opts: { deferred?: ReadonlySet<string>; server?: readonly Anthropic.Beta.BetaToolUnion[] } = {},
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
  for (const n of opts.deferred ?? []) if (!byName.has(n)) throw new Error(`deferred tool not found: ${n}`);
  // A host's tools are always deferred (H1).
  const deferred = new Set([...(opts.deferred ?? []), ...sorted.filter((t) => isRemoteHost(t.host)).map((t) => t.name)]);
  const own: Anthropic.Beta.BetaToolUnion[] = [
    ...(deferred.size ? [TOOL_SEARCH] : []),
    ...(opts.server ?? []),
    ...sorted.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema ? (t.inputSchema as Anthropic.Beta.BetaTool.InputSchema) : inputSchema(t.schema),
      ...(deferred.has(t.name) && { defer_loading: true }),
    })),
  ];
  let external = new Map<string, ToolDef>();
  let apiTools = own;
  const subsets = new Map<string, Anthropic.Beta.BetaToolUnion[]>();
  const lookup = (name: string) => byName.get(name) ?? external.get(name);
  return {
    get apiTools() {
      return apiTools;
    },
    setExternal(tools) {
      external = new Map();
      for (const t of tools) if (!byName.has(t.name) && !external.has(t.name)) external.set(t.name, t);
      const ext = [...external.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      apiTools = [
        ...(ext.length && !deferred.size ? [TOOL_SEARCH] : []),
        ...own,
        ...ext.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema ? (t.inputSchema as Anthropic.Beta.BetaTool.InputSchema) : inputSchema(t.schema),
          defer_loading: true,
        })),
      ];
      subsets.clear();
    },
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
    get: (name) => lookup(name),
    tierOf: (name) => lookup(name)?.tier ?? "consequential",
    callTier(name, input, port, prepared) {
      const t = lookup(name);
      if (!t) return "consequential";
      const parsed = t.schema.safeParse(input);
      if (!t.tierFor || !parsed.success) return t.tier;
      try {
        return t.tierFor(parsed.data, port, prepared);
      } catch {
        return t.tier;
      }
    },
    async prepare(name, input, port, env) {
      const t = lookup(name);
      const parsed = t?.schema.safeParse(input);
      if (!t?.prepare || !parsed?.success) return undefined;
      return t.prepare(parsed.data, port, env);
    },
    describe(name, input, port, prepared) {
      const t = lookup(name);
      const parsed = t?.schema.safeParse(input);
      if (!t?.describe || !parsed?.success) return undefined;
      try {
        return t.describe(parsed.data, port, prepared);
      } catch {
        return undefined;
      }
    },
    review(name, input, prepared) {
      const t = lookup(name);
      const parsed = t?.schema.safeParse(input);
      if (!t?.review || !parsed?.success) return undefined;
      try {
        return t.review(parsed.data, prepared);
      } catch {
        return undefined;
      }
    },
    trustFacts(name, input, port, prepared) {
      const t = lookup(name);
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
