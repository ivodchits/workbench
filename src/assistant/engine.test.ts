import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import {
  buildParams,
  createEngine,
  effectiveEffort,
  toApiMessages,
  type Engine,
  type StreamFn,
  type StreamLike,
} from "./engine";
import type { WorkbenchPort } from "./port";
import type { DuckEvent } from "./protocol";
import { createThreadStore, type ThreadBackend } from "./threads";
import { getTime } from "./tools/getTime";
import { createRegistry, defineTool, type ToolDef } from "./tools/registry";

type Msg = Anthropic.Beta.BetaMessage;
type Block = Msg["content"][number];
type Params = Parameters<StreamFn>[0];

// ── fakes ───────────────────────────────────────────────────────────────────

/** duck.db in memory, with the backend's append-only rule. */
function memoryBackend(): ThreadBackend & { rows: StoredMessage[] } {
  const threads: ThreadRow[] = [];
  const rows: StoredMessage[] = [];
  const pending = new Map<
    string,
    { id: string; threadId: string; data: unknown }
  >();
  return {
    rows,
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
    async threadTitle(id, title) {
      const t = threads.find((x) => x.id === id);
      if (!t) throw new Error("no thread");
      t.title = title;
    },
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
  };
}

const port: WorkbenchPort = { listProjects: () => [], listSessions: () => [] };

function message(
  content: Block[],
  stop: Msg["stop_reason"],
  extra: Partial<Msg> = {},
): Msg {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra,
  } as Msg;
}

const text = (t: string) =>
  ({ type: "text", text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown) =>
  ({ type: "tool_use", id, name, input }) as Block;

/** One scripted reply: a message (streamed as text deltas), an error, or a stream
 *  that emits some text and then hangs until aborted. */
type Step = Msg | { error: unknown } | { hang: string };

function scripted(steps: Step[]) {
  const calls: { params: Params; headers: Record<string, string> }[] = [];
  const stream: StreamFn = (params, opts) => {
    calls.push({ params: structuredClone(params), headers: opts.headers });
    const step = steps.shift();
    if (!step) throw new Error("no more scripted replies");
    const s: StreamLike = {
      async *[Symbol.asyncIterator]() {
        if ("error" in step) throw step.error;
        if ("hang" in step) {
          yield delta(step.hang);
          await new Promise((_, reject) =>
            opts.signal.addEventListener("abort", () =>
              reject(new Anthropic.APIUserAbortError()),
            ),
          );
          return;
        }
        for (const b of step.content)
          if (b.type === "text") yield delta(b.text);
      },
      async finalMessage() {
        if ("error" in step) throw step.error;
        if ("hang" in step) throw new Anthropic.APIUserAbortError();
        return step;
      },
    };
    return s;
  };
  return { stream, calls };
}

function delta(t: string): Anthropic.Beta.BetaRawMessageStreamEvent {
  return {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: t },
  } as Anthropic.Beta.BetaRawMessageStreamEvent;
}

const sendPrompt = defineTool({
  name: "send_prompt",
  description: "Send a prompt to a session.",
  schema: z.object({ session: z.string(), text: z.string() }),
  tier: "consequential",
  run: ({ session }) => `sent to ${session}`,
});

async function setup(
  steps: Step[],
  tools: ToolDef[] = [getTime, sendPrompt],
  backend = memoryBackend(),
) {
  const store = createThreadStore(backend);
  await store.load();
  const s = scripted(steps);
  const engine = createEngine({
    stream: s.stream,
    registry: createRegistry(tools),
    port,
    store,
  });
  const events: DuckEvent[] = [];
  engine.onEvent((e) => events.push(e));
  return { engine, store, backend, events, calls: s.calls };
}

async function turn(
  engine: Engine,
  text: string,
  threadId: string | null = null,
) {
  const id = await engine.send({ threadId, text, source: "desktop" });
  await engine.settled(id);
  return id;
}

const roles = (ms: readonly StoredMessage[]) => ms.map((m) => m.role);

// ── tests ───────────────────────────────────────────────────────────────────

describe("engine", () => {
  it("runs a tool round trip and sends the frozen prefix with the thread purpose", async () => {
    const { engine, store, events, calls } = await setup([
      message(
        [text("Let me check."), toolUse("t1", "get_time", {})],
        "tool_use",
      ),
      message([text("It's Monday.")], "end_turn"),
    ]);
    const id = await turn(engine, "what day is it?");

    const ms = store.loaded(id);
    expect(roles(ms)).toEqual(["user", "assistant", "user", "assistant"]);
    const result = (
      ms[2].content as Anthropic.Beta.BetaToolResultBlockParam[]
    )[0];
    expect(result.tool_use_id).toBe("t1");
    expect(result.is_error).toBeUndefined();
    expect(JSON.parse(result.content as string)).toHaveProperty("timeZone");

    // The second request carries the whole history, append-only.
    expect(calls).toHaveLength(2);
    expect(calls[1].params.messages).toHaveLength(3);
    expect(calls[0].headers["x-wb-purpose"]).toBe("thread");
    const p = calls[0].params;
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.tools?.map((t) => (t as { name: string }).name)).toEqual([
      "get_time",
      "send_prompt",
    ]);
    expect(
      (p.system as Anthropic.Beta.BetaTextBlockParam[])[0].cache_control,
    ).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(p.fallbacks).toBe("default");

    expect(
      events
        .filter((e) => e.type === "delta")
        .map((e) => (e as { text: string }).text),
    ).toEqual(["Let me check.", "It's Monday."]);
    expect(
      events
        .filter((e) => e.type === "tool")
        .map((e) => (e as { phase: string }).phase),
    ).toEqual(["start", "end"]);
    expect(engine.state(id)).toBe("idle");
  });

  it("returns parallel tool results in one message, in order, failures marked", async () => {
    const slow = defineTool({
      name: "slow",
      description: "Never finishes in time.",
      schema: z.object({}),
      tier: "read",
      timeoutMs: 20,
      run: () => new Promise(() => {}),
    });
    const { engine, store } = await setup(
      [
        message(
          [
            toolUse("a", "get_time", {}),
            toolUse("b", "get_time", { extra: 1 }), // zod strips unknown keys: still valid
            toolUse("c", "slow", {}),
            toolUse("d", "no_such_tool", {}),
          ],
          "tool_use",
        ),
        message([text("Done.")], "end_turn"),
      ],
      [getTime, slow],
    );
    const id = await turn(engine, "go");
    const ms = store.loaded(id);
    expect(roles(ms)).toEqual(["user", "assistant", "user", "assistant"]);
    const results = ms[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b", "c", "d"]);
    expect(results.map((r) => !!r.is_error)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(results[2].content).toMatch(/did not finish within/);
  });

  it("parks a consequential call, survives a restart, and resumes on confirm", async () => {
    const first = await setup([
      message(
        [
          toolUse("g", "get_time", {}),
          toolUse("s", "send_prompt", { session: "api", text: "run tests" }),
        ],
        "tool_use",
      ),
    ]);
    const id = await turn(first.engine, "tell api to run the tests");

    // Parked: the read ran, the send waits; nothing more was asked of the model.
    expect(first.engine.state(id)).toBe("waiting");
    expect(first.calls).toHaveLength(1);
    const ask = first.events.find((e) => e.type === "confirm");
    expect(ask).toMatchObject({
      request: { toolUseId: "s", name: "send_prompt" },
    });
    expect(roles(first.store.loaded(id))).toEqual(["user", "assistant"]);

    // "Restart": a new store and engine over the same database.
    const second = await setup(
      [
        message([text("Sent.")], "end_turn"),
        message([text("Nothing else.")], "end_turn"),
      ],
      undefined,
      first.backend,
    );
    expect(second.engine.pendingRequests()).toMatchObject([
      { threadId: id, toolUseId: "s" },
    ]);
    await second.engine.confirm(id, "s", true);
    await second.engine.settled(id);

    const ms = await second.store.messages(id);
    expect(roles(ms)).toEqual(["user", "assistant", "user", "assistant"]);
    const results = ms[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((r) => [r.tool_use_id, r.content])).toEqual([
      ["g", expect.stringContaining("timeZone")],
      ["s", "sent to api"],
    ]);
    expect(second.store.pending()).toEqual([]);
    expect(second.engine.state(id)).toBe("idle");
  });

  it("sends a declined call back as an error and carries on", async () => {
    const { engine, store } = await setup([
      message(
        [toolUse("s", "send_prompt", { session: "api", text: "x" })],
        "tool_use",
      ),
      message([text("OK, I won't.")], "end_turn"),
      message([text("Waiting.")], "end_turn"),
    ]);
    const id = await turn(engine, "send it");
    // A message sent while the call waits is queued behind it, not dropped.
    await engine.send({
      threadId: id,
      text: "actually, wait",
      source: "desktop",
    });
    await engine.confirm(id, "s", false);
    await engine.settled(id);
    const ms = store.loaded(id);
    const r = (ms[2].content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
    expect(r).toMatchObject({ tool_use_id: "s", is_error: true });
    expect(r.content).toMatch(/declined/);
    expect(roles(ms)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(ms[4].content).toEqual([{ type: "text", text: "actually, wait" }]);
  });

  it("queues a message sent mid-turn and runs it next", async () => {
    const { engine, store, calls } = await setup([
      message([text("One.")], "end_turn"),
      message([text("Two.")], "end_turn"),
    ]);
    const id = await engine.send({
      threadId: null,
      text: "first",
      source: "desktop",
    });
    await engine.send({ threadId: id, text: "second", source: "voice" });
    await engine.settled(id);
    expect(roles(store.loaded(id))).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(store.loaded(id)[2].source).toBe("voice");
    expect(calls).toHaveLength(2);
  });

  it("does not keep a refused reply and says why", async () => {
    const { engine, store } = await setup([
      message([text("partial")], "refusal", {
        stop_details: {
          type: "refusal",
          category: "cyber",
          explanation: "it looked like malware",
        },
      } as Partial<Msg>),
    ]);
    const id = await turn(engine, "write me a worm");
    const ms = store.loaded(id);
    expect(roles(ms)).toEqual(["user", "notice"]);
    expect(ms[1].content).toEqual({
      kind: "refusal",
      text: "Declined: it looked like malware",
    });
  });

  it("reports the budget cap from the proxy's 402", async () => {
    const capped = new Anthropic.APIError(
      402,
      {
        type: "error",
        error: {
          type: "budget_exceeded",
          message: "Duck's monthly API budget is used up ($90.00 of $90.00)",
        },
      },
      "402",
      new Headers(),
    );
    const { engine, store } = await setup([{ error: capped }]);
    const id = await turn(engine, "hi");
    const n = store.loaded(id)[1];
    expect(n.role).toBe("notice");
    expect(n.content).toMatchObject({
      kind: "cap",
      text: expect.stringContaining("$90.00"),
    });
  });

  it("keeps the text of a stopped reply, and nothing else", async () => {
    const { engine, store } = await setup([{ hang: "Half a sen" }]);
    const id = await engine.send({
      threadId: null,
      text: "talk",
      source: "desktop",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.state(id)).toBe("streaming");
    engine.stop(id);
    await engine.settled(id);
    const ms = store.loaded(id);
    expect(roles(ms)).toEqual(["user", "assistant", "notice"]);
    expect(ms[1].content).toEqual([{ type: "text", text: "Half a sen" }]);
  });

  it("drops a tool call cut off at max_tokens", async () => {
    const { engine, store } = await setup([
      message([toolUse("x", "get_time", {})], "max_tokens"),
    ]);
    const id = await turn(engine, "hi");
    expect(roles(store.loaded(id))).toEqual(["user", "notice"]);
  });

  it("resends after pause_turn", async () => {
    const { engine, store, calls } = await setup([
      message([text("Searching…")], "pause_turn"),
      message([text("Found it.")], "end_turn"),
    ]);
    const id = await turn(engine, "look it up");
    expect(calls).toHaveLength(2);
    expect(roles(store.loaded(id))).toEqual(["user", "assistant", "assistant"]);
  });

  it("changes effort with a mid-conversation system message", async () => {
    const { engine, store, calls } = await setup([
      message([text("Thinking hard.")], "end_turn"),
      message([text("Back to normal.")], "end_turn"),
    ]);
    const id = await engine.send({
      threadId: null,
      text: "plan this",
      source: "desktop",
      effort: "high",
    });
    await engine.settled(id);
    await turn(engine, "thanks", id);
    expect(roles(store.loaded(id))).toEqual([
      "user",
      "system",
      "assistant",
      "user",
      "system",
      "assistant",
    ]);
    expect(
      calls[0].params.messages[calls[0].params.messages.length - 1],
    ).toEqual({
      role: "system",
      content: [],
      output_config: { effort: "high" },
    });
    // The top-level effort never changes (that would break the cache).
    expect(calls.map((c) => c.params.output_config?.effort)).toEqual([
      "medium",
      "medium",
    ]);
  });
});

describe("toApiMessages", () => {
  const m = (role: StoredMessage["role"], content: unknown): StoredMessage => ({
    threadId: "t",
    seq: 0,
    ts: 0,
    role,
    content,
    source: "desktop",
  });

  it("drops notices and a system message a failed turn left before a user message", () => {
    const api = toApiMessages([
      m("user", "a"),
      m("system", { content: [], output_config: { effort: "high" } }),
      m("notice", { kind: "error", text: "x" }),
      m("user", "b"),
    ]);
    expect(api).toEqual([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
    expect(effectiveEffort(api)).toBe("medium");
  });

  it("builds the same request bytes for the same history", () => {
    const reg = createRegistry([sendPrompt, getTime]);
    const a = JSON.stringify(
      buildParams(reg, [{ role: "user", content: "x" }]),
    );
    const b = JSON.stringify(
      buildParams(createRegistry([getTime, sendPrompt]), [
        { role: "user", content: "x" },
      ]),
    );
    expect(a).toBe(b);
  });
});
