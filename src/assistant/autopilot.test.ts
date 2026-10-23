import { describe, expect, it } from "vitest";

import {
  createAutopilot,
  detectChecklist,
  inWindow,
  nextAt,
  overLimits,
  planContext,
  stallAfter,
  type Autopilot,
  type AutopilotCall,
  type QuestionAnswer,
  type Review,
  type StallCheck,
} from "./autopilot";
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
    finished: true,
    stepId: "A1",
    nextStepId: "A2",
    summary: "Built the core; tests pass.",
    reason: "The step is done and recorded.",
    question: null,
    compact: true,
    compactReason: "a new step",
    compactFocus: "keep the plan path",
    nextPrompt: null,
    decisions: [],
    failed: false,
    missed: [],
    ...v,
  };
}

const QUESTION = {
  id: "c1",
  kind: "question",
  toolName: "AskUserQuestion",
  input: {},
  at: 1,
  questions: [{ header: "DB", question: "Which database?", multiSelect: false, options: [] }],
  options: [
    { key: 1, label: "SQLite", detail: "", typed: false },
    { key: 2, label: "Postgres", detail: "", typed: false },
  ],
  terminalOnly: null,
  sent: null,
  optionsFrom: "hook",
  held: false,
} satisfies ChoiceRef;

function setup(
  opts: {
    reviews?: (Review | Error)[];
    answers?: QuestionAnswer[];
    stalls?: StallCheck[];
    data?: FakePortData;
    phase?: SessionPhase;
    stored?: Autopilot[];
    /** The clock's start (epoch ms). */
    at?: number;
  } = {},
) {
  const s = session({ id: "w", projectId: "p", title: "workbench", phase: opts.phase ?? "done" });
  const s2 = session({ id: "v", projectId: "p", title: "voice", phase: "working" });
  const port = fakePort({
    projects: [project({ id: "p", name: "Workbench" })],
    sessions: [s, s2],
    transcripts: { w: [], v: [] },
    ...opts.data,
  });
  const reviews = [...(opts.reviews ?? [])];
  const answers = [...(opts.answers ?? [])];
  const stalls = [...(opts.stalls ?? [])];
  const asked: AutopilotCall<never>[] = [];
  const told: string[] = [];
  const levels: (string | undefined)[] = [];
  let ticker: (() => void) | null = null;
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
    call: async (r) => {
      asked.push(r as AutopilotCall<never>);
      if (r.purpose === "autopilot-question") return answers.shift() as never;
      if (r.purpose === "autopilot-stall") return stalls.shift() as never;
      const next = reviews.shift() ?? verdict();
      if (next instanceof Error) throw next;
      return next as never;
    },
    readFile: async (path) => {
      if (path !== "C:/src/p/plan.md") throw new Error(`no file ${path}`);
      return PLAN;
    },
    tell: (_t, text, level) => {
      told.push(text);
      levels.push(level);
    },
    notice: (_t, text) => notices.push(text),
    now: () => (clock += 1000),
    settleMs: 0,
    every: (_ms, cb) => {
      ticker = cb;
      return () => {
        ticker = null;
      };
    },
  });
  if (opts.at !== undefined) clock = opts.at;
  /** Set the clock, and run the timer's check. */
  const tick = async (at?: number) => {
    if (at !== undefined) clock = at;
    ticker?.();
    await flush();
  };
  const setClock = (at: number) => {
    clock = at;
  };
  /** The session finishes a turn. */
  const turnEnds = () => {
    s.phase = "done";
    port.phase("w", "done", "working");
  };
  const calls = (name: string) => port.calls.filter((c) => c.name === name).map((c) => c.args);
  return { port, ap, s, s2, asked, told, levels, notices, stored, removed, turnEnds, calls, tick, setClock };
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

  it("waits on a permission prompt without failing", async () => {
    const t = setup({ phase: "working" });
    await start(t);
    await flush();
    expect(t.asked).toHaveLength(0);
    t.port.phase("w", "needs_you", "working");
    expect(t.ap.get("w")?.doing).toBe("waiting");
    expect(t.port.badges.get("w")?.text).toContain("waiting on you");
    t.port.phase("w", "working", "needs_you");
    expect(t.ap.get("w")?.doing).toBe("working");
  });

  it("answers a small question itself, records it and alerts; a serious one pauses", async () => {
    const t = setup({
      phase: "working",
      answers: [
        { serious: false, option: 1, text: null, why: "The plan keeps everything local." },
        { serious: true, option: null, text: null, why: "It changes the data model." },
      ],
    });
    await start(t);
    t.s.choice = QUESTION;
    t.port.phase("w", "needs_you", "working");
    await flush();
    expect(t.asked[0]).toMatchObject({ purpose: "autopilot-question" });
    expect(t.asked[0].input).toContain("Which database?\nOptions:\n1. SQLite\n2. Postgres");
    expect(t.calls("answerChoice")).toEqual([["w", "c1", 1]]);
    expect(t.ap.get("w")?.decisions).toMatchObject([
      { question: "Which database?", decision: "SQLite", by: "question", reported: false },
    ]);
    expect(t.calls("alertUser")).toEqual([["w", "Autopilot decided", "Which database? → SQLite"]]);
    expect(last(t.notices)).toBe("Autopilot decided: Which database? → SQLite · The plan keeps everything local.");
    expect(t.ap.get("w")?.state).toBe("running");

    t.s.choice = { ...QUESTION, id: "c2" };
    t.port.phase("w", "working", "needs_you");
    t.port.phase("w", "needs_you", "working");
    await flush();
    expect(t.calls("answerChoice")).toHaveLength(1);
    expect(t.ap.get("w")).toMatchObject({ state: "paused", why: "the session asks a question that's yours to decide" });
    // The pause reports what was settled so far, once.
    expect(last(t.told)).toContain("settled 1 small question(s) on its own");
    expect(last(t.told)).toContain("1. Which database? → SQLite (The plan keeps everything local)");
    expect(t.ap.get("w")?.decisions[0].reported).toBe(true);
  });

  it("settles a turn's small questions, tells the agent, and doesn't count a fix-up as a step", async () => {
    const t = setup({
      reviews: [
        verdict({
          finished: false,
          compact: false,
          nextStepId: "A1",
          decisions: [{ question: "Name the table?", decision: "cache_entries", why: "Matches the other tables." }],
        }),
        verdict({ finished: false, compact: false, nextPrompt: "the tracker isn't ticked: tick it, then proceed" }),
        ...Array.from({ length: 10 }, () => verdict({ finished: false, compact: false })),
      ],
      data: { contextUsed: { w: 30 } },
    });
    await start(t);
    await flush();
    expect(t.calls("sendPrompt")).toEqual([["w", "continue the implementation\n\nOn the open questions: Name the table: cache_entries."]]);
    expect(t.ap.get("w")).toMatchObject({ stepsDone: 0, turnsOnStep: 1, step: "A1" });
    expect(t.port.badges.get("w")?.text).toBe("step 1 of 5 (A1) · working · 1 decided");
    expect(t.asked[0].input).toContain("Context used: 30%");
    t.turnEnds();
    await flush();
    expect(t.calls("sendPrompt")[1]).toEqual(["w", "the tracker isn't ticked: tick it, then proceed"]);
    for (let i = 0; i < 10; i++) {
      t.turnEnds();
      await flush();
    }
    // Twelve turns without a finished step: it's going in circles.
    expect(t.ap.get("w")).toMatchObject({ state: "paused", why: "12 turns went by without finishing a step" });
    expect(t.calls("sendPrompt")).toHaveLength(11);
  });

  it("gives one summary of every run when the user comes back, what needs them first", async () => {
    const t = setup({
      phase: "working",
      reviews: [verdict({ decisions: [{ question: "Retry count?", decision: "3", why: "The plan's default." }] })],
    });
    const left = 10_000_100_000;
    t.setClock(left);
    await start(t, { notifyDecisions: false });
    await t.ap.start({ instanceId: "v", threadId: "t2", planPath: "C:/src/p/plan.md" });
    t.turnEnds();
    await flush();
    expect(t.calls("alertUser")).toEqual([]);
    t.s2.phase = "done";
    t.port.phase("v", "done", "working");
    await flush();
    t.setClock(left + 8 * 3600_000);
    for (const cb of t.port.back) cb(left);
    const summary = last(t.told);
    expect(summary).toContain("The user is back after 8 hour(s) away.");
    // Both ran; neither needs the user, so it's a report.
    expect(summary).toContain('"workbench" (session w): 1 step(s) done while away (A1); still running, on A2.');
    expect(summary).toContain("1. [A1] Retry count? → 3 (The plan's default)");
    expect(summary).toContain('"voice" (session v)');
    expect(last(t.levels)).toBe("report");
    // Told once.
    const n = t.told.length;
    for (const cb of t.port.back) cb(left + 8 * 3600_000);
    expect(t.told).toHaveLength(n);

    // A run paused on a question leads, and makes it needs_you.
    const u = setup({ reviews: [verdict({ verdict: "needs_you", question: "SQLite or Postgres?" })] });
    const since = 10_000_100_000;
    u.setClock(since);
    await start(u);
    await flush();
    await u.ap.start({ instanceId: "v", threadId: "t2", planPath: "C:/src/p/plan.md" });
    for (const cb of u.port.back) cb(since);
    const lines = last(u.told).split("\n");
    expect(lines[1]).toContain('"workbench" (session w): no step finished while away; paused');
    expect(lines[1]).toContain("Its question: SQLite or Postgres?");
    expect(lines[2]).toContain('"voice" (session v)');
    expect(last(u.levels)).toBe("needs_you");
  });

  it("stops when the session ends, and pauses a run the app quit during", async () => {
    const t = setup({ phase: "working" });
    await start(t);
    t.port.phase("w", "ended", "working");
    expect(t.ap.get("w")).toMatchObject({ state: "stopped", why: "the session ended" });

    const running = { ...t.stored.get("w")!, state: "running" as const };
    const old = { ...running, instanceId: "gone", state: "stopped" as const, created: 0, log: [] };
    const waiting = { ...running, instanceId: "v", state: "paused" as const, resumeAt: 1, why: "the 5-hour limit…" };
    const u = setup({ stored: [running, old, waiting] });
    await u.ap.load();
    expect(u.ap.get("w")).toMatchObject({ state: "paused", why: "Workbench restarted" });
    expect(u.ap.get("v")).toMatchObject({ state: "paused", why: "Workbench restarted", resumeAt: null });
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

/** Local time on 2026-10-21. */
const at = (h: number, m = 0, day = 21) => new Date(2026, 9, day, h, m).getTime();

describe("unattended runs (P2)", () => {
  it("detects the checklist from the plan's format", () => {
    expect(detectChecklist(PLAN)).toEqual([
      'the step\'s work is done as the plan describes it, and its "Done when" is met where it can be checked from here',
      "the tests were run and reported passing (or the step has nothing to test)",
      "the step is ticked in the plan's progress tracker",
    ]);
    expect(detectChecklist("# Plan\n- [ ] one\n\nAppend an As built note and commit each step.")).toEqual([
      "the step's work is done as the plan describes it",
      "the tests were run and reported passing (or the step has nothing to test)",
      "the step's checkbox in the plan is ticked",
      "an As built note is appended to the step in the plan",
      "the work is committed",
    ]);
  });

  it("reads windows, times, stalls and limits", () => {
    const night = { from: 22 * 60, to: 7 * 60 };
    expect(inWindow(night, at(23))).toBe(true);
    expect(inWindow(night, at(6, 59))).toBe(true);
    expect(inWindow(night, at(7))).toBe(false);
    expect(inWindow({ from: 9 * 60, to: 18 * 60 }, at(12))).toBe(true);
    expect(nextAt(22 * 60, at(20))).toBe(at(22));
    expect(nextAt(7 * 60, at(20))).toBe(at(7, 0, 22));
    expect(stallAfter([])).toBe(45 * 60_000);
    expect(stallAfter([10 * 60_000, 20 * 60_000, 30 * 60_000])).toBe(60 * 60_000);
    expect(stallAfter([60_000, 60_000])).toBe(10 * 60_000);
    const resets = at(14, 20) / 1000;
    expect(overLimits({ fiveHour: { usedPercentage: 93, resetsAt: resets }, sevenDay: null, receivedAt: 0 }, at(12))).toEqual({
      why: "the 5-hour limit is at 93%",
      until: at(14, 21),
    });
    // Under the line, or past its reset (the snapshot is old), it doesn't stop a run.
    expect(overLimits({ fiveHour: { usedPercentage: 80, resetsAt: resets }, sevenDay: null, receivedAt: 0 }, at(12))).toBeNull();
    expect(overLimits({ fiveHour: { usedPercentage: 99, resetsAt: resets }, sevenDay: null, receivedAt: 0 }, at(15))).toBeNull();
  });

  it("runs until the plan is done, past its step limit", async () => {
    const t = setup();
    await start(t, { maxSteps: 1, untilDone: true });
    await flush();
    t.turnEnds();
    await flush();
    expect(t.ap.get("w")).toMatchObject({ state: "running", stepsDone: 2 });
    expect(t.calls("sendPrompt")).toHaveLength(2);
    expect(t.port.badges.get("w")?.text).toBe("step 3 (A2) · working");
  });

  it("waits for its window, runs in it, and stops at its end", async () => {
    const t = setup({ at: at(20) });
    await start(t, { window: { from: 22 * 60, to: 7 * 60 } });
    await flush();
    expect(t.ap.get("w")).toMatchObject({ state: "paused", why: "waiting for its window, from 22:00", resumeAt: at(22) });
    expect(t.asked).toHaveLength(0);
    await t.tick(at(21, 59));
    expect(t.ap.get("w")?.state).toBe("paused");
    await t.tick(at(22, 1));
    expect(t.ap.get("w")?.state).toBe("running");
    expect(t.calls("sendPrompt")).toEqual([["w", "continue the implementation"]]);
    expect(t.port.badges.get("w")?.text).toContain("· until Thu 07:00");

    t.setClock(at(7, 5, 22));
    t.turnEnds();
    await flush();
    expect(t.ap.get("w")).toMatchObject({ state: "stopped", why: "its window ended at 07:00", stepsDone: 2 });
    expect(t.calls("sendPrompt")).toHaveLength(1);
    expect(last(t.told)).toContain("stopped after 2 step(s): its window ended at 07:00");
  });

  it("stops at its end time", async () => {
    const t = setup({ at: at(12) });
    await expect(start(t, { endsAt: at(11) })).rejects.toThrow("has passed");
    await start(t, { endsAt: at(18) });
    await flush();
    t.setClock(at(18, 30));
    t.turnEnds();
    await flush();
    expect(t.ap.get("w")).toMatchObject({ state: "stopped", why: "it ran until 18:00" });
  });

  it("pauses near a limit and carries on by itself after the reset", async () => {
    const t = setup({
      at: at(12),
      data: { limits: { fiveHour: { usedPercentage: 95, resetsAt: at(14, 20) / 1000 }, sevenDay: null, receivedAt: 0 } },
    });
    await start(t);
    await flush();
    expect(t.ap.get("w")).toMatchObject({ state: "paused", why: "the 5-hour limit is at 95%; resuming at 14:21", resumeAt: at(14, 21) });
    expect(t.calls("compactSession")).toEqual([]);
    expect(t.calls("sendPrompt")).toEqual([]);
    expect(last(t.levels)).toBe("info");
    expect(t.calls("alertUser")).toEqual([]);
    await t.tick(at(14));
    expect(t.calls("sendPrompt")).toEqual([]);
    // The snapshot still says 95%, but its reset has passed.
    await t.tick(at(14, 22));
    expect(t.asked).toHaveLength(1);
    expect(t.calls("compactSession")).toEqual([["w", "keep the plan path"]]);
    expect(t.calls("sendPrompt")).toEqual([["w", "continue the implementation"]]);
    expect(t.ap.get("w")).toMatchObject({ state: "running", held: null, stepsDone: 1 });
    // The step is in the log once.
    expect(t.ap.get("w")?.log.filter((e) => e.finished)).toHaveLength(1);
  });

  it("pauses when the same step fails twice", async () => {
    const t = setup({
      reviews: [
        verdict({ finished: false, failed: true, stepId: "A2", nextStepId: "A2", compact: false, nextPrompt: "fix the two failing tests" }),
        verdict({ finished: false, failed: true, stepId: "A2", nextStepId: "A2", compact: false }),
      ],
    });
    await start(t);
    await flush();
    expect(t.calls("sendPrompt")).toEqual([["w", "fix the two failing tests"]]);
    t.turnEnds();
    await flush();
    expect(t.ap.get("w")).toMatchObject({ state: "paused", why: "A2 failed twice in a row" });
    expect(t.calls("sendPrompt")).toHaveLength(1);
  });

  it("sends a missed checklist item back once, then lets the step through", async () => {
    const t = setup({
      reviews: [
        verdict({ missed: ["tick A1 in the progress tracker"], nextPrompt: null }),
        verdict({ missed: ["tick A1 in the progress tracker"] }),
      ],
    });
    await start(t, { situational: false });
    await flush();
    expect(t.calls("compactSession")).toEqual([]);
    expect(t.calls("sendPrompt")).toEqual([["w", "Before going on from A1: tick A1 in the progress tracker. Then proceed to the next step."]]);
    expect(t.ap.get("w")).toMatchObject({ stepsDone: 0, step: "A1", fixedUp: "A1" });
    expect(t.asked[0].input).toContain("- the step is ticked in the plan's progress tracker");
    t.turnEnds();
    await flush();
    expect(t.ap.get("w")).toMatchObject({ stepsDone: 1, state: "running" });
    expect(last(t.notices)).toContain("Still missing: tick A1 in the progress tracker.");
  });

  it("checks on a turn far past the usual, and pauses when it's stuck", async () => {
    const t = setup({
      at: at(9),
      stalls: [
        { stuck: false, summary: "Running the full test suite.", why: "Steady progress." },
        { stuck: true, summary: "Retrying the same failing build.", why: "The same error four times." },
      ],
    });
    await start(t);
    await flush();
    // Two turns of 10 minutes each.
    for (const end of [at(9, 10), at(9, 20)]) {
      t.setClock(end);
      t.turnEnds();
      await flush();
    }
    expect(t.ap.get("w")?.turnTimes).toHaveLength(2);
    // The third has run 25 minutes: under 3× the median (30).
    await t.tick(at(9, 45));
    expect(t.asked.filter((a) => a.purpose === "autopilot-stall")).toHaveLength(0);
    await t.tick(at(9, 51));
    expect(t.asked.filter((a) => a.purpose === "autopilot-stall")).toHaveLength(1);
    expect(t.ap.get("w")?.state).toBe("running");
    expect(last(t.notices)).toContain("Still going after 31 min: Running the full test suite.");
    // Looked at again when it has run twice as long.
    await t.tick(at(10, 20));
    expect(t.asked.filter((a) => a.purpose === "autopilot-stall")).toHaveLength(1);
    await t.tick(at(10, 23));
    expect(t.ap.get("w")).toMatchObject({ state: "paused" });
    expect(t.ap.get("w")?.why).toContain("the turn has run 63 minutes, far longer than usual, and looks stuck (The same error four times)");
    expect(last(t.calls("alertUser"))[1]).toBe("Autopilot paused");
    expect(t.calls("sendPrompt")).toHaveLength(3);
  });

  it("runs several sessions at once, each on its own", async () => {
    const t = setup({ reviews: [verdict(), verdict({ verdict: "needs_you", question: "Which voice?" })] });
    await start(t);
    await t.ap.start({ instanceId: "v", threadId: "t2", planPath: "C:/src/p/plan.md" });
    await flush();
    t.s2.phase = "done";
    t.port.phase("v", "done", "working");
    await flush();
    expect(t.ap.get("w")).toMatchObject({ state: "running", stepsDone: 1 });
    expect(t.ap.get("v")).toMatchObject({ state: "paused", question: "Which voice?" });
    expect(t.ap.list()).toHaveLength(2);
  });
});
