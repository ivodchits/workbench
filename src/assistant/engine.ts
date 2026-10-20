// Duck's engine (step A2): a manual streaming loop over the Messages API, not the
// SDK's tool runner, because a turn has to be able to stop at a confirmation gate
// and pick up again later, possibly after a restart.
//
// One turn, per thread:
//   1. Append the user's message (and, when the effort changes, a mid-conversation
//      system message carrying it, which keeps the cache).
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
import { MAIN_MODEL, SYSTEM_PROMPT } from "./prompt";
import type {
  ConfirmRequest,
  DuckEvent,
  Effort,
  Notice,
  Source,
  TurnState,
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
  registry: Registry;
  port: WorkbenchPort;
  store: ThreadStore;
  gate?: Gate;
  newId?: () => string;
  /** Called with the first message of a new thread, to name it (fire and forget). */
  nameThread?: (text: string) => Promise<string>;
  /** Duck's settings as they are now (the policy and some tools read them). */
  settings?: () => DuckSettings;
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
}

export interface Engine {
  /** Send a message; resolves to the thread id once it's appended or queued. */
  send(input: SendInput): Promise<string>;
  newThread(mode?: string): Promise<ThreadRow>;
  /** Delete a thread. Refused while a turn runs; a parked one is dropped with its
   *  confirmations and queue. */
  deleteThread(threadId: string): Promise<void>;
  stop(threadId: string): void;
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

/**
 * The API's view of a thread: notices dropped, and a mid-conversation system
 * message dropped when what follows it would make the request invalid (it must be
 * last or followed by an assistant turn; a turn that failed can leave one followed
 * by the next user message).
 */
export function toApiMessages(history: readonly StoredMessage[]): ApiMessage[] {
  const kept = history.filter((m) => m.role !== "notice");
  const out: ApiMessage[] = [];
  kept.forEach((m, i) => {
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
): Params {
  return {
    model: MAIN_MODEL,
    max_tokens: MAX_TOKENS,
    stream: true,
    betas: BETAS,
    thinking: { type: "adaptive" },
    output_config: { effort: DEFAULT_EFFORT },
    fallbacks: "default",
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

interface Turn {
  ctl: AbortController;
  state: TurnState;
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

  const emit = (e: DuckEvent) => {
    for (const l of listeners) {
      try {
        l(e);
      } catch (err) {
        console.error("duck: event listener failed", err);
      }
    }
  };

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
    const turn: Turn = { ctl: new AbortController(), state: "thinking" };
    turns.set(threadId, turn);
    setState(threadId, "thinking");
    try {
      const history = await store.messages(threadId);
      const first = history.length === 0;
      await append(
        threadId,
        "user",
        [{ type: "text", text: input.text }],
        input.source,
      );
      const want = input.effort ?? DEFAULT_EFFORT;
      if (want !== effectiveEffort(toApiMessages(history))) {
        await append(
          threadId,
          "system",
          { content: [], output_config: { effort: want } },
          "duck",
        );
      }
      if (first && deps.nameThread) {
        // Fire and forget: a thread without a title is still a thread.
        void deps
          .nameThread(input.text)
          .then((title) => store.setTitle(threadId, title))
          .then((t) => t && emit({ type: "thread", thread: t }))
          .catch((e) => console.warn("duck: naming the thread failed", e));
      }
      await loop(threadId, turn);
    } catch (e) {
      await notice(threadId, { kind: "error", text: errorMessage(e) }).catch(
        () => {},
      );
    } finally {
      settle(threadId);
    }
  }

  /** Model rounds until the turn ends, parks, or is stopped. */
  async function loop(threadId: string, turn: Turn) {
    const signal = turn.ctl.signal;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) {
        // Stopped while tools ran: their results are stored, so the history is whole.
        await notice(threadId, { kind: "stopped", text: "Stopped." });
        return;
      }
      setState(threadId, "thinking");
      const messages = toApiMessages(await store.messages(threadId));
      let text = "";
      let msg: Anthropic.Beta.BetaMessage;
      try {
        const stream = await deps.stream(buildParams(registry, messages), {
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
          call.prepared = await withTimeout(registry.prepare(u.name, u.input, port), tool.timeoutMs);
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
          request: lastUserText(store.loaded(threadId)),
          prepared,
          notice: (n) => notice(threadId, n).then(() => {}),
          later: (text) => {
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
    const turn: Turn = { ctl: new AbortController(), state: "tool" };
    turns.set(threadId, turn);
    try {
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

  async function send(input: SendInput): Promise<string> {
    const threadId = await ensureThread(input.threadId);
    const msg = { ...input, threadId };
    if (busy(threadId)) {
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

    async deleteThread(threadId) {
      if (!store.thread(threadId)) throw new Error(`no thread ${threadId}`);
      if (turns.has(threadId))
        throw new Error(
          "Duck is still replying in that thread. Stop it first.",
        );
      queues.delete(threadId);
      await store.remove(threadId);
      emit({ type: "threadDeleted", threadId });
      for (const w of settledWaiters.get(threadId) ?? []) w();
      settledWaiters.delete(threadId);
    },

    stop(threadId) {
      queues.delete(threadId);
      const t = turns.get(threadId);
      if (t) {
        t.ctl.abort();
        return;
      }
      // Parked on a confirmation: answer every open call with "stopped".
      const batch = store.pending().find((b) => b.threadId === threadId);
      if (batch) void resume(batch, true);
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
