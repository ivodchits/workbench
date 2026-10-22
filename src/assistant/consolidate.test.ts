// Memory consolidation (step L2): what the nightly call reads (the window's
// threads, not the ones you asked Duck not to remember, nor Workbench events),
// how its answer becomes one plan (merges, retirements, made-up ids dropped, a
// contradiction's entries held for the question), the question asked once, the
// skill ideas kept, and when the nightly run is due. The files and the one commit
// are tested in `memory.rs`.

import { describe, expect, it } from "vitest";

import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import type { MemoryEntry, MemoryPlan, MemoryStateKey } from "../ipc/memory";
import { createConsolidator, IDLE_MS, planFrom, type Consolidation } from "./consolidate";
import { recallFor } from "./memory";

const DAY = 86_400_000;
/** 2026-10-22 01:30 local. */
const NIGHT = new Date(2026, 9, 22, 1, 30).getTime();

const entry = (id: number, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  topic: "decisions",
  file: "memory/decisions.md",
  line: id + 4,
  date: "2026-10-15",
  text,
  src: `thread:t${id}`,
  conf: "high",
  tags: null,
  raw: `2026-10-15 — ${text} (src: thread:t${id}, conf: high)`,
  ...extra,
});

const answer = (over: Partial<Consolidation> = {}): Consolidation => ({
  new_entries: [],
  merges: [],
  retire: [],
  contradictions: [],
  journal: "",
  skill_ideas: [],
  improvements: [],
  ...over,
});

const msg = (threadId: string, seq: number, ts: number, role: StoredMessage["role"], text: string, source = "desktop"): StoredMessage => ({
  threadId,
  seq,
  ts,
  role,
  content: role === "notice" ? { kind: "memoryOff", off: true, text } : [{ type: "text", text }],
  source,
});

function setup(o: { entries?: MemoryEntry[]; answers?: Consolidation[]; idle?: number; now?: number } = {}) {
  let now = o.now ?? NIGHT;
  let idle = o.idle ?? IDLE_MS;
  const threads: ThreadRow[] = [
    { id: "a", title: "Notes sync", mode: "chat", created: 1, updated: NIGHT - 3 * 3_600_000 },
    { id: "b", title: "Private", mode: "chat", created: 1, updated: NIGHT - 2 * 3_600_000 },
    { id: "c", title: "Old", mode: "chat", created: 1, updated: NIGHT - 3 * DAY },
  ];
  const messages: Record<string, StoredMessage[]> = {
    a: [
      msg("a", 1, NIGHT - 4 * 3_600_000, "user", "Let's switch notes sync to SQLite after all"),
      msg("a", 2, NIGHT - 4 * 3_600_000 + 1, "assistant", "Done: SQLite it is."),
      msg("a", 3, NIGHT - 3 * 3_600_000, "user", "<workbench_event>task finished</workbench_event>", "event"),
    ],
    b: [msg("b", 1, NIGHT - 2 * 3_600_000, "user", "my bank PIN story"), msg("b", 2, NIGHT - 2 * 3_600_000, "notice", "off")],
    c: [msg("c", 1, NIGHT - 3 * DAY, "user", "an old chat")],
  };
  const state = new Map<MemoryStateKey, string>();
  const inputs: string[] = [];
  const applied: { plan: MemoryPlan; message: string }[] = [];
  const answers = [...(o.answers ?? [])];
  const c = createConsolidator({
    threads: () => threads,
    messages: async (id) => messages[id] ?? [],
    list: async () => o.entries ?? [],
    apply: async (plan, message) => {
      applied.push({ plan, message });
      return { edits: [], skipped: [] };
    },
    state: {
      get: async (k) => state.get(k) ?? null,
      set: async (k, v) => void (v === null ? state.delete(k) : state.set(k, v)),
    },
    call: async (input) => {
      inputs.push(input);
      const a = answers.shift();
      if (!a) throw new Error("no answer scripted");
      return a;
    },
    idleMs: async () => idle,
    now: () => now,
  });
  return {
    c,
    inputs,
    applied,
    state,
    threads,
    messages,
    setNow: (n: number) => (now = n),
    setIdle: (n: number) => (idle = n),
  };
}

const PG = entry(1, "Notes sync uses Postgres");
const PG2 = entry(2, "Postgres is the store for notes sync");
const SQLITE = entry(3, "Use SQLite for local caches");
const BETA = entry(4, "Ship the beta by October 1", { topic: "goals", file: "memory/goals.md" });

describe("what the tidy reads", () => {
  it("reads the window's conversations, not events nor threads Duck mustn't remember", async () => {
    const t = setup({ entries: [PG, BETA], answers: [answer()] });
    await t.c.run();
    const input = t.inputs[0];
    expect(input).toContain("Today is 2026-10-22.");
    expect(input).toContain('<thread title="Notes sync">');
    expect(input).toContain("user (2026-10-21 21:30): Let's switch notes sync to SQLite after all");
    expect(input).toContain("duck (2026-10-21 21:30): Done: SQLite it is.");
    expect(input).not.toContain("workbench_event");
    expect(input).not.toContain("bank PIN");
    expect(input).not.toContain("an old chat");
    expect(input).toContain("[e1] decisions · 2026-10-15 · conf high: Notes sync uses Postgres");
  });

  it("makes no call when nothing happened, and the next run starts where this one ended", async () => {
    const t = setup({ answers: [answer()] });
    await t.c.run();
    t.setNow(NIGHT + DAY);
    const r = await t.c.run();
    expect(r.ran).toBe(false);
    expect(t.inputs).toHaveLength(1);
    expect(t.applied).toHaveLength(1);
  });
});

describe("the plan", () => {
  it("merges duplicates into one entry and retires what no longer holds, in one apply", async () => {
    const t = setup({
      entries: [PG, PG2, BETA],
      answers: [
        answer({
          merges: [{ ids: ["e1", "e2"], topic: "decisions", fact: "Notes sync uses Postgres", why: null, conf: "high", tags: "синхронизация заметок" }],
          retire: [{ id: "e3", why: "the beta shipped" }],
          new_entries: [{ topic: "preferences", fact: "Likes short replies", why: null, conf: "med", tags: null }],
          journal: "Worked on the notes sync.",
        }),
      ],
    });
    const r = await t.c.run();
    expect(t.applied).toHaveLength(1);
    const { plan, message } = t.applied[0];
    expect(plan.remove).toEqual([PG, PG2, BETA].map((e) => ({ file: e.file, raw: e.raw })));
    expect(plan.add).toEqual([
      { topic: "decisions", entry: { date: "2026-10-15", fact: "Notes sync uses Postgres", src: "thread:t1", conf: "high", tags: "синхронизация заметок" } },
      { topic: "preferences", entry: { date: "2026-10-22", fact: "Likes short replies", src: "tidy:2026-10-22", conf: "med" } },
    ]);
    // The journal is about the evening before the 01:30 run.
    expect(plan.journal).toEqual({ date: "2026-10-21", text: "Worked on the notes sync." });
    expect(message.split("\n")[0]).toBe("memory: tidied 2026-10-22 (1 new, 2 merged, 1 retired)");
    expect(message).toContain("- retired: Ship the beta by October 1 (the beta shipped)");
    expect(r).toMatchObject({ ran: true, added: 1, merged: 2, retired: 1, journal: "Worked on the notes sync." });
    expect(JSON.parse(t.state.get("consolidation")!)).toMatchObject({ date: "2026-10-22", at: NIGHT });
  });

  it("drops made-up and reused ids, and holds a contradiction's entries for the question", () => {
    const ids = new Map([
      ["e1", PG],
      ["e2", SQLITE],
      ["e3", PG2],
    ]);
    const p = planFrom(
      answer({
        contradictions: [{ ids: ["e1", "e9"], question: "Earlier: Postgres. Today: SQLite. Which holds?" }],
        merges: [
          { ids: ["e1", "e3"], topic: "decisions", fact: "merged", why: null, conf: "high", tags: null },
          { ids: ["e9", "e8"], topic: "decisions", fact: "invented", why: null, conf: "high", tags: null },
        ],
        retire: [{ id: "e1", why: "" }, { id: "e2", why: "" }, { id: "e2", why: "again" }],
        new_entries: [{ topic: "nonsense", fact: "x", why: null, conf: "low", tags: null }],
      }),
      ids,
      "2026-10-22",
    );
    expect(p.questions).toEqual([{ question: "Earlier: Postgres. Today: SQLite. Which holds?", entries: [PG.raw] }]);
    expect(p.plan.remove).toEqual([{ file: SQLITE.file, raw: SQLITE.raw }]);
    expect(p.plan.add).toEqual([]);
    expect([p.added, p.merged, p.retired]).toEqual([0, 0, 1]);
  });

  it("asks a contradiction once, the next time you talk", async () => {
    const t = setup({
      entries: [PG, SQLITE],
      answers: [answer({ contradictions: [{ ids: ["e1", "e2"], question: "Earlier: Postgres for notes sync. Today: SQLite. Which holds?" }] })],
    });
    const r = await t.c.run();
    expect(r.questions).toBe(1);
    expect(t.applied[0].plan.remove).toEqual([]);
    const host = { search: async () => [], write: async () => { throw new Error(); }, matching: async () => [], forget: async () => [], question: () => t.c.question() };
    const first = await recallFor(host, "good morning");
    expect(first.note).toContain("Earlier: Postgres for notes sync. Today: SQLite. Which holds?");
    expect((await recallFor(host, "and then?")).note).toBeNull();
  });

  it("keeps skill ideas for later, one per request", async () => {
    const idea = { request: "Pull, run the tests and open the failing file", steps: ["git pull", "npm test", "open the file"], times: 3 };
    const t = setup({ answers: [answer({ skill_ideas: [idea, { ...idea, request: "once only", times: 1 }] }), answer({ skill_ideas: [{ ...idea, times: 4 }] })] });
    await t.c.run();
    t.messages.a.push(msg("a", 4, NIGHT + DAY - 1000, "user", "pull and test again"));
    t.threads[0].updated = NIGHT + DAY - 1000;
    t.setNow(NIGHT + DAY);
    await t.c.run();
    const offers = JSON.parse(t.state.get("skill_offers")!);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ request: idea.request, times: 4 });
  });

  it("offers a request seen three times as a skill (S2), once, and not beside a change to Duck", async () => {
    const idea = { request: "Pull, run the tests and open the failing file", steps: ["git pull", "npm test"], times: 3 };
    const t = setup({ answers: [answer({ skill_ideas: [idea, { ...idea, request: "twice", times: 2 }] })] });
    await t.c.run();
    expect(await t.c.skillOffer()).toBe("Pull, run the tests and open the failing file (asked about 3 times; the steps: git pull; npm test)");
    t.setNow(NIGHT + 8 * DAY);
    // Seen twice isn't enough, and the first is offered already.
    expect(await t.c.skillOffer()).toBeNull();
    const base = { search: async () => [], write: async () => { throw new Error(); }, matching: async () => [], forget: async () => [] };
    const note = (await recallFor({ ...base, skillOffer: async () => "Pull and test" }, "morning")).note!;
    expect(note).toContain("<skill_suggestion>");
    expect(note).toContain("Write it with draft_skill only if the user says yes.");
    let asked = false;
    const both = await recallFor(
      { ...base, suggestion: async () => "Pick backend-api", skillOffer: async () => ((asked = true), "Pull and test") },
      "morning",
    );
    expect(both.note).not.toContain("<skill_suggestion>");
    expect(asked).toBe(false);
  });
});

describe("when it runs", () => {
  it("runs after midnight once you've been away an hour, once a day", async () => {
    const t = setup({ answers: [answer(), answer()], now: NIGHT - DAY });
    await t.c.run(); // the first run, a day back
    t.setNow(NIGHT - DAY + 3_600_000);
    expect(await t.c.tick()).toBeNull(); // the same day
    t.setNow(NIGHT);
    t.setIdle(IDLE_MS - 1);
    expect(await t.c.tick()).toBeNull(); // not away long enough
    t.setIdle(IDLE_MS);
    expect(await t.c.tick()).not.toBeNull();
    expect(await t.c.tick()).toBeNull(); // done for today
  });

  it("needs only a short break when a run is overdue, and waits an hour after a failure", async () => {
    const t = setup({ answers: [], idle: 10 * 60_000 });
    await expect(t.c.tick()).rejects.toThrow("no answer scripted");
    expect(t.inputs).toHaveLength(1);
    expect(await t.c.tick()).toBeNull();
    expect(t.inputs).toHaveLength(1);
  });
});

describe("changes to Duck it may suggest (step L3)", () => {
  const toolMsg = (seq: number, ts: number, content: unknown[]): StoredMessage => ({ threadId: "a", seq, ts, role: seq % 2 ? "assistant" : "user", content, source: "duck" });

  it("reads the tool calls that kept failing, not the ones you declined", async () => {
    const t = setup({ answers: [answer()] });
    const at = NIGHT - 3_600_000;
    t.messages.a.push(
      toolMsg(5, at, [{ type: "tool_use", id: "u1", name: "send_prompt", input: {} }]),
      toolMsg(6, at, [{ type: "tool_result", tool_use_id: "u1", is_error: true, content: "no session called backend" }]),
      toolMsg(7, at, [{ type: "tool_use", id: "u2", name: "send_prompt", input: {} }]),
      toolMsg(8, at, [{ type: "tool_result", tool_use_id: "u2", is_error: true, content: "no session called the backend" }]),
      toolMsg(9, at, [{ type: "tool_use", id: "u3", name: "kill_session", input: {} }]),
      toolMsg(10, at, [{ type: "tool_result", tool_use_id: "u3", is_error: true, content: "The user declined this action." }]),
      toolMsg(11, at, [{ type: "tool_use", id: "u4", name: "kill_session", input: {} }]),
      toolMsg(12, at, [{ type: "tool_result", tool_use_id: "u4", is_error: true, content: "The user declined this action." }]),
    );
    await t.c.run();
    expect(t.inputs[0]).toContain("<tool_errors>\n- send_prompt, 2 times: no session called backend\n</tool_errors>");
  });

  it("suggests one change a week at most, each once", async () => {
    const t = setup({
      answers: [
        answer({
          improvements: [
            { request: "When the user says 'the backend', pick the session titled backend-api", why: "corrected three times this week." },
            { request: "Ask before reading a long note aloud", why: "stopped twice" },
          ],
        }),
      ],
    });
    const r = await t.c.run();
    expect(r.log).toContain("to suggest: When the user says 'the backend', pick the session titled backend-api");
    expect(await t.c.suggestion()).toBe("When the user says 'the backend', pick the session titled backend-api (corrected three times this week)");
    expect(await t.c.suggestion()).toBeNull();
    t.setNow(NIGHT + 7 * DAY);
    expect(await t.c.suggestion()).toBe("Ask before reading a long note aloud (stopped twice)");
    const host = { search: async () => [], write: async () => { throw new Error(); }, matching: async () => [], forget: async () => [], suggestion: () => t.c.suggestion() };
    t.setNow(NIGHT + 14 * DAY);
    expect((await recallFor(host, "morning")).note).toBeNull();
  });

  it("carries a suggestion in the recall note, to offer and not to start", async () => {
    const host = { search: async () => [], write: async () => { throw new Error(); }, matching: async () => [], forget: async () => [], suggestion: async () => "Pick backend-api for 'the backend'" };
    const note = (await recallFor(host, "morning")).note!;
    expect(note).toContain("<duck_suggestion>");
    expect(note).toContain("Pick backend-api for 'the backend'");
    expect(note).toContain("Start it only if the user says yes.");
  });
});
