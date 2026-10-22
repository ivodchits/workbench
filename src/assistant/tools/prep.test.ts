import { describe, expect, it } from "vitest";

import { fakePort, toolCtx } from "../fakePort.test-util";
import type { RunRequest, Task, TaskManager } from "../tasks";
import { prepAhead, prepBrief, prepCandidates, prepPart, prepTitle } from "./prep";

/** A task manager that records what it's asked to run. */
function fakeTasks(existing: Partial<Task>[] = []) {
  const runs: RunRequest[] = [];
  const list = existing as Task[];
  const tasks = {
    list: () => list,
    run(req: RunRequest) {
      runs.push(req);
      const t = { id: `p${runs.length}`, title: req.title, kind: req.kind, state: "queued", why: "the weekly limit is at 85%, and prep waits for room rather than using Duck's API credits", runner: "session", model: "sonnet", effort: "medium", tier: req.tier, prep: req.prep } as Task;
      list.push(t);
      return Promise.resolve(t);
    },
  } as unknown as TaskManager;
  return { tasks, runs };
}

describe("prep ahead", () => {
  it("offers today's timed meetings and near deadlines, not the invoice or what's prepped", () => {
    const day = {
      schedule: [
        { time: "all day", title: "Conference", type: "event" },
        { time: "09:00–09:30", title: "Standup", type: "event" },
        { time: "11:00", title: "Water plants", type: "task" },
        { time: "14:00–15:00", title: "Design review", type: "event" },
      ],
      overdue: [{ title: "Renew passport", due: "2026-10-21 17:00" }],
      open: [
        { title: "Send invoice", due: "18:00" },
        { title: "Someday", due: undefined },
        { title: "Ship 1.2", critical: true },
      ],
    };
    const prepped = [{ title: "Prep: Standup", prep: true, state: "done" }] as Task[];
    expect(prepCandidates(day, "Send invoice", [], "10:00").map((c) => c.title)).toEqual([
      "Design review",
      "Renew passport",
      "Ship 1.2",
    ]);
    expect(prepCandidates(day, "Send invoice", prepped)).toEqual([
      { for: "meeting", title: "Design review", when: "14:00–15:00" },
      { for: "deadline", title: "Renew passport", when: "2026-10-21 17:00" },
      { for: "deadline", title: "Ship 1.2" },
    ]);
  });

  it("writes a fixed, draft-only brief", () => {
    const b = prepBrief("meeting", "Design review", "14:00–15:00", "With Ana; agenda: onboarding flow");
    expect(b).toMatch(/^Prepare the user for the meeting "Design review" \(14:00–15:00\)\./);
    expect(b).toContain("With Ana; agenda: onboarding flow");
    expect(b).toMatch(/don't contact anyone, send, publish or change anything outside this task's folder/);
    expect(prepBrief("deadline", "Ship 1.2", undefined, undefined)).toMatch(/^Make a checklist for "Ship 1\.2"\. /);
  });

  it("starts a standard writing worker marked as prep, once per item", async () => {
    const { tasks, runs } = fakeTasks();
    const ctx = { ...toolCtx(fakePort({})), tasks };
    const input = { for: "meeting" as const, title: "Design review", when: "14:00" };
    const out = (await prepAhead.run(input, ctx)) as { next: string };
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ title: "Prep: Design review", kind: "writing", tier: "standard", prep: true });
    expect(out.next).toMatch(/^waiting: the weekly limit is at 85%/);
    const again = (await prepAhead.run(input, ctx)) as { next: string };
    expect(runs).toHaveLength(1);
    expect(again.next).toMatch(/already being prepared/);
    expect(prepTitle("deadline", "x".repeat(100))).toHaveLength(80);
  });

  it("lists the day's prep tasks for the briefing", () => {
    const now = Date.now();
    const { tasks } = fakeTasks([
      { id: "a", title: "Prep: Standup", prep: true, state: "done", created: now - 3600_000, headline: "Brief ready" },
      { id: "b", title: "Research", prep: false, state: "done", created: now },
      { id: "c", title: "Checklist: Old", prep: true, state: "done", created: now - 2 * 86400_000 },
      { id: "d", title: "Checklist: Ship", prep: true, state: "queued", created: now, why: "the weekly limit is at 85%" },
    ]);
    expect(prepPart(tasks, now)).toEqual([
      { id: "a", title: "Prep: Standup", state: "done", headline: "Brief ready" },
      { id: "d", title: "Checklist: Ship", state: "queued", why: "the weekly limit is at 85%" },
    ]);
  });
});
