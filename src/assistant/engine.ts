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
//
// Compaction (step A6): once a turn is over, a thread whose last request was past
// the `compactAt` setting (or that the user asked to compact) gets a summary of its
// older turns, written by the same model over the same prefix, so the request reads
// the cache. The summary is stored as a `compacted` notice naming the last message
// it covers; requests send it in place of those messages, and the last few turns
// go verbatim. The stored messages stay, so the drawer still shows everything.
//
// The subscription brain (step M3): when the policy (`brain/policy.ts`) picks it,
// a turn runs in a headless Claude Code on the subscription instead of this loop.
// Its replies are stored as any turn's; its tool calls come back here through the
// same gate, confirmations and time budgets. A call that must be confirmed parks
// on its own and answers the brain at once that it's waiting; the user's answer
// goes back to it as a Workbench event. An API turn the API refuses for want of
// credits carries on there, the user's message kept.
//
// Modes (step S1, `modes.ts`): a thread's mode gives its system prompt, its tools
// and the effort it starts at, for its whole life. A call to a tool outside the
// mode fails with the reason.

import Anthropic from "@anthropic-ai/sdk";
import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import {
  attachmentsOf,
  createFileCache,
  expand,
  findAttachment,
  isAttachment,
  MAX_ATTACHMENTS,
  noFile,
  toApiBlocks,
  type AttachmentHost,
  type AttachmentRef,
  type FileData,
} from "./attachments";
import { capMessage, errorMessage, purpose, THREAD_PURPOSE } from "./client";
import type { WorkbenchPort } from "./port";
import { CORE_OPEN, coreText, type CoreHost } from "./core";
import { memoryOff, recallFor, recallRow, type MemoryHost, type Recall } from "./memory";
import { COMPACT_REQUEST, compactedText } from "./prompt";
import { DEFAULT_PROMPTS, type ConfigHost, type Prompts } from "./config";
import type { RoutinesHost } from "./tools/routines";
import { MODELS, route, type Brain } from "./routing";
import { findMode, modeOf, systemFor as modeSystem, thinksOnSession, type Mode } from "./modes";
import { skillsBlock, type SkillsHost } from "./skills";
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
import type { HostedCaller } from "./tools/mcpHost";
import type { GoogleHost } from "./google";
import type { HostCaller } from "./hosts";
import type { MusicProvider } from "./music/provider";
import type { RemindersHost } from "./reminders";
import type { ThreadMoves } from "./tools/threads";
import type { HaikuCall } from "./tools/haikuTask";
import type { Level } from "./announce";
import type { RateLimits } from "../ipc/usageLimits";
import { creditsGone, pickBackend, switchCard, type Backend, type BackendChoice } from "./brain/policy";
import {
  ASKED,
  BRAIN_IDLE_MS,
  BRAIN_MAX,
  BRAIN_SOURCE,
  brainTurn,
  lastBrainSeq,
  mcpTools,
  storedBlocks,
  storedResults,
  toMcpResult,
  unanswered,
  type BrainHost,
  type BrainMessage,
  type BrainSpawnOptions,
} from "./brain/subscription";
import type { BrainToolCall } from "../ipc/brain";

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
  "mid-conversation-system-clear-at-2026-08-21",
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
  /** The hosted stdio servers and the browser's profiles (step B2). */
  hosted?: HostedCaller;
  /** The connected hosts (step H1), for the `pc` and `phone` tools. */
  hosts?: HostCaller;
  /** Music and video search and play (step H3), for `play_music` and the rest. */
  music?: MusicProvider;
  /** The user's reminders (step H8): their tools, and the general ones' note on
   *  the first message of a conversation. */
  reminders?: RemindersHost;
  /** The morning routine's Google sheet, for `morning_briefing`. */
  google?: GoogleHost;
  /** Duck's core memory (step W4): read into each new thread, edited by
   *  `remember_core` and `forget`. */
  core?: CoreHost;
  /** Duck's long-term memory (step L1): searched before each of your messages
   *  (automatic recall), and the `remember` / `recall` / `forget` tools. */
  memory?: MemoryHost;
  /** Attachments (step G1): how each is sent, and an image's or PDF's bytes.
   *  Without it, a message's files are referenced only. */
  attachments?: AttachmentHost;
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
  /** Duck's prompts as files (step L3): the system prompt and the voice note each
   *  thread was pinned on. The built-in ones when absent. */
  config?: ConfigHost;
  /** Routines and the backup (step L4), for their tools. */
  routines?: RoutinesHost;
  /** Duck's skills (step S2): listed after the system prompt, and the modes they
   *  declare. None when absent. */
  skills?: SkillsHost;
  /** Whether the API budget is past its soft limit (step M2): turns then run on
   *  Haiku. Not degraded when absent or when it fails. */
  degraded?: () => Promise<boolean>;
  /** The subscription brain (step M3). Without it, every turn is on the API. */
  brain?: BrainHost;
  /** The subscription's usage windows, for the brain policy. */
  limits?: () => Promise<RateLimits | null>;
}

/** The core memory's block for a new thread, or null (none, or unreadable). */
async function readCore(core: CoreHost): Promise<string | null> {
  try {
    return coreText((await core.read()).text);
  } catch (e) {
    console.warn("duck: the core memory couldn't be read", e);
    return null;
  }
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
  /** The mode of the thread a `null` `threadId` starts (step S1). */
  mode?: string;
  /** Files sent with the message (step G1), stored already. */
  attachments?: AttachmentRef[];
}

export interface ImportedThread {
  id: string;
  title: string;
  /** Alternating, from a user's: plain text each. */
  messages: { role: "user" | "assistant"; text: string; source: Source }[];
}

export interface Engine {
  /** Send a message; resolves to the thread id once it's appended or queued. */
  send(input: SendInput): Promise<string>;
  /** A new thread; `title` names it at once (Duck's own threads, step L4). */
  newThread(mode?: string, title?: string): Promise<ThreadRow>;
  /** A conversation held elsewhere, as a thread of its own (step H7: the phone's
   *  offline brain's): its messages stored as they were, no turn run. False when
   *  a thread `id` is already here. */
  importThread(t: ImportedThread): Promise<boolean>;
  /** Delete a thread. Refused while a turn runs; a parked one is dropped with its
   *  confirmations and queue. */
  deleteThread(threadId: string): Promise<void>;
  /** Keep a thread from the clean-up of idle threads (step L4), or stop. */
  keepThread(threadId: string, keep: boolean): Promise<void>;
  stop(threadId: string): void;
  /** A provisional turn stands: its message is kept and the reply carries on. */
  commit(threadId: string): void;
  /** A provisional turn is dropped (you went on talking): its request is
   *  aborted, and nothing of it is kept. */
  withdraw(threadId: string): void;
  /** `choice`: which of the card's choices allowed it (B2), for a tool that has them. */
  confirm(threadId: string, toolUseId: string, allow: boolean, choice?: string): Promise<void>;
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
  /** Compact a thread (step A6): now, or once the turn running there is over.
   *  Resolves once it's started or scheduled; `settled` waits for it. */
  compact(threadId: string): Promise<void>;
}

// ── history → request ───────────────────────────────────────────────────────

interface SystemContent {
  content: Anthropic.Beta.BetaContentBlockParam[] | string;
  output_config?: { effort?: Effort };
  /** Turn-scoped (step L1's recall): shown for this reply only, then cleared by
   *  the API, and still sent as it was. */
  clear_at?: "next_user_message";
}

const STOPPED_UNANSWERED =
  "[The user stopped this message before you answered it. Don't act on it; if they still want it, they'll ask again.]";

type Blocks = Exclude<ApiMessage["content"], string>;

function asBlocks(content: unknown): Blocks {
  return typeof content === "string" ? [{ type: "text", text: content }] : (content as Blocks);
}

/** A message with words in it (the user's, or an event), not only tool results:
 *  text, or files sent (step G1). */
function hasText(m: StoredMessage): boolean {
  return typeof m.content === "string" || asBlocks(m.content).some((b) => b.type === "text" || isAttachment(b));
}

/** A message's content as sent: its attachments as the API's blocks (step G1). */
function sentContent(content: unknown, files?: FileData): ApiMessage["content"] {
  if (!Array.isArray(content) || !content.some(isAttachment)) return content as ApiMessage["content"];
  return (content as unknown[]).flatMap((b) => (isAttachment(b) ? toApiBlocks(b, files) : [b])) as Blocks;
}

/** The latest core memory block (step W4) in a system message at or before
 *  `through`: what a compaction cut away. */
function droppedCore(history: readonly StoredMessage[], through: number): string | null {
  let found: string | null = null;
  for (const m of history) {
    if (m.seq > through) break;
    if (m.role !== "system") continue;
    for (const b of asBlocks((m.content as SystemContent).content))
      if (b.type === "text" && b.text.startsWith(CORE_OPEN)) found = b.text;
  }
  return found;
}

/**
 * The API's view of a thread: notices dropped, and a mid-conversation system
 * message dropped when what follows it would make the request invalid (it must be
 * last or followed by an assistant turn, other system messages aside; a turn that
 * failed can leave one followed by the next user message).
 */
export function toApiMessages(history: readonly StoredMessage[], files?: FileData): ApiMessage[] {
  // After a compaction (step A6), its summary stands in for what it covers.
  const c = lastCompaction(history);
  const kept = history.filter((m) => m.role !== "notice" && (!c || m.seq > c.through));
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
      out.push({ role: "user", content: [...asBlocks(sentContent(m.content, files)), { type: "text", text: STOPPED_UNANSWERED }] });
      return;
    }
    if (m.role === "system") {
      const next = kept.slice(i + 1).find((n) => n.role !== "system");
      if (next && next.role !== "assistant") return;
      const s = m.content as SystemContent;
      out.push({
        role: "system",
        content: s.content,
        ...(s.output_config && { output_config: s.output_config }),
        // Not in the SDK's types yet (a beta field).
        ...(s.clear_at && ({ clear_at: s.clear_at } as object)),
      } as ApiMessage);
      return;
    }
    out.push({
      role: m.role as "user" | "assistant",
      content: m.role === "user" ? sentContent(m.content, files) : (m.content as ApiMessage["content"]),
    });
  });
  if (c) {
    // The cut is always at the start of a turn, so what follows is your message:
    // the summary goes in front of it, in the same user turn, after the core
    // memory the thread started with (step W4), which the cut would drop.
    const core = droppedCore(history, c.through);
    const head = [
      ...(core ? [{ type: "text" as const, text: core }] : []),
      { type: "text" as const, text: compactedText(c.summary) },
    ];
    if (out[0]?.role === "user") out[0] = { ...out[0], content: [...head, ...asBlocks(out[0].content)] };
    else out.unshift({ role: "user", content: head });
  }
  return out;
}

// ── compaction (step A6) ────────────────────────────────────────────────────

type Compaction = NonNullable<Notice["compaction"]>;

/** The thread's latest compaction, if it has one. */
export function lastCompaction(history: readonly StoredMessage[]): Compaction | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const c = m.role === "notice" ? (m.content as Notice | null)?.compaction : undefined;
    if (c) return c;
  }
  return null;
}

/** Turns a compaction keeps verbatim, at most. */
export const KEEP_TURNS = 2;
/** The share of the threshold those turns may take; a bigger turn is summarized. */
export const TAIL_SHARE = 0.3;
/** The line the drawer shows where a thread was compacted. */
export const COMPACTED_LINE = "Compacted here: Duck now works from a summary of the turns above.";
export const NOTHING_TO_COMPACT = "Nothing to compact yet: this thread has no older turns to summarize.";
export const COMPACT_PURPOSE = "compact";

/** A rough token count of the messages as sent (four characters a token). */
export function estimateTokens(messages: readonly StoredMessage[]): number {
  let chars = 0;
  for (const m of messages) if (m.role !== "notice") chars += JSON.stringify(m.content ?? "").length;
  return Math.ceil(chars / 4);
}

/**
 * Where a compaction cuts `history`: the index of the first message kept
 * verbatim. That's the start of one of the last `KEEP_TURNS` turns (a message of
 * yours or a Workbench event, never tool results), as long as the turns from there
 * fit `tailTokens`; otherwise the end, and everything is summarized. At least one
 * turn since the last compaction is always summarized. Null when there's none.
 */
export function compactionCut(history: readonly StoredMessage[], tailTokens: number): number | null {
  const prev = lastCompaction(history)?.through ?? -1;
  const starts: number[] = [];
  history.forEach((m, i) => {
    if (m.role === "user" && m.source !== "duck" && m.source !== BRAIN_SOURCE && m.seq > prev && hasText(m)) starts.push(i);
  });
  if (starts.length === 0) return null;
  let cut = history.length;
  for (let k = 1; k <= Math.min(KEEP_TURNS, starts.length - 1); k++) {
    const i = starts[starts.length - k];
    if (estimateTokens(history.slice(i)) > tailTokens) break;
    cut = i;
  }
  return cut;
}

/** The input tokens a request was billed for, cached or not. */
function inputTokens(u: Anthropic.Beta.BetaUsage | undefined): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}

/** The request that writes a compaction's summary: the thread up to the cut, as
 *  sent before (so it reads the cache), then the instruction. */
export function compactionMessages(summarized: readonly StoredMessage[]): ApiMessage[] {
  const messages = toApiMessages(summarized);
  // A turn that failed can leave a system message last, which only a reply may follow.
  while (messages[messages.length - 1]?.role === "system") messages.pop();
  const ask = { type: "text" as const, text: COMPACT_REQUEST };
  const last = messages[messages.length - 1];
  if (last?.role === "user") messages[messages.length - 1] = { ...last, content: [...asBlocks(last.content), ask] };
  else messages.push({ role: "user", content: [ask] });
  return messages;
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
  system: string = DEFAULT_PROMPTS.system,
  tools: Anthropic.Beta.BetaToolUnion[] = registry.apiTools,
  skills: string | null = null,
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
    // The skills (step S2) come after it with a breakpoint of their own, so a
    // changed skill rewrites only from there.
    tools,
    system: [
      { type: "text", text: system, cache_control: CACHE_1H },
      ...(skills ? [{ type: "text" as const, text: skills, cache_control: CACHE_1H }] : []),
    ],
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

/** What a brain's failed `result` says. */
function brainError(r: { subtype: string; result?: string; errors?: string[] }): string {
  return r.result?.trim() || r.errors?.join("; ") || r.subtype.replace(/_/g, " ");
}
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

/** The month a "credit balance is too low" is remembered for. */
const monthKey = () => new Date().toISOString().slice(0, 7);

/** The user's message a turn answers: the last one with words that isn't Duck's. */
function turnMessage(history: readonly StoredMessage[]): StoredMessage | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && m.source !== "duck" && m.source !== BRAIN_SOURCE && hasText(m)) return m;
  }
  return undefined;
}

/** One brain turn being heard: what its process says, and its end. */
interface BrainRun {
  message(msg: BrainMessage): void;
  exit(code: number | null, stderr: string): void;
}

/** A brain process the engine started and hasn't stopped. */
interface LiveBrain {
  /** Its session is new: it has seen none of the thread. */
  fresh: boolean;
  /** What it was started with (model, effort, why): another needs a new process. */
  spec: string;
  last: number;
  idle?: ReturnType<typeof setTimeout>;
}

/** What the card back on the API adds when the turn runs on Haiku. */
export const HAIKU_MEANWHILE = 'Haiku answers meanwhile; "think hard" sends a message on Sonnet.';

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
  backend: Backend;
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
  /** Each thread's last request size in input tokens (step A6). */
  const sizes = new Map<string, number>();
  /** Threads to compact once their turn is over: asked for, not past the threshold. */
  const compactAsked = new Set<string>();
  /** The brain each thread's latest turn ran on (step M3), for the switch card. */
  const backends = new Map<string, Backend>();
  /** The month the API last said the credit balance is too low. */
  let creditsOut: string | null = null;
  /** Attachments' bytes for the requests (step G1). */
  const loadFiles = createFileCache(deps.attachments ?? { prepare: noFile, data: noFile });

  /** The prompts the thread was pinned on (step L3); the built-in ones when the
   *  config can't be read. */
  const promptsFor = (threadId: string): Promise<Prompts> =>
    deps.config
      ? deps.config.forThread(threadId).catch((e: unknown) => {
          console.warn("duck: the config couldn't be read; using the built-in prompts", e);
          return DEFAULT_PROMPTS;
        })
      : Promise.resolve(DEFAULT_PROMPTS);
  /** The thread's mode (step S1); the assistant for one not known. */
  const modeFor = (threadId: string): Mode => modeOf(store.thread(threadId)?.mode);
  /** The thread's system prompt: its mode's, or the assistant's it was pinned on. */
  const systemOf = async (threadId: string): Promise<string> =>
    modeSystem(modeFor(threadId), (await promptsFor(threadId)).system);
  const toolsOf = (threadId: string) => registry.toolsFor(modeFor(threadId).tools);
  /** The skills block a thread's requests carry (step S2), read now: a skill
   *  written or edited works from the next request. None in a mode without
   *  load_skill. Reading them also registers the modes they declare. */
  const skillsOf = async (threadId: string): Promise<string | null> => {
    if (!deps.skills) return null;
    try {
      const skills = await deps.skills.list();
      const tools = modeFor(threadId).tools;
      return !tools || tools.includes("load_skill") ? skillsBlock(skills) : null;
    } catch (e) {
      console.warn("duck: the skills couldn't be read", e);
      return null;
    }
  };
  /** A loaded skill's tools (step S2), by thread, until the next message. */
  const narrowed = new Map<string, { skill: string; tools: readonly string[] }>();
  /** The subscription brains running, and the turns listening to them. */
  const live = new Map<string, LiveBrain>();
  const brainRuns = new Map<string, BrainRun>();
  deps.brain?.onEvent((threadId, msg) => brainRuns.get(threadId)?.message(msg));
  deps.brain?.onExit((threadId, code, stderr) => {
    const b = live.get(threadId);
    if (b) clearTimeout(b.idle);
    live.delete(threadId);
    brainRuns.get(threadId)?.exit(code, stderr);
  });
  deps.brain?.onToolCall((call) => void brainCall(call));

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

  /** The thread's mode thinks on the subscription (step D3). */
  const sessionMode = (threadId: string) => thinksOnSession(modeFor(threadId), settings().sessionModes);

  /** Which brain a turn runs on (step M3). A model named outright is the API's. */
  async function chooseBackend(threadId: string, input: Pick<SendInput, "brain">, degraded: boolean): Promise<BackendChoice> {
    if (!deps.brain || input.brain) return { backend: "api", why: "" };
    const limits = await (deps.limits?.() ?? Promise.resolve(null)).catch(() => null);
    return pickBackend({
      policy: settings().brainPolicy,
      softReached: degraded,
      creditsOut: creditsOut === monthKey(),
      limits,
      session: sessionMode(threadId),
    });
  }

  async function start(threadId: string, input: SendInput) {
    const turn: Turn = { ctl: new AbortController(), state: "thinking", brain: "sonnet", backend: "api" };
    turns.set(threadId, turn);
    narrowed.delete(threadId);
    setState(threadId, "thinking");
    try {
      // The skills first: a thread in a mode one of them declares needs it known.
      await skillsOf(threadId);
      const history = await store.messages(threadId);
      const first = history.length === 0;
      const prompts = await promptsFor(threadId);
      const degraded = await isDegraded();
      const { brain, effort: want } = route({
        text: input.text,
        source: input.source,
        mode: modeFor(threadId).id,
        effort: input.effort,
        brain: input.brain,
        degraded,
      });
      turn.brain = brain;
      const choice = await chooseBackend(threadId, input, degraded);
      turn.backend = choice.backend;
      emit({
        type: "routing",
        threadId,
        mode: modeFor(threadId).id,
        brain,
        effort: want,
        ...(choice.backend === "subscription" && { backend: "subscription" as const }),
      });
      // Files go first, then your words (step G1).
      const files = input.attachments?.length
        ? await expand(input.attachments.slice(0, MAX_ATTACHMENTS), deps.attachments ?? { prepare: noFile, data: noFile }, settings().attachmentTokens)
        : [];
      const opening: Opening[] = [
        { role: "user", content: [...files, ...(input.text.trim() || !files.length ? [{ type: "text", text: input.text }] : [])], source: input.source },
      ];
      const effortChanged = want !== effectiveEffort(toApiMessages(history));
      // A spoken message gets a spoken-style answer (step V2). One system message
      // carries both, since one must be followed by the reply.
      const spoken = input.source === "voice" || input.source === "phone-voice";
      // A new thread starts with the core memory (step W4); a read that fails
      // leaves it out rather than holding the turn.
      const core = first && deps.core ? await readCore(deps.core) : null;
      if (effortChanged || spoken || input.brief || core) {
        opening.push({
          role: "system",
          content: {
            content: [
              ...(core ? [{ type: "text", text: core }] : []),
              ...(spoken ? [{ type: "text", text: prompts.voice }] : []),
              ...(input.brief ? [{ type: "text", text: input.brief }] : []),
            ],
            ...(effortChanged && { output_config: { effort: want } }),
          },
          source: "duck",
        });
      }
      // What the long-term memory holds about your message (step L1), for this
      // reply only: a turn-scoped note after the others, kept as it was sent. It
      // also carries a contradiction the tidy wants to ask about (step L2).
      const recall = deps.memory && input.source !== "event" ? await recallFor(deps.memory, input.text) : null;
      if (recall?.note)
        opening.push({
          role: "system",
          content: { content: [{ type: "text", text: recall.note }], clear_at: "next_user_message" },
          source: "duck",
        });
      // The general reminders (step H8), on a new thread or after a quiet spell:
      // turn-scoped too, so Duck mentions them once and the prefix holds.
      const reminded = deps.reminders && USER_SOURCES.has(input.source) ? deps.reminders.opening(first) : null;
      if (reminded)
        opening.push({
          role: "system",
          content: { content: [{ type: "text", text: reminded }], clear_at: "next_user_message" },
          source: "duck",
        });
      const before = history[history.length - 1]?.seq ?? 0;
      // A turn on the other brain than the thread's last says so (step M3), and so
      // does the first Haiku turn in a thread (shown, never sent).
      const onHaiku = choice.backend === "api" && brain === "haiku";
      if (choice.backend !== (backends.get(threadId) ?? "api"))
        opening.push({
          role: "notice",
          content: { kind: "budget", text: `${switchCard(choice)}${onHaiku ? ` ${HAIKU_MEANWHILE}` : ""}` },
          source: "duck",
        });
      else if (onHaiku && brains.get(threadId) !== "haiku")
        opening.push({ role: "notice", content: { kind: "budget", text: HAIKU_CARD }, source: "duck" });
      const named = () => {
        if (!first || !deps.nameThread) return;
        // Fire and forget: a thread without a title is still a thread.
        void deps
          .nameThread(input.text.trim() || `Files: ${files.map((f) => f.name).join(", ")}`)
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
      // The API's model, which a subscription turn didn't use.
      if (choice.backend === "api") brains.set(threadId, brain);
      backends.set(threadId, choice.backend);
      if (choice.backend === "subscription") await brainLoop(threadId, turn);
      else if ((await loop(threadId, turn)) === "credits") await creditsLoop(threadId, turn, degraded);
      if (recall) logRecall(threadId, recall, before);
      await afterTurn(threadId, turn);
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
      compact: () => void compactAsked.add(threadId),
    };
  }

  /** The turn is over: compact the thread if it has grown past the threshold, or
   *  was asked to be. A parked turn waits until it's answered; a stopped one
   *  isn't compacted. */
  /** Log a turn's automatic recall with what the reply used of it (step L2); not
   *  in a thread you asked Duck not to remember. */
  function logRecall(threadId: string, recall: Recall, after: number) {
    const log = deps.memory?.log;
    const messages = store.loaded(threadId);
    if (!log || memoryOff(messages)) return;
    const row = recallRow(threadId, recall, messages.filter((m) => m.seq > after), Date.now());
    void log(row).catch((e: unknown) => console.warn("duck: the recall log failed", e));
  }

  async function afterTurn(threadId: string, turn: Turn) {
    const asked = compactAsked.has(threadId);
    const at = settings().compactAt;
    if (!asked && !(at > 0 && (sizes.get(threadId) ?? 0) > at)) return;
    if (store.pending().some((b) => b.threadId === threadId)) return;
    compactAsked.delete(threadId);
    if (turn.ctl.signal.aborted || turn.withdrawn) return;
    await compactThread(threadId, turn, asked);
  }

  /** One compaction, inside `turn` (which keeps the thread busy, so a message
   *  sent meanwhile waits for it). Its failure is a notice; a stop drops it. */
  async function compactThread(threadId: string, turn: Turn, asked: boolean) {
    setState(threadId, "thinking");
    try {
      const history = await store.messages(threadId);
      const at = settings().compactAt || DEFAULT_SETTINGS.compactAt;
      const cut = compactionCut(history, at * TAIL_SHARE);
      if (cut === null) {
        if (asked) await notice(threadId, { kind: "compacted", text: NOTHING_TO_COMPACT });
        return;
      }
      const system = await systemOf(threadId);
      const messages = compactionMessages(history.slice(0, cut));
      const skills = await skillsOf(threadId);
      const stream = await deps.stream(buildParams(registry, messages, turn.brain, system, toolsOf(threadId), skills), {
        signal: turn.ctl.signal,
        ...purpose(COMPACT_PURPOSE),
      });
      for await (const ev of stream) void ev;
      const msg = await stream.finalMessage();
      const summary = msg.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("")
        .trim();
      if (msg.stop_reason === "refusal" || !summary) throw new Error("the summary came back empty");
      await notice(threadId, {
        kind: "compacted",
        text: COMPACTED_LINE,
        compaction: { summary, through: history[cut - 1].seq },
      });
      sizes.delete(threadId);
    } catch (e) {
      if (turn.ctl.signal.aborted) return;
      await notice(threadId, { kind: "error", text: `Compacting this thread failed: ${errorMessage(e)}` }).catch(
        () => {},
      );
    }
  }

  async function removeThread(threadId: string) {
    if (!store.thread(threadId)) throw new Error(`no thread ${threadId}`);
    if (turns.has(threadId))
      throw new Error(
        "Duck is still replying in that thread. Stop it first.",
      );
    queues.delete(threadId);
    moves.delete(threadId);
    sizes.delete(threadId);
    compactAsked.delete(threadId);
    backends.delete(threadId);
    const b = live.get(threadId);
    if (b) {
      clearTimeout(b.idle);
      live.delete(threadId);
      void deps.brain?.kill(threadId).catch(() => {});
    }
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

  /** Model rounds until the turn ends, parks, or is stopped. "credits": the API
   *  refused it for want of credits, with the subscription brain there to take it
   *  (nothing of the failed request is kept). */
  async function loop(threadId: string, turn: Turn): Promise<"credits" | void> {
    const signal = turn.ctl.signal;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) {
        // Stopped while tools ran: their results are stored, so the history is whole.
        if (await kept(threadId, turn)) await notice(threadId, { kind: "stopped", text: "Stopped." });
        return;
      }
      setState(threadId, "thinking");
      const history = await requestHistory(threadId, turn);
      const messages = toApiMessages(history, await loadFiles(history.flatMap((m) => (m.role === "user" ? attachmentsOf(m.content) : []))));
      const system = await systemOf(threadId);
      const skills = await skillsOf(threadId);
      let text = "";
      let msg: Anthropic.Beta.BetaMessage;
      try {
        const stream = await deps.stream(buildParams(registry, messages, turn.brain, system, toolsOf(threadId), skills), {
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
          } else if (ev.type === "content_block_start" && ev.content_block.type === "server_tool_use") {
            // A web search or fetch (B1) runs on the server, inside this reply.
            setState(threadId, "tool");
          }
        }
        msg = await stream.finalMessage();
        sizes.set(threadId, inputTokens(msg.usage));
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
        if (creditsGone(e) && deps.brain && !text.trim()) {
          creditsOut = monthKey();
          return "credits";
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
    for (const u of uses) calls.push(await judge(threadId, u, notices));
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

  /** A call before it runs: what its card needs, the gate's verdict (`ask` to
   *  confirm), or its result already when it can't run. The gate's word for the
   *  thread goes in `notices`. */
  async function judge(threadId: string, u: ToolUse, notices: string[]): Promise<BatchCall> {
    const tool = registry.get(u.name);
    const call: BatchCall = { id: u.id, name: u.name, input: u.input, state: "done" };
    // A call whose input doesn't fit its schema can't run: it fails at once
    // with the reason rather than asking the user to allow it.
    if (!tool || !tool.schema.safeParse(u.input).success) return call;
    // Only the mode's tools (step S1): another one is the assistant's to call.
    const allowed = modeFor(threadId).tools;
    if (allowed && !allowed.includes(u.name)) {
      call.result = errorResult(
        u.id,
        `${u.name} isn't available in this ${modeFor(threadId).title} thread. If the user wants it, use switch_mode to move the request to an assistant thread.`,
      );
      return call;
    }
    // A loaded skill's tools (step S2): the rest of the turn stays inside them.
    const narrow = narrowed.get(threadId);
    if (narrow && u.name !== "load_skill" && !narrow.tools.includes(u.name)) {
      call.result = errorResult(
        u.id,
        `The skill ${narrow.skill} limits this turn to ${narrow.tools.join(", ")}; ${u.name} isn't one of them. Do the skill's work with those, or tell the user what else it would need.`,
      );
      return call;
    }
    // What the card shows is worked out first; a call that can't be (no such
    // action, a file with problems) fails before any card, with the reason.
    if (tool.prepare) {
      try {
        const env = {
          settings: settings(),
          google: deps.google ?? null,
          memory: deps.memory ?? null,
          tasks: deps.tasks ?? null,
          config: deps.config ?? null,
          skills: deps.skills ?? null,
        };
        call.prepared = await withTimeout(registry.prepare(u.name, u.input, port, env), tool.timeoutMs);
      } catch (e) {
        call.result = errorResult(u.id, `${u.name} failed: ${errorMessage(e)}`);
        return call;
      }
    }
    const tier = registry.callTier(u.name, u.input, port, call.prepared);
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
    return call;
  }

  // ── the subscription brain (step M3) ──

  /** The API refused the turn for want of credits: on to the subscription, if the
   *  policy allows it now, with a card; otherwise the turn ends saying why. */
  async function creditsLoop(threadId: string, turn: Turn, degraded: boolean) {
    const choice = await chooseBackend(threadId, {}, degraded);
    if (choice.backend !== "subscription") {
      await notice(threadId, { kind: "error", text: `The API credit balance is too low (${choice.why}).` });
      return;
    }
    turn.backend = "subscription";
    backends.set(threadId, "subscription");
    emit({ type: "routing", threadId, mode: modeFor(threadId).id, brain: turn.brain, effort: DEFAULT_EFFORT, backend: "subscription" });
    await notice(threadId, { kind: "budget", text: switchCard(choice) });
    await brainLoop(threadId, turn);
  }

  /** Stop the brains idle longest while as many as the cap are running. */
  async function makeRoom() {
    const idle = [...live.entries()].filter(([id]) => !turns.has(id)).sort((a, b) => a[1].last - b[1].last);
    while (live.size >= BRAIN_MAX && idle.length) {
      const [id, b] = idle.shift()!;
      clearTimeout(b.idle);
      live.delete(id);
      await deps.brain!.kill(id).catch(() => {});
    }
  }

  /** A turn on the subscription brain: started if it isn't running, sent what it
   *  hasn't seen with your message, and heard until its result. */
  async function brainLoop(threadId: string, turn: Turn) {
    const host = deps.brain!;
    if (!(await kept(threadId, turn))) return;
    if (turn.ctl.signal.aborted) {
      await notice(threadId, { kind: "stopped", text: "Stopped." });
      return;
    }
    setState(threadId, "thinking");
    const history = await store.messages(threadId);
    const said = turnMessage(history);
    if (!said) throw new Error("there is no message here to answer");
    // A mode that thinks here (step D3) runs on its model and effort, and its
    // prompt says it's here by choice, not for want of credits.
    const chosen = sessionMode(threadId);
    const opts: BrainSpawnOptions = chosen
      ? { model: settings().sessionModel, effort: modeFor(threadId).effort, chosen: true }
      : {};
    const spec = JSON.stringify(opts);
    let b = live.get(threadId);
    if (b && b.spec !== spec) {
      clearTimeout(b.idle);
      live.delete(threadId);
      await host.kill(threadId).catch(() => {});
      b = undefined;
    }
    if (!b) {
      await makeRoom();
      const skills = await skillsOf(threadId);
      const system = await systemOf(threadId);
      const { resumed } = await host.spawn(threadId, mcpTools(toolsOf(threadId)), skills ? `${system}\n\n${skills}` : system, opts);
      b = { fresh: !resumed, spec, last: Date.now() };
      live.set(threadId, b);
    }
    clearTimeout(b.idle);
    const seen = b.fresh ? null : lastBrainSeq(history.filter((m) => m.seq < said.seq));
    b.fresh = false;
    try {
      await brainRun(threadId, turn, said.seq, brainTurn(history, said.seq, seen));
    } finally {
      const now = live.get(threadId);
      if (now) {
        now.last = Date.now();
        now.idle = setTimeout(() => {
          if (turns.has(threadId) || live.get(threadId) !== now) return;
          live.delete(threadId);
          void host.kill(threadId).catch(() => {});
        }, BRAIN_IDLE_MS);
      }
    }
  }

  /** Send `text` and keep what the brain says until the turn's result (or its
   *  process ending). Calls it left without a result get one saying so, so the
   *  thread stays a valid history for the API. */
  function brainRun(threadId: string, turn: Turn, turnSeq: number, text: string): Promise<void> {
    const host = deps.brain!;
    const signal = turn.ctl.signal;
    return new Promise((resolve) => {
      let reply: { id: string; blocks: Anthropic.Beta.BetaContentBlockParam[] } | null = null;
      let streamed = "";
      let chain: Promise<unknown> = Promise.resolve();
      let done = false;
      const put = (role: StoredMessage["role"], content: unknown) => {
        chain = chain.then(() => append(threadId, role, content, BRAIN_SOURCE));
      };
      // A stopped reply keeps what was said, as on the API.
      const flush = (keepStreamed: boolean) => {
        if (keepStreamed && streamed.trim()) {
          reply ??= { id: "", blocks: [] };
          reply.blocks.push({ type: "text", text: streamed });
        }
        if (reply?.blocks.length) put("assistant", reply.blocks);
        reply = null;
        streamed = "";
      };
      const onAbort = () => void host.interrupt(threadId).catch(() => {});
      const finish = (n?: Notice) => {
        if (done) return;
        done = true;
        brainRuns.delete(threadId);
        signal.removeEventListener("abort", onAbort);
        chain = chain
          .then(async () => {
            const open = unanswered(await store.messages(threadId), turnSeq);
            if (open.length) await append(threadId, "user", open.map((id) => errorResult(id, STOPPED)), BRAIN_SOURCE);
            if (n) await notice(threadId, n);
          })
          .catch((e) => console.error("duck: keeping the brain's turn failed", e));
        void chain.then(() => resolve());
      };
      brainRuns.set(threadId, {
        message(msg) {
          switch (msg.type) {
            case "stream_event": {
              const t = msg.event.delta?.type === "text_delta" ? msg.event.delta.text : undefined;
              if (!t) return;
              if (turn.state !== "streaming") setState(threadId, "streaming");
              streamed += t;
              emit({ type: "delta", threadId, text: t });
              return;
            }
            case "assistant":
              // One message per content block, the same id for one reply.
              if (reply && reply.id !== msg.message.id) flush(false);
              reply ??= { id: msg.message.id, blocks: [] };
              reply.blocks.push(...storedBlocks(msg.message.content));
              streamed = "";
              return;
            case "user": {
              flush(false);
              const results = storedResults(msg.message.content);
              if (results.length) put("user", results);
              setState(threadId, "thinking");
              return;
            }
            case "result":
              flush(signal.aborted);
              if (signal.aborted) finish({ kind: "stopped", text: "Stopped." });
              else if (msg.is_error || msg.subtype !== "success")
                finish({ kind: "error", text: `Duck's subscription brain: ${brainError(msg)}` });
              else finish();
              return;
          }
        },
        exit(code, stderr) {
          flush(true);
          const why = stderr.trim().split("\n").pop()?.trim();
          finish(
            signal.aborted
              ? { kind: "stopped", text: "Stopped." }
              : {
                  kind: "error",
                  text: `Duck's subscription brain stopped mid-turn${code !== null ? ` (exit code ${code})` : ""}${why ? `: ${why}` : ""}. Your next message starts it again.`,
                },
          );
        },
      });
      signal.addEventListener("abort", onAbort);
      host.send(threadId, text).catch((e) => {
        live.delete(threadId);
        void host.kill(threadId).catch(() => {});
        brainRuns.get(threadId)?.exit(null, errorMessage(e));
      });
    });
  }

  /** The brain called one of Duck's tools: judged and run as on the API, or parked
   *  on a card (the brain hears it's waiting). Answered either way. */
  async function brainCall(c: BrainToolCall) {
    const host = deps.brain!;
    const id = c.toolUseId ?? `toolu_${c.callId.replace(/[^A-Za-z0-9_-]/g, "")}`;
    const use = { type: "tool_use", id, name: c.name, input: c.input } as ToolUse;
    let r: ToolResult;
    try {
      const turn = turns.get(c.threadId);
      if (!turn || turn.backend !== "subscription") r = errorResult(id, "No turn of yours is running in this thread.");
      else {
        setState(c.threadId, "tool");
        const notices: string[] = [];
        const call = await judge(c.threadId, use, notices);
        for (const text of notices) await notice(c.threadId, { kind: "trust", text });
        if (call.result) r = call.result as ToolResult;
        else if (call.state === "ask") {
          const batch: PendingBatch = { id: newId(), threadId: c.threadId, calls: [call], brain: true };
          await store.putPending(batch);
          emit({ type: "confirm", request: request(c.threadId, batch.id, call) });
          r = { type: "tool_result", tool_use_id: id, content: ASKED };
        } else r = await execute(c.threadId, turn, use, call.prepared);
      }
    } catch (e) {
      r = errorResult(id, `${c.name} failed: ${errorMessage(e)}`);
    }
    await host.answer(c.callId, toMcpResult(r)).catch((e) => console.warn("duck: a tool result didn't reach the brain", e));
  }

  /** A brain call parked on a card is answered: run if allowed, and the brain told
   *  as a Workbench event (it heard "waiting" at the time). A stop drops it. */
  async function resumeBrain(batch: PendingBatch, stopped: boolean) {
    const { threadId } = batch;
    const turn: Turn = { ctl: new AbortController(), state: "tool", brain: "sonnet", backend: "subscription" };
    try {
      const said: string[] = [];
      for (const c of batch.calls) {
        if (c.state === "allowed" && !stopped) {
          const use = { type: "tool_use", id: c.id, name: c.name, input: c.input } as ToolUse;
          const r = await execute(threadId, turn, use, c.prepared);
          const out = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
          said.push(`${c.name} ${r.is_error ? "failed" : "ran"}: ${out}`);
        } else said.push(`${c.name} was declined by the user and not carried out.`);
      }
      await store.clearPending(batch.id);
      if (stopped) await notice(threadId, { kind: "stopped", text: "Stopped." });
      else
        void send({
          threadId,
          text: eventText(`The user answered the card for your earlier call.\n${said.join("\n")}`),
          source: "event",
        }).catch((e) => console.warn("duck: a confirmation's result was dropped", e));
    } catch (e) {
      await notice(threadId, { kind: "error", text: errorMessage(e) }).catch(() => {});
    } finally {
      if (!turns.has(threadId) && !busy(threadId)) settle(threadId);
    }
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
          hosted: deps.hosted ?? null,
          hosts: deps.hosts ?? null,
          music: deps.music ?? null,
          reminders: deps.reminders ?? null,
          surface: surfaceOf(store.loaded(threadId)),
          google: deps.google ?? null,
          core: deps.core ?? null,
          memory: deps.memory ?? null,
          config: deps.config ?? null,
          routines: deps.routines ?? null,
          skills: deps.skills ?? null,
          narrow: (skill, tools) => narrowed.set(threadId, { skill, tools }),
          memoryOff: memoryOff(store.loaded(threadId)),
          request: lastUserText(store.loaded(threadId)),
          attachment: (id) => findAttachment(store.loaded(threadId), id),
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
    const turn: Turn = { ctl: new AbortController(), state: "tool", brain: brains.get(threadId) ?? "sonnet", backend: "api" };
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
      if ((await loop(threadId, turn)) === "credits") await creditsLoop(threadId, turn, await isDegraded());
      await afterTurn(threadId, turn);
    } catch (e) {
      await notice(threadId, { kind: "error", text: errorMessage(e) }).catch(
        () => {},
      );
    } finally {
      settle(threadId);
      moveOn(threadId, stopped || turn.ctl.signal.aborted);
    }
  }

  async function ensureThread(threadId: string | null, mode?: string): Promise<string> {
    if (threadId) {
      if (!store.thread(threadId)) throw new Error(`no thread ${threadId}`);
      return threadId;
    }
    // A mode from a skill not read yet (step S2).
    if (mode && !findMode(mode)) await deps.skills?.list().catch(() => []);
    const t = await store.create(modeOf(mode).id);
    emit({ type: "thread", thread: t });
    return t.id;
  }

  /** A new thread on part of the user's latest message here, which goes in as
   *  their message (same source), so its mandate and grants are theirs. A fixed
   *  line says where it came from. With `go` (step A7), its turn starts once this
   *  one is over, as the conversation moves into it. */
  async function split(from: string, words: string, opts: { go?: boolean; brief?: string; mode?: string } = {}): Promise<string> {
    let said: { text: string; source: Source };
    try {
      said = carried(from, words, opts.go ? "Moved here by Duck from" : "Split off by Duck from");
    } catch {
      throw new Error(
        "start_thread takes the user's own words from their latest message, quoted exactly (at least a few words); these aren't in it.",
      );
    }
    const t = await store.create(opts.mode ? modeOf(opts.mode).id : undefined);
    emit({ type: "thread", thread: t });
    if (!opts.go) return send({ threadId: t.id, ...said });
    const brief = opts.brief?.trim() ? briefNote(store.thread(from)?.title, opts.brief) : undefined;
    moves.set(from, { to: t.id, surface: surfaceOf(store.loaded(from)), ...said, ...(brief && { brief }) });
    return t.id;
  }

  async function send(input: SendInput): Promise<string> {
    const threadId = await ensureThread(input.threadId, input.mode);
    const msg = { ...input, threadId };
    delete msg.mode;
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
    const tool = registry.get(c.name);
    return {
      threadId,
      batchId,
      toolUseId: c.id,
      name: c.name,
      input: c.input,
      ...(summary && { summary }),
      ...(review?.length && { review }),
      ...(tool?.choices?.length && { choices: tool.choices.map((x) => ({ ...x })) }),
      ...(tool?.denyLabel && { denyLabel: tool.denyLabel }),
    };
  }

  /** The card's choice (B2) kept in the call's `prepared`, for `run`: the one
   *  picked, or the first when the answer had none (a plain "allow"). */
  function chosen(c: BatchCall, choice: string | undefined): Partial<BatchCall> {
    const choices = registry.get(c.name)?.choices;
    if (!choices?.length) return {};
    const id = choices.some((x) => x.id === choice) ? choice! : choices[0].id;
    return { prepared: { ...((c.prepared as object | undefined) ?? {}), choice: id } };
  }

  return {
    send,

    async newThread(mode, title) {
      const made = await store.create(mode);
      const t = (title && (await store.setTitle(made.id, title))) || made;
      emit({ type: "thread", thread: t });
      return t;
    },

    async importThread(t) {
      if (store.thread(t.id)) return false;
      await store.create("assistant", t.id);
      for (const m of t.messages)
        await store.append(t.id, m.role, [{ type: "text", text: m.text }], m.role === "user" ? m.source : "duck");
      const made = (await store.setTitle(t.id, t.title)) ?? store.thread(t.id);
      if (made) emit({ type: "thread", thread: made });
      return true;
    },

    deleteThread: removeThread,
    async keepThread(threadId, keep) {
      const t = await store.setKeep(threadId, keep);
      if (!t) throw new Error(`no thread ${threadId}`);
      emit({ type: "thread", thread: t });
    },

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
      if (batch) void (batch.brain ? resumeBrain(batch, true) : resume(batch, true));
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

    async confirm(threadId, toolUseId, allow, choice) {
      const batch = store
        .pending()
        .find(
          (b) =>
            b.threadId === threadId &&
            b.calls.some((c) => c.id === toolUseId && c.state === "ask"),
        );
      // A brain's call parks on its own while the brain's turn may still run.
      if (!batch || (turns.has(threadId) && !batch.brain)) return;
      const calls = batch.calls.map((c) =>
        c.id === toolUseId
          ? { ...c, state: allow ? ("allowed" as const) : ("denied" as const), ...(allow && chosen(c, choice)) }
          : c,
      );
      const next = { ...batch, calls };
      emit({ type: "confirmed", threadId, toolUseId, allow });
      if (calls.some((c) => c.state === "ask")) {
        await store.putPending(next);
        return;
      }
      await (next.brain ? resumeBrain(next, false) : resume(next, false));
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

    async compact(threadId) {
      if (!store.thread(threadId)) throw new Error(`no thread ${threadId}`);
      if (busy(threadId)) {
        compactAsked.add(threadId);
        return;
      }
      const turn: Turn = { ctl: new AbortController(), state: "thinking", brain: brains.get(threadId) ?? "sonnet", backend: "api" };
      turns.set(threadId, turn);
      void (async () => {
        try {
          if (!brains.has(threadId) && (await isDegraded())) turn.brain = "haiku";
          await compactThread(threadId, turn, true);
        } finally {
          settle(threadId);
        }
      })();
    },
  };
}
