// Reminders (step H8): when they come up, the clock for timed ones, the tools, and
// the general reminders' note on a conversation's first message.

import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import type { ReminderRecord, RemindersFile } from "../ipc/reminders";
import { createEngine, type StreamFn, type StreamLike } from "./engine";
import { fakePort } from "./fakePort.test-util";
import type { Notice } from "./protocol";
import {
  createReminderClock,
  createReminders,
  dueAt,
  dueText,
  findReminder,
  isActive,
  localStamp,
  projectLine,
  view,
  widgetOrder,
  type RemindersBackend,
} from "./reminders";
import { DEFAULT_SETTINGS } from "./settings";
import { createThreadStore, type ThreadBackend } from "./threads";
import { createRegistry, type ToolContext, type ToolDef } from "./tools/registry";
import { REMINDER_TOOLS, addReminder, completeReminder, editReminder, listReminders, remindersFor } from "./tools/reminders";

const rec = (id: string, title: string, more: Partial<ReminderRecord> = {}): ReminderRecord => ({
  id,
  title,
  state: "open",
  created: "2026-10-23T09:00",
  ...more,
});

const WB = { id: "p1", name: "Workbench" };

/** `reminders.json` in memory, with the Rust side's check of what a write is over. */
function fakeBackend(start: ReminderRecord[] = [], problem: string | null = null) {
  let list = structuredClone(start);
  const seen = new Map<string, string>();
  const commits: string[] = [];
  const file = (): RemindersFile => ({ path: "C:\\Duck\\reminders.json", reminders: structuredClone(list), problem });
  const backend: RemindersBackend = {
    read: async () => file(),
    async put(id, before, after, message) {
      const now = list.find((r) => r.id === id) ?? null;
      if (JSON.stringify(now) !== JSON.stringify(before)) throw new Error(`stale: the reminder ${id} changed since it was read`);
      list = after ? (now ? list.map((r) => (r.id === id ? after : r)) : [...list, after]) : list.filter((r) => r.id !== id);
      commits.push(message);
      return file();
    },
    seen: async () => [...seen.entries()],
    setSeen: async (id, v) => void (v === null ? seen.delete(id) : seen.set(id, v)),
  };
  return {
    backend,
    commits,
    seen,
    list: () => list,
    /** A hand edit (or the phone) behind Duck's back. */
    edit: (f: (l: ReminderRecord[]) => ReminderRecord[]) => (list = f(list)),
  };
}

describe("when a reminder is", () => {
  it("reads a due time or a day, and says it back", () => {
    expect(new Date(dueAt("2026-10-24T10:00")).getHours()).toBe(10);
    expect(new Date(dueAt("2026-10-24")).getHours()).toBe(9);
    expect(dueAt("2026-02-30")).toBeNaN();
    expect(dueText("2026-10-24T10:00")).toBe("Saturday 24 Oct, 10:00");
    expect(dueText("2026-10-24")).toBe("Saturday 24 Oct");
    expect(dueText("2026-10-24T10:00", true)).toBe("Sat 24 Oct, 10:00");
    expect(localStamp(new Date(2026, 9, 3, 7, 5))).toBe("2026-10-03T07:05");
  });

  it("comes up once open and due, not before", () => {
    const at = dueAt("2026-10-24T10:00");
    expect(isActive(rec("a", "x"), at)).toBe(true);
    expect(isActive(rec("a", "x", { due: "2026-10-24T10:00" }), at - 1)).toBe(false);
    expect(isActive(rec("a", "x", { due: "2026-10-24T10:00" }), at)).toBe(true);
    expect(isActive(rec("a", "x", { state: "done" }), at)).toBe(false);
  });

  it("is found by id, by title, or by words from it", () => {
    const list = [rec("r1", "Call the bank"), rec("r2", "Rotate the signing key", { details: "before the release" }), rec("r3", "Call mum")];
    expect(findReminder(list, "r2").id).toBe("r2");
    expect(findReminder(list, "call the bank").id).toBe("r1");
    expect(findReminder(list, "bank").id).toBe("r1");
    expect(findReminder(list, "release key").id).toBe("r2");
    expect(() => findReminder(list, "call")).toThrow(/Several reminders match "call": r1 "Call the bank", r3 "Call mum"/);
    expect(() => findReminder(list, "dentist")).toThrow(/No reminder matches/);
  });

  it("orders the widget: timed, the shown project's, general, other projects'", () => {
    const now = dueAt("2026-10-24T12:00");
    const list = [
      rec("g", "general"),
      rec("o", "other project", { project: { id: "p2", name: "Backend" } }),
      rec("p", "this project", { project: WB }),
      rec("t2", "later", { due: "2026-10-25T09:00" }),
      rec("t1", "sooner", { due: "2026-10-24T10:00" }),
    ].map((r) => view(r, now));
    expect(widgetOrder(list, "p1").map((v) => v.id)).toEqual(["t1", "t2", "p", "g", "o"]);
    expect(list.find((v) => v.id === "t1")).toMatchObject({ due: "Sat 24 Oct, 10:00", overdue: true });
  });
});

describe("what comes up", () => {
  it("names a project's reminders in one line", () => {
    expect(projectLine("Workbench", [rec("a", "rotate the signing key"), rec("b", "update the changelog")])).toBe(
      "Workbench · 2 reminders: rotate the signing key; update the changelog",
    );
  });

  it("gives the general reminders on a new thread or after a quiet spell, not on every message", async () => {
    const f = fakeBackend([
      rec("g", "Call the bank"),
      rec("p", "Rotate the key", { project: WB }),
      rec("later", "Send the invoice", { due: "2026-10-30T10:00" }),
      rec("d", "Done already", { state: "done" }),
    ]);
    const r = createReminders({ backend: f.backend, spellMinutes: () => 30 });
    await r.load();
    const t0 = dueAt("2026-10-24T10:00");
    const note = r.opening(false, t0)!;
    expect(note).toContain("Call the bank");
    expect(note).not.toMatch(/Rotate|invoice|Done already/);
    expect(r.opening(false, t0 + 60_000)).toBeNull();
    // A new thread is a new conversation.
    expect(r.opening(true, t0 + 120_000)).toContain("Call the bank");
    // Half an hour without a message is a quiet spell.
    expect(r.opening(false, t0 + 120_000 + 30 * 60_000)).toContain("Call the bank");
    expect(r.forProject("p1", t0).map((x) => x.id)).toEqual(["p"]);
    expect(r.forProject("p2", t0)).toEqual([]);
  });
});

describe("the clock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("announces a timed reminder once when it's due, late when it came due while the app was closed", async () => {
    const start = dueAt("2026-10-24T10:00");
    vi.setSystemTime(start);
    const f = fakeBackend([
      rec("missed", "Water the plants", { due: "2026-10-24T08:30" }),
      rec("soon", "Send the invoice", { due: "2026-10-24T10:02" }),
      rec("plain", "Call the bank"),
    ]);
    const r = createReminders({ backend: f.backend, spellMinutes: () => 30 });
    await r.load();
    const said: string[] = [];
    const clock = await createReminderClock({
      reminders: r,
      backend: f.backend,
      startedAt: start,
      announce: (x, late) => said.push(`${x.id}${late ? " late" : ""}`),
    });
    clock.arm();
    expect(said).toEqual(["missed late"]);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(said).toEqual(["missed late"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(said).toEqual(["missed late", "soon"]);
    clock.arm();
    expect(said).toHaveLength(2);
    expect(JSON.parse(f.seen.get("soon")!)).toMatchObject({ announced: "2026-10-24T10:02" });

    // After a restart the bookkeeping holds; a reminder moved to a new time is
    // announced again then.
    f.edit((l) => l.map((x) => (x.id === "soon" ? { ...x, due: "2026-10-24T10:05" } : x)));
    await r.load();
    const again: string[] = [];
    const next = await createReminderClock({ reminders: r, backend: f.backend, startedAt: Date.now(), announce: (x) => again.push(x.id) });
    next.arm();
    expect(again).toEqual([]);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(again).toEqual(["soon"]);
    clock.stop();
    next.stop();
  });
});

// ── the tools ──

function toolCtx(r: ReturnType<typeof createReminders>) {
  const notices: Notice[] = [];
  const ctx = {
    reminders: r,
    port: fakePort({ projects: [{ ...WB, rootPath: "C:\\wb", group: null, remote: false }] }),
    threadId: "t1",
    notice: async (n: Notice) => void notices.push(n),
    signal: new AbortController().signal,
  } as unknown as ToolContext & { prepared: undefined };
  const run = (t: ToolDef, input: unknown) => t.run(t.schema.parse(input), ctx);
  return { notices, run };
}

describe("the reminder tools", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("adds a project reminder and a timed one, each a commit with a chip", async () => {
    vi.setSystemTime(dueAt("2026-10-23T15:00"));
    const f = fakeBackend();
    const r = createReminders({ backend: f.backend, spellMinutes: () => 30 });
    await r.load();
    const t = toolCtx(r);
    const a = (await t.run(addReminder, { title: "Rotate the signing key", project: "workbench" })) as Record<string, unknown>;
    expect(a).toMatchObject({ title: "Rotate the signing key", project: "Workbench" });
    const b = (await t.run(addReminder, { title: "Send the invoice", due: "2026-10-24T10:00" })) as Record<string, unknown>;
    expect(b.due).toBe("Saturday 24 Oct, 10:00");
    expect(f.commits).toEqual(['reminders: added "Rotate the signing key" (Workbench)', 'reminders: added "Send the invoice"']);
    expect(f.list()[0]).toMatchObject({ project: WB, state: "open", created: "2026-10-23T15:00", createdIn: "t1" });
    expect(t.notices[1]).toMatchObject({
      kind: "reminder",
      text: "Reminder added: Send the invoice, Saturday 24 Oct, 10:00",
      reminder: { path: "C:\\Duck\\reminders.json", before: null, after: { title: "Send the invoice" } },
    });
    await expect(t.run(addReminder, { title: "x", due: "2026-10-22T10:00" })).rejects.toThrow(/in the past/);
    await expect(t.run(addReminder, { title: "x", project: "Nope" })).rejects.toThrow(/No project is called "Nope"/);
    // Duck's own start in the project carries it.
    expect(remindersFor({ reminders: r }, "p1")).toMatchObject({ reminders: ["Rotate the signing key"] });
  });

  it("closes one named by its words, over a change made since", async () => {
    vi.setSystemTime(dueAt("2026-10-23T15:00"));
    const f = fakeBackend([rec("r1", "Call the bank"), rec("r2", "Call mum")]);
    const r = createReminders({ backend: f.backend, spellMinutes: () => 30 });
    await r.load();
    // The phone changed r1's details after Duck's last read: the write is redone over it.
    f.edit((l) => l.map((x) => (x.id === "r1" ? { ...x, details: "about the card" } : x)));
    const t = toolCtx(r);
    expect(await t.run(completeReminder, { reminder: "bank" })).toEqual({ done: "Call the bank" });
    expect(f.list()[0]).toMatchObject({ state: "done", closed: "2026-10-23T15:00", details: "about the card" });
    expect(f.commits).toEqual(['reminders: done "Call the bank"']);
    expect(t.notices[0]).toMatchObject({ text: "Reminder done: Call the bank", reminder: { before: { state: "open" }, after: { state: "done" } } });
    await expect(t.run(completeReminder, { reminder: "r1" })).rejects.toThrow(/already done/);
  });

  it("moves one to another day, and lists them grouped", async () => {
    vi.setSystemTime(dueAt("2026-10-23T15:00"));
    const f = fakeBackend([rec("r1", "Send the invoice", { due: "2026-10-24T10:00" }), rec("r2", "Rotate the key", { project: WB }), rec("r3", "Call the bank")]);
    const r = createReminders({ backend: f.backend, spellMinutes: () => 30 });
    await r.load();
    const t = toolCtx(r);
    await t.run(editReminder, { reminder: "invoice", due: "2026-10-26" });
    expect(f.list()[0].due).toBe("2026-10-26");
    expect(await t.run(listReminders, {})).toEqual({
      timed: [expect.objectContaining({ id: "r1", due: "Monday 26 Oct" })],
      projects: { Workbench: [expect.objectContaining({ id: "r2" })] },
      general: [expect.objectContaining({ id: "r3" })],
    });
    expect(await t.run(listReminders, { project: "Workbench" })).toEqual({ projects: { Workbench: [expect.objectContaining({ id: "r2" })] } });
    await t.run(editReminder, { reminder: "r2", project: null });
    expect(f.list()[1].project).toBeUndefined();
  });

  it("refuses to write over a broken file, and says what's wrong", async () => {
    const f = fakeBackend([], "reminders.json doesn't parse: EOF at line 3");
    const r = createReminders({ backend: f.backend, spellMinutes: () => 30 });
    await r.load();
    const t = toolCtx(r);
    await expect(t.run(addReminder, { title: "x" })).rejects.toThrow(/doesn't parse.*fix the file/);
    expect(await t.run(listReminders, {})).toEqual({ problem: expect.stringContaining("C:\\Duck\\reminders.json") });
    expect(f.commits).toEqual([]);
  });
});

// ── through the engine ──

type Msg = Anthropic.Beta.BetaMessage;
type Params = Parameters<StreamFn>[0];

function threadBackend(): ThreadBackend {
  const threads: ThreadRow[] = [];
  const rows: StoredMessage[] = [];
  return {
    async threadCreate(id, mode) {
      const t = { id, title: "", mode, created: 1, updated: 1 };
      threads.push(t);
      return { ...t };
    },
    threadList: async () => threads.map((t) => ({ ...t })),
    threadMessages: async (id) => rows.filter((m) => m.threadId === id),
    async threadTitle() {},
    async messageAppend(m) {
      rows.push(structuredClone(m));
    },
    async pendingPut() {},
    pendingList: async () => [],
    async pendingClear() {},
    async threadDelete() {},
  };
}

const reply = (t: string): Msg =>
  ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: t, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as Msg;

describe("the general reminders in a conversation", () => {
  it("are a turn-scoped note on the first message, and not on the next", async () => {
    const f = fakeBackend([rec("g", "Call the bank")]);
    const reminders = createReminders({ backend: f.backend, spellMinutes: () => 30 });
    await reminders.load();
    const store = createThreadStore(threadBackend());
    await store.load();
    const calls: Params[] = [];
    const steps = [reply("Hi. Also: call the bank."), reply("Sure.")];
    const stream: StreamFn = (params) => {
      calls.push(structuredClone(params));
      const step = steps.shift()!;
      return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => step } as StreamLike;
    };
    const engine = createEngine({
      stream,
      registry: createRegistry(REMINDER_TOOLS),
      port: fakePort(),
      store,
      reminders,
      settings: () => DEFAULT_SETTINGS,
    });
    const id = await engine.send({ threadId: null, text: "hello", source: "desktop" });
    await engine.settled(id);
    const first = calls[0].messages as unknown as { role: string; clear_at?: string; content: { text: string }[] }[];
    expect(first.map((m) => [m.role, m.clear_at ?? null])).toEqual([
      ["user", null],
      ["system", "next_user_message"],
    ]);
    expect(first[1].content[0].text).toContain("Call the bank");
    await engine.send({ threadId: id, text: "what's the time?", source: "desktop" });
    await engine.settled(id);
    expect(calls[1].messages.map((m) => m.role)).toEqual(["user", "system", "assistant", "user"]);
  });
});
