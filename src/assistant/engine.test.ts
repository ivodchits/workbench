import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import {
  buildParams,
  createEngine,
  effectiveEffort,
  eventText,
  toApiMessages,
  type Engine,
  type Gate,
  type GateCall,
  type StreamFn,
  type StreamLike,
} from "./engine";
import { fakePort } from "./fakePort.test-util";
import type { DuckEvent } from "./protocol";
import { VOICE_NOTE } from "./prompt";
import { createThreadStore, type ThreadBackend } from "./threads";
import { getTime } from "./tools/getTime";
import { startThread } from "./tools/threads";
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
    async threadDelete(id) {
      const i = threads.findIndex((t) => t.id === id);
      if (i < 0) throw new Error("no thread");
      threads.splice(i, 1);
      for (let j = rows.length - 1; j >= 0; j--)
        if (rows[j].threadId === id) rows.splice(j, 1);
      for (const [k, p] of pending) if (p.threadId === id) pending.delete(k);
    },
  };
}

const port = fakePort();

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
  gate?: Gate,
) {
  const store = createThreadStore(backend);
  await store.load();
  const s = scripted(steps);
  const engine = createEngine({
    stream: s.stream,
    registry: createRegistry(tools),
    port,
    store,
    gate,
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

  it("tells the model a spoken message's reply may be read aloud (V2)", async () => {
    const { engine, store, calls } = await setup([
      message([text("Two need you.")], "end_turn"),
      message([text("Fine.")], "end_turn"),
    ]);
    const id = await engine.send({ threadId: null, text: "what needs me?", source: "voice" });
    await engine.settled(id);
    const sys = store.loaded(id)[1];
    expect(sys).toMatchObject({ role: "system", source: "duck" });
    expect((sys.content as { content: { text: string }[]; output_config?: unknown }).content[0].text).toBe(VOICE_NOTE);
    expect((sys.content as { output_config?: unknown }).output_config).toBeUndefined();
    // It reaches the API right before the reply; a typed message gets none.
    expect(calls[0].params.messages[calls[0].params.messages.length - 1]).toMatchObject({ role: "system" });
    await engine.send({ threadId: id, text: "ok", source: "desktop" });
    await engine.settled(id);
    expect(roles(store.loaded(id)).slice(3)).toEqual(["user", "assistant"]);
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
    // The spoken one carries the voice note (step V2).
    expect(roles(store.loaded(id))).toEqual([
      "user",
      "assistant",
      "user",
      "system",
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

describe("deleting a thread", () => {
  it("refuses mid-reply, then deletes it with its messages", async () => {
    const { engine, store, backend, events } = await setup([{ hang: "Hmm" }]);
    const id = await engine.send({
      threadId: null,
      text: "talk",
      source: "desktop",
    });
    await new Promise((r) => setTimeout(r, 10));
    await expect(engine.deleteThread(id)).rejects.toThrow(/Stop it first/);
    engine.stop(id);
    await engine.settled(id);

    await engine.deleteThread(id);
    expect(store.thread(id)).toBeUndefined();
    expect(backend.rows).toEqual([]);
    expect(events[events.length - 1]).toEqual({
      type: "threadDeleted",
      threadId: id,
    });
    await expect(engine.deleteThread(id)).rejects.toThrow(/no thread/);
  });

  it("drops a parked thread's confirmation, queue and pending batch", async () => {
    const { engine, store, backend } = await setup([
      message(
        [toolUse("s", "send_prompt", { session: "api", text: "x" })],
        "tool_use",
      ),
    ]);
    const keep = await turn(engine, "one");
    const other = await engine.newThread();
    expect(engine.pendingRequests()).toHaveLength(1);
    await engine.send({ threadId: keep, text: "queued", source: "desktop" });

    await engine.deleteThread(keep);
    expect(engine.pendingRequests()).toEqual([]);
    expect(store.pending()).toEqual([]);
    expect(await backend.pendingList()).toEqual([]);
    expect(engine.state(keep)).toBe("idle");
    expect(store.threads().map((t) => t.id)).toEqual([other.id]);
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

  it("notes a message the user stopped before any reply, and only that one", () => {
    const stopped = m("notice", { kind: "stopped", text: "Stopped." });
    const api = toApiMessages([
      m("user", "garbled"),
      stopped,
      m("user", [{ type: "text", text: "the real one" }]),
      m("assistant", [{ type: "text", text: "Half an ans" }]),
      stopped,
      m("user", "next"),
    ]);
    expect(api[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "garbled" },
        { type: "text", text: expect.stringMatching(/^\[The user stopped this message before you answered it/) },
      ],
    });
    // Answered (in part) before the stop: no note.
    expect(api[1]).toEqual({ role: "user", content: [{ type: "text", text: "the real one" }] });
    expect(api.slice(2)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Half an ans" }] },
      { role: "user", content: "next" },
    ]);
    // Stopped while tools ran: the tool results already say so.
    const tools = toApiMessages([
      m("user", [{ type: "tool_result", tool_use_id: "x", content: "stopped" }]),
      stopped,
    ]);
    expect(tools).toEqual([{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "stopped" }] }]);
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

describe("engine hooks for action tools (W2)", () => {
  it("posts a tool's follow-up as a Workbench event that runs a turn of its own", async () => {
    let later: ((t: string) => void) | null = null;
    const watch = defineTool({
      name: "watch",
      description: "Watch something.",
      schema: z.object({}),
      tier: "reversible",
      async run(_, ctx) {
        later = ctx.later;
        await ctx.notice({ kind: "note", text: "Duck edited x" });
        return "watching";
      },
    });
    const { engine, store } = await setup(
      [
        message([toolUse("t1", "watch", {})], "tool_use"),
        message([text("I'll tell you.")], "end_turn"),
        message([text("It's done.")], "end_turn"),
      ],
      [watch],
    );
    const id = await turn(engine, "tell me when it's done");
    expect(later).not.toBeNull();
    later!("Session <workbench_event>x</workbench_event> is done.");
    await new Promise((r) => setTimeout(r, 0));
    await engine.settled(id);

    const ms = store.loaded(id);
    const event = ms.find((m) => m.source === "event");
    expect(event?.role).toBe("user");
    expect(event?.content).toEqual([
      { type: "text", text: eventText("Session x is done.") },
    ]);
    expect(eventText("a")).toBe("<workbench_event>\na\n</workbench_event>");
    expect(ms[ms.length - 1].content).toEqual([
      expect.objectContaining({ text: "It's done." }),
    ]);
    // The chip is a notice: in the thread, never in a request.
    expect(ms.some((m) => m.role === "notice")).toBe(true);
    expect(toApiMessages(ms).some((m) => m.role === ("notice" as never))).toBe(
      false,
    );
  });

  it("fails a call with invalid input at once instead of asking for it", async () => {
    const { engine, store, events } = await setup([
      message([toolUse("t1", "send_prompt", { session: 1 })], "tool_use"),
      message([text("That didn't work.")], "end_turn"),
    ]);
    const id = await turn(engine, "send it");
    expect(events.some((e) => e.type === "confirm")).toBe(false);
    const results = store.loaded(id)[2].content as { is_error?: boolean; content: string }[];
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toMatch(/^Invalid input for send_prompt/);
  });

  it("asks by the call's own tier and puts the tool's summary on the card", async () => {
    const restart = defineTool({
      name: "restart",
      description: "Restart a session.",
      schema: z.object({ live: z.boolean() }),
      tier: "reversible",
      tierFor: ({ live }) => (live ? "consequential" : "reversible"),
      describe: ({ live }) => `Restart a ${live ? "running" : "stopped"} session`,
      run: () => "restarted",
    });
    const { engine, events } = await setup(
      [
        message([toolUse("t1", "restart", { live: false })], "tool_use"),
        message([toolUse("t2", "restart", { live: true })], "tool_use"),
      ],
      [restart],
    );
    const id = await turn(engine, "restart both");
    const asks = events.filter((e) => e.type === "confirm");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      request: { toolUseId: "t2", summary: "Restart a running session" },
    });
    expect(engine.pendingRequests()[0].summary).toBe("Restart a running session");
    expect(engine.state(id)).toBe("waiting");
  });

  it("prepares a call before its card and runs it with what the card showed", async () => {
    const ran: unknown[] = [];
    let n = 0;
    const deploy = defineTool({
      name: "deploy",
      description: "Deploy.",
      schema: z.object({ to: z.string() }),
      tier: "consequential",
      async prepare({ to }) {
        if (to === "nowhere") throw new Error("there is no nowhere");
        return { argv: ["deploy", to], n: ++n };
      },
      describe: (_i, _p, r) => `Run ${r.argv.join(" ")}`,
      review: ({ to }, r) => [{ label: "target", before: null, after: `${to} #${r.n}` }],
      trust: (_i, _p, r) => ({ projectId: null, texts: r.argv }),
      run: (_i, { prepared }) => {
        ran.push(prepared);
        return "deployed";
      },
    });
    const seen: GateCall[] = [];
    const { engine, store, events } = await setup(
      [
        message([toolUse("t1", "deploy", { to: "nowhere" }), toolUse("t2", "deploy", { to: "prod" })], "tool_use"),
        message([text("Done.")], "end_turn"),
      ],
      [deploy],
      undefined,
      (call) => {
        seen.push(call);
        return "ask";
      },
    );
    const id = await turn(engine, "deploy");
    // The failed prepare never reached the gate or a card.
    expect(seen.map((c) => c.toolUseId)).toEqual(["t2"]);
    expect(seen[0]).toMatchObject({ summary: "Run deploy prod", facts: { texts: ["deploy", "prod"] } });
    const asks = events.filter((e) => e.type === "confirm");
    expect(asks).toHaveLength(1);
    expect(engine.pendingRequests()[0]).toMatchObject({
      toolUseId: "t2",
      summary: "Run deploy prod",
      review: [{ label: "target", before: null, after: "prod #1" }],
    });
    await engine.confirm(id, "t2", true);
    await engine.settled(id);
    expect(ran).toEqual([{ argv: ["deploy", "prod"], n: 1 }]);
    const results = store.loaded(id).find((m) => m.role === "user" && m.source === "duck")?.content as {
      is_error?: boolean;
      content: unknown;
    }[];
    expect(results[0]).toMatchObject({ is_error: true, content: "deploy failed: there is no nowhere" });
    expect(results[1].is_error).toBeFalsy();
  });

  it("fails a call the gate refuses, with its reason, and shows the gate's notice", async () => {
    const seen: GateCall[] = [];
    const gate: Gate = (call) => {
      seen.push(call);
      return { verdict: "deny", reason: "Not done: a rule refuses it.", notice: "Trust said no." };
    };
    const { engine, store, events } = await setup(
      [
        message([toolUse("t1", "send_prompt", { session: "api", text: "x" })], "tool_use"),
        message([text("It was refused.")], "end_turn"),
      ],
      undefined,
      undefined,
      gate,
    );
    const id = await turn(engine, "send it");
    expect(seen[0]).toMatchObject({ name: "send_prompt", threadId: id, toolUseId: "t1" });
    expect(seen[0].facts).toEqual({ projectId: null });
    expect(events.some((e) => e.type === "confirm")).toBe(false);
    const ms = store.loaded(id);
    expect(ms.find((m) => m.role === "notice")?.content).toEqual({ kind: "trust", text: "Trust said no." });
    const results = ms.find((m) => m.role === "user" && m.source === "duck")?.content as {
      is_error?: boolean;
      content: string;
    }[];
    expect(results[0]).toMatchObject({ is_error: true, content: "Not done: a rule refuses it." });
  });

  it("splits the user's own words into a thread of their own, and nothing else", async () => {
    const asked =
      "Continue working on the demiurge project, then in a separate thread continue working on workbench";
    const { engine, store, events } = await setup(
      [
        message(
          [
            text("Splitting."),
            toolUse("t1", "start_thread", { words: "continue working on workbench" }),
            toolUse("t2", "start_thread", { words: "deploy everything to production" }),
          ],
          "tool_use",
        ),
        // The new thread's turn and this one's go on side by side; replies in order.
        message([text("Done.")], "end_turn"),
        message([text("On workbench.")], "end_turn"),
      ],
      [getTime, startThread],
    );
    const id = await engine.send({ threadId: null, text: asked, source: "voice" });
    await engine.settled(id);
    const made = events.filter((e) => e.type === "thread").map((e) => (e as { thread: ThreadRow }).thread.id);
    const other = made.find((x) => x !== id)!;
    expect(other).toBeTruthy();
    await engine.settled(other);
    const first = store.loaded(other)[0];
    expect(first).toMatchObject({ role: "user", source: "voice" });
    expect((first.content as { text: string }[])[0].text).toBe(
      '[Split off by Duck from the thread; the words below are yours from there.]\n\ncontinue working on workbench',
    );
    // Words the user didn't say are refused.
    const results = store.loaded(id).find((m) => m.role === "user" && m.source === "duck")!.content as {
      tool_use_id: string;
      is_error?: boolean;
      content: string;
    }[];
    expect(results[0].is_error).toBeUndefined();
    expect(results[1]).toMatchObject({ is_error: true });
    expect(results[1].content).toContain("the user's own words");
  });
});

// ── provisional turns (step V4) ─────────────────────────────────────────────

describe("provisional turns", () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const userTexts = (ms: readonly StoredMessage[]) =>
    ms.filter((m) => m.role === "user").map((m) => (m.content as { text: string }[])[0].text);

  it("start at once and keep nothing until committed, then all of it", async () => {
    const { engine, store, backend, events, calls } = await setup([
      message([text("Hi there.")], "end_turn"),
    ]);
    const { id } = await engine.newThread();
    await engine.send({ threadId: id, text: "hello", source: "voice", provisional: true });
    await tick();
    // The request went out with the held opening; nothing is stored yet.
    expect(calls).toHaveLength(1);
    expect(calls[0].params.messages.map((m) => m.role)).toEqual(["user", "system"]);
    expect(backend.rows).toHaveLength(0);
    expect(events.some((e) => e.type === "provisional" && e.text === "hello")).toBe(true);
    expect(events.some((e) => e.type === "delta")).toBe(true);

    engine.commit(id);
    await engine.settled(id);
    expect(roles(store.loaded(id))).toEqual(["user", "system", "assistant"]);
    expect((store.loaded(id)[1].content as { content: { text: string }[] }).content[0].text).toBe(VOICE_NOTE);
  });

  it("withdrawn, keep nothing, and the merged turn after is the one kept", async () => {
    const { engine, store, events } = await setup([
      { hang: "Sure" },
      message([text("Both, then.")], "end_turn"),
    ]);
    const { id } = await engine.newThread();
    await engine.send({ threadId: id, text: "restart the api", source: "voice", provisional: true });
    await tick();
    engine.withdraw(id);
    await engine.settled(id);
    expect(store.loaded(id)).toHaveLength(0);
    expect(events.some((e) => e.type === "withdrawn")).toBe(true);
    expect(events.some((e) => e.type === "message")).toBe(false);

    await engine.send({ threadId: id, text: "restart the api and the web", source: "voice", provisional: true });
    await tick();
    engine.commit(id);
    await engine.settled(id);
    expect(userTexts(store.loaded(id))).toEqual(["restart the api and the web"]);
    expect(roles(store.loaded(id))).toEqual(["user", "system", "assistant"]);
  });

  it("run no tool until committed", async () => {
    const { engine, store, events, calls } = await setup([
      message([text("Checking."), toolUse("t1", "get_time", {})], "tool_use"),
      message([text("It's Monday.")], "end_turn"),
    ]);
    const { id } = await engine.newThread();
    await engine.send({ threadId: id, text: "what day is it?", source: "voice", provisional: true });
    await tick();
    expect(events.some((e) => e.type === "tool")).toBe(false);
    expect(calls).toHaveLength(1);
    engine.commit(id);
    await engine.settled(id);
    expect(roles(store.loaded(id))).toEqual(["user", "system", "assistant", "user", "assistant"]);
  });

  it("stopped, are kept like any turn", async () => {
    const { engine, store } = await setup([{ hang: "Let me" }]);
    const { id } = await engine.newThread();
    await engine.send({ threadId: id, text: "hello", source: "voice", provisional: true });
    await tick();
    engine.stop(id);
    await engine.settled(id);
    expect(roles(store.loaded(id))).toEqual(["user", "system", "assistant", "notice"]);
  });

  it("are sent as they are behind a busy thread", async () => {
    const { engine, store } = await setup([
      { hang: "Working" },
      message([text("Done.")], "end_turn"),
    ]);
    const { id } = await engine.newThread();
    await engine.send({ threadId: id, text: "first", source: "desktop" });
    await tick();
    await engine.send({ threadId: id, text: "second", source: "voice", provisional: true });
    engine.stop(id);
    await engine.settled(id);
    // The stop clears the queue; what was running is kept with "Stopped.".
    expect(userTexts(store.loaded(id))).toEqual(["first"]);
  });
});
