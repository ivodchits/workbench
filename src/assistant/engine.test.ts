import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import {
  briefNote,
  buildParams,
  createEngine,
  HAIKU_CARD,
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
import { DUCK_PROMPT } from "./modes";
import { SYSTEM_PROMPT, VOICE_NOTE } from "./prompt";
import { createThreadStore, type ThreadBackend } from "./threads";
import { getTime } from "./tools/getTime";
import { goToThread, listThreads, startThread, switchMode } from "./tools/threads";
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
  degraded?: () => Promise<boolean>,
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
    degraded,
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

// ── moving the conversation (step A7) ───────────────────────────────────────

describe("moving the conversation", () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const firstText = (m: StoredMessage) => (m.content as { text: string }[])[0].text;

  it("moves once the reply is over, and the user's words answer there", async () => {
    const { engine, store, events } = await setup(
      [
        message([text("Moving."), toolUse("t1", "go_to_thread", { thread: "B", words: "give me the details" })], "tool_use"),
        message([text("Moving to the other thread.")], "end_turn"),
        message([text("Here are the details.")], "end_turn"),
      ],
      [goToThread, listThreads],
    );
    const b = await engine.newThread();
    await store.setTitle(b.id, "B");
    const a = await engine.send({ threadId: null, text: "let's go to B and give me the details", source: "voice" });
    await engine.settled(a);
    await tick();
    await engine.settled(b.id);

    const go = events.findIndex((e) => e.type === "goThread");
    expect(events[go]).toEqual({ type: "goThread", threadId: b.id, from: a, surface: "desktop" });
    // After the reply here was whole and the turn idle.
    const idle = events.findIndex((e) => e.type === "turnState" && e.threadId === a && e.state === "idle");
    expect(idle).toBeGreaterThan(-1);
    expect(go).toBeGreaterThan(idle);
    const there = store.loaded(b.id);
    expect(there[0]).toMatchObject({ role: "user", source: "voice" });
    expect(firstText(there[0])).toBe(
      "[Brought over by Duck from the thread; the words below are yours from there.]\n\ngive me the details",
    );
    expect(roles(there)).toEqual(["user", "system", "assistant"]);
  });

  it("moves the phone's view for a phone's request, and goes back", async () => {
    const { engine, store, events } = await setup(
      [
        message([toolUse("t1", "go_to_thread", { thread: "B" })], "tool_use"),
        message([text("Moving.")], "end_turn"),
        message([toolUse("t2", "go_to_thread", { thread: "back" })], "tool_use"),
        message([text("Back we go.")], "end_turn"),
      ],
      [goToThread],
    );
    const b = await engine.newThread();
    await store.setTitle(b.id, "B");
    const a = await engine.send({ threadId: null, text: "go to B", source: "phone" });
    await engine.settled(a);
    // Asked on the desktop, "back" has nowhere to go: only the phone moved.
    await turn(engine, "go back", b.id);
    const moves = events.filter((e) => e.type === "goThread");
    expect(moves[0]).toEqual({ type: "goThread", threadId: b.id, from: a, surface: "phone" });
    expect(moves).toHaveLength(1);
    const result = store.loaded(b.id).find((m) => m.source === "duck" && m.role === "user")!;
    expect(JSON.stringify(result.content)).toContain("no thread to go back to");

    // From the phone, "back" returns to where it was.
    const { engine: e2, store: s2, events: ev2 } = await setup(
      [
        message([toolUse("t1", "go_to_thread", { thread: "B" })], "tool_use"),
        message([text("Moving.")], "end_turn"),
        message([toolUse("t2", "go_to_thread", { thread: "back" })], "tool_use"),
        message([text("Back we go.")], "end_turn"),
      ],
      [goToThread],
    );
    const b2 = await e2.newThread();
    await s2.setTitle(b2.id, "B");
    const a2 = await e2.send({ threadId: null, text: "go to B", source: "phone" });
    await e2.settled(a2);
    await e2.send({ threadId: b2.id, text: "go back", source: "phone-voice" });
    await e2.settled(b2.id);
    expect(ev2.filter((e) => e.type === "goThread")).toEqual([
      { type: "goThread", threadId: b2.id, from: a2, surface: "phone" },
      { type: "goThread", threadId: a2, from: b2.id, surface: "phone" },
    ]);
  });

  it("starts a new thread with go once the reply is over, its brief a note, not the user's", async () => {
    const { engine, store, events, calls } = await setup(
      [
        message(
          [
            toolUse("t1", "start_thread", {
              words: "new thread for the release plan",
              go: true,
              brief: "We picked Friday for the release.",
            }),
          ],
          "tool_use",
        ),
        message([text("Moving to the new thread.")], "end_turn"),
        message([text("Let's plan it.")], "end_turn"),
      ],
      [startThread],
    );
    const a = await engine.send({ threadId: null, text: "new thread for the release plan, let's talk there", source: "desktop" });
    await engine.settled(a);
    const made = events.filter((e) => e.type === "thread").map((e) => (e as { thread: ThreadRow }).thread.id);
    const other = made.find((x) => x !== a)!;
    expect(events.find((e) => e.type === "goThread")).toEqual({ type: "goThread", threadId: other, from: a, surface: "desktop" });
    await tick();
    await engine.settled(other);
    const there = store.loaded(other);
    expect(roles(there)).toEqual(["user", "system", "assistant"]);
    expect(firstText(there[0])).toBe(
      "[Moved here by Duck from the thread; the words below are yours from there.]\n\nnew thread for the release plan",
    );
    const note = (there[1].content as { content: { text: string }[] }).content[0].text;
    expect(note).toBe(briefNote(undefined, "We picked Friday for the release."));
    // The new thread's request started only after the move.
    expect(calls).toHaveLength(3);
    expect(calls[2].params.messages.map((m) => m.role)).toEqual(["user", "system"]);
  });

  it("drops the move when the turn is stopped", async () => {
    const { engine, store, events } = await setup(
      [message([toolUse("t1", "go_to_thread", { thread: "B" })], "tool_use"), { hang: "Moving" }],
      [goToThread],
    );
    const b = await engine.newThread();
    await store.setTitle(b.id, "B");
    const a = await engine.send({ threadId: null, text: "go to B", source: "desktop" });
    await tick();
    engine.stop(a);
    await engine.settled(a);
    expect(events.some((e) => e.type === "goThread")).toBe(false);
  });
});

describe("routing (M2)", () => {
  const lastEffort = (p: Params) => {
    const m = p.messages[p.messages.length - 1];
    return m.role === "system" ? m.output_config?.effort : undefined;
  };

  it("raises the effort for involved work and keeps it at medium otherwise", async () => {
    const { engine, events, calls } = await setup([
      message([text("On it.")], "end_turn"),
      message([text("Idle.")], "end_turn"),
    ]);
    const id = await turn(engine, "compare these three libraries for state and write it up in a note");
    await turn(engine, "what's the backend agent doing", id);
    expect(lastEffort(calls[0].params)).toBe("high");
    // Back to medium: a system message carries the change.
    expect(lastEffort(calls[1].params)).toBe("medium");
    expect(events.filter((e) => e.type === "routing")).toEqual([
      { type: "routing", threadId: id, brain: "sonnet", effort: "high" },
      { type: "routing", threadId: id, brain: "sonnet", effort: "medium" },
    ]);
  });

  it("drops thinking blocks bound to an old prompt instead of failing", async () => {
    const { engine, calls } = await setup([message([text("Hi.")], "end_turn")]);
    await turn(engine, "hi");
    expect(calls[0].params.thinking).toEqual({
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    expect(calls[0].params.betas).toContain("thinking-binding-controls-2026-08-01");
  });

  it("runs on Haiku past the soft limit, says so once, and takes Sonnet for \"think hard\"", async () => {
    const { engine, store, calls } = await setup(
      [
        message([text("Haiku here.")], "end_turn"),
        message([text("Still Haiku.")], "end_turn"),
        message([text("Sonnet, thinking.")], "end_turn"),
      ],
      undefined,
      undefined,
      undefined,
      async () => true,
    );
    const id = await turn(engine, "what's up");
    await turn(engine, "and the tests?", id);
    await turn(engine, "think hard: should we split the repo?", id);
    expect(calls.map((c) => c.params.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"]);
    // Haiku has no server-side fallback; Sonnet keeps it.
    expect(calls[0].params.fallbacks).toBeUndefined();
    expect(calls[2].params.fallbacks).toBe("default");
    expect(lastEffort(calls[2].params)).toBe("high");
    const cards = store.loaded(id).filter((m) => m.role === "notice");
    expect(cards.map((m) => m.content)).toEqual([{ kind: "budget", text: HAIKU_CARD }]);
    // The card is never sent.
    expect(JSON.stringify(calls[1].params.messages)).not.toContain("soft limit");
  });

  it("sends one message on the model the surface names", async () => {
    const { engine, calls } = await setup([message([text("Sonnet.")], "end_turn")], undefined, undefined, undefined, async () => true);
    const id = await engine.send({ threadId: null, text: "hi", source: "desktop", brain: "sonnet" });
    await engine.settled(id);
    expect(calls[0].params.model).toBe("claude-sonnet-5-5");
  });

  it("counts a budget it can't read as not degraded", async () => {
    const { engine, calls } = await setup([message([text("Hi.")], "end_turn")], undefined, undefined, undefined, () =>
      Promise.reject(new Error("ledger down")),
    );
    await turn(engine, "hi");
    expect(calls[0].params.model).toBe("claude-sonnet-5-5");
  });
});

describe("prompts as data (step L3)", () => {
  it("runs each thread on the prompts it was pinned on, the voice note too", async () => {
    const store = createThreadStore(memoryBackend());
    await store.load();
    const s = scripted([message([text("one")], "end_turn"), message([text("two")], "end_turn"), message([text("three")], "end_turn")]);
    let now = { system: "System A", voice: "Voice A" };
    const pins = new Map<string, { system: string; voice: string }>();
    const engine = createEngine({
      stream: s.stream,
      registry: createRegistry([getTime]),
      port,
      store,
      config: {
        forThread: async (id) => {
          if (!pins.has(id)) pins.set(id, now);
          return pins.get(id)!;
        },
        current: () => Promise.reject(new Error("unused")),
        write: () => Promise.reject(new Error("unused")),
      },
    });
    const first = await turn(engine, "hello");
    now = { system: "System B", voice: "Voice B" };
    await turn(engine, "again", first);
    const second = await engine.send({ threadId: null, text: "hi", source: "voice" });
    await engine.settled(second);
    const systems = s.calls.map((c) => (c.params.system as { text: string }[])[0].text);
    expect(systems).toEqual(["System A", "System A", "System B"]);
    const sys = store.loaded(second).find((m) => m.role === "system")!;
    expect((sys.content as { content: { text: string }[] }).content[0].text).toBe("Voice B");
  });
});

describe("modes (S1)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const firstText = (m: StoredMessage) => (m.content as { text: string }[])[0].text;
  const systemText = (p: Params) => (p.system as Anthropic.Beta.BetaTextBlockParam[])[0].text;
  const toolNames = (p: Params) => p.tools?.map((t) => (t as { name: string }).name);

  it("a duck thread runs on its own prompt and tools, at high effort; the assistant's on everything", async () => {
    const { engine, store, calls } = await setup(
      [message([text("What breaks first?")], "end_turn"), message([text("Done.")], "end_turn")],
      [getTime, sendPrompt, switchMode],
    );
    const d = await engine.send({ threadId: null, text: "the sync bug", source: "desktop", mode: "duck" });
    await engine.settled(d);
    expect(store.thread(d)?.mode).toBe("duck");
    expect(systemText(calls[0].params)).toBe(DUCK_PROMPT);
    expect(toolNames(calls[0].params)).toEqual(["get_time", "switch_mode"]);
    const sys = calls[0].params.messages.find((m) => m.role === "system") as { output_config?: { effort: string } };
    expect(sys.output_config).toEqual({ effort: "high" });

    const a = await turn(engine, "what time is it?");
    expect(store.thread(a)?.mode).toBe("assistant");
    expect(systemText(calls[1].params)).toBe(SYSTEM_PROMPT);
    expect(toolNames(calls[1].params)).toEqual(["get_time", "send_prompt", "switch_mode"]);
  });

  it("a call to a tool outside the mode fails with the reason", async () => {
    const { engine, store } = await setup(
      [message([toolUse("t1", "send_prompt", { session: "api", text: "go" })], "tool_use"), message([text("I can't here.")], "end_turn")],
      [getTime, sendPrompt],
    );
    const id = await engine.send({ threadId: null, text: "tell api to go", source: "desktop", mode: "chat" });
    await engine.settled(id);
    const r = (store.loaded(id)[1 + 1].content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("isn't available in this chat thread");
  });

  it("switch_mode moves the conversation into a new duck thread with the user's words", async () => {
    const words = "давай подумаем над синхронизацией заметок";
    const { engine, store, events, calls } = await setup(
      [
        message([toolUse("t1", "switch_mode", { mode: "duck", words, brief: "Notes sync in the Workbench project." })], "tool_use"),
        message([text("Let's think it through in a duck thread.")], "end_turn"),
        message([text("What happens when both devices edit offline?")], "end_turn"),
      ],
      [switchMode],
    );
    const a = await turn(engine, words);
    const b = events.find((e) => e.type === "goThread") as { threadId: string } | undefined;
    expect(b).toBeDefined();
    expect(store.thread(b!.threadId)?.mode).toBe("duck");
    await tick();
    await engine.settled(b!.threadId);
    expect(firstText(store.loaded(b!.threadId)[0])).toContain(words);
    expect(systemText(calls[2].params)).toBe(DUCK_PROMPT);
    expect(store.thread(a)?.mode).toBe("assistant");
  });
});
