import { describe, expect, it } from "vitest";

import type { ThreadRow } from "../ipc/assistant";
import type { BackupStatus, BranchReview, HousekeepReport, PushOutcome } from "../ipc/routines";
import type { Level } from "./announce";
import { createHousekeeping, idleThreads, localDate, type GitLane } from "./housekeeping";
import type { WorktreeChanges, WorkbenchPort } from "./port";
import { createRoutines, type Routine } from "./routines";
import { DEFAULT_SETTINGS } from "./settings";
import { Task, type RunRequest, type TaskManager } from "./tasks";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 25, 3).getTime();

const row = (id: string, daysIdle: number, extra: Partial<ThreadRow> = {}): ThreadRow => ({
  id,
  title: id,
  mode: "chat",
  created: NOW - 30 * DAY,
  updated: NOW - daysIdle * DAY,
  ...extra,
});

function mkTask(p: Partial<Task> & Pick<Task, "id" | "threadId" | "title" | "kind" | "tier">): Task {
  return Task.parse({
    model: "sonnet",
    effort: "medium",
    projectId: null,
    workspace: "C:/Duck",
    folder: `tasks/x-${p.id}`,
    instanceId: null,
    state: "queued",
    created: NOW,
    started: null,
    runStarted: null,
    finished: null,
    headline: null,
    question: null,
    resultFrom: null,
    nudged: false,
    error: null,
    mandate: null,
    ...p,
  });
}

function fakeTasks() {
  const tasks = new Map<string, Task>();
  const listeners = new Set<() => void>();
  const runs: RunRequest[] = [];
  const emit = () => {
    for (const l of listeners) l();
  };
  let n = 0;
  const mgr = {
    async run(req: RunRequest) {
      runs.push(req);
      n++;
      const t = mkTask({
        id: `k${n}`,
        threadId: req.threadId,
        title: req.title,
        kind: req.kind,
        tier: req.tier,
        projectId: req.projectId ?? null,
        quiet: req.quiet === true,
        self: req.self === true,
        state: "running",
        instanceId: `i${n}`,
      });
      tasks.set(t.id, t);
      emit();
      return t;
    },
    get: (id: string) => tasks.get(id),
    list: () => [...tasks.values()],
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async close(id: string) {
      const t = tasks.get(id)!;
      tasks.set(id, { ...t, state: "closed" });
      emit();
      return tasks.get(id)!;
    },
  };
  return {
    mgr: mgr as unknown as TaskManager,
    runs,
    tasks,
    finish(id: string, patch: Partial<Task>) {
      tasks.set(id, { ...tasks.get(id)!, finished: NOW, ...patch });
      emit();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function lab(opts: { threads?: ThreadRow[]; consolidatedTo?: number | null; busy?: (id: string) => string | null } = {}) {
  const clock = { now: NOW };
  const tells: { threadId: string; text: string; level: Level }[] = [];
  const threads: ThreadRow[] = [...(opts.threads ?? [])];
  const removed: string[] = [];
  const status: BackupStatus = { repo: true, remote: "https://github.com/me/duck-data.git", branch: "main", ahead: 2 };
  const pushes: PushOutcome[] = [];
  const pushed: number[] = [];
  const reviews = new Map<string, BranchReview>();
  const changes = new Map<string, WorktreeChanges>();
  const merged: string[] = [];
  const results = new Map<string, string>();
  const cutoffs: string[] = [];
  const mech: HousekeepReport = { indexed: ["2026-09-01-flight"], removed: 3, bytes: 4096, committed: [] };
  const git: GitLane = {
    status: async () => ({ ...status }),
    push: async () => {
      pushed.push(clock.now);
      return pushes.shift() ?? { outcome: "pushed", detail: "pushed main" };
    },
    review: async (b) => reviews.get(b) ?? { files: [], removed: [], added: 0 },
    housekeep: async (cutoff) => {
      cutoffs.push(cutoff);
      return mech;
    },
  };
  const tasks = fakeTasks();
  const port = {
    listProjects: () => [{ id: "wb", name: "workbench", rootPath: "C:/repos/workbench", remote: false }],
    worktreeChanges: async (id: string) => {
      const c = changes.get(id);
      if (!c) throw new Error(`no changes for ${id}`);
      return c;
    },
    mergeWorktree: async (id: string) => {
      merged.push(id);
      return "main";
    },
  } as unknown as WorkbenchPort;
  let n = 0;
  const backend = new Map<string, Routine>();
  const routines = createRoutines({
    backend: {
      put: async (r) => void backend.set(r.id, r),
      list: async () => [...backend.values()],
      remove: async (id) => void backend.delete(id),
    },
    now: () => clock.now,
    idleMs: async () => 0,
    run: (r) => hk.run(r),
  });
  const settings = { ...DEFAULT_SETTINGS };
  const hk = createHousekeeping({
    routines,
    tasks: tasks.mgr,
    port,
    settings: () => settings,
    git,
    duckProject: async () => "duck",
    threads: {
      list: () => threads,
      create: async (title) => {
        const id = `new${++n}`;
        threads.push(row(id, 0, { title }));
        return id;
      },
      remove: async (id) => {
        removed.push(id);
        threads.splice(
          threads.findIndex((t) => t.id === id),
          1,
        );
      },
    },
    busy: opts.busy ?? (() => null),
    piloted: () => new Set(),
    consolidatedTo: async () => (opts.consolidatedTo === undefined ? NOW - DAY / 2 : opts.consolidatedTo),
    resultJson: async (t) => results.get(t.id) ?? null,
    tell: (threadId, text, level) => tells.push({ threadId, text, level }),
    now: () => clock.now,
  });
  return { clock, tells, threads, removed, status, pushes, pushed, reviews, changes, merged, results, cutoffs, tasks, routines, hk, settings };
}

describe("idle threads", () => {
  it("deletes the threads idle for 7 days and keeps a pinned one, an open one, and one a task reports to", () => {
    const threads = [
      row("old", 10),
      row("pinned", 10, { keep: true }),
      row("open", 10),
      row("tasked", 10),
      row("recent", 3),
      // Talked in after the last tidy read: not remembered yet.
      row("unread", 8, { updated: NOW - 8 * DAY }),
    ];
    const gone = idleThreads({
      threads,
      now: NOW,
      days: 7,
      consolidatedTo: NOW - 9 * DAY,
      reportsTo: new Set(["tasked"]),
      busy: (id) => (id === "open" ? "open on a surface" : null),
    });
    expect(gone.map((t) => t.id)).toEqual(["old"]);
    expect(idleThreads({ threads, now: NOW, days: 0, consolidatedTo: NOW, reportsTo: new Set(), busy: () => null })).toEqual([]);
    expect(idleThreads({ threads, now: NOW, days: 7, consolidatedTo: null, reportsTo: new Set(), busy: () => null })).toEqual([]);
  });
});

describe("the backup", () => {
  it("reminds once a week when there's no remote", async () => {
    const l = lab();
    await l.routines.load();
    l.status.remote = null;
    expect(await l.routines.runNow("builtin-backup")).toBe("not backed up: no remote");
    expect(await l.routines.runNow("builtin-backup")).toBe("not backed up: no remote");
    expect(l.tells).toHaveLength(1);
    expect(l.tells[0]).toMatchObject({ level: "info" });
    expect(l.tells[0].text).toMatch(/set_up_backup/);
    expect(l.threads.find((t) => t.id === l.tells[0].threadId)?.title).toBe("Housekeeping");
    l.clock.now += 7 * DAY;
    await l.routines.runNow("builtin-backup");
    expect(l.tells).toHaveLength(2);
    expect(l.pushed).toHaveLength(0);
  });

  it("pushes only when there's something to push", async () => {
    const l = lab();
    await l.routines.load();
    expect(await l.routines.runNow("builtin-backup")).toBe("pushed");
    l.status.ahead = 0;
    expect(await l.routines.runNow("builtin-backup")).toBe("up to date");
    expect(l.pushed).toHaveLength(1);
    expect(l.tells).toEqual([]);
  });

  it("tells a failing push once as info, as needs-you after a day, and when it works again", async () => {
    const l = lab();
    await l.routines.load();
    l.pushes.push({ outcome: "offline", detail: "Could not resolve host" }, { outcome: "offline", detail: "Could not resolve host" });
    await l.routines.runNow("builtin-backup");
    await l.routines.runNow("builtin-backup");
    expect(l.tells.map((t) => t.level)).toEqual(["info"]);
    l.clock.now += DAY;
    l.pushes.push({ outcome: "offline", detail: "Could not resolve host" }, { outcome: "offline", detail: "Could not resolve host" });
    await l.routines.runNow("builtin-backup");
    await l.routines.runNow("builtin-backup");
    expect(l.tells.map((t) => t.level)).toEqual(["info", "needs_you"]);
    expect(await l.routines.runNow("builtin-backup")).toBe("pushed");
    expect(l.tells.map((t) => t.level)).toEqual(["info", "needs_you", "info"]);
    expect(l.tells[2].text).toMatch(/works again/);
    expect(l.routines.get("builtin-backup")!.memo.failingSince).toBeNull();
  });

  it("repairs a push the remote rejected with a background worker, without interrupting you", async () => {
    const l = lab();
    await l.routines.load();
    l.pushes.push({ outcome: "rejected", detail: "! [rejected] main -> main (fetch first)" });
    expect(await l.routines.runNow("builtin-backup")).toBe("push rejected: started task k1 to repair it");
    expect(l.tasks.runs[0]).toMatchObject({ kind: "code", tier: "standard", projectId: "duck", quiet: true, title: "Repair Duck's data repo" });
    expect(l.tasks.runs[0].brief).toMatch(/fetch first/);
    expect(l.tasks.runs[0].brief).toMatch(/Never push, never force/);
    // While it works, the hourly run waits for it.
    expect(await l.routines.runNow("builtin-backup")).toBe("waiting for the repair (task k1)");
    l.changes.set("i1", { branch: "agent/repair", base: "main", files: ["memory/goals.md"], uncommitted: [], insertions: 3, deletions: 0 });
    l.tasks.finish("k1", { state: "done", headline: "Merged origin/main" });
    await settle();
    expect(l.merged).toEqual(["i1"]);
    expect(l.tasks.tasks.get("k1")!.state).toBe("closed");
    expect(l.pushed).toHaveLength(2);
    expect(l.routines.get("builtin-backup")!.lastResult).toBe("pushed");
    expect(l.tells).toEqual([]);
  });

  it("asks you when the repair worker is blocked", async () => {
    const l = lab();
    await l.routines.load();
    l.pushes.push({ outcome: "rejected", detail: "non-fast-forward" });
    await l.routines.runNow("builtin-backup");
    l.tasks.finish("k1", { state: "blocked", headline: "The remote's history was rewritten" });
    await settle();
    expect(l.merged).toEqual([]);
    expect(l.tells.map((t) => t.level)).toEqual(["needs_you"]);
    expect(l.tells[0].text).toMatch(/history was rewritten/);
  });
});

describe("housekeeping", () => {
  const threads = () => [row("stale-a", 9, { title: "Release notes" }), row("stale-b", 8, { title: "Flight search" }), row("pinned", 20, { keep: true }), row("fresh", 1)];

  it("deletes idle threads, folds old tasks, and merges a tidy-only branch", async () => {
    const l = lab({ threads: threads() });
    await l.routines.load();
    const out = await l.routines.runNow("builtin-housekeeping");
    expect(out).toBe('Deleted 2 idle threads: "Release notes", "Flight search". started task k1 to tidy memory.');
    expect(l.removed).toEqual(["stale-a", "stale-b"]);
    expect(l.cutoffs).toEqual([localDate(NOW - 30 * DAY)]);
    expect(l.tasks.runs[0]).toMatchObject({ kind: "code", tier: "standard", projectId: "duck", quiet: true });
    expect(l.tasks.runs[0].brief).toMatch(/result\.json's `removed`/);
    l.changes.set("i1", { branch: "agent/housekeeping", base: "main", files: ["memory/decisions.md", "memory/projects/notes.md"], uncommitted: [], insertions: 4, deletions: 6 });
    l.reviews.set("agent/housekeeping", { files: [], removed: ["- 2026-10-02 — tabs over spaces. (src: thread:b)"], added: 2 });
    l.results.set("k1", JSON.stringify({ status: "done", headline: "Merged 3 duplicates", question: null, removed: [{ entry: "- 2026-10-02 — tabs over spaces. (src: thread:b)", reason: "superseded: spaces decided later", source: "decisions.md 2026-10-10" }] }));
    l.tasks.finish("k1", { state: "done", headline: "Merged 3 duplicates" });
    await settle();
    expect(l.merged).toEqual(["i1"]);
    expect(l.pushed).toHaveLength(1);
    expect(l.tells).toHaveLength(1);
    expect(l.tells[0].level).toBe("info");
    expect(l.tells[0].text).toMatch(/Deleted 2 idle threads: "Release notes", "Flight search"/);
    expect(l.tells[0].text).toMatch(/folded 1 old task folders/);
    expect(l.tells[0].text).toMatch(/was merged/);
  });

  it("leaves a branch that drops entries without a reason for your OK", async () => {
    const l = lab({ threads: threads() });
    await l.routines.load();
    await l.routines.runNow("builtin-housekeeping");
    l.changes.set("i1", { branch: "agent/housekeeping", base: "main", files: ["memory/people.md", "CLAUDE.md"], uncommitted: [], insertions: 1, deletions: 5 });
    l.reviews.set("agent/housekeeping", { files: [], removed: ["- 2026-10-01 — Ann leads infra. (src: thread:c)"], added: 0 });
    l.results.set("k1", JSON.stringify({ status: "done", headline: "Tidied", question: null, removed: [] }));
    l.tasks.finish("k1", { state: "done", headline: "Tidied" });
    await settle();
    expect(l.merged).toEqual([]);
    expect(l.tells.map((t) => t.level)).toEqual(["report"]);
    expect(l.tells[0].text).toMatch(/drops 1 memory entries without a sourced reason: - 2026-10-01 — Ann leads infra/);
    expect(l.tells[0].text).toMatch(/outside memory\/: CLAUDE\.md/);
    expect(l.hk.pendingMerge()?.id).toBe("k1");
    await expect(l.hk.merge("k9")).rejects.toThrow(/isn't a housekeeping branch/);
    expect(await l.hk.merge("k1")).toBe("merged into main");
    expect(l.merged).toEqual(["i1"]);
    expect(l.hk.pendingMerge()).toBeNull();
  });

  it("doesn't start a second worker while the last one runs", async () => {
    const l = lab({ threads: threads() });
    await l.routines.load();
    await l.routines.runNow("builtin-housekeeping");
    expect(await l.routines.runNow("builtin-housekeeping")).toBe("the last run's worker is still going (task k1)");
    expect(l.tasks.runs).toHaveLength(1);
  });

  it("turned off, deletes no threads", async () => {
    const l = lab({ threads: threads() });
    l.settings.deleteIdleThreadsDays = 0;
    await l.routines.load();
    await l.routines.runNow("builtin-housekeeping");
    expect(l.removed).toEqual([]);
  });
});

describe("the other actions", () => {
  it("the docs clean-up is a reviewed change to Duck", async () => {
    const l = lab();
    await l.routines.load();
    await l.routines.runNow("builtin-docs");
    expect(l.tasks.runs[0]).toMatchObject({ kind: "code", tier: "serious", effort: "medium", projectId: "wb", self: true });
    expect(l.tasks.runs[0].quiet).toBeUndefined();
    expect(l.tasks.runs[0].brief).toMatch(/duck-architecture\.md/);
    expect(await l.routines.runNow("builtin-docs")).toMatch(/still open/);
  });

  it("a message routine tells its thread, and a task routine starts a task there", async () => {
    const l = lab({ threads: [row("t1", 0)] });
    await l.routines.load();
    const m = await l.routines.add({ title: "Morning briefing", schedule: { every: "day", at: "08:30" }, action: { kind: "message", text: "Run the morning routine." }, threadId: "t1" });
    expect(await l.routines.runNow(m.id)).toBe("sent to Duck");
    expect(l.tells[0]).toMatchObject({ threadId: "t1", level: "report" });
    expect(l.tells[0].text).toBe('Your routine "Morning briefing" (every day at 08:30) is due: Run the morning routine.');
    const t = await l.routines.add({ title: "Rust news", schedule: { every: "week", day: 0 }, action: { kind: "task", brief: "What's new in Rust this week?", taskKind: "research", tier: "standard" }, threadId: "t1" });
    expect(await l.routines.runNow(t.id)).toBe("started task k1");
    expect(l.tasks.runs[0]).toMatchObject({ threadId: "t1", kind: "research", brief: "What's new in Rust this week?" });
    // Its thread was deleted: a new one, named after it.
    l.threads.splice(0, 1);
    await l.routines.runNow(m.id);
    expect(l.threads.find((x) => x.id === l.tells[1].threadId)?.title).toBe("Morning briefing");
  });

  it("a skill routine (S2) tells its thread to run the skill", async () => {
    const l = lab({ threads: [row("t1", 0)] });
    await l.routines.load();
    const r = await l.routines.add({ title: "Morning", schedule: { every: "day", at: "08:30" }, action: { kind: "skill", skill: "morning-briefing" }, threadId: "t1" });
    expect(await l.routines.runNow(r.id)).toBe("sent to Duck");
    expect(l.tells[0].text).toBe('Your routine "Morning" (every day at 08:30) is due: run the skill "morning-briefing" (load_skill), as if the user asked for it.');
  });
});
