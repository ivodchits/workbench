// Long-term memory (step L1), the engine's side: what automatic recall shows, the
// correction line, the turn-scoped note in a real turn (sent as stored, cleared by
// the API), and the remember / recall / forget tools over a fake index. The index,
// the files, the secret filter and the commits are tested in `memory.rs`.

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import type { MemoryEntry, MemoryHit, NewMemoryEntry, RecallRow } from "../ipc/memory";
import { createEngine, toApiMessages, type StreamFn, type StreamLike } from "./engine";
import { fakePort } from "./fakePort.test-util";
import { isCorrection, memoryOff, recallNote, RECALL_OPEN, stems, usedHit, worthRecalling, type MemoryHost } from "./memory";
import type { DuckEvent } from "./protocol";
import { DEFAULT_SETTINGS } from "./settings";
import { createThreadStore, type ThreadBackend } from "./threads";
import { MEMORY_TOOLS } from "./tools/memory";
import { createRegistry } from "./tools/registry";

type Msg = Anthropic.Beta.BetaMessage;
type Block = Msg["content"][number];
type Params = Parameters<StreamFn>[0];

const entry = (text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  topic: "decisions",
  file: "memory/decisions.md",
  line: 5,
  date: "2026-10-15",
  text,
  src: "thread:t0",
  conf: "high",
  tags: null,
  raw: `2026-10-15 — ${text} (src: thread:t0, conf: high)`,
  ...extra,
});

const hit = (kind: "memory" | "note", matched: number, terms: number, text = "x"): MemoryHit => ({
  kind,
  label: kind === "memory" ? "decisions" : "note: Workbench / auth",
  text,
  file: "memory/decisions.md",
  path: "C:\\Duck\\memory\\decisions.md",
  line: 5,
  matched,
  terms,
  entry: kind === "memory" ? entry(text) : null,
});

describe("automatic recall", () => {
  it("shows a memory entry holding two of the message's words, a note three", () => {
    expect(worthRecalling([hit("memory", 1, 4), hit("memory", 2, 4), hit("note", 2, 4), hit("note", 3, 4)]).map((h) => [h.kind, h.matched])).toEqual([
      ["memory", 2],
      ["note", 3],
    ]);
    // A one-word message needs its one word, for memory; a note needs more.
    expect(worthRecalling([hit("memory", 1, 1), hit("note", 1, 1)]).map((h) => h.kind)).toEqual(["memory"]);
    expect(worthRecalling(Array.from({ length: 6 }, () => hit("memory", 3, 3)))).toHaveLength(3);
  });

  it("words the note, with the lesson line for a correction", () => {
    expect(recallNote([], false)).toBeNull();
    const n = recallNote([hit("memory", 2, 2, "Decided SQLite for notes sync. Why: one file")], true)!;
    expect(n.startsWith(RECALL_OPEN)).toBe(true);
    expect(n).toContain("- [decisions, 2026-10-15, conf high] Decided SQLite for notes sync. Why: one file (src: thread:t0)");
    expect(n).toContain("remember (topic lessons)");
    expect(recallNote([], true)).not.toContain(RECALL_OPEN);
  });

  it("knows a correction in English and Russian", () => {
    for (const t of ["No, I meant the backend session", "not that one", "I said high effort", "Нет, не то", "не то, я имел в виду бэкенд", "Я же сказал: без кода"])
      expect(isCorrection(t), t).toBe(true);
    for (const t of ["Nothing new today?", "What did we decide about sync?", "Нормально, спасибо", "это не тот случай, но ладно"])
      expect(isCorrection(t), t).toBe(false);
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

const message = (content: Block[], stop: Msg["stop_reason"]): Msg =>
  ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
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

/** An index over a list of entries: a hit per entry holding a query word. */
function fakeMemory(entries: MemoryEntry[] = []) {
  const written: { topic: string; entry: NewMemoryEntry }[] = [];
  const forgotten: { file: string; raw: string }[][] = [];
  const words = (q: string) => q.toLowerCase().match(/[\p{L}\d]{4,}/gu) ?? [];
  const host: MemoryHost = {
    async search(query, k) {
      const ws = words(query);
      return entries
        .map((e) => ({ e, n: ws.filter((w) => e.text.toLowerCase().includes(w)).length }))
        .filter((x) => x.n > 0)
        .slice(0, k)
        .map(({ e, n }) => ({ ...hit("memory", n, ws.length, e.text), entry: e }));
    },
    async write(topic, e) {
      written.push({ topic, entry: e });
      const made = entry(e.fact, { topic, file: `memory/${topic}.md`, raw: e.fact });
      return {
        edit: { file: made.file, path: `C:\\Duck\\${made.file}`, before: null, after: `# T\n\n- ${e.fact}\n` },
        entry: made,
      };
    },
    async matching(query) {
      const ws = words(query);
      return entries.filter((e) => ws.every((w) => e.text.toLowerCase().includes(w)));
    },
    async forget(items) {
      forgotten.push(items);
      entries = entries.filter((e) => !items.some((i) => i.raw === e.raw));
      return [{ file: "memory/decisions.md", path: "C:\\Duck\\memory\\decisions.md", before: "a", after: "b" }];
    },
  };
  return { host, written, forgotten };
}

async function setup(steps: Msg[], memory: MemoryHost) {
  const store = createThreadStore(memoryBackend());
  await store.load();
  const s = scripted(steps);
  const events: DuckEvent[] = [];
  const engine = createEngine({
    stream: s.stream,
    registry: createRegistry(MEMORY_TOOLS),
    port: fakePort(),
    store,
    memory,
    settings: () => DEFAULT_SETTINGS,
  });
  engine.onEvent((e) => events.push(e));
  const turn = async (words: string, threadId: string | null = null) => {
    const id = await engine.send({ threadId, text: words, source: "desktop" });
    await engine.settled(id);
    return id;
  };
  return { engine, store, calls: s.calls, events, turn };
}

const SQLITE = entry("Decided SQLite for notes sync. Why: one file, no server");

describe("long-term memory in threads (L1)", () => {
  it("brings up a decision when it comes up again, for that reply only", async () => {
    const { host } = fakeMemory([SQLITE, entry("Prefers dark themes", { topic: "preferences" })]);
    const { calls, store, turn } = await setup(
      [message([text("SQLite, as decided.")], "end_turn"), message([text("Sure.")], "end_turn")],
      host,
    );
    const id = await turn("Let's get back to the notes sync design");
    const first = calls[0];
    expect(first.betas).toContain("mid-conversation-system-clear-at-2026-08-21");
    const sys = first.messages[1] as unknown as { role: string; clear_at?: string; content: { text: string }[] };
    expect(first.messages.map((m) => m.role)).toEqual(["user", "system"]);
    expect(sys.clear_at).toBe("next_user_message");
    expect(sys.content[0].text).toContain("Decided SQLite for notes sync");
    expect(sys.content[0].text).not.toContain("dark themes");

    await turn("ok, and the themes?", id);
    // The earlier note is sent again as it was (the API has cleared it), so the
    // history stays append-only; this message gets its own.
    const second = calls[1];
    expect(second.messages.slice(0, 3)).toEqual([...first.messages, expect.objectContaining({ role: "assistant" })]);
    expect(second.messages.map((m) => m.role)).toEqual(["user", "system", "assistant", "user", "system"]);
    expect(JSON.stringify(second.messages[4])).toContain("dark themes");
    expect(toApiMessages(store.loaded(id))).toHaveLength(6);
  });

  it("adds nothing when nothing matches, and goes on when the search fails", async () => {
    const failing: MemoryHost = { ...fakeMemory().host, search: () => Promise.reject(new Error("index locked")) };
    const { calls, turn } = await setup([message([text("Hi.")], "end_turn")], failing);
    await turn("hello there");
    expect(calls[0].messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps the core memory's system message ahead of the recall note", async () => {
    const { host } = fakeMemory([SQLITE]);
    const store = createThreadStore(memoryBackend());
    await store.load();
    const s = scripted([message([text("ok")], "end_turn")]);
    const engine = createEngine({
      stream: s.stream,
      registry: createRegistry(MEMORY_TOOLS),
      port: fakePort(),
      store,
      memory: host,
      core: { read: async () => ({ path: "C:\\Duck\\memory\\core.md", text: "# Core\n\n## About you\n- Lives in Madrid\n" }), write: async () => {} },
      settings: () => DEFAULT_SETTINGS,
    });
    const id = await engine.send({ threadId: null, text: "notes sync again", source: "desktop" });
    await engine.settled(id);
    const ms = s.calls[0].messages as unknown as { role: string; clear_at?: string }[];
    expect(ms.map((m) => [m.role, m.clear_at ?? null])).toEqual([
      ["user", null],
      ["system", null],
      ["system", "next_user_message"],
    ]);
  });

  it("remembers with a chip, and not in a thread you asked it not to", async () => {
    const mem = fakeMemory();
    const { engine, store, turn } = await setup(
      [
        message([toolUse("r1", "remember", { topic: "decisions", fact: "Notes sync uses SQLite", why: "one file", conf: "high", tags: "синхронизация заметок" })], "tool_use"),
        message([text("Noted.")], "end_turn"),
        message([toolUse("r2", "remember", { topic: "preferences", fact: "Likes tea" })], "tool_use"),
        message([text("Not saved.")], "end_turn"),
      ],
      mem.host,
    );
    const id = await turn("We'll use SQLite for notes sync, because it's one file.");
    expect(mem.written).toMatchObject([
      { topic: "decisions", entry: { fact: "Notes sync uses SQLite", why: "one file", conf: "high", src: `thread:${id}`, tags: "синхронизация заметок" } },
    ]);
    expect(mem.written[0].entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const chip = store.loaded(id).find((m) => m.role === "notice")!.content as { kind: string; memory: { file: string } };
    expect(chip).toMatchObject({ kind: "memory", memory: { file: "memory/decisions.md" } });

    await engine.notice(id, { kind: "memoryOff", off: true, text: "Duck won't remember this conversation." });
    expect(memoryOff(store.loaded(id))).toBe(true);
    await turn("I like tea", id);
    expect(mem.written).toHaveLength(1);
    const results = store.loaded(id).filter((m) => m.role === "user").pop()!.content as { content: string }[];
    expect(JSON.stringify(results)).toContain("not to remember this conversation");
  });

  it("forgets what it matches only after you confirm the card", async () => {
    const mem = fakeMemory([SQLITE, entry("Prefers dark themes")]);
    const { engine, events, turn } = await setup(
      [
        message([toolUse("f1", "forget", { query: "notes sync" })], "tool_use"),
        message([text("Forgotten.")], "end_turn"),
      ],
      mem.host,
    );
    const id = await turn("Forget what I said about notes sync");
    const ask = events.find((e) => e.type === "confirm");
    expect(ask).toMatchObject({ request: { name: "forget", summary: expect.stringContaining("Decided SQLite for notes sync") } });
    expect(mem.forgotten).toHaveLength(0);
    await engine.confirm(id, "f1", true);
    await engine.settled(id);
    expect(mem.forgotten).toEqual([[{ file: SQLITE.file, raw: SQLITE.raw }]]);
  });

  it("recall returns the hits with where they're from", async () => {
    const mem = fakeMemory([SQLITE]);
    const { store, turn } = await setup(
      [message([toolUse("q1", "recall", { query: "sqlite sync" })], "tool_use"), message([text("SQLite.")], "end_turn")],
      mem.host,
    );
    const id = await turn("What did we decide?");
    const result = JSON.stringify(store.loaded(id).filter((m) => m.role === "user").pop()!.content);
    expect(result).toContain("Decided SQLite for notes sync");
    expect(result).toContain("2/2 words");
  });
});

describe("the recall log and the tidy's questions (L2)", () => {
  it("guesses whether a reply used a hit from the hit's own words", () => {
    const h = { ...hit("memory", 2, 4, SQLITE.text), entry: SQLITE };
    const q = "Let's get back to the notes sync design";
    expect(usedHit(h, q, "We'll keep SQLite: it's one file.")).toBe(true);
    // Words the message itself has don't count: echoing "notes sync" isn't use.
    expect(usedHit(h, q, "Sure, the notes sync design. Where were we?")).toBe(false);
    expect([...stems("Заметки, заметок; synchronization")]).toEqual(["замет", "synchronizati"]);
  });

  it("logs each recall with what the reply used and whether Duck searched itself", async () => {
    const mem = fakeMemory([SQLITE]);
    const rows: RecallRow[] = [];
    mem.host.log = async (r) => void rows.push(r);
    const { engine, turn } = await setup(
      [
        message([text("We'll keep SQLite: it's one file.")], "end_turn"),
        message([toolUse("q1", "recall", { query: "themes" })], "tool_use"),
        message([text("Nothing on themes.")], "end_turn"),
        message([text("Fine.")], "end_turn"),
      ],
      mem.host,
    );
    const id = await turn("Let's get back to the notes sync design");
    await turn("and the colour themes?", id);
    await new Promise((r) => setTimeout(r, 0));
    expect(rows.map((r) => [r.shown, r.used, r.selfRecall])).toEqual([
      [1, 1, false],
      [0, 0, true],
    ]);
    expect(rows[0]).toMatchObject({ threadId: id, query: "Let's get back to the notes sync design", hits: [{ label: "decisions", used: true }] });
    // Not in a thread you asked Duck not to remember.
    await engine.notice(id, { kind: "memoryOff", off: true, text: "off" });
    await turn("notes sync once more", id);
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toHaveLength(2);
  });

  it("asks about a contradiction once, in the next message's note", async () => {
    const mem = fakeMemory();
    const asks = ["Earlier: Postgres for notes sync. Today: SQLite. Which holds?"];
    mem.host.question = async () => asks.shift() ?? null;
    const { calls, turn } = await setup(
      [message([text("Quick one: Postgres or SQLite?")], "end_turn"), message([text("SQLite it is.")], "end_turn")],
      mem.host,
    );
    const id = await turn("morning");
    const note = JSON.stringify(calls[0].messages[1]);
    expect(note).toContain("<memory_question>");
    expect(note).toContain("Earlier: Postgres for notes sync. Today: SQLite. Which holds?");
    await turn("SQLite", id);
    expect(calls[1].messages.map((m) => m.role)).toEqual(["user", "system", "assistant", "user"]);
  });
});
