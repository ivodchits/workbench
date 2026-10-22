// Core memory (step W4): `core.md`'s edits, and a fact remembered in one thread
// reaching the next one, through a compaction too.

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import { addFact, coreFacts, coreText, coreWorkspace, EMPTY_CORE, removeFact, type CoreHost } from "./core";
import { createEngine, toApiMessages, type StreamFn, type StreamLike } from "./engine";
import { fakePort } from "./fakePort.test-util";
import { DEFAULT_SETTINGS } from "./settings";
import { createThreadStore, type ThreadBackend } from "./threads";
import { MEMORY_TOOLS } from "./tools/memory";
import { createRegistry } from "./tools/registry";

type Msg = Anthropic.Beta.BetaMessage;
type Block = Msg["content"][number];
type Params = Parameters<StreamFn>[0];

describe("core.md edits", () => {
  it("adds a fact under its section, once", () => {
    const a = addFact(null, "Names & nicknames", "- \"the game\" means project Hollow");
    expect(a.startsWith(EMPTY_CORE.split("\n")[0])).toBe(true);
    expect(coreFacts(a)).toEqual([{ section: "Names & nicknames", fact: "\"the game\" means project Hollow" }]);
    expect(addFact(a, "Preferences", "\"The game\"  means project Hollow")).toBe(a);
    const b = addFact(a, "About you", "Lives in Madrid");
    expect(b.indexOf("Lives in Madrid")).toBeLessThan(b.indexOf("## Preferences"));
    const c = addFact(b, "About you", "Learning Spanish");
    expect(coreFacts(c).map((f) => f.fact)).toEqual(["Lives in Madrid", "Learning Spanish", "\"the game\" means project Hollow"]);
  });

  it("makes a section the user deleted, and keeps CRLF files CRLF", () => {
    const crlf = "# Core memory\r\n\r\n## About you\r\n- Lives in Madrid\r\n";
    const out = addFact(crlf, "Standing instructions", "Reviews use high effort");
    expect(out).toBe(`${crlf}\r\n## Standing instructions\r\n- Reviews use high effort\r\n`);
  });

  it("forgets the fact named, or a single one containing the words; several is ambiguous", () => {
    let t = addFact(null, "About you", "Lives in Madrid");
    t = addFact(t, "Preferences", "Short replies in the morning");
    t = addFact(t, "Preferences", "Short replies when busy");
    expect(removeFact(t, "madrid").removed).toEqual(["Lives in Madrid"]);
    const many = removeFact(t, "short replies");
    expect(many.removed).toEqual([]);
    expect(many.matches).toHaveLength(2);
    expect(many.text).toBe(t);
    const one = removeFact(t, "Short replies when busy");
    expect(coreFacts(one.text).map((f) => f.fact)).toEqual(["Lives in Madrid", "Short replies in the morning"]);
    expect(removeFact(t, "Hollow").removed).toEqual([]);
  });

  it("sends nothing for a profile without facts", () => {
    expect(coreText(null)).toBeNull();
    expect(coreText(EMPTY_CORE)).toBeNull();
    expect(coreText(addFact(null, "About you", "x"))).toContain("<core_memory>");
    expect(coreWorkspace("C:\\Users\\me\\repos\\Duck\\memory\\core.md")).toBe("C:\\Users\\me\\repos\\Duck");
  });
});

// ── through the engine ──

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

function scripted(steps: Msg[]) {
  const calls: Params[] = [];
  const stream: StreamFn = (params) => {
    calls.push(structuredClone(params));
    const step = steps.shift();
    if (!step) throw new Error("no more scripted replies");
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

/** core.md in memory; `edit` stands for a save in the editor. */
function memoryCore(text: string | null = null) {
  const file = { text, writes: 0 };
  const host: CoreHost = {
    async read() {
      return { path: "C:\\Duck\\memory\\core.md", text: file.text };
    },
    async write(next, expected) {
      if (file.text !== expected) throw new Error("stale: core.md changed since it was read");
      file.text = next;
      file.writes++;
    },
  };
  return { file, host };
}

async function setup(steps: Msg[], core: CoreHost, compactAt = 0) {
  const store = createThreadStore(memoryBackend());
  await store.load();
  const s = scripted(steps);
  const engine = createEngine({
    stream: s.stream,
    registry: createRegistry(MEMORY_TOOLS),
    port: fakePort(),
    store,
    core,
    settings: () => ({ ...DEFAULT_SETTINGS, compactAt }),
  });
  const turn = async (words: string, threadId: string | null = null) => {
    const id = await engine.send({ threadId, text: words, source: "desktop" });
    await engine.settled(id);
    return id;
  };
  return { engine, store, calls: s.calls, turn };
}

const sent = (p: Params) => JSON.stringify(p.messages);

describe("core memory in threads (W4)", () => {
  it("\"the game means project Hollow\" survives a new thread", async () => {
    const { file, host } = memoryCore();
    const { store, calls, turn } = await setup(
      [
        message([toolUse("u1", "remember_core", { section: "Names & nicknames", fact: "\"the game\" means project Hollow" })], "tool_use"),
        message([text("Got it.")], "end_turn"),
        message([text("Hollow, then.")], "end_turn"),
      ],
      host,
    );
    const first = await turn("Remember: the game means project Hollow.");
    // The first thread started with no profile, so it carries no block.
    expect(sent(calls[0])).not.toContain("<core_memory>");
    expect(coreFacts(file.text!)).toEqual([{ section: "Names & nicknames", fact: "\"the game\" means project Hollow" }]);
    // The chip: the diff of core.md.
    const chip = store.loaded(first).find((m) => m.role === "notice")!.content as { kind: string; memory: { before: unknown; after: string } };
    expect(chip.kind).toBe("memory");
    expect(chip.memory.before).toBeNull();
    expect(chip.memory.after).toBe(file.text);

    await turn("How's the game going?");
    const next = calls[2];
    // In the system message after the first message, not the cached system prompt.
    const roles = next.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "system"]);
    expect(sent(next)).toContain("project Hollow");
    expect(JSON.stringify(next.system)).not.toContain("project Hollow");
  });

  it("keeps a thread's profile as it started, and carries it past a compaction", async () => {
    const { file, host } = memoryCore(addFact(null, "About you", "Lives in Madrid"));
    const { store, calls, turn } = await setup(
      [
        message([text("Hola.")], "end_turn"),
        message([text("Sure.")], "end_turn", 5_000),
        message([text("Summary.")], "end_turn"),
        message([text("Madrid.")], "end_turn"),
      ],
      host,
      1_000,
    );
    const id = await turn("hi");
    file.text = addFact(file.text, "About you", "Learning Spanish");
    await turn("ok", id);
    // The second request has the same prefix as the first: the profile read once.
    expect(sent(calls[1])).toContain("Lives in Madrid");
    expect(sent(calls[1])).not.toContain("Learning Spanish");
    await turn("where do I live?", id);
    const after = toApiMessages(store.loaded(id));
    const head = after[0].content as { text: string }[];
    expect(head[0].text).toContain("<core_memory>");
    expect(head[1].text).toContain("<thread_summary>");
    expect(sent(calls[3])).toContain("Lives in Madrid");
  });

  it("redoes an edit over a save made in between, and forgets by part of a fact", async () => {
    const { file, host } = memoryCore(addFact(null, "About you", "Lives in Madrid"));
    const saved = addFact(file.text, "Preferences", "Short replies");
    let raced = false;
    const racing: CoreHost = {
      read: host.read,
      async write(next, expected) {
        if (!raced) {
          raced = true;
          file.text = saved; // you saved in the editor just then
        }
        return host.write(next, expected);
      },
    };
    const { calls, turn } = await setup(
      [
        message([toolUse("u1", "forget", { fact: "madrid" })], "tool_use"),
        message([text("Forgotten.")], "end_turn"),
      ],
      racing,
    );
    await turn("Forget where I live.");
    expect(coreFacts(file.text!).map((f) => f.fact)).toEqual(["Short replies"]);
    expect(sent(calls[1])).toContain("Lives in Madrid"); // the result names what went
  });
});
