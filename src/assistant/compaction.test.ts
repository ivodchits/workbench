// Thread compaction (step A6): the engine summarizes a long thread's older turns
// between turns, and requests send the summary in their place.

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import {
  compactionCut,
  createEngine,
  estimateTokens,
  NOTHING_TO_COMPACT,
  toApiMessages,
  type Engine,
  type StreamFn,
  type StreamLike,
} from "./engine";
import { fakePort } from "./fakePort.test-util";
import { DEFAULT_SETTINGS } from "./settings";
import { createThreadStore, type ThreadBackend } from "./threads";
import { getTime } from "./tools/getTime";
import { createRegistry, type ToolDef } from "./tools/registry";
import { compactThread } from "./tools/threads";

type Msg = Anthropic.Beta.BetaMessage;
type Block = Msg["content"][number];
type Params = Parameters<StreamFn>[0];

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
    async threadTitle(id, title) {
      const t = threads.find((x) => x.id === id);
      if (t) t.title = title;
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
    async threadDelete() {},
  };
}

const message = (content: Block[], stop: Msg["stop_reason"], inputTokens = 1): Msg =>
  ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 1 },
  }) as Msg;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Block;

/** A scripted reply, or a stream that hangs until aborted. */
type Step = Msg | { hang: true };

function scripted(steps: Step[]) {
  const calls: { params: Params; headers: Record<string, string> }[] = [];
  const stream: StreamFn = (params, opts) => {
    calls.push({ params: structuredClone(params), headers: opts.headers });
    const step = steps.shift();
    if (!step) throw new Error("no more scripted replies");
    const hang = () =>
      new Promise<never>((_, reject) =>
        opts.signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError())),
      );
    const s: StreamLike = {
      async *[Symbol.asyncIterator]() {
        if ("hang" in step) await hang();
        yield* [];
      },
      async finalMessage() {
        if ("hang" in step) return hang();
        return step;
      },
    };
    return s;
  };
  return { stream, calls };
}

async function setup(steps: Step[], compactAt = 1_000, tools: ToolDef[] = [getTime]) {
  const store = createThreadStore(memoryBackend());
  await store.load();
  const s = scripted(steps);
  const engine = createEngine({
    stream: s.stream,
    registry: createRegistry(tools),
    port: fakePort(),
    store,
    settings: () => ({ ...DEFAULT_SETTINGS, compactAt }),
  });
  return { engine, store, calls: s.calls };
}

async function turn(engine: Engine, words: string, threadId: string | null = null) {
  const id = await engine.send({ threadId, text: words, source: "desktop" });
  await engine.settled(id);
  return id;
}

const sentText = (p: Params) => JSON.stringify(p.messages);
const compactions = (ms: readonly StoredMessage[]) =>
  ms.flatMap((m) => {
    const c = m.role === "notice" ? (m.content as { compaction?: { summary: string; through: number } }).compaction : undefined;
    return c ? [c] : [];
  });

const SUMMARY = "The user's dog is called Biscuit. Open: the release notes, for later.";

describe("compaction (A6)", () => {
  it("compacts a thread past the threshold between turns, and the next turn goes on from the summary", async () => {
    const { engine, store, calls } = await setup([
      message([text("Nice name.")], "end_turn"),
      message([text("Will do.")], "end_turn"),
      message([text("Sure.")], "end_turn", 5_000),
      message([text(SUMMARY)], "end_turn"),
      message([text("Biscuit, and the release notes are still open.")], "end_turn"),
    ]);
    const id = await turn(engine, "My dog is called Biscuit.");
    await turn(engine, "Draft the release notes later.", id);
    expect(calls).toHaveLength(2); // under the threshold: nothing yet
    await turn(engine, "ok, thanks", id);

    // The summary's request: the oldest turn as it was sent, then the instruction,
    // on the same prefix (so it reads the cache), under its own purpose.
    expect(calls).toHaveLength(4);
    const ask = calls[3];
    expect(ask.headers["x-wb-purpose"]).toBe("compact");
    expect(ask.params.system).toEqual(calls[2].params.system);
    expect(ask.params.tools).toEqual(calls[2].params.tools);
    expect(ask.params.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sentText(ask.params)).toContain("This thread is being compacted");
    expect(sentText(ask.params)).not.toContain("Draft the release notes");
    expect(compactions(store.loaded(id))).toEqual([{ summary: SUMMARY, through: 1 }]);

    await turn(engine, "what's my dog called, and what's open?", id);
    const next = calls[4].params;
    // The summary in place of the first turn; the last two turns verbatim.
    expect(next.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    const head = next.messages[0].content as { text: string }[];
    expect(head[0].text).toContain("<thread_summary>");
    expect(head[0].text).toContain("Biscuit");
    expect(head[1].text).toBe("Draft the release notes later.");
    expect(sentText(next)).not.toContain("My dog is called Biscuit.");
    expect(Math.ceil(sentText(next).length / 4)).toBeLessThan(1_000);
    // Every message is still stored, for the drawer.
    expect(store.loaded(id).filter((m) => m.role !== "notice")).toHaveLength(8);
  });

  it("summarizes a turn too big to keep, and builds on the previous summary next time", async () => {
    const long = `Here is the whole log: ${"x".repeat(3_000)}`;
    const { engine, store, calls } = await setup([
      message([text("Hi.")], "end_turn"),
      message([text("Got it.")], "end_turn", 5_000),
      message([text("First summary.")], "end_turn"),
      message([text("Fine.")], "end_turn", 5_000),
      message([text("Second summary.")], "end_turn"),
    ]);
    const id = await turn(engine, "hello there");
    await turn(engine, long, id);
    // Both turns are summarized: the big one doesn't fit the tail.
    expect(sentText(calls[2].params)).toContain("whole log");
    expect(compactions(store.loaded(id))[0].through).toBe(3);

    await turn(engine, "and now?", id);
    expect(calls[3].params.messages).toHaveLength(1);
    expect(sentText(calls[3].params)).toContain("First summary.");
    expect(sentText(calls[3].params)).not.toContain("whole log");
    // The second compaction is written over the first summary, not the old turns.
    expect(sentText(calls[4].params)).toContain("First summary.");
    expect(sentText(calls[4].params)).not.toContain("whole log");
    const sent = JSON.stringify(toApiMessages(store.loaded(id)));
    expect(sent).toContain("Second summary.");
    expect(sent).not.toContain("First summary.");
  });

  it("compacts when asked: from the drawer at once, and by the tool once the reply is over", async () => {
    const { engine, store, calls } = await setup(
      [
        message([text("One.")], "end_turn"),
        message([text("Two.")], "end_turn"),
        message([text("Summary of one.")], "end_turn"),
        message([text("Compacting."), toolUse("c1", "compact_thread", {})], "tool_use"),
        message([text("It'll be compacted.")], "end_turn"),
        message([text("Summary of two.")], "end_turn"),
      ],
      100_000,
      [getTime, compactThread],
    );
    const id = await turn(engine, "first thing to talk about");
    await turn(engine, "second thing to talk about", id);
    await engine.compact(id);
    await engine.settled(id);
    expect(calls[2].headers["x-wb-purpose"]).toBe("compact");
    expect(sentText(calls[2].params)).toContain("first thing");
    expect(sentText(calls[2].params)).not.toContain("second thing");

    await turn(engine, "compact this thread please", id);
    // The tool's turn ends first; the compaction runs before the thread settles.
    expect(calls).toHaveLength(6);
    expect(calls[5].headers["x-wb-purpose"]).toBe("compact");
    expect(sentText(calls[5].params)).toContain("Summary of one.");
    expect(compactions(store.loaded(id)).map((c) => c.summary)).toEqual(["Summary of one.", "Summary of two."]);
  });

  it("says when there's nothing to compact, and a stop drops the compaction", async () => {
    const { engine, store, calls } = await setup(
      [
        message([text("Hi.")], "end_turn"),
        message([text("Summary of the one turn.")], "end_turn"),
        message([text("Hello again.")], "end_turn"),
        { hang: true },
      ],
      100_000,
    );
    const id = await turn(engine, "just one turn");
    await engine.compact(id);
    await engine.settled(id);
    expect(calls).toHaveLength(2);
    // Nothing new since: no call, a line saying so.
    await engine.compact(id);
    await engine.settled(id);
    expect(calls).toHaveLength(2);
    const ms = store.loaded(id);
    expect(ms[ms.length - 1].content).toEqual({ kind: "compacted", text: NOTHING_TO_COMPACT });

    await turn(engine, "a second turn", id);
    await engine.compact(id);
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.state(id)).toBe("thinking");
    engine.stop(id);
    await engine.settled(id);
    expect(calls).toHaveLength(4);
    // The stopped one left nothing: still one compaction, and no error.
    expect(compactions(store.loaded(id))).toHaveLength(1);
    expect(store.loaded(id).filter((m) => m.role === "notice")).toHaveLength(2);
    expect(engine.state(id)).toBe("idle");
  });

  it("is off at 0", async () => {
    const { engine, calls } = await setup(
      [message([text("A.")], "end_turn", 900_000), message([text("B.")], "end_turn", 900_000)],
      0,
    );
    const id = await turn(engine, "first message here");
    await turn(engine, "second message here", id);
    expect(calls).toHaveLength(2);
  });
});

describe("compactionCut", () => {
  const m = (seq: number, role: StoredMessage["role"], content: unknown, source = "desktop"): StoredMessage => ({
    threadId: "t",
    seq,
    ts: seq,
    role,
    content,
    source,
  });
  const say = (t: string) => [{ type: "text", text: t }];
  const h = [
    m(0, "user", say("one")),
    m(1, "assistant", [{ type: "tool_use", id: "a", name: "get_time", input: {} }], "duck"),
    m(2, "user", [{ type: "tool_result", tool_use_id: "a", content: "x" }], "duck"),
    m(3, "assistant", say("done"), "duck"),
    m(4, "user", say("two")),
    m(5, "assistant", say("ok"), "duck"),
  ];
  const marker = (seq: number, through: number) =>
    m(seq, "notice", { kind: "compacted", text: "", compaction: { summary: "the gist", through } }, "duck");

  it("cuts at a turn's start, never at tool results, and always summarizes a turn", () => {
    expect(compactionCut(h, 10_000)).toBe(4);
    expect(compactionCut(h.slice(0, 4), 10_000)).toBe(4); // one turn: all of it
    expect(compactionCut(h, 5)).toBe(6); // the last turn doesn't fit the tail
    expect(compactionCut([], 10_000)).toBeNull();
    // After a compaction through 3, "two" is the one new turn: summarized whole.
    expect(compactionCut([...h, marker(6, 3)], 10_000)).toBe(7);
    expect(compactionCut([...h.slice(0, 4), marker(4, 3)], 10_000)).toBeNull();
  });

  it("sends the summary in front of the first kept message", () => {
    const out = toApiMessages([...h, m(6, "user", say("three")), marker(7, 5)]);
    expect(out).toHaveLength(1);
    const blocks = out[0].content as { text: string }[];
    expect(blocks[0].text).toContain("the gist");
    expect(blocks[1].text).toBe("three");
    expect(estimateTokens(h)).toBeGreaterThan(estimateTokens(h.slice(0, 1)));
  });
});
