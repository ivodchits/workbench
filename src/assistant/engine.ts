// Duck's engine (step A2): a manual streaming loop over the Messages API, not the
// SDK's tool runner, because a turn has to be able to stop at a confirmation gate
// and pick up again later, possibly after a restart.
//
// One turn, per thread:
//   0. Route it (step M2, `routing.ts`): the model (Sonnet; Haiku past the
//      budget's soft limit) and the effort.
//   1. Append the user's message (and, when the effort changes or the message was
//      spoken, a mid-conversation system message carrying the effort or the voice
//      note, which keeps the cache).
//   2. Stream a reply, emitting text deltas. Append the reply as it ended.
//   3. On `tool_use`: validate every call against its tool's schema, ask the gate
//      (the trust policy) whether it may run, fail the ones it refuses, and run the
//      ones that may, in parallel, each within its
//      time budget. If any must be confirmed, park the batch (persisted) and stop;
//      `confirm()` resumes it once every call is answered. All results go back in one
//      user message, failures marked `is_error`.
//   4. `pause_turn` → resend; `max_tokens`, `refusal`, the budget cap and errors end
//      the turn with a notice (shown, never sent to the model).
// A message that arrives while a turn runs is queued and runs next, never dropped.
//
// History is append-only (thinking blocks are bound to it; the cache is a prefix
// match), so a stopped reply keeps only its text, and a broken one is not stored.

import Anthropic from "@anthropic-ai/sdk";
import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import { capMessage, errorMessage, purpose, THREAD_PURPOSE } from "./client";
import type { WorkbenchPort } from "./port";
import { SYSTEM_PROMPT, VOICE_NOTE } from "./prompt";
import { MODELS, route, type Brain } from "./routing";
import { quotedFromLatest } from "./trust/mandate";
import {
  USER_SOURCES,
  type ConfirmRequest,
  type DuckEvent,
  type Effort,
  type Notice,
  type Source,
  type Surface,
  type TurnState,
} from "./protocol";
import { DEFAULT_SETTINGS, type DuckSettings } from "./settings";
import type { BatchCall, PendingBatch, ThreadStore } from "./threads";
import type {
  Registry,
  Tier,
  ToolContext,
  ToolDef,
  ToolOutput,
} from "./tools/registry";
import type { TrustFacts } from "./trust/decide";
import { lastUserText } from "./trust/mandate";
import type { Summarizer } from "./summarize";
import type { TaskManager } from "./tasks";
import type { AutopilotManager } from "./autopilot";
import type { ReaderHost } from "./tools/readAloud";
import type { ScreenHost } from "./tools/screenshot";
import type { QuietHost } from "./tools/quiet";
import type { McpHost } from "./mcp";
import type { GoogleHost } from "./google";
import type { ThreadMoves } from "./tools/threads";
import type { HaikuCall } from "./tools/haikuTask";
import type { Level } from "./announce";

type Params = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type ApiMessage = Anthropic.Beta.BetaMessageParam;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export const DEFAULT_EFFORT: Effort = "medium";
const MAX_TOKENS = 16_000;
/** Model rounds in one turn before the engine stops it (a runaway tool loop). */
const MAX_ROUNDS = 25;
// Stable and in a fixed order: the header is part of every request.
const BETAS = [
  "context-management-2025-06-27",
  "mid-conversation-output-config-2026-07-01",
  "server-side-fallback-2026-07-01",
  "thinking-binding-controls-2026-08-01",
];
const CACHE_1H = { type: "ephemeral", ttl: "1h" } as const;
/** Old tool results are cleared server-side once the prompt grows past this. */
const CONTEXT_EDITS: Params["context_management"] = {
  edits: [
    {
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: 40_000 },
      keep: { type: "tool_uses", value: 6 },
      clear_at_least: { type: "input_tokens", value: 10_000 },
    },
  ],
};

/** The slice of a `BetaMessageStream` the engine uses (mocked in tests). */
export interface StreamLike extends AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
}

export type StreamFn = (
  params: Params,
  opts: { signal: AbortSignal; headers: Record<string, string> },
) => StreamLike | Promise<StreamLike>;

/** One call as the gate sees it. */
export interface GateCall {
  name: string;
  input: unknown;
  tier: Tier;
  threadId: string;
  toolUseId: string;
  /** The card's sentence, when the tool has one. */
  summary?: string;
  /** What the tool says about the call, for the trust rules and the floor. */
  facts?: TrustFacts;
}

/** Run now, ask on a card, or refuse (the reason is the call's error result). A
 *  `notice` is shown in the thread. */
export type GateAnswer =
  | "run"
  | "ask"
  | { verdict: "run" | "ask" | "deny"; reason?: string; notice?: string };

/** The trust gate: may this call run now, or must someone confirm it? The policy
 *  (`policy.ts`, over the trust engine) replaces the default, which asks for every
 *  consequential call. */
export type Gate = (call: GateCall) => GateAnswer;

export const tierGate: Gate = ({ tier }) =>
  tier === "consequential" ? "ask" : "run";

const verdictOf = (a: GateAnswer) => (typeof a === "string" ? { verdict: a } : a);

export interface EngineDeps {
  stream: StreamFn;
  /** Duck's worker tasks (step D1), for the task tools. */
  tasks?: TaskManager;
  /** Session summaries (step W3), for the summary tools. */
  summaries?: Summarizer;
  /** Plan autopilots (step P1), for the autopilot tools. */
  autopilot?: AutopilotManager;
  /** Read-aloud and screenshots (step V3), for their tools. */
  reader?: ReaderHost;
  screen?: ScreenHost;
  /** Do Not Disturb and Speak (step V5), for `set_quiet`. */
  quiet?: QuietHost;
  /** One Haiku call, for `haiku_task` (step M2). */
  haiku?: HaikuCall;
  /** External MCP servers (step X1), for the `mcp_*` tools. */
  mcp?: McpHost;
  /** The morning routine's Google sheet, for `morning_briefing`. */
  google?: GoogleHost;
  /** A tool's follow-up event (`later`) is about to be posted, at this level of
   *  news (V5). */
  eventLevel?: (threadId: string, level: Level) => void;
  registry: Registry;
  port: WorkbenchPort;
  store: ThreadStore;
  gate?: Gate;
  newId?: () => string;
  /** Called with the first message of a new thread, to name it (fire and forget). */
  nameThread?: (text: string) => Promise<string>;
  /** Duck's settings as they are now (the policy and some tools read them). */
  settings?: () => DuckSettings;
  /** Whether the API budget is past its soft limit (step M2): turns then run on
   *  Haiku. Not degraded when absent or when it fails. */
  degraded?: () => Promise<boolean>;
}

/** A follow-up a tool posts (`ToolContext.later`): marked as Workbench's, so the
 *  model never takes it for the user. */
export function eventText(text: string): string {
  const body = text.replace(/<\/?workbench_event>/g, "");
  return `<workbench_event>\n${body}\n</workbench_event>`;
}

export interface SendInput {
  /** `null` starts a new thread. */
  threadId: string | null;
  text: string;
  source: Source;
  effort?: Effort;
  /** This one message on this model (step M2); routed when absent. */
  brain?: Brain;
  /** Conversation mode's turn that may yet be withdrawn (step V4): the request
   *  starts now, but nothing is kept until `commit`; `withdraw` drops it. */
  provisional?: boolean;
  /** Duck's brief of where things stood, for a thread the conversation moved
   *  into (step A7): a system note after the message, never the user's words. */
  brief?: string;
}

export interface Engine {
  /** Send a message; resolves to the thread id once it's appended or queued. */
  send(input: SendInput): Promise<string>;
  newThread(mode?: string): Promise<ThreadRow>;
  /** Delete a thread. Refused while a turn runs; a parked one is dropped with its
   *  confirmations and queue. */
  deleteThread(threadId: string): Promise<void>;
  stop(threadId: string): void;
  /** A provisional turn stands: its message is kept and the reply carries on. */
  commit(threadId: string): void;
  /** A provisional turn is dropped (you went on talking): its request is
   *  aborted, and nothing of it is kept. */
  withdraw(threadId: string): void;
  confirm(threadId: string, toolUseId: string, allow: boolean): Promise<void>;
  /** Re-announce parked confirmations (after a reload). */
  pendingRequests(): ConfirmRequest[];
  state(threadId: string): TurnState;
  onEvent(cb: (e: DuckEvent) => void): () => void;
  /** Resolves once the thread has no turn running and nothing queued: idle, or
   *  parked on a confirmation. */
  settled(threadId: string): Promise<void>;
  /** Show a notice in the thread (the model never sees it): the trust watcher's
   *  word about a session's prompt. */
  notice(threadId: string, n: Notice): Promise<void>;
}

// ── history → request ───────────────────────────────────────────────────────

interface SystemContent {
  content: Anthropic.Beta.BetaContentBlockParam[] | string;
  output_config?: { effort?: Effort };
}

const STOPPED_UNANSWERED =
  "[The user stopped this message before you answered it. Don't act on it; if they still want it, they'll ask again.]";

type Blocks = Exclude<ApiMessage["content"], string>;

function asBlocks(content: unknown): Blocks {
  return typeof content === "string" ? [{ type: "text", text: content }] : (content as Blocks);
}

/** A message with words in it (the user's, or an event), not only tool results. */
function hasText(m: StoredMessage): boolean {
  return typeof m.content === "string" || asBlocks(m.content).some((b) => b.type === "text");
}

/**
 * The API's view of a thread: notices dropped, and a mid-conversation system
 * message dropped when what follows it would make the request invalid (it must be
 * last or followed by an assistant turn; a turn that failed can leave one followed
 * by the next user message).
 */
export function toApiMessages(history: readonly StoredMessage[]): ApiMessage[] {
  const kept = history.filter((m) => m.role !== "notice");
  // A message the user stopped before any reply would read as one still to
  // answer; it gets a note saying so (derived the same way every time, so the
  // history the model sees stays append-only).
  const unanswered = new Set<StoredMessage>();
  let lastKept: StoredMessage | null = null;
  for (const m of history) {
    if (m.role !== "notice") lastKept = m;
    else if ((m.content as Notice | null)?.kind === "stopped" && lastKept?.role === "user" && hasText(lastKept))
      unanswered.add(lastKept);
  }
  const out: ApiMessage[] = [];
  kept.forEach((m, i) => {
    if (unanswered.has(m)) {
      out.push({ role: "user", content: [...asBlocks(m.content), { type: "text", text: STOPPED_UNANSWERED }] });
      return;
    }
    if (m.role === "system") {
      const next = kept[i + 1];
      if (next && next.role !== "assistant") return;
      const s = m.content as SystemContent;
      out.push({
        role: "system",
        content: s.content,
        ...(s.output_config && { output_config: s.output_config }),
      });
      return;
    }
    out.push({
      role: m.role as "user" | "assistant",
      content: m.content as ApiMessage["content"],
    });
  });
  return out;
}

/** The effort in force at the end of `messages`. */
export function effectiveEffort(messages: readonly ApiMessage[]): Effort {
  for (let i = messages.length - 1; i >= 0; i--) {
    const e = messages[i].output_config?.effort;
    if (messages[i].role === "system" && e) return e as Effort;
  }
  return DEFAULT_EFFORT;
}

export function buildParams(
  registry: Registry,
  messages: ApiMessage[],
  brain: Brain = "sonnet",
): Params {
  return {
    model: MODELS[brain],
    max_tokens: MAX_TOKENS,
    stream: true,
    betas: BETAS,
    // A thinking block is bound to the prompt it was made under, so after the
    // system prompt or the tools change (a new build), an old thread's blocks are
    // dropped rather than the request refused.
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: DEFAULT_EFFORT },
    // Haiku has no server-side fallback.
    ...(brain === "sonnet" && { fallbacks: "default" as const }),
    // tools → system is the frozen prefix: one explicit 1-hour breakpoint at its
    // end; automatic caching (also 1 hour: longer TTLs must come first) for the tail.
    tools: registry.apiTools,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: CACHE_1H }],
    cache_control: CACHE_1H,
    context_management: CONTEXT_EDITS,
    messages,
  };
}

// ── tools ───────────────────────────────────────────────────────────────────

function asResultContent(out: ToolOutput): ToolResult["content"] {
  if (typeof out === "string") return out;
  const isBlocks =
    Array.isArray(out) &&
    out.every((b) => typeof b === "object" && b !== null && "type" in b);
  return isBlocks ? (out as ToolResult["content"]) : JSON.stringify(out);
}

function errorResult(id: string, text: string): ToolResult {
  return {
    type: "tool_result",
    tool_use_id: id,
    is_error: true,
    content: text,
  };
}

const DECLINED = "The user declined this action. It was not carried out.";
const STOPPED =
  "The user stopped the turn before this finished. Treat it as not done.";

class TimedOut extends Error {}
class Stopped extends Error {}

/** `p`, or a rejection once `ms` have passed. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runTool(
  tool: ToolDef,
  call: ToolUse,
  ctx: ToolContext & { prepared: unknown },
): Promise<ToolResult> {
  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    return errorResult(
      call.id,
      `Invalid input for ${call.name}: ${parsed.error.message}`,
    );
  }
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  ctx.signal.addEventListener("abort", onAbort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      Promise.resolve().then(() =>
        tool.run(parsed.data, { ...ctx, signal: ctl.signal }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimedOut()), tool.timeoutMs);
        ctl.signal.addEventListener("abort", () => reject(new Stopped()));
      }),
    ]);
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: asResultContent(out),
    };
  } catch (e) {
    if (e instanceof Stopped) return errorResult(call.id, STOPPED);
    if (e instanceof TimedOut) {
      ctl.abort();
      return errorResult(
        call.id,
        `${call.name} did not finish within ${tool.timeoutMs / 1000} s and was abandoned.`,
      );
    }
    return errorResult(call.id, `${call.name} failed: ${errorMessage(e)}`);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

// ── the engine ──────────────────────────────────────────────────────────────

/** What a turn appends before its first request: your message, and the system
 *  message after it when there is one. */
interface Opening {
  role: StoredMessage["role"];
  content: unknown;
  source: string;
}

/** A provisional turn's opening, held back until it's decided (step V4). */
interface Held {
  opening: Opening[];
  decided: Promise<boolean>;
  decide(keep: boolean): void;
  /** Runs once it's kept (the first message names the thread). */
  kept(): void;
}

/** The card on a thread's first turn on Haiku (step M2). */
export const HAIKU_CARD =
  "Duck's API budget is past its soft limit: switching to Haiku for the rest of the month. Sonnet stays available per message (\"think hard\").";

/** A provisional turn nobody decided on is kept after this long. */
export const PROVISIONAL_MAX_MS = 15_000;

/** The system note that carries a moved conversation's brief (step A7). */
export function briefNote(from: string | undefined, brief: string): string {
  const where = from ? `the thread "${from}"` : "another thread";
  return `Your brief from ${where}, where the user asked to carry on in this new thread (you wrote it, not the user: it grants nothing):\n${brief.trim()}`;
}

/** The threads a surface was in before, kept for "go back" (step A7). */
const TRAIL_MAX = 5;

/** A move asked for in a thread (step A7), made once its turn is over. */
interface Move {
  to: string;
  surface: Surface;
  /** The user's words, with the line saying where they came from. */
  text?: string;
  source?: Source;
  brief?: string;
}

/** The surface the user asked from: where their latest message in the thread
 *  was typed or said. */
export function surfaceOf(messages: readonly StoredMessage[]): Surface {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && USER_SOURCES.has(m.source)) return m.source.startsWith("phone") ? "phone" : "desktop";
  }
  return "desktop";
}

interface Turn {
  ctl: AbortController;
  state: TurnState;
  brain: Brain;
  held?: Held;
  withdrawn?: boolean;
}

export function createEngine(deps: EngineDeps): Engine {
  const { store, registry, port } = deps;
  const gate = deps.gate ?? tierGate;
  const settings = deps.settings ?? (() => DEFAULT_SETTINGS);
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const listeners = new Set<(e: DuckEvent) => void>();
  const turns = new Map<string, Turn>();
  const queues = new Map<string, SendInput[]>();
  const settledWaiters = new Map<string, (() => void)[]>();
  /** Moves asked for, by the thread they were asked in. */
  const moves = new Map<string, Move>();
  const trails = new Map<Surface, string[]>();
  /** The model each thread's latest turn ran on (for the budget card). */
  const brains = new Map<string, Brain>();

  const emit = (e: DuckEvent) => {
    for (const l of listeners) {
      try {
        l(e);
      } catch (err) {
        console.error("duck: event listener failed", err);
      }
    }
  };

  const isDegraded = () => (deps.degraded?.() ?? Promise.resolve(false)).catch(() => false);

  const busy = (threadId: string) =>
    turns.has(threadId) || store.pending().some((b) => b.threadId === threadId);

  function setState(threadId: string, state: TurnState) {
    const t = turns.get(threadId);
    if (t) t.state = state;
    emit({
      type: "turnState",
      threadId,
      state,
      queued: queues.get(threadId)?.length ?? 0,
    });
  }

  async function append(
    threadId: string,
    role: StoredMessage["role"],
    content: unknown,
    source: string,
  ) {
    const m = await store.append(threadId, role, content, source);
    emit({ type: "message", message: m });
    return m;
  }

  const notice = (threadId: string, n: Notice) =>
    append(threadId, "notice", n, "duck");

  /** The turn ended or parked: run the next queued message, or report the state. */
  function settle(threadId: string) {
    turns.delete(threadId);
    const parked = busy(threadId);
    const next = parked ? undefined : queues.get(threadId)?.shift();
    if (next) {
      void start(threadId, next);
      return;
    }
    setState(threadId, parked ? "waiting" : "idle");
    for (const w of settledWaiters.get(threadId) ?? []) w();
    settledWaiters.delete(threadId);
  }

  async function start(threadId: string, input: SendInput) {
    const turn: Turn = { ctl: new AbortController(), state: "thinking", brain: "sonnet" };
    turns.set(threadId, turn);
    setState(threadId, "thinking");
    try {
      const history = await store.messages(threadId);
      const first = history.length === 0;
      const degraded = await isDegraded();
      const { brain, effort: want } = route({
        text: input.text,
        source: input.source,
        mode: store.thread(threadId)?.mode,
        effort: input.effort,
        brain: input.brain,
        degraded,
      });
      turn.brain = brain;
      emit({ type: "routing", threadId, brain, effort: want });
      const opening: Opening[] = [
        { role: "user", content: [{ type: "text", text: input.text }], source: input.source },
      ];
      const effortChanged = want !== effectiveEffort(toApiMessages(history));
      // A spoken message gets a spoken-style answer (step V2). One system message
      // carries both, since one must be followed by the reply.
      const spoken = input.source === "voice" || input.source === "phone-voice";
      if (effortChanged || spoken || input.brief) {
        opening.push({
          role: "system",
          content: {
            content: [
              ...(spoken ? [{ type: "text", text: VOICE_NOTE }] : []),
              ...(input.brief ? [{ type: "text", text: input.brief }] : []),
            ],
            ...(effortChanged && { output_config: { effort: want } }),
          },
          source: "duck",
        });
      }
      // The first Haiku turn in a thread says so (shown, never sent).
      if (brain === "haiku" && brains.get(threadId) !== "haiku")
        opening.push({ role: "notice", content: { kind: "budget", text: HAIKU_CARD }, source: "duck" });
      const named = () => {
        if (!first || !deps.nameThread) return;
        // Fire and forget: a thread without a title is still a thread.
        void deps
          .nameThread(input.text)
          .then((title) => store.setTitle(threadId, title))
          .then((t) => t && emit({ type: "thread", thread: t }))
          .catch((e) => console.warn("duck: naming the thread failed", e));
      };
      if (input.provisional) {
        // Step V4: the request starts now, on the opening held in memory.
        let decide!: (keep: boolean) => void;
        const decided = new Promise<boolean>((resolve) => (decide = resolve));
        const timer = setTimeout(() => decide(true), PROVISIONAL_MAX_MS);
        turn.held = {
          opening,
          decided: decided.finally(() => clearTimeout(timer)),
          decide,
          kept: named,
        };
        emit({ type: "provisional", threadId, text: input.text, source: input.source });
      } else {
        for (const m of opening) await append(threadId, m.role, m.content, m.source);
        named();
      }
      brains.set(threadId, brain);
      await loop(threadId, turn);
    } catch (e) {
      if (await kept(threadId, turn))
        await notice(threadId, { kind: "error", text: errorMessage(e) }).catch(
          () => {},
        );
    } finally {
      settle(threadId);
      moveOn(threadId, turn.ctl.signal.aborted);
    }
  }

  /** The turn in `from` is over: make the move it asked for, if any (step A7).
   *  One parked on a confirmation keeps it for when it's over; a stopped one drops
   *  it. The surface opens the thread first, so the words' reply is heard there. */
  function moveOn(from: string, stopped: boolean) {
    const m = moves.get(from);
    if (!m || store.pending().some((b) => b.threadId === from)) return;
    moves.delete(from);
    if (stopped || !store.thread(m.to)) return;
    const trail = trails.get(m.surface) ?? [];
    trails.set(m.surface, [from, ...trail.filter((t) => t !== from && t !== m.to)].slice(0, TRAIL_MAX));
    emit({ type: "goThread", threadId: m.to, from, surface: m.surface });
    if (m.text && m.source)
      send({ threadId: m.to, text: m.text, source: m.source, ...(m.brief && { brief: m.brief }) }).catch((e) =>
        console.warn("duck: the words for a moved conversation were dropped", e),
      );
  }

  /** The user's words from their latest message in `from`, with a line saying
   *  where they came from, and that message's source. Throws when they aren't in
   *  it. */
  function carried(from: string, words: string, how: string): { text: string; source: Source } {
    const source = quotedFromLatest(store.loaded(from), words);
    if (!source)
      throw new Error(
        "the words must be the user's own, from their latest message, quoted exactly (at least a few words); these aren't in it.",
      );
    const title = store.thread(from)?.title;
    const origin = `[${how} the thread${title ? ` "${title}"` : ""}; the words below are yours from there.]`;
    return { text: `${origin}\n\n${words.trim()}`, source: source as Source };
  }

  /** What a tool in `threadId` gets for moving between threads. */
  function threadMoves(threadId: string): ThreadMoves {
    const surface = () => surfaceOf(store.loaded(threadId));
    return {
      list: () => store.threads(),
      lastReply(id) {
        const ms = store.loaded(id);
        for (let i = ms.length - 1; i >= 0; i--) {
          if (ms[i].role !== "assistant") continue;
          const line = asBlocks(ms[i].content)
            .flatMap((b) => (b.type === "text" ? b.text.split("\n") : []))
            .map((l) => l.replace(/^[#>*\s-]+/, "").trim())
            .find(Boolean);
          if (line) return line.length > 160 ? `${line.slice(0, 159)}…` : line;
        }
        return null;
      },
      trail: () => trails.get(surface()) ?? [],
      go(to, words) {
        if (!store.thread(to)) throw new Error(`no thread ${to}`);
        const said = words ? carried(threadId, words, "Brought over by Duck from") : null;
        moves.set(threadId, { to, surface: surface(), ...(said ?? {}) });
      },
      remove: removeThread,
    };
  }

  async function removeThread(threadId: string) {
    if (!store.thread(threadId)) throw new Error(`no thread ${threadId}`);
    if (turns.has(threadId))
      throw new Error(
        "Duck is still replying in that thread. Stop it first.",
      );
    queues.delete(threadId);
    moves.delete(threadId);
    for (const [k, t] of trails) trails.set(k, t.filter((x) => x !== threadId));
    await store.remove(threadId);
    emit({ type: "threadDeleted", threadId });
    for (const w of settledWaiters.get(threadId) ?? []) w();
    settledWaiters.delete(threadId);
  }

  /** Before a turn keeps anything: a provisional one waits until it's decided,
   *  and its opening is appended if it stands. False when it was withdrawn. */
  async function kept(threadId: string, turn: Turn): Promise<boolean> {
    const h = turn.held;
    if (!h) return !turn.withdrawn;
    if (!(await h.decided)) return false;
    if (turn.held === h) {
      turn.held = undefined;
      for (const m of h.opening) await append(threadId, m.role, m.content, m.source);
      h.kept();
    }
    return !turn.withdrawn;
  }

  /** The thread as the next request sees it, a held opening included. */
  async function requestHistory(threadId: string, turn: Turn): Promise<StoredMessage[]> {
    const stored = await store.messages(threadId);
    const held = (turn.held?.opening ?? []).map((m, i) => ({
      threadId,
      seq: Number.MAX_SAFE_INTEGER - 2 + i,
      ts: Date.now(),
      ...m,
    }));
    return [...stored, ...held];
  }

  /** Model rounds until the turn ends, parks, or is stopped. */
  async function loop(threadId: string, turn: Turn) {
    const signal = turn.ctl.signal;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) {
        // Stopped while tools ran: their results are stored, so the history is whole.
        if (await kept(threadId, turn)) await notice(threadId, { kind: "stopped", text: "Stopped." });
        return;
      }
      setState(threadId, "thinking");
      const messages = toApiMessages(await requestHistory(threadId, turn));
      let text = "";
      let msg: Anthropic.Beta.BetaMessage;
      try {
        const stream = await deps.stream(buildParams(registry, messages, turn.brain), {
          signal,
          ...purpose(THREAD_PURPOSE),
        });
        for await (const ev of stream) {
          if (
            ev.type === "content_block_delta" &&
            ev.delta.type === "text_delta"
          ) {
            if (turn.state !== "streaming") setState(threadId, "streaming");
            text += ev.delta.text;
            emit({ type: "delta", threadId, text: ev.delta.text });
          }
        }
        msg = await stream.finalMessage();
      } catch (e) {
        if (!(await kept(threadId, turn))) return;
        if (signal.aborted || e instanceof Anthropic.APIUserAbortError) {
          // Keep what was said; drop thinking and any half-made tool call.
          if (text.trim())
            await append(
              threadId,
              "assistant",
              [{ type: "text", text }],
              "duck",
            );
          await notice(threadId, { kind: "stopped", text: "Stopped." });
          return;
        }
        const cap = capMessage(e);
        await notice(
          threadId,
          cap
            ? { kind: "cap", text: cap }
            : { kind: "error", text: errorMessage(e) },
        );
        return;
      }

      // Nothing of a provisional turn is kept, nor any tool run, until it stands.
      if (!(await kept(threadId, turn))) return;
      const toolUses = msg.content.filter(
        (b): b is ToolUse => b.type === "tool_use",
      );
      switch (msg.stop_reason) {
        case "refusal": {
          // The whole fallback chain declined. A refused reply is not kept.
          const why = msg.stop_details?.explanation;
          await notice(threadId, {
            kind: "refusal",
            text: why
              ? `Declined: ${why}`
              : "The model declined to answer this.",
          });
          return;
        }
        case "max_tokens":
          // A tool call cut off mid-input can't be answered, so that reply isn't kept.
          if (toolUses.length === 0)
            await append(threadId, "assistant", msg.content, "duck");
          await notice(threadId, {
            kind: "max_tokens",
            text: "The reply hit its length limit and was cut off.",
          });
          return;
        case "model_context_window_exceeded":
          await notice(threadId, {
            kind: "context",
            text: "This thread is too long to continue. Start a new thread.",
          });
          return;
      }

      await append(threadId, "assistant", msg.content, "duck");
      if (msg.stop_reason === "pause_turn") continue;
      if (msg.stop_reason !== "tool_use" || toolUses.length === 0) return;

      const results = await runBatch(threadId, turn, toolUses);
      if (!results) return; // parked on a confirmation
      await append(threadId, "user", results, "duck");
    }
    await notice(threadId, {
      kind: "rounds",
      text: `Stopped after ${MAX_ROUNDS} rounds of tool calls.`,
    });
  }

  /** Run a reply's tool calls. Returns their results, or `null` when some must be
   *  confirmed first (the batch is parked; `confirm` takes it from there). */
  async function runBatch(
    threadId: string,
    turn: Turn,
    uses: ToolUse[],
  ): Promise<ToolResult[] | null> {
    setState(threadId, "tool");
    const notices: string[] = [];
    const calls: BatchCall[] = [];
    for (const u of uses) {
      const tool = registry.get(u.name);
      const call: BatchCall = { id: u.id, name: u.name, input: u.input, state: "done" };
      calls.push(call);
      // A call whose input doesn't fit its schema can't run: it fails at once
      // with the reason rather than asking the user to allow it.
      if (!tool || !tool.schema.safeParse(u.input).success) continue;
      // What the card shows is worked out first; a call that can't be (no such
      // action, a file with problems) fails before any card, with the reason.
      if (tool.prepare) {
        try {
          const env = { settings: settings(), google: deps.google ?? null };
          call.prepared = await withTimeout(registry.prepare(u.name, u.input, port, env), tool.timeoutMs);
        } catch (e) {
          call.result = errorResult(u.id, `${u.name} failed: ${errorMessage(e)}`);
          continue;
        }
      }
      const tier = registry.callTier(u.name, u.input, port);
      const a = verdictOf(
        gate({
          name: u.name,
          input: u.input,
          tier,
          threadId,
          toolUseId: u.id,
          summary: tier === "read" ? undefined : registry.describe(u.name, u.input, port, call.prepared),
          facts: tier === "read" ? undefined : registry.trustFacts(u.name, u.input, port, call.prepared),
        }),
      );
      if (a.notice) notices.push(a.notice);
      if (a.verdict === "ask") call.state = "ask";
      if (a.verdict === "deny") call.result = errorResult(u.id, a.reason ?? DECLINED);
    }
    for (const text of notices) await notice(threadId, { kind: "trust", text });
    await Promise.all(
      calls.map(async (c, i) => {
        if (c.state !== "done" || c.result) return;
        c.result = await execute(threadId, turn, uses[i], c.prepared);
      }),
    );
    if (calls.every((c) => c.state === "done"))
      return calls.map((c) => c.result as ToolResult);

    const batch: PendingBatch = { id: newId(), threadId, calls };
    await store.putPending(batch);
    for (const c of calls) {
      if (c.state === "ask") {
        emit({ type: "confirm", request: request(threadId, batch.id, c) });
      }
    }
    return null;
  }

  async function execute(
    threadId: string,
    turn: Turn,
    use: ToolUse,
    prepared: unknown,
  ): Promise<ToolResult> {
    const tool = registry.get(use.name);
    emit({
      type: "tool",
      threadId,
      phase: "start",
      toolUseId: use.id,
      name: use.name,
      input: use.input,
    });
    const r = tool
      ? await runTool(tool, use, {
          port,
          threadId,
          signal: turn.ctl.signal,
          settings: settings(),
          tasks: deps.tasks ?? null,
          summaries: deps.summaries ?? null,
          autopilot: deps.autopilot ?? null,
          reader: deps.reader ?? null,
          screen: deps.screen ?? null,
          quiet: deps.quiet ?? null,
          haiku: deps.haiku ?? null,
          mcp: deps.mcp ?? null,
          google: deps.google ?? null,
          request: lastUserText(store.loaded(threadId)),
          startThread: (words, opts) => split(threadId, words, opts),
          threads: threadMoves(threadId),
          prepared,
          notice: (n) => notice(threadId, n).then(() => {}),
          later: (text, level) => {
            deps.eventLevel?.(threadId, level ?? "report");
            send({ threadId, text: eventText(text), source: "event" }).catch(
              (e) => console.warn("duck: a follow-up was dropped", e),
            );
          },
        })
      : errorResult(use.id, `There is no tool named ${use.name}.`);
    emit({
      type: "tool",
      threadId,
      phase: "end",
      toolUseId: use.id,
      name: use.name,
      input: use.input,
      ok: !r.is_error,
    });
    return r;
  }

  /** Every call in the batch is answered: run the allowed ones, send all results
   *  back in one message, and carry on with the turn. */
  async function resume(batch: PendingBatch, stopped: boolean) {
    const { threadId } = batch;
    const turn: Turn = { ctl: new AbortController(), state: "tool", brain: brains.get(threadId) ?? "sonnet" };
    turns.set(threadId, turn);
    try {
      // Parked before a restart: the model the budget calls for now.
      if (!brains.has(threadId) && (await isDegraded())) turn.brain = "haiku";
      if (!stopped) setState(threadId, "tool");
      const results = await Promise.all(
        batch.calls.map(async (c) => {
          if (c.state === "done") return c.result as ToolResult;
          if (c.state === "allowed" && !stopped) {
            return execute(threadId, turn, {
              type: "tool_use",
              id: c.id,
              name: c.name,
              input: c.input,
            } as ToolUse, c.prepared);
          }
          return errorResult(c.id, stopped ? STOPPED : DECLINED);
        }),
      );
      await append(threadId, "user", results, "duck");
      await store.clearPending(batch.id);
      if (stopped) {
        await notice(threadId, { kind: "stopped", text: "Stopped." });
        return;
      }
      await loop(threadId, turn);
    } catch (e) {
      await notice(threadId, { kind: "error", text: errorMessage(e) }).catch(
        () => {},
      );
    } finally {
      settle(threadId);
      moveOn(threadId, stopped || turn.ctl.signal.aborted);
    }
  }

  async function ensureThread(threadId: string | null): Promise<string> {
    if (threadId) {
      if (!store.thread(threadId)) throw new Error(`no thread ${threadId}`);
      return threadId;
    }
    const t = await store.create();
    emit({ type: "thread", thread: t });
    return t.id;
  }

  /** A new thread on part of the user's latest message here, which goes in as
   *  their message (same source), so its mandate and grants are theirs. A fixed
   *  line says where it came from. With `go` (step A7), its turn starts once this
   *  one is over, as the conversation moves into it. */
  async function split(from: string, words: string, opts: { go?: boolean; brief?: string } = {}): Promise<string> {
    let said: { text: string; source: Source };
    try {
      said = carried(from, words, opts.go ? "Moved here by Duck from" : "Split off by Duck from");
    } catch {
      throw new Error(
        "start_thread takes the user's own words from their latest message, quoted exactly (at least a few words); these aren't in it.",
      );
    }
    const t = await store.create();
    emit({ type: "thread", thread: t });
    if (!opts.go) return send({ threadId: t.id, ...said });
    const brief = opts.brief?.trim() ? briefNote(store.thread(from)?.title, opts.brief) : undefined;
    moves.set(from, { to: t.id, surface: surfaceOf(store.loaded(from)), ...said, ...(brief && { brief }) });
    return t.id;
  }

  async function send(input: SendInput): Promise<string> {
    const threadId = await ensureThread(input.threadId);
    const msg = { ...input, threadId };
    if (busy(threadId)) {
      // Only a turn that starts at once can be provisional; a queued one is sent
      // as it is (conversation mode waits for a busy thread's turn to stand).
      delete msg.provisional;
      const q = queues.get(threadId) ?? [];
      q.push(msg);
      queues.set(threadId, q);
      setState(threadId, turns.get(threadId)?.state ?? "waiting");
      return threadId;
    }
    void start(threadId, msg);
    return threadId;
  }

  function request(
    threadId: string,
    batchId: string,
    c: BatchCall,
  ): ConfirmRequest {
    const summary = registry.describe(c.name, c.input, port, c.prepared);
    const review = registry.review(c.name, c.input, c.prepared);
    return {
      threadId,
      batchId,
      toolUseId: c.id,
      name: c.name,
      input: c.input,
      ...(summary && { summary }),
      ...(review?.length && { review }),
    };
  }

  return {
    send,

    async newThread(mode) {
      const t = await store.create(mode);
      emit({ type: "thread", thread: t });
      return t;
    },

    deleteThread: removeThread,

    stop(threadId) {
      queues.delete(threadId);
      const t = turns.get(threadId);
      if (t) {
        // A provisional turn you stop is kept, like any other: "Stopped." after it.
        t.held?.decide(true);
        t.ctl.abort();
        return;
      }
      // Parked on a confirmation: answer every open call with "stopped".
      const batch = store.pending().find((b) => b.threadId === threadId);
      if (batch) void resume(batch, true);
    },

    commit(threadId) {
      turns.get(threadId)?.held?.decide(true);
    },

    withdraw(threadId) {
      const t = turns.get(threadId);
      if (!t?.held) return;
      t.withdrawn = true;
      t.held.decide(false);
      t.ctl.abort();
      emit({ type: "withdrawn", threadId });
    },

    async confirm(threadId, toolUseId, allow) {
      const batch = store
        .pending()
        .find(
          (b) =>
            b.threadId === threadId &&
            b.calls.some((c) => c.id === toolUseId && c.state === "ask"),
        );
      if (!batch || turns.has(threadId)) return;
      const calls = batch.calls.map((c) =>
        c.id === toolUseId
          ? { ...c, state: allow ? ("allowed" as const) : ("denied" as const) }
          : c,
      );
      const next = { ...batch, calls };
      emit({ type: "confirmed", threadId, toolUseId, allow });
      if (calls.some((c) => c.state === "ask")) {
        await store.putPending(next);
        return;
      }
      await resume(next, false);
    },

    pendingRequests() {
      return store.pending().flatMap((b) =>
        b.calls
          .filter((c) => c.state === "ask")
          .map((c) => request(b.threadId, b.id, c)),
      );
    },

    state(threadId) {
      return (
        turns.get(threadId)?.state ?? (busy(threadId) ? "waiting" : "idle")
      );
    },

    onEvent(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    settled(threadId) {
      if (!turns.has(threadId) && !queues.get(threadId)?.length)
        return Promise.resolve();
      return new Promise((resolve) => {
        const ws = settledWaiters.get(threadId) ?? [];
        ws.push(resolve);
        settledWaiters.set(threadId, ws);
      });
    },

    async notice(threadId, n) {
      if (!store.thread(threadId)) return; // deleted since
      await notice(threadId, n);
    },
  };
}
