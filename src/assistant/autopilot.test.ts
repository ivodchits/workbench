import { describe, expect, it } from "vitest";

import { createAutopilot, planContext, type Autopilot, type Review, type ReviewRequest } from "./autopilot";
import { fakePort, project, session, type FakePortData } from "./fakePort.test-util";
import type { ChoiceRef, SessionPhase } from "./port";

const PLAN = `# The plan

## Steps

### Step A1 — Core
Build the core.
**Done when:** it runs.

### Step A2 — Tools
Build the tools.

## Progress tracker

| A1 | Core | ☑ |
| A2 | Tools | ☐ |
`;

const last = <T,>(xs: T[]) => xs[xs.length - 1];
const settle = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => {
  for (let i = 0; i < 6; i++) await settle();
};

function verdict(v: Partial<Review> = {}): Review {
  return {
    verdict: "continue",
    stepId: "A1",
    nextStepId: "A2",
    summary: "Built the core; tests pass.",
    reason: "The step is done and recorded.",
    question: null,
    compact: true,
    compactReason: "a new step",
    compactFocus: "keep the plan path",
    nextPrompt: null,
    ...v,
  };
}

function setup(opts: { reviews?: (Review | Error)[]; data?: FakePortData; phase?: SessionPhase; stored?: Autopilot[] } = {}) {
  const s = session({ id: "w", projectId: "p", title: "workbench", phase: opts.phase ?? "done" });
  const port = fakePort({
    projects: [project({ id: "p", name: "Workbench" })],
    sessions: [s],
    transcripts: { w: [] },
    ...opts.data,
  });
  const reviews = [...(opts.reviews ?? [])];
  const asked: ReviewRequest[] = [];
  const told: string[] = [];
  const notices: string[] = [];
  const stored = new Map<string, Autopilot>();
  for (const a of opts.stored ?? []) stored.set(a.instanceId, a);
  const removed: string[] = [];
  let clock = 10_000_000_000;
  const ap = createAutopilot({
    port,
    backend: {
      put: async (a) => void stored.set(a.instanceId, a),
      list: async () => [...stored.values()],
      remove: async (id) => void removed.push(id),
    },
    review: async (r) => {
      asked.push(r);
      const next = reviews.shift() ?? verdict();
      if (next instanceof Error) throw next;
      return next;
    },
    readFile: async (path) => {
      if (path !== "C:/src/p/plan.md") throw new Error(`no file ${path}`);
      return PLAN;
    },
    tell: (_t, text) => told.push(text),
    notice: (_t, text) => notices.push(text),
    now: () => (clock += 1000),
    settleMs: 0,
  });
  /** The session finishes a turn. */
  const turnEnds = () => {
    s.phase = "done";
    port.phase("w", "done", "working");
  };
  const calls = (name: string) => port.calls.filter((c) => c.name === name).map((c) => c.args);
  return { port, ap, s, asked, told, notices, stored, removed, turnEnds, calls };
}

const start = (t: ReturnType<typeof setup>, extra: Partial<Parameters<ReturnType<typeof setup>["ap"]["start"]>[0]> = {}) =>
  t.ap.start({ instanceId: "w", threadId: "t1", planPath: "C:/src/p/plan.md", ...extra });

describe("planContext", () => {
  it("keeps the outline, the progress records and the steps asked for", () => {
    const c = planContext(PLAN, ["A2", null]);
    expect(c).toContain("Outline:\n# The plan\n## Steps\n### Step A1 — Core");
    expect(c).toContain("Progress records:\n## Progress tracker\n\n| A1 | Core | ☑ |");
    expect(c).toContain("Step A2:\n### Step A2 — Tools\nBuild the tools.");
    expect(c).not.toContain("Build the core.");
  });

  it("falls back to the checkbox lines when there's no progress section", () => {
    const c = planContext("# Plan\n- [x] one\n- [ ] two\nprose", []);
    expect(c).toContain("Progress records:\n- [x] one\n- [ ] two");
    expect(c).not.toContain("prose");
  });
});

describe("autopilot", () => {
  it("reviews the last turn, compacts, and sends the user's phrasing", async () => {
    const t = setup();
    await start(t);
    await flush();
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]).toMatchObject({ purpose: "autopilot-review", model: "claude-sonnet-5-5" });
    expect(t.asked[0].input).toContain("Plan file: C:/src/p/plan.md");
    expect(t.asked[0].input).toContain("<plan>");
    expect(t.calls("compactSession")).toEqual([["w", "keep the plan path"]]);
    expect(t.calls("sendPrompt")).toEqual([["w", "continue the implementation"]]);
    const a = t.ap.get("w")!;
    expect(a).toMatchObject({ state: "running", doing: "working", stepsDone: 1, step: "A2", lastStep: "A1" });
    expect(t.port.badges.get("w")).toMatchObject({ state: "running", text: "step 2 of 5 (A2) · working", threadId: "t1" });
    expect(last(t.notices)).toBe(
      'Autopilot A1: continue · Built the core; tests pass. · compacted, then sent "continue the implementation"',
    );

    // The next step's review reads that step's text.
    t.turnEnds();
    await flush();
    expect(t.asked[1].input).toContain("Step A2:\n### Step A2 — Tools");
    expect(t.calls("sendPrompt")[1]).toEqual(["w", "proceed to the next step"]);
  });

  it("takes the review's own prompt when allowed, and skips a compaction it says isn't due", async () => {
    const t = setup({ reviews: [verdict({ compact: false, nextPrompt: "finish the As built note for A1, then proceed" })] });
    await start(t);
    await flush();
    expect(t.calls("compactSession")).toEqual([]);
    expect(t.calls("sendPrompt")).toEqual([["w", "finish the As built note for A1, then proceed"]]);

    const u = setup({ reviews: [verdict({ nextPrompt: "something else" })] });
    await start(u, { situational: false, compactPolicy: "never" });
    await flush();
    expect(u.calls("compactSession")).toEqual([]);
    expect(u.calls("sendPrompt")).toEqual([["w", "continue the implementation"]]);
  });

  it("pauses with the question, and resumes with the user's answer as the next prompt", async () => {
    const t = setup({
      reviews: [verdict({ verdict: "needs_you", reason: "The agent asks which store to use.", question: "SQLite or Postgres for the cache?" })],
    });
    await start(t);
    await flush();
    expect(t.ap.get("w")).toMatchObject({ state: "paused", question: "SQLite or Postgres for the cache?", stepsDone: 0 });
    expect(last(t.told)).toContain("paused after 0 step(s): The agent asks which store to use. Its question: SQLite or Postgres");
    expect(t.calls("alertUser")).toEqual([["w", "Autopilot paused", "SQLite or Postgres for the cache?"]]);
    expect(t.port.badges.get("w")).toMatchObject({ state: "paused" });
    expect(t.calls("sendPrompt")).toEqual([]);

    await t.ap.resume("w", { prompt: "SQLite" });
    expect(t.calls("sendPrompt")).toEqual([["w", "SQLite"]]);
    expect(t.ap.get("w")).toMatchObject({ state: "running", question: null, why: null });
    t.turnEnds();
    await flush();
    expect(t.calls("sendPrompt")[1]).toEqual(["w", "continue the implementation"]);
  });

  it("stops when the plan is done, and after its last allowed step", async () => {
    const t = setup({ reviews: [verdict({ verdict: "plan_done", summary: "Landed A2, the last step." })] });
    await start(t);
    await flush();
    expect(t.ap.get("w")).toMatchObject({ state: "stopped", why: "the plan is done", stepsDone: 1 });
    expect(t.port.badges.get("w")).toBeNull();
    expect(t.calls("alertUser")[0]).toEqual(["w", "Autopilot stopped", "the plan is done"]);

    const u = setup();
    await start(u, { maxSteps: 2 });
    await flush();
    u.turnEnds();
    await flush();
    expect(u.ap.get("w")).toMatchObject({ state: "stopped", stepsDone: 2 });
    expect(u.calls("sendPrompt")).toHaveLength(1);
    expect(last(u.told)).toContain("it ran the 2 step(s) it was given");
  });

  it("pauses when the review or the compaction fails", async () => {
    const t = setup({ reviews: [new Error("overloaded")] });
    await start(t);
    await flush();
    expect(t.ap.get("w")).toMatchObject({ state: "paused", why: "its review failed (overloaded)" });

    const u = setup({ data: { compactError: "Claude Code didn't start compacting" } });
    await start(u);
    await flush();
    expect(u.ap.get("w")).toMatchObject({ state: "paused", why: "the compaction failed (Claude Code didn't start compacting)" });
    expect(u.calls("sendPrompt")).toEqual([]);
  });

  it("waits on a prompt without failing, and hands a question to the thread", async () => {
    const t = setup({ phase: "working" });
    await start(t);
    await flush();
    expect(t.asked).toHaveLength(0);
    const choice = {
      id: "c1",
      kind: "question",
      toolName: "AskUserQuestion",
      input: {},
      at: 1,
      questions: [{ header: "DB", question: "Which database?", multiSelect: false, options: [] }],
      options: [{ key: 1, label: "SQLite", detail: "", typed: false }],
      terminalOnly: null,
      sent: null,
      optionsFrom: "hook",
      held: false,
    } satisfies ChoiceRef;
    t.port.setChoice("w", choice);
    t.port.phase("w", "needs_you", "working");
    expect(t.ap.get("w")?.doing).toBe("waiting");
    expect(t.port.badges.get("w")?.text).toContain("waiting on you");
    expect(last(t.told)).toContain('asks: Which database? Options: 1. SQLite. If the plan (C:/src/p/plan.md)');
    t.port.phase("w", "working", "needs_you");
    expect(t.ap.get("w")?.doing).toBe("working");
  });

  it("stops when the session ends, and pauses a run the app quit during", async () => {
    const t = setup({ phase: "working" });
    await start(t);
    t.port.phase("w", "ended", "working");
    expect(t.ap.get("w")).toMatchObject({ state: "stopped", why: "the session ended" });

    const running = { ...t.stored.get("w")!, state: "running" as const };
    const old = { ...running, instanceId: "gone", state: "stopped" as const, created: 0, log: [] };
    const u = setup({ stored: [running, old] });
    await u.ap.load();
    expect(u.ap.get("w")).toMatchObject({ state: "paused", why: "Workbench restarted" });
    expect(u.removed).toEqual(["gone"]);
  });

  it("refuses a worker, a session that isn't running, a second run, and a plan it can't read", async () => {
    const t = setup({ phase: "working" });
    await expect(start(t, { planPath: "C:/nope.md" })).rejects.toThrow("The plan can't be read: no file C:/nope.md");
    await start(t);
    await expect(start(t)).rejects.toThrow("already on autopilot");
    t.s.phase = "offline";
    t.ap.stop("w");
    await expect(start(t)).rejects.toThrow("isn't running");
    t.s.phase = "idle";
    t.s.duckTask = "research";
    await expect(start(t)).rejects.toThrow("Duck's worker");
  });
});
