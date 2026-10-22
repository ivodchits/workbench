// The subscription brain (step M3): the policy, the handoff, and turns through a
// fake headless Claude Code, with tool calls coming back over "MCP" to the engine.

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import type { StoredMessage, ThreadRow } from "../../ipc/assistant";
import type { BrainToolCall, McpResult } from "../../ipc/brain";
import type { RateLimits } from "../../ipc/usageLimits";
import { addFact, coreText } from "../core";
import { createEngine, HAIKU_MEANWHILE, toApiMessages, type StreamFn, type StreamLike } from "../engine";
import { fakePort } from "../fakePort.test-util";
import type { DuckEvent, Notice } from "../protocol";
import { MODELS } from "../routing";
import { DEFAULT_SETTINGS, type DuckSettings } from "../settings";
import { createThreadStore, type ThreadBackend } from "../threads";
import { getTime } from "../tools/getTime";
import { createRegistry } from "../tools/registry";
import { testConfirm } from "../tools/testConfirm";
import { creditsGone, pickBackend, subscriptionOver } from "./policy";
import {
  ASKED,
  BRAIN_SOURCE,
  brainTurn,
  mcpTools,
  storedBlocks,
  toMcpResult,
  TOOL_PREFIX,
  type BrainHost,
  type BrainMessage,
} from "./subscription";

type Msg = Anthropic.Beta.BetaMessage;
type Params = Parameters<StreamFn>[0];

// ── the policy ──────────────────────────────────────────────────────────────

const limits = (fiveHour: number, sevenDay = 10): RateLimits => ({
  fiveHour: { usedPercentage: fiveHour, resetsAt: 0 },
  sevenDay: { usedPercentage: sevenDay, resetsAt: 0 },
  receivedAt: 0,
});

describe("which brain answers", () => {
  it("moves to the subscription past the soft limit or out of credits, while it has room", () => {
    const base = { policy: "auto" as const, softReached: false, creditsOut: false, limits: limits(20) };
    expect(pickBackend(base).backend).toBe("api");
    expect(pickBackend({ ...base, softReached: true })).toEqual({
      backend: "subscription",
      why: "Duck's API spend is past its soft limit",
    });
    expect(pickBackend({ ...base, creditsOut: true }).why).toBe("the API credit balance is too low");
    // No reading yet counts as room.
    expect(pickBackend({ ...base, softReached: true, limits: null }).backend).toBe("subscription");
    const busy = pickBackend({ ...base, softReached: true, limits: limits(75) });
    expect(busy.backend).toBe("api");
    expect(busy.why).toContain("its 5-hour limit is at 75%");
    expect(subscriptionOver(limits(10, 85))).toBe("its weekly limit is at 85%");
    // Pinned either way.
    expect(pickBackend({ ...base, policy: "subscription", limits: limits(99) }).backend).toBe("subscription");
    expect(pickBackend({ ...base, policy: "api", creditsOut: true }).backend).toBe("api");
    expect(creditsGone(new Error("400 Your credit balance is too low to access the Anthropic API."))).toBe(true);
    expect(creditsGone(new Error("Duck's monthly API budget is used up"))).toBe(false);
  });
});

// ── what the brain is sent and what's kept ─────────────────────────────────

let seq = 0;
const row = (role: StoredMessage["role"], content: unknown, source = "desktop"): StoredMessage => ({
  threadId: "t",
  seq: seq++,
  ts: 0,
  role,
  content,
  source,
});
const say = (t: string) => [{ type: "text", text: t }];

describe("the handoff", () => {
  it("gives a new session the thread so far, its profile and the summary; a running one only what it missed", () => {
    seq = 0;
    const core = coreText(addFact(null, "Names & nicknames", '"the game" means project Hollow'))!;
    const history = [
      row("user", say("old question")),
      row("system", { content: [{ type: "text", text: core }] }, "duck"),
      row("assistant", say("old answer"), "duck"),
      row("notice", { kind: "compacted", text: "c", compaction: { summary: "They asked about Hollow.", through: 2 } }, "duck"),
      row("user", say("how's the game?")),
      row("assistant", [{ type: "text", text: "Checking." }, { type: "tool_use", id: "u1", name: "list_sessions", input: {} }], BRAIN_SOURCE),
      row("user", [{ type: "tool_result", tool_use_id: "u1", content: "2 sessions" }], BRAIN_SOURCE),
      row("assistant", say("Two sessions are running."), BRAIN_SOURCE),
      row("user", say("and now?")),
      row("assistant", say("API answer"), "duck"),
      row("user", say("what next?")),
    ];
    const fresh = brainTurn(history, 10, null);
    expect(fresh).toContain("<core_memory>");
    expect(fresh).toContain("<thread_summary>\nThey asked about Hollow.");
    expect(fresh).not.toContain("old question");
    expect(fresh).toContain("User: how's the game?");
    expect(fresh).toContain("[Duck called list_sessions {}]");
    expect(fresh).toContain("Duck: API answer");
    expect(fresh.endsWith("\n\nwhat next?")).toBe(true);
    // A session that wrote seq 7 has seen up to there.
    const caught = brainTurn(history, 10, 7);
    expect(caught).not.toContain("how's the game?");
    expect(caught).not.toContain("<core_memory>");
    expect(caught).toContain("User: and now?\nDuck: API answer");
    // Nothing missed: just the words.
    expect(brainTurn(history.slice(0, 9), 8, 7)).toBe("and now?");
  });

  it("keeps the brain's replies as API messages, and lists the registry's tools", () => {
    expect(
      storedBlocks([
        { type: "thinking", thinking: "…", signature: "s" },
        { type: "text", text: "Hi" },
        { type: "tool_use", id: "toolu_1", name: `${TOOL_PREFIX}get_time`, input: {}, caller: { type: "direct" } },
      ]),
    ).toEqual([
      { type: "text", text: "Hi" },
      { type: "tool_use", id: "toolu_1", name: "get_time", input: {} },
    ]);
    const tools = mcpTools(createRegistry([getTime, testConfirm], { deferred: new Set(["test_confirm"]) }).apiTools);
    expect(tools.map((t) => t.name)).toEqual(["get_time", "test_confirm"]);
    expect(tools[1].inputSchema).toMatchObject({ type: "object" });
    expect(
      toMcpResult({
        type: "tool_result",
        tool_use_id: "u",
        is_error: true,
        content: [
          { type: "text", text: "a" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        ],
      }),
    ).toEqual({
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "AAA", mimeType: "image/png" },
      ],
      isError: true,
    });
  });
});

// ── turns through a fake Claude Code ───────────────────────────────────────

function memoryBackend(): ThreadBackend {
  const threads: ThreadRow[] = [];
  const rows: StoredMessage[] = [];
  const pending = new Map<string, { id: string; threadId: string; data: unknown }>();
  return {
    async threadCreate(id, mode) {
      const t = { id, title: "", mode, created: 1, updated: 1 };
      threads.push(t);
      return { ...t };
    },
    async threadList() {
      return threads.map((t) => ({ ...t }));
    },
    async threadMessages(id) {
      return rows.filter((m) => m.threadId === id);
    },
    async threadTitle() {},
    async messageAppend(m) {
      const next = rows.filter((r) => r.threadId === m.threadId).length;
      if (m.seq !== next) throw new Error(`out of order: ${m.seq} != ${next}`);
      rows.push(structuredClone(m));
    },
    async pendingPut(id, threadId, data) {
      pending.set(id, { id, threadId, data: structuredClone(data) });
    },
    async pendingList() {
      return [...pending.values()];
    },
    async pendingClear(id) {
      pending.delete(id);
    },
    async threadDelete() {},
  };
}

/** One scripted turn of the brain: it gets what was sent, and plays the process. */
type Script = (text: string, io: Io) => Promise<void>;
interface Io {
  say(msg: BrainMessage): void;
  /** A tool call over MCP, as Claude Code makes it: the reply's block, the call,
   *  and the result message its loop adds. */
  tool(id: string, name: string, input: unknown): Promise<McpResult>;
  text(t: string): void;
  done(subtype?: string, extra?: Record<string, unknown>): void;
  exit(code: number, stderr: string): void;
}

let msgId = 0;
function fakeBrain(scripts: Script[]) {
  const on: {
    event?: (id: string, m: BrainMessage) => void;
    exit?: (id: string, code: number | null, stderr: string) => void;
    tool?: (c: BrainToolCall) => void;
  } = {};
  const sent: string[] = [];
  const spawns: { resumed: boolean; tools: string[] }[] = [];
  const interrupts: string[] = [];
  const sessions = new Set<string>();
  const answers = new Map<string, (r: McpResult) => void>();
  let calls = 0;
  const io = (threadId: string): Io => ({
    say: (m) => on.event!(threadId, m),
    async tool(id, name, input) {
      const mid = `msg_${msgId++}`;
      on.event!(threadId, { type: "assistant", message: { id: mid, content: [{ type: "tool_use", id, name: `${TOOL_PREFIX}${name}`, input }] } });
      const r = await new Promise<McpResult>((resolve) => {
        const callId = `bc-${calls++}`;
        answers.set(callId, resolve);
        on.tool!({ callId, threadId, name, input, toolUseId: id });
      });
      on.event!(threadId, {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, content: r.content, ...(r.isError && { is_error: true }) }] },
      });
      return r;
    },
    text(t) {
      on.event!(threadId, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
      on.event!(threadId, { type: "assistant", message: { id: `msg_${msgId++}`, content: [{ type: "text", text: t }] } });
    },
    done: (subtype = "success", extra = {}) => on.event!(threadId, { type: "result", subtype, ...extra }),
    exit: (code, stderr) => on.exit!(threadId, code, stderr),
  });
  const host: BrainHost = {
    async spawn(threadId, tools) {
      const resumed = sessions.has(threadId);
      sessions.add(threadId);
      spawns.push({ resumed, tools: tools.map((t) => t.name) });
      return { resumed };
    },
    async send(threadId, text) {
      sent.push(text);
      const s = scripts.shift();
      if (!s) throw new Error("no more scripted turns");
      void s(text, io(threadId));
    },
    async interrupt(threadId) {
      interrupts.push(threadId);
    },
    async kill() {},
    async answer(callId, result) {
      answers.get(callId)?.(result);
    },
    onEvent: (cb) => void (on.event = cb),
    onExit: (cb) => void (on.exit = cb),
    onToolCall: (cb) => void (on.tool = cb),
  };
  return { host, sent, spawns, interrupts, scripts };
}

/** The API, scripted: each step a reply or an error. */
function api(steps: (Msg | Error)[]) {
  const calls: Params[] = [];
  const stream: StreamFn = (params) => {
    calls.push(structuredClone(params));
    const step = steps.shift();
    if (!step) throw new Error("no more scripted API replies");
    if (step instanceof Error) throw step;
    const s: StreamLike = {
      async *[Symbol.asyncIterator]() {
        yield* [];
      },
      finalMessage: async () => step,
    };
    return s;
  };
  return { stream, calls };
}

const reply = (t: string): Msg =>
  ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "m",
    content: [{ type: "text", text: t, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as Msg;

async function setup(opts: {
  scripts: Script[];
  api?: (Msg | Error)[];
  policy?: DuckSettings["brainPolicy"];
  degraded?: () => boolean;
  limits?: () => RateLimits | null;
}) {
  const store = createThreadStore(memoryBackend());
  await store.load();
  const brain = fakeBrain(opts.scripts);
  const a = api(opts.api ?? []);
  const engine = createEngine({
    stream: a.stream,
    registry: createRegistry([getTime, testConfirm]),
    port: fakePort(),
    store,
    brain: brain.host,
    degraded: async () => opts.degraded?.() ?? false,
    limits: async () => opts.limits?.() ?? null,
    settings: () => ({ ...DEFAULT_SETTINGS, brainPolicy: opts.policy ?? "auto" }),
  });
  const events: DuckEvent[] = [];
  engine.onEvent((e) => events.push(e));
  const turn = async (words: string, threadId: string | null = null) => {
    const id = await engine.send({ threadId, text: words, source: "desktop" });
    await engine.settled(id);
    return id;
  };
  return { engine, store, brain, api: a, events, turn };
}

const notices = (ms: readonly StoredMessage[]) =>
  ms.filter((m) => m.role === "notice").map((m) => (m.content as Notice).text);
const last = <T>(xs: readonly T[], n = 1): T | undefined => xs[xs.length - n];
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(cond()).toBe(true);
};

describe("turns on the subscription brain", () => {
  it("runs Duck's tools through the gate, parks a consequential one, and tells the brain the answer", async () => {
    const { engine, store, brain, api, events, turn } = await setup({
      policy: "subscription",
      scripts: [
        async (_t, io) => {
          const r = await io.tool("toolu_a", "get_time", {});
          expect(r.isError).toBeUndefined();
          io.text("It's noon.");
          io.done();
        },
        async (_t, io) => {
          const r = await io.tool("toolu_b", "test_confirm", { action: "ship it" });
          expect(r.content[0]).toEqual({ type: "text", text: ASKED });
          io.text("That needs your OK.");
          io.done();
        },
        async (t, io) => {
          expect(t).toContain("The user answered the card");
          expect(t).toContain("test_confirm ran");
          io.text("Shipped.");
          io.done();
        },
      ],
    });
    const id = await turn("what time is it?");
    expect(api.calls).toHaveLength(0);
    expect(brain.spawns).toEqual([{ resumed: false, tools: ["get_time", "test_confirm"] }]);
    expect(brain.sent[0]).toBe("what time is it?");
    const ms = store.loaded(id);
    expect(notices(ms)).toEqual(["Now answering on your subscription: Duck's brain is set to your subscription."]);
    // Kept as API messages under Duck's names, so the thread can go on on the API.
    const sent = toApiMessages(ms);
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(sent[1].content).toEqual([{ type: "tool_use", id: "toolu_a", name: "get_time", input: {} }]);
    expect(ms.filter((m) => m.role === "assistant").every((m) => m.source === BRAIN_SOURCE)).toBe(true);
    expect(events).toContainEqual({ type: "routing", threadId: id, brain: "sonnet", effort: "medium", backend: "subscription" });

    await turn("ship it", id);
    expect(brain.spawns).toHaveLength(1); // still running
    expect(brain.sent[1]).toBe("ship it"); // it has seen the rest
    expect(engine.state(id)).toBe("waiting");
    const [ask] = engine.pendingRequests();
    expect(ask).toMatchObject({ name: "test_confirm", toolUseId: "toolu_b" });
    await engine.confirm(id, "toolu_b", true);
    await until(() => brain.sent.length === 3);
    await engine.settled(id);
    expect(engine.state(id)).toBe("idle");
    expect(last(store.loaded(id), 1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Shipped." }] });
  });

  it("follows the budget: the subscription past the soft limit with room, Haiku when it's busy, and back", async () => {
    let five = 20;
    const { store, brain, api, turn } = await setup({
      degraded: () => true,
      limits: () => limits(five),
      api: [reply("Haiku here.")],
      scripts: [
        async (_t, io) => {
          io.text("On the subscription.");
          io.done();
        },
        async (_t, io) => {
          io.text("Back again.");
          io.done();
        },
      ],
    });
    const id = await turn("hi");
    expect(notices(store.loaded(id))).toEqual([
      "Now answering on your subscription: Duck's API spend is past its soft limit.",
    ]);
    five = 75;
    await turn("and now?", id);
    expect(api.calls[0].model).toBe(MODELS.haiku);
    // The brain's turn went to the API as history.
    expect(JSON.stringify(api.calls[0].messages)).toContain("On the subscription.");
    expect(last(notices(store.loaded(id)), 1)).toBe(
      `Back on the API: Duck's API spend is past its soft limit, but your subscription is busy (its 5-hour limit is at 75%). ${HAIKU_MEANWHILE}`,
    );
    five = 20;
    await turn("one more", id);
    expect(api.calls).toHaveLength(1);
    // What the API answered meanwhile goes to the brain first.
    expect(brain.sent[1]).toContain("User: and now?\nDuck: Haiku here.");
    expect(brain.sent[1].endsWith("\n\none more")).toBe(true);
  });

  it("carries a turn the API refuses for want of credits over to the subscription, the message kept", async () => {
    const { store, brain, api, turn } = await setup({
      api: [new Error('400 {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}')],
      scripts: [
        async (t, io) => {
          expect(t).toBe("draft the email");
          io.text("Drafted.");
          io.done();
        },
        async (_t, io) => {
          io.text("Still here.");
          io.done();
        },
      ],
    });
    const id = await turn("draft the email");
    const ms = store.loaded(id);
    expect(ms.filter((m) => m.role === "user")).toHaveLength(1);
    expect(notices(ms)).toEqual(["Now answering on your subscription: the API credit balance is too low."]);
    expect(last(ms, 1)).toMatchObject({ role: "assistant", source: BRAIN_SOURCE });
    // The rest of the month stays there, without asking the API again.
    await turn("thanks", id);
    expect(api.calls).toHaveLength(1);
    expect(brain.sent).toHaveLength(2);
  });

  it("reports a brain that dies mid-turn, and starts it again for the next message", async () => {
    const { engine, store, brain, turn } = await setup({
      policy: "subscription",
      scripts: [
        async (_t, io) => {
          io.say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Let me" } } });
          io.exit(1, "panic: something\nboom");
        },
        async (_t, io) => {
          io.text("Recovered.");
          io.done();
        },
        async (_t, io) => {
          io.say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "A long" } } });
          await until(() => brain.interrupts.length === 1);
          io.done("error_during_execution", { is_error: true });
        },
      ],
    });
    const id = await turn("check the build");
    let ms = store.loaded(id);
    expect(last(ms, 2)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Let me" }] });
    expect(last(notices(ms), 1)).toBe(
      "Duck's subscription brain stopped mid-turn (exit code 1): boom. Your next message starts it again.",
    );
    await turn("try again", id);
    expect(brain.spawns.map((s) => s.resumed)).toEqual([false, true]);
    expect(last(store.loaded(id), 1)).toMatchObject({ content: [{ type: "text", text: "Recovered." }] });
    // Stopping a brain's turn interrupts it, and keeps what was said.
    const sending = engine.send({ threadId: id, text: "write a long answer", source: "desktop" });
    await until(() => brain.sent.length === 3);
    await sending;
    await until(() => engine.state(id) === "streaming");
    engine.stop(id);
    await engine.settled(id);
    ms = store.loaded(id);
    expect(last(ms, 2)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "A long" }] });
    expect(last(notices(ms), 1)).toBe("Stopped.");
  });
});
