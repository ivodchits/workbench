import { describe, expect, it } from "vitest";

import type { TaskResultFiles } from "../ipc/assistant";
import { fakePort, project, session, toolCtx, type FakePort } from "./fakePort.test-util";
import { DEFAULT_SETTINGS, type DuckSettings } from "./settings";
import type { ApiWorkerOutcome } from "./apiWorker";
import { createTaskManager, NUDGE, type RunRequest, type Task, type TaskBackend, type TaskDeps } from "./tasks";
import type { ChoiceRef } from "./port";
import { answerChoice } from "./tools/act";
import { createRegistry } from "./tools/registry";
import { listTasks, runTask, taskClose, taskFollowup, taskStatus } from "./tools/tasks";

const WS = "C:\\Users\\me\\repos\\Duck";

function memBackend() {
  const files = new Map<string, TaskResultFiles>();
  const stored = new Map<string, Task>();
  const briefs: { title: string; brief: string }[] = [];
  let n = 0;
  const backend: TaskBackend = {
    prepare: (dir) => Promise.resolve(dir ?? WS),
    newFolder: (ws, date, title, brief) => {
      briefs.push({ title, brief });
      return Promise.resolve(`${ws}\\tasks\\${date}-t${++n}`);
    },
    result: (_ws, folder) => Promise.resolve(files.get(folder) ?? { json: null, jsonModified: null, md: null }),
    writeResult: (_ws, folder, md, json) => {
      files.set(folder, { json, jsonModified: Date.now(), md });
      return Promise.resolve();
    },
    put: (t) => {
      stored.set(t.id, structuredClone(t));
      return Promise.resolve();
    },
    list: () => Promise.resolve([...stored.values()]),
  };
  return { backend, files, stored, briefs };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(opts: { settings?: Partial<DuckSettings>; port?: FakePort; apiWorker?: TaskDeps["apiWorker"] } = {}) {
  const port =
    opts.port ??
    fakePort({
      projects: [project({ id: "app" }), project({ id: "far", remote: true })],
    });
  const mem = memBackend();
  let clock = 1_000_000;
  let ids = 0;
  const told: { threadId: string; text: string }[] = [];
  const tasks = createTaskManager({
    port,
    backend: mem.backend,
    settings: () => ({ ...DEFAULT_SETTINGS, ...opts.settings }),
    tell: (threadId, text) => told.push({ threadId, text }),
    now: () => clock,
    newId: () => `task${++ids}xxxx`,
    today: () => "2026-10-20",
    apiWorker: opts.apiWorker,
  });
  const advance = (ms: number) => (clock += ms);
  /** The worker wrote its result files now. */
  const write = (t: Task, json: unknown) =>
    mem.files.set(t.folder, {
      json: typeof json === "string" ? json : JSON.stringify(json),
      jsonModified: clock,
      md: "# result",
    });
  return { port, tasks, mem, told, advance, write, now: () => clock };
}

const req = (r: Partial<RunRequest> = {}): RunRequest => ({
  threadId: "th1",
  title: "Tauri auto-update",
  brief: "Find how other Tauri apps do auto-update and recommend one.",
  kind: "research",
  tier: "standard",
  mandate: { text: "research how other Tauri apps do auto-update", threadId: "th1" },
  ...r,
});

describe("subscription limits (D2)", () => {
  const limits = (fiveHour: number, sevenDay: number) => ({
    fiveHour: { usedPercentage: fiveHour, resetsAt: 2_000 },
    sevenDay: { usedPercentage: sevenDay, resetsAt: 9_000 },
    receivedAt: 1,
  });
  const spend = (soft: boolean) =>
    ({ todayUsd: 1, monthUsd: 50, byModel: [], byPurpose: [], limits: {}, softReached: soft, capReached: false }) as never;
  const outcome: ApiWorkerOutcome = {
    result: { status: "done", headline: "Use the Tauri updater plugin.", question: null, markdown: "# Use the plugin\n\nBecause." },
    costUsd: 0.18,
  };

  it("runs an API worker over the weekly limit, with the same result files and its cost", async () => {
    const briefs: string[] = [];
    const port = fakePort({ projects: [project({ id: "app" })], limits: limits(20, 85), spend: spend(false) });
    const { tasks, mem, told } = setup({
      port,
      apiWorker: async (_t, brief, _signal, onCost) => {
        briefs.push(brief);
        onCost(0.05);
        return outcome;
      },
    });
    const t = await tasks.run(req());
    await settle();
    expect(port.calls.some((c) => c.name === "createSession")).toBe(false);
    expect(briefs).toEqual([req().brief]);
    expect(tasks.get(t.id)).toMatchObject({
      state: "done",
      runner: "api",
      why: "over subscription limit: the weekly limit is at 85%",
      costUsd: 0.18,
      headline: "Use the Tauri updater plugin.",
      resultFrom: "file",
    });
    expect(JSON.parse(mem.files.get(t.folder)!.json!)).toEqual({ status: "done", headline: "Use the Tauri updater plugin.", question: null });
    expect(mem.files.get(t.folder)!.md).toContain("# Use the plugin");
    expect(told[told.length - 1].text).toMatch(/is done\. .* It ran on the API \(over subscription limit: the weekly limit is at 85%\), costing \$0\.18\.$/);
  });

  it("runs a session under the limits", async () => {
    const port = fakePort({ projects: [project({ id: "app" })], limits: limits(69, 79) });
    const { tasks } = setup({ port, apiWorker: () => Promise.reject(new Error("not this")) });
    const t = await tasks.run(req());
    expect(t).toMatchObject({ runner: "session", why: null, state: "running" });
  });

  it("keeps a code task in a session, and says why", async () => {
    const port = fakePort({ projects: [project({ id: "app" })], limits: limits(75, 10) });
    const { tasks, told } = setup({ port });
    const t = await tasks.run(req({ kind: "code", projectId: "app" }));
    expect(t).toMatchObject({ runner: "session", why: "the 5-hour limit is at 75%", state: "running" });
    expect(told[0].text).toMatch(/code task, so it runs in a session although the 5-hour limit is at 75%/);
  });

  it("waits when Duck's API budget is past its soft limit too", async () => {
    const port = fakePort({ projects: [project({ id: "app" })], limits: limits(90, 10), spend: spend(true) });
    const { tasks, told } = setup({ port, apiWorker: () => Promise.reject(new Error("not this")) });
    const t = await tasks.run(req());
    expect(t).toMatchObject({ state: "queued", why: expect.stringContaining("past its soft limit") });
    expect(t.notBefore).toBeGreaterThan(1_000_000);
    expect(told).toHaveLength(1);
    expect(told[0].text).toMatch(/is waiting: the 5-hour limit is at 90%/);
    tasks.dispose();
  });

  it("keeps prep waiting over the limits rather than on the API, even with budget left", async () => {
    const port = fakePort({ projects: [project({ id: "app" })], limits: limits(20, 85), spend: spend(false) });
    const { tasks, told } = setup({ port, apiWorker: () => Promise.reject(new Error("not this")) });
    const t = await tasks.run(req({ kind: "writing", prep: true }));
    expect(t).toMatchObject({ state: "queued", prep: true, why: expect.stringContaining("prep waits for room") });
    expect(port.calls.some((c) => c.name === "createSession")).toBe(false);
    expect(told[0].text).toMatch(/is waiting: the weekly limit is at 85%/);
    tasks.dispose();
  });

  it("re-runs an API task's follow-up with its previous result", async () => {
    const briefs: string[] = [];
    const port = fakePort({ projects: [project({ id: "app" })], limits: limits(20, 85), spend: spend(false) });
    const { tasks } = setup({
      port,
      apiWorker: async (_t, brief) => {
        briefs.push(brief);
        return outcome;
      },
    });
    const t = await tasks.run(req());
    await settle();
    expect(await tasks.followup(t.id, "Dig into the signing step.")).toBe("sent");
    await settle();
    expect(briefs[1]).toContain("## Your previous result\n\n# Use the plugin");
    expect(briefs[1]).toContain("## Follow-up\n\nDig into the signing step.");
    expect(tasks.get(t.id)).toMatchObject({ state: "done", costUsd: 0.36 });
  });

  it("re-runs a task one tier up as a new task, closing the old one", async () => {
    const { tasks } = setup();
    const t = await tasks.run(req());
    const next = await tasks.rerun(t.id);
    expect(next).toMatchObject({ tier: "involved", effort: "high", brief: req().brief, title: t.title });
    expect(next.id).not.toBe(t.id);
    expect(tasks.get(t.id)?.state).toBe("closed");
  });
});

describe("run", () => {
  it("writes the brief and starts a worker in Duck's workspace on the tier's model", async () => {
    const { port, tasks, mem } = setup();
    const t = await tasks.run(req());
    expect(t).toMatchObject({ state: "running", model: "sonnet", effort: "medium", instanceId: "new-1" });
    expect(mem.briefs[0].brief).toContain("# Tauri auto-update");
    expect(mem.briefs[0].brief).toContain("research · standard");
    const create = port.calls.find((c) => c.name === "createSession")!.args[0] as Record<string, unknown>;
    expect(create).toMatchObject({
      projectId: "p-duck",
      title: "Tauri auto-update",
      model: "sonnet",
      worktree: false,
      trustFolder: true,
      headless: true,
      worker: { workspace: WS, folder: t.folder, effort: "medium", kind: "research" },
      mandate: { text: "research how other Tauri apps do auto-update", threadId: "th1" },
    });
    expect(create.prompt).toContain(`${t.folder}\\brief.md`);
    expect(create.prompt).toContain("result.json");
    expect(port.calls.some((c) => c.name === "ensureProject" && c.args[1] === WS)).toBe(true);
    expect(port.calls.find((c) => c.name === "setDuckTask")?.args).toEqual(["new-1", "Tauri auto-update"]);
    // Stored as it changed.
    expect(mem.stored.get(t.id)?.state).toBe("running");
  });

  it("takes the tier from settings, and an explicit model or effort over it", async () => {
    const { tasks } = setup({ settings: { tiers: { ...DEFAULT_SETTINGS.tiers, involved: { model: "opus", effort: "high" } } } });
    expect(await tasks.run(req({ tier: "involved" }))).toMatchObject({ model: "opus", effort: "high" });
    expect(await tasks.run(req({ tier: "serious", effort: "low" }))).toMatchObject({ model: "opus", effort: "low" });
  });

  it("starts a code task in the project's worktree, never a remote one", async () => {
    const { port, tasks } = setup();
    await expect(tasks.run(req({ kind: "code" }))).rejects.toThrow("needs the project");
    await expect(tasks.run(req({ kind: "code", projectId: "far" }))).rejects.toThrow("remote project");
    const t = await tasks.run(req({ kind: "code", projectId: "app", tier: "serious" }));
    const create = port.calls.find((c) => c.name === "createSession")!.args[0] as Record<string, unknown>;
    expect(create).toMatchObject({ projectId: "app", worktree: true, trustFolder: false, model: "opus" });
    expect(t.projectId).toBe("app");
  });

  it("fails a task whose session can't start, and says so", async () => {
    const { port, tasks, told } = setup();
    port.createSession = () => Promise.reject(new Error("claude not found"));
    const t = await tasks.run(req());
    expect(t).toMatchObject({ state: "failed", error: "It couldn't start: claude not found" });
    expect(told[0].text).toContain("failed");
  });
});

describe("a worker's turn ends", () => {
  it("reads a fresh result.json and reports its headline", async () => {
    const { port, tasks, told, write, advance } = setup();
    const t = await tasks.run(req());
    advance(60_000);
    write(t, { status: "done", headline: "Use the official updater plugin.", question: null });
    port.phase("new-1", "done", "working");
    await settle();
    expect(tasks.get(t.id)).toMatchObject({ state: "done", headline: "Use the official updater plugin.", resultFrom: "file", finished: t.started! + 60_000 });
    expect(told).toEqual([{ threadId: "th1", text: expect.stringContaining("Headline: Use the official updater plugin.") }]);
  });

  it("carries blocked and needs_decision through", async () => {
    const { port, tasks, told, write } = setup();
    const t = await tasks.run(req());
    write(t, { status: "needs_decision", headline: "Two good options.", question: "Signed or unsigned builds?" });
    port.phase("new-1", "done");
    await settle();
    expect(tasks.get(t.id)).toMatchObject({ state: "needs_decision", question: "Signed or unsigned builds?" });
    expect(told[0].text).toContain("Signed or unsigned builds?");
  });

  it("nudges once without a result, then takes the last reply", async () => {
    const { port, tasks, told } = setup();
    const t = await tasks.run(req());
    port.phase("new-1", "done");
    await settle();
    expect(port.calls.filter((c) => c.name === "sendPrompt").map((c) => c.args)).toEqual([["new-1", NUDGE]]);
    expect(tasks.get(t.id)?.state).toBe("running");
    (port as unknown as { lastResponse: (id: string) => Promise<string> }).lastResponse = () =>
      Promise.resolve("## Recommendation\nUse tauri-plugin-updater with GitHub releases.\n\nMore…");
    port.phase("new-1", "done");
    await settle();
    expect(tasks.get(t.id)).toMatchObject({
      state: "done",
      resultFrom: "reply",
      headline: "Recommendation",
    });
    expect(told[0].text).toContain("without its result files");
  });

  it("ignores a result file from an earlier run, and an invalid one", async () => {
    const { port, tasks, write, advance, mem } = setup();
    const t = await tasks.run(req());
    write(t, { status: "done", headline: "old" });
    mem.files.get(t.folder)!.jsonModified = t.runStarted! - 60_000;
    port.phase("new-1", "done");
    await settle();
    expect(tasks.get(t.id)).toMatchObject({ state: "running", nudged: true });
    advance(1000);
    write(t, "{ not json");
    port.phase("new-1", "done");
    await settle();
    // No reply either: failed.
    expect(tasks.get(t.id)).toMatchObject({ state: "failed", error: "It wrote no result and no reply." });
  });

  it("fails a task whose session ended without a result", async () => {
    const { port, tasks } = setup();
    const t = await tasks.run(req());
    port.phase("new-1", "ended");
    await settle();
    expect(tasks.get(t.id)).toMatchObject({ state: "failed", error: "Its session ended before it wrote a result." });
    expect(port.calls.some((c) => c.name === "sendPrompt")).toBe(false);
  });

  it("tells the thread once per prompt a worker waits on", async () => {
    const { port, tasks, told } = setup();
    await tasks.run(req());
    port.phase("new-1", "needs_you");
    port.phase("new-1", "needs_you");
    expect(told).toHaveLength(1);
    expect(told[0].text).toContain("is waiting on");
  });
});

describe("Duck as the worker's user (D2)", () => {
  const question: ChoiceRef = {
    id: "q1",
    kind: "question",
    toolName: "AskUserQuestion",
    input: {},
    at: 1,
    questions: [{ header: "DB", question: "Which database?", multiSelect: false, options: [] }],
    options: [
      { key: 1, label: "Postgres", detail: "relational", typed: false },
      { key: 2, label: "SQLite", detail: "", typed: false },
    ],
    terminalOnly: null,
    sent: null,
    optionsFrom: "hook",
    held: false,
  };

  it("asks Duck to answer a worker's question itself, and records the answer with its reason", async () => {
    const { port, tasks, told } = setup();
    const t = await tasks.run(req());
    port.setChoice("new-1", question);
    port.phase("new-1", "needs_you");
    expect(told[0].text).toMatch(/asks: Which database\? Options: 1\. Postgres \(relational\); 2\. SQLite\. You are its user/);
    expect(told[0].text).toContain("choiceId q1");

    // As its user, Duck answers without a card.
    const r = createRegistry([answerChoice]);
    const input = { session: "new-1", choiceId: "q1", option: 1, reason: "you said earlier you want Postgres" };
    expect(r.callTier("answer_choice", input, port)).toBe("reversible");
    await answerChoice.run(input as never, { ...toolCtx(port), tasks, prepared: undefined });
    expect(port.calls.find((c) => c.name === "answerChoice")?.args).toEqual(["new-1", "q1", 1]);
    expect(tasks.get(t.id)?.answers).toEqual([
      { question: "Which database?", answer: "Postgres", reason: "you said earlier you want Postgres", at: expect.any(Number) },
    ]);
  });

  it("keeps a question in a session of the user's on a card", () => {
    const port = fakePort({
      projects: [project({ id: "app" })],
      sessions: [session({ id: "s1", projectId: "app", phase: "needs_you", choice: question })],
    });
    const r = createRegistry([answerChoice]);
    expect(r.callTier("answer_choice", { session: "s1", choiceId: "q1", option: 1 }, port)).toBe("consequential");
  });

  it("points a question it can't answer from the app, and a plan, back to the console", async () => {
    const { port, tasks, told } = setup();
    await tasks.run(req());
    port.setChoice("new-1", { ...question, terminalOnly: "several questions are answered one after another" });
    port.phase("new-1", "needs_you");
    expect(told[0].text).toMatch(/can only be answered in its console \(several questions/);
    port.setChoice("new-1", { ...question, id: "p1", kind: "plan" });
    port.phase("new-1", "needs_you");
    expect(told[1].text).toContain("Plan approvals in workers are the user's.");
  });
});

describe("the queue", () => {
  it("runs at most maxWorkers at once, and starts the next when one ends", async () => {
    const { port, tasks, write } = setup({ settings: { maxWorkers: 2 } });
    const a = await tasks.run(req({ title: "a" }));
    await tasks.run(req({ title: "b" }));
    const c = await tasks.run(req({ title: "c" }));
    expect(tasks.list().map((t) => [t.title, t.state])).toEqual([
      ["c", "queued"],
      ["b", "running"],
      ["a", "running"],
    ]);
    expect(c.instanceId).toBeNull();
    write(a, { status: "done", headline: "a done" });
    port.phase(a.instanceId!, "done");
    await settle();
    expect(tasks.get(c.id)).toMatchObject({ state: "running", instanceId: "new-3" });
  });

  it("starts tasks asked for together side by side, the Duck project made once", async () => {
    const { port, tasks } = setup({ settings: { maxWorkers: 2 } });
    const [a, b, c] = await Promise.all([
      tasks.run(req({ title: "a" })),
      tasks.run(req({ title: "b" })),
      tasks.run(req({ title: "c" })),
    ]);
    expect([a.state, b.state, c.state]).toEqual(["running", "running", "queued"]);
    expect([a.instanceId, b.instanceId]).toEqual(["new-1", "new-2"]);
    expect(port.calls.filter((x) => x.name === "ensureProject")).toHaveLength(1);
  });

  it("frees a slot when a running task is closed, and a queued one never starts", async () => {
    const { port, tasks } = setup({ settings: { maxWorkers: 1 } });
    const a = await tasks.run(req({ title: "a" }));
    const b = await tasks.run(req({ title: "b" }));
    const c = await tasks.run(req({ title: "c" }));
    await tasks.close(c.id);
    expect(tasks.get(c.id)?.state).toBe("closed");
    port.listSessions().find((s) => s.id === a.instanceId)!.phase = "working";
    await tasks.close(a.id);
    await settle();
    expect(port.calls.filter((c) => c.name === "stopSession").map((c) => c.args)).toEqual([[a.instanceId]]);
    expect(port.calls.filter((c) => c.name === "setDuckTask").slice(-2)[0]?.args).toEqual([a.instanceId, null]);
    expect(tasks.get(b.id)?.state).toBe("running");
    expect(tasks.get(c.id)?.instanceId).toBeNull();
  });
});

describe("follow-ups", () => {
  it("go into the same session and wait for a newer result", async () => {
    const { port, tasks, write, advance } = setup();
    const t = await tasks.run(req());
    write(t, { status: "done", headline: "first" });
    port.phase("new-1", "done");
    await settle();
    advance(5000);
    await tasks.followup(t.id, "Dig into option 2");
    const sent = port.calls.filter((c) => c.name === "sendPrompt").slice(-1)[0].args;
    expect(sent[0]).toBe("new-1");
    expect(sent[1]).toContain("Dig into option 2");
    expect(sent[1]).toContain(`${t.folder}\\brief.md`);
    expect(tasks.get(t.id)).toMatchObject({ state: "running", finished: null });
    // The first run's file doesn't count: a nudge.
    port.phase("new-1", "done");
    await settle();
    expect(port.calls.filter((c) => c.name === "sendPrompt").slice(-1)[0].args[1]).toBe(NUDGE);
    advance(1000);
    write(t, { status: "done", headline: "option 2 wins" });
    port.phase("new-1", "done");
    await settle();
    expect(tasks.get(t.id)).toMatchObject({ state: "done", headline: "option 2 wins" });
  });

  it("are refused before the task started", async () => {
    const { tasks } = setup({ settings: { maxWorkers: 1 } });
    await tasks.run(req());
    const queued = await tasks.run(req({ title: "later" }));
    await expect(tasks.followup(queued.id, "x")).rejects.toThrow("waiting for a free worker");
  });
});

describe("load", () => {
  it("settles tasks that were running when the app closed, and starts queued ones", async () => {
    const first = setup();
    const done = await first.tasks.run(req({ title: "done" }));
    const lost = await first.tasks.run(req({ title: "lost" }));
    first.write(done, { status: "done", headline: "it finished meanwhile" });
    first.tasks.dispose();
    const queued: Task = { ...lost, id: "q1", title: "queued", state: "queued", instanceId: null, started: null, runStarted: null, created: lost.created + 1 };
    first.mem.stored.set("q1", queued);

    // A new run of the app over the same records and files.
    const port = fakePort({ projects: [project({ id: "app" })], sessions: [session({ id: "new-1", projectId: "p-duck", phase: "offline" })] });
    const told: string[] = [];
    const tasks = createTaskManager({
      port,
      backend: first.mem.backend,
      settings: () => DEFAULT_SETTINGS,
      tell: (_th, text) => told.push(text),
      now: first.now,
    });
    await tasks.load();
    expect(tasks.get(done.id)).toMatchObject({ state: "done", headline: "it finished meanwhile" });
    expect(tasks.get(lost.id)).toMatchObject({ state: "failed" });
    expect(tasks.get(lost.id)?.error).toContain("Workbench closed while it ran");
    expect(tasks.get("q1")?.state).toBe("running");
    expect(told).toHaveLength(2);
    // Its worker is still marked as Duck's, and headless for its next launch.
    expect(port.calls.some((c) => c.name === "setDuckTask" && c.args[0] === "new-1")).toBe(true);
    expect(port.calls.some((c) => c.name === "setHeadless" && c.args[0] === "new-1" && c.args[1] === true)).toBe(true);
  });

  it("runs a worker in a terminal when headless workers are off, and closing hands a headless one back as a terminal", async () => {
    const off = setup({ settings: { headlessWorkers: false } });
    const a = await off.tasks.run(req());
    expect(a.headless).toBe(false);
    expect(off.port.calls.find((c) => c.name === "createSession")?.args[0]).toMatchObject({ headless: false });

    const on = setup();
    const b = await on.tasks.run(req());
    expect(b.headless).toBe(true);
    await on.tasks.close(b.id);
    expect(on.port.calls.find((c) => c.name === "setHeadless")?.args).toEqual(["new-1", false]);
  });
});

describe("the tools", () => {
  it("run_task shows a card and says what comes next", async () => {
    const { port, tasks } = setup({ settings: { maxWorkers: 1 } });
    const ctx = { ...toolCtx(port), tasks, request: "research tauri updates" };
    const r = (await runTask.run({ title: "a", brief: "b", kind: "research", tier: "standard" }, ctx)) as Record<string, unknown>;
    expect(r).toMatchObject({ state: "running", worker: "sonnet · medium (standard)" });
    expect(ctx.notices).toEqual([{ kind: "task", text: "Task: a", task: { id: r.id } }]);
    const q = (await runTask.run({ title: "b", brief: "b", kind: "writing", tier: "serious" }, ctx)) as Record<string, unknown>;
    expect(q.next).toContain("waiting for a free worker");
    await expect(runTask.run({ title: "c", brief: "b", kind: "code", tier: "serious" }, ctx)).rejects.toThrow("needs `project`");
    expect(tasks.get(r.id as string)?.mandate).toBe("research tauri updates");
  });

  it("list_tasks, task_status, task_followup and task_close find tasks by id or title", async () => {
    const { port, tasks } = setup({ settings: { maxWorkers: 1 } });
    const ctx = { ...toolCtx(port), tasks };
    const a = await tasks.run(req({ title: "Alpha" }));
    await tasks.run(req({ title: "Beta" }));
    const open = (await listTasks.run({ state: "open", limit: 15 }, ctx)) as { tasks: { title: string }[] };
    expect(open.tasks.map((t) => t.title)).toEqual(["Beta", "Alpha"]);
    (port as unknown as { lastResponse: () => Promise<string> }).lastResponse = () => Promise.resolve("Reading the docs of three apps.");
    const s = (await taskStatus.run({ task: "alpha", progress: true }, ctx)) as Record<string, unknown>;
    expect(s).toMatchObject({ id: a.id, state: "running", latestReply: "Reading the docs of three apps." });
    const f = (await taskFollowup.run({ task: a.id, prompt: "also check Electron" }, ctx)) as Record<string, unknown>;
    expect(f.delivery).toBe("sent");
    expect(await taskClose.run({ task: "Beta" }, ctx)).toMatchObject({ state: "closed" });
    await expect(taskStatus.run({ task: "Gamma", progress: false }, ctx)).rejects.toThrow('no task "Gamma"');
    expect(() => listTasks.run({ limit: 5 }, toolCtx(port))).toThrow("aren't available");
  });
});

describe("tidying up finished tasks", () => {
  async function finished(status: "done" | "blocked" = "done", opts: Parameters<typeof setup>[0] = {}) {
    const t = setup(opts);
    const task = await t.tasks.run(req());
    const s = t.port.listSessions().find((x) => x.id === task.instanceId)!;
    s.phase = "done";
    t.write(task, { status, headline: "Use the plugin.", question: null });
    t.port.phase(s.id, "done", "working");
    await settle();
    expect(t.tasks.get(task.id)?.state).toBe(status);
    const calls = (name: string) => t.port.calls.filter((c) => c.name === name).map((c) => c.args);
    return { ...t, task, s, calls };
  }

  it("stops an idle worker, then closes the task and takes its session off the rail", async () => {
    const t = await finished();
    t.advance(29 * 60_000);
    await t.tasks.tidy();
    expect(t.calls("stopSession")).toEqual([]);
    t.advance(2 * 60_000);
    await t.tasks.tidy();
    expect(t.calls("stopSession")).toEqual([[t.s.id]]);
    t.s.phase = "offline";
    await t.tasks.tidy();
    expect(t.calls("stopSession")).toHaveLength(1);

    t.advance(24 * 3_600_000);
    await t.tasks.tidy();
    expect(t.tasks.get(t.task.id)).toMatchObject({ state: "closed", headline: "Use the plugin." });
    expect(t.calls("killSession")).toEqual([[t.s.id]]);
    expect(t.port.listSessions().some((x) => x.id === t.s.id)).toBe(false);
    // Closed is done with: nothing more to tidy.
    t.advance(48 * 3_600_000);
    await t.tasks.tidy();
    expect(t.calls("killSession")).toHaveLength(1);
  });

  it("counts idle from the session's own activity, and waits for a turn to end", async () => {
    const t = await finished();
    t.advance(40 * 60_000);
    // You talked to it yourself ten minutes ago.
    t.s.lastActivity = Math.floor((t.now() - 10 * 60_000) / 1000);
    await t.tasks.tidy();
    expect(t.calls("stopSession")).toEqual([]);
    t.advance(25 * 60_000);
    t.s.phase = "working";
    await t.tasks.tidy();
    expect(t.calls("stopSession")).toEqual([]);
    t.s.phase = "done";
    await t.tasks.tidy();
    expect(t.calls("stopSession")).toEqual([[t.s.id]]);
  });

  it("leaves a task that waits on you, a session with a worktree on the rail, and the 'never' settings", async () => {
    const blocked = await finished("blocked");
    blocked.advance(100 * 3_600_000);
    await blocked.tasks.tidy();
    expect(blocked.calls("stopSession")).toEqual([]);
    expect(blocked.tasks.get(blocked.task.id)?.state).toBe("blocked");

    const tree = await finished();
    tree.s.worktreeBranch = "duck/task1";
    tree.advance(25 * 3_600_000);
    await tree.tasks.tidy();
    expect(tree.tasks.get(tree.task.id)?.state).toBe("closed");
    expect(tree.calls("killSession")).toEqual([]);

    const never = await finished("done", { settings: { workerIdleStopMinutes: 0, closeFinishedHours: 0 } });
    never.advance(100 * 3_600_000);
    await never.tasks.tidy();
    expect(never.calls("stopSession")).toEqual([]);
    expect(never.tasks.get(never.task.id)?.state).toBe("done");
  });
});


describe("the user's files (G1)", () => {
  const file = (name: string) => ({ id: `${name[0]}`.repeat(32), name, mime: "text/csv", size: 10 });

  function withFiles(limits?: unknown) {
    const port = fakePort({
      projects: [project({ id: "app" })],
      ...(limits ? { limits: limits as never, spend: { softReached: false, capReached: false } as never } : {}),
    });
    const mem = memBackend();
    const copied: { folder: string; names: string[] }[] = [];
    let outputs: ReturnType<typeof file>[] = [];
    mem.backend.inputs = async (_ws, folder, files) => {
      copied.push({ folder, names: files.map((f) => f.name) });
      return files.map((f) => f.name);
    };
    mem.backend.outputs = async () => outputs;
    const told: string[] = [];
    const posted: { threadId: string; names: string[]; title: string }[] = [];
    let clock = 1_000_000;
    const tasks = createTaskManager({
      port,
      backend: mem.backend,
      settings: () => DEFAULT_SETTINGS,
      tell: (_t, text) => told.push(text),
      files: (threadId, files, title) => posted.push({ threadId, names: files.map((f) => f.name), title }),
      now: () => clock,
      today: () => "2026-10-20",
      apiWorker: async () => {
        throw new Error("files never go to the API worker");
      },
    });
    const finishWith = (folder: string, made: ReturnType<typeof file>[]) => {
      outputs = made;
      clock += 1000;
      mem.files.set(folder, { json: JSON.stringify({ status: "done", headline: "Merged.", question: null }), jsonModified: clock, md: "# Merged" });
    };
    return { port, tasks, mem, copied, told, posted, finishWith };
  }

  it("copies them into inputs/, lists them in the brief, and posts what the worker made", async () => {
    const { port, tasks, mem, copied, told, posted, finishWith } = withFiles();
    const t = await tasks.run(req({ title: "Merge", kind: "analysis", files: [file("a.csv"), file("b.csv"), { ...file("a.csv"), id: "z".repeat(32) }] }));
    expect(copied).toEqual([{ folder: t.folder, names: ["a.csv", "b.csv", "a.csv"] }]);
    expect(t.inputs).toEqual(["a.csv", "b.csv", "a (2).csv"]);
    expect(mem.briefs[0].brief).toContain("In `inputs/` in this folder: `a.csv`, `b.csv`, `a (2).csv`.");
    const create = port.calls.find((c) => c.name === "createSession")!.args[0] as { prompt: string };
    expect(create.prompt).toContain(`${t.folder}\\outputs\\`);
    finishWith(t.folder, [{ id: "m".repeat(32), name: "merged.xlsx", mime: "application/vnd.ms-excel", size: 99 }]);
    port.phase("new-1", "done");
    await settle();
    expect(posted).toEqual([{ threadId: "th1", names: ["merged.xlsx"], title: "Merge" }]);
    expect(tasks.get(t.id)?.outputs.map((f) => f.name)).toEqual(["merged.xlsx"]);
    expect(told[told.length - 1]).toContain(`The files it made are in the thread for the user to open or drag out: attached: merged.xlsx (application/vnd.ms-excel, 99 B, id ${"m".repeat(32)})`);
  });

  it("runs in a session over the subscription's limits, since the API worker can't read them", async () => {
    const limits = { fiveHour: { usedPercentage: 90, resetsAt: 2_000 }, sevenDay: { usedPercentage: 10, resetsAt: 9_000 }, receivedAt: 1 };
    const { port, tasks, told } = withFiles(limits);
    const t = await tasks.run(req({ files: [file("a.csv")] }));
    expect(t.runner).toBe("session");
    expect(port.calls.some((c) => c.name === "createSession")).toBe(true);
    expect(told[0]).toContain("works on the user's files, so it runs in a session");
  });

  it("without a way to copy them, refuses", async () => {
    const { tasks } = setup();
    await expect(tasks.run(req({ files: [file("a.csv")] }))).rejects.toThrow("can't be given files");
  });
});
